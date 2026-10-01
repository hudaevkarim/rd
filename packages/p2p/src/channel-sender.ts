/**
 * Канал отправки с очередью и учётом backpressure.
 *
 * Зачем очередь: DataChannel в состоянии `connecting` принимать данные не
 * умеет — `send()` бросает исключение. Окно между `createDataChannel` и
 * `open` (~десятки миллисекунд) вполне реально, и Yjs-провайдер за это время
 * уже хочет отправить sync-шаг. Поэтому сообщения копятся в небольшой очереди и
 * сливаются при открытии.
 *
 * Зачем backpressure: `bufferedAmount` — это сколько байт мы отдали в SCTP, а
 * тот ещё не отправил. Без пауз передача файла на 500 МБ забивает память
 * получателя и самого отправителя. `waitDrained()` позволяет передатчику
 * остановиться, когда очередь опустела.
 */

import type { RtcDataChannel } from './transport.js';

/** Сколько сообщений копить, пока канал не открыт. Больше — сигнал о проблеме. */
const MAX_QUEUED = 64;

export class ChannelSender {
  readonly label: string;
  #channel: RtcDataChannel | null = null;
  readonly #queue: Uint8Array[] = [];
  #closed = false;
  #error: Error | null = null;
  readonly #drainWaiters: Array<() => void> = [];
  #lost = false;

  constructor(label: string) {
    this.label = label;
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

  attach(channel: RtcDataChannel): void {
    this.#channel = channel;
    channel.bufferedAmountLowThreshold = 256 * 1024;

    channel.addEventListener('open', () => {
      this.#flush();
    });
    channel.addEventListener('close', () => {
      this.#closed = true;
      this.#queue.length = 0;
      this.#releaseDrainWaiters();
    });
    channel.addEventListener('error', (ev) => {
      this.#error = new Error(`канал ${this.label}: ${describeEvent(ev)}`);
    });
    channel.addEventListener('bufferedamountlow', () => {
      this.#releaseDrainWaiters();
    });

    if (channel.readyState === 'open') this.#flush();
  }

  send(bytes: Uint8Array): void {
    if (this.#closed) throw this.#error ?? new Error(`канал ${this.label} закрыт`);
    if (this.isOpen) {
      this.#rawSend(bytes);
      this.#releaseDrainWaiters();
      return;
    }
    if (this.#queue.length >= MAX_QUEUED) {
      this.#lost = true;
      throw new Error(`канал ${this.label}: очередь переполнена, соединение ненадёжно`);
    }
    this.#queue.push(bytes);
  }

  /**
   * Ждёт, пока отправка «догонит» получателя. Используется передатчиком файлов
   * как основа для паузы между чанками.
   */
  waitDrained(): Promise<void> {
    if (!this.isOpen || this.bufferedAmount <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#drainWaiters.push(resolve);
    });
  }

  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    this.#channel?.close();
    this.#releaseDrainWaiters();
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
    this.#releaseDrainWaiters();
  }

  #releaseDrainWaiters(): void {
    if (this.bufferedAmount > 0) return;
    const waiters = this.#drainWaiters.splice(0, this.#drainWaiters.length);
    for (const resolve of waiters) resolve();
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
