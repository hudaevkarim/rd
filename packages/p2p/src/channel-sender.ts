/**
 * Канал отправки с очередью и учётом backpressure.
 *
 * Зачем очередь: DataChannel в состоянии `connecting` принимать данные не
 * умеет — `send()` бросает исключение. Окно между `createDataChannel` и
 * `open` (~десятки миллисекунд) вполне реально, и Yjs-провайдер за это время
 * уже хочет отправить sync-шаг. Поэтому сообщения копятся в небольшой очереди и
 * сливаются при открытии.
 *
 * ─── Backpressure ────────────────────────────────────────────────────────────
 *
 * `bufferedAmount` — сколько байт мы отдали в SCTP, а тот ещё не отправил.
 * Отправитель обязан его уважать: иначе передача файла на 500 МБ забивает
 * память получателя и своего, и соединение встаёт колом.
 *
 * ГЛАВНАЯ ЛОВУШКА, из-за которой передача вставала на живом канале и не
 * вставала в тестах: событие `bufferedamountlow` по спецификации WebRTC
 * срабатывает ТОЛЬКО при переходе STRОГО ВЫШЕ порога в «не выше порога».
 * Если `bufferedAmountLowThreshold` (256 КиБ) выше, чем максимум, до которого
 * реально доходит очередь (один чанок, 16 КиБ), событие не придёт НИКОГДА.
 * А единственный другой обработчик — вызов из `send()` — недостижим, потому что
 * отправитель в этот момент стоит и ждёт. Получается не «медленно», а
 * вечная блокировка без таймаута.
 *
 * Поэтому здесь три независимые страховки:
 *   1. порог задаётся НИЖЕ отметки, до которой буфер доходит, — тогда
 *      `bufferedamountlow` действительно срабатывает;
 *   2. опрос буфера по таймеру, если событие почему-то не пришло (бывает при
 *      нестандартных реализациях и при переполнении на стороне получателя);
 *   3. таймаут на ожидание: ждать вечно нельзя, иначе зависшая передача
 *      не отличима от идущей.
 */

import type { RtcDataChannel } from './transport.js';

/** Сколько сообщений копить, пока канал не открыт. Больше — сигнал о проблеме. */
const MAX_QUEUED = 64;

/**
 * Выше этого объёма в очереди отправки новые кадры не принимаются.
 * 256 КиБ — компромисс: достаточно, чтобы сетка была занята, и мало, чтобы
 * получатель не копил десятки мегабайт у себя.
 */
const DEFAULT_HIGH_WATER = 256 * 1024;

/**
 * Ниже этого объёма отправка возобновляется. Меньше `highWaterMark` — иначе
 * получатель встанет на каждом чанке, а при равенстве возможен бесконечный
 * цикл «ждём → отправили → снова ждём».
 */
const DEFAULT_LOW_WATER = 64 * 1024;

/** Как часто проверять буфер, если браузер не прислал `bufferedamountlow`. */
const DEFAULT_POLL_MS = 10;

export interface ChannelSenderOptions {
  /** Не отправлять новое, пока очередь не опустее ниже этого значения. */
  highWaterMark?: number;
  /** Считать, что место появилось, когда очередь упала до этого значения. */
  lowWaterMark?: number;
  /** Период опроса буфера, если событие не сработало. */
  pollIntervalMs?: number;
  /** Подробный журнал: срабатывания пауз, таймауты, размеры буфера. */
  onTrace?(message: string): void;
}

interface Waiter {
  resolve(ok: boolean): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class ChannelSender {
  readonly label: string;
  #channel: RtcDataChannel | null = null;
  readonly #queue: Uint8Array[] = [];
  #closed = false;
  #error: Error | null = null;
  readonly #waiters: Waiter[] = [];
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #lost = false;

  readonly #highWaterMark: number;
  readonly #lowWaterMark: number;
  readonly #pollIntervalMs: number;
  readonly #onTrace: ((message: string) => void) | undefined;

  /** Сколько раз отправка ждала место. Показывается в панели соединения. */
  #waits = 0;

  constructor(label: string, opts: ChannelSenderOptions = {}) {
    this.label = label;
    this.#highWaterMark = Math.max(1, opts.highWaterMark ?? DEFAULT_HIGH_WATER);
    // Порог не может быть выше границы, иначе событие не сработает никогда —
    // ровно та ошибка, ради которой всё это затевалось.
    this.#lowWaterMark = Math.min(this.#highWaterMark, opts.lowWaterMark ?? DEFAULT_LOW_WATER);
    this.#pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.#onTrace = opts.onTrace;
  }

  get isOpen(): boolean {
    return this.#channel !== null && this.#channel.readyState === 'open';
  }

  get bufferedAmount(): number {
    return this.#channel?.bufferedAmount ?? 0;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get highWaterMark(): number {
    return this.#highWaterMark;
  }

  get lowWaterMark(): number {
    return this.#lowWaterMark;
  }

  get waitCount(): number {
    return this.#waits;
  }

  /** Можно ли сейчас принять ещё один кадр без риска переполнить очередь. */
  get hasCapacity(): boolean {
    if (this.#closed) return false;
    if (!this.isOpen) return true; // канал ещё открывается, размер не важен
    return this.bufferedAmount < this.#highWaterMark;
  }

  /** Состояние для диагностики и панели «соединение». */
  get stats(): { buffered: number; queued: number; high: number; low: number; waits: number } {
    return {
      buffered: this.bufferedAmount,
      queued: this.#queue.length,
      high: this.#highWaterMark,
      low: this.#lowWaterMark,
      waits: this.#waits,
    };
  }

  attach(channel: RtcDataChannel): void {
    this.#channel = channel;
    // Порог обязан быть НИЖЕ highWaterMark, иначе событие не сработает.
    channel.bufferedAmountLowThreshold = this.#lowWaterMark;

    channel.addEventListener('open', () => {
      this.#flush();
    });
    channel.addEventListener('close', () => {
      this.#closed = true;
      this.#queue.length = 0;
      this.#stopPolling();
      this.#rejectWaiters('канал закрыт');
    });
    channel.addEventListener('error', (ev) => {
      this.#error = new Error(`канал ${this.label}: ${describeEvent(ev)}`);
    });
    channel.addEventListener('bufferedamountlow', () => {
      this.#releaseWaiters();
    });

    if (channel.readyState === 'open') this.#flush();
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) throw this.#error ?? new Error(`канал ${this.label} закрыт`);
    if (this.isOpen) {
      this.#rawSend(bytes);
      return;
    }
    if (this.#queue.length >= MAX_QUEUED) {
      this.#lost = true;
      throw new Error(`канал ${this.label}: очередь переполнена, соединение ненадёжно`);
    }
    this.#queue.push(bytes);
  }

  /**
   * Ждёт места в очереди отправки.
   *
   * Возвращает `false` на таймауте или при закрытии канала — вызывающий код
   * обязан это обработать. Раньше здесь был `waitDrained()`, который ждал
   * `bufferedAmount === 0` и не имел ни таймаута, ни обработки события по
   * порогу: на живом DataChannel он не просыпался никогда.
   *
   * @param timeoutMs сколько максимум ждать, мс
   * @param reason для журнала: что именно собираемся слать
   */
  async waitForCapacity(timeoutMs: number, reason = ''): Promise<boolean> {
    if (this.hasCapacity) return true;
    if (this.#closed) return false;

    this.#waits++;
    const started = this.bufferedAmount;
    this.#onTrace?.(
      `${this.label}: пауза${reason === '' ? '' : ` перед ${reason}`} — буфер ${started} Б, ждём ≤ ${timeoutMs} мс`,
    );

    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        resolve: (ok) => {
          this.#clearWaiterTimer(waiter);
          resolve(ok);
        },
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this.#onTrace?.(
          `${this.label}: ТАЙМАУТ ${timeoutMs} мс — буфер ${this.bufferedAmount} Б так и не опустел`,
        );
        this.#dropWaiter(waiter);
        resolve(false);
      }, timeoutMs);
      waiter.timer.unref?.();
      this.#waiters.push(waiter);
      this.#startPolling();
    });
  }

  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    this.#stopPolling();
    this.#channel?.close();
    this.#rejectWaiters('канал закрыт');
  }

  #rawSend(bytes: Uint8Array): void {
    const channel = this.#channel;
    if (channel === null) return;
    try {
      // Копия нужна: AeadChannel переиспользует буферы между вызовами seal(),
      // а send() в реальном браузере кладёт данные в очередь асинхронно.
      channel.send(bytes.slice().buffer);
    } catch (err) {
      this.#error = new Error(`отправка в ${this.label} не удалась: ${(err as Error).message}`);
      throw this.#error;
    }
  }

  #flush(): void {
    while (this.#queue.length > 0 && this.isOpen) {
      const next = this.#queue.shift();
      if (next === undefined) break;
      try {
        this.#rawSend(next);
      } catch {
        return;
      }
    }
    this.#releaseWaiters();
  }

  /** Буфер упал ниже порога — значит место появилось, отпускаем ждущих. */
  #releaseWaiters(): void {
    if (this.#waiters.length === 0) return;
    if (!this.hasCapacity) return;
    const waiters = this.#waiters.splice(0, this.#waiters.length);
    this.#stopPolling();
    for (const w of waiters) {
      this.#clearWaiterTimer(w);
      w.resolve(true);
    }
  }

  #rejectWaiters(why: string): void {
    const waiters = this.#waiters.splice(0, this.#waiters.length);
    for (const w of waiters) {
      this.#clearWaiterTimer(w);
      w.resolve(false);
    }
    if (waiters.length > 0) this.#onTrace?.(`${this.label}: снято ожиданий — ${why}`);
  }

  #dropWaiter(waiter: Waiter): void {
    const i = this.#waiters.indexOf(waiter);
    if (i >= 0) this.#waiters.splice(i, 1);
    if (this.#waiters.length === 0) this.#stopPolling();
  }

  #clearWaiterTimer(waiter: Waiter): void {
    if (waiter.timer === null) return;
    clearTimeout(waiter.timer);
    waiter.timer = null;
  }

  /**
   * Страховка на случай, если `bufferedamountlow` не придёт: раз в
   * `pollIntervalMs` смотрим на буфер сами. Без этого любая реализация,
   * не реализующая событие по спеке, даёт вечную блокировку.
   */
  #startPolling(): void {
    if (this.#pollTimer !== null) return;
    const tick = (): void => {
      this.#pollTimer = null;
      if (this.#waiters.length === 0) return;
      this.#releaseWaiters();
      if (this.#waiters.length === 0) return;
      const next = setTimeout(tick, this.#pollIntervalMs);
      next.unref?.();
      this.#pollTimer = next;
    };
    const first = setTimeout(tick, this.#pollIntervalMs);
    first.unref?.();
    this.#pollTimer = first;
  }

  #stopPolling(): void {
    if (this.#pollTimer === null) return;
    clearTimeout(this.#pollTimer);
    this.#pollTimer = null;
  }
}

function describeEvent(ev: unknown): string {
  if (typeof ev === 'object' && ev !== null && 'error' in ev) {
    const e = (ev as { error?: unknown }).error;
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
  }
  return 'неизвестная ошибка канала';
}