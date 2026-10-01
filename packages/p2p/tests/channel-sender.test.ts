/**
 * Юнит-тесты ChannelSender — той части, которую in-memory WebRTC принципиально
 * не проверяет.
 *
 * В `mock-webrtc.ts` `bufferedAmount` всегда 0: буфер мгновенно «съедает» всё
 * отправленное. Это удобно для сквозных тестов, но означает, что весь код
 * backpressure там не исполняется ни разу. Именно поэтому настоящий баг
 * (передача вставала на живом DataChannel) жил незамеченным: тесты были зелёные.
 *
 * Здесь канал — честная модель SCTP: очередь растёт при `send()`, убывает по
 * мере отправки в сеть, а `bufferedamountlow` срабатывает СТРОГО по спеке
 * WebRTC — только при переходе выше порога в «не выше порога». Реализация,
 * срабатывающая на любое уменьшение, скрыла бы баг.
 */

import { describe, expect, it } from 'vitest';
import { ChannelSender } from '@rd/p2p';

/**
 * Модель очереди отправки. `bytesPerTick` — сколько уходит в сеть за тик;
 * `drain: false` имитирует канал, который перестал забирать данные.
 */
class FakeDataChannel {
  readyState: RTCDataChannelState = 'open';
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  bufferedAmountLowThreshold = 0;
  maxMessageSize = 262_144;

  readonly #pending: number[] = [];
  readonly #listeners = new Map<string, Set<() => void>>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  bytesPerTick = 8 * 1024;
  /** Сколько тиков ждать до первой отправки: имитация задержки сети. */
  latencyTicks = 0;
  /** Полностью остановить слив — для проверки таймаута. */
  drain = true;

  get bufferedAmount(): number {
    return this.#pending.reduce((sum, n) => sum + n, 0);
  }

  /** Пиковая отметка, до которой доходила очередь. */
  peak = 0;

  send(data: ArrayBufferView | ArrayBuffer | string): void {
    const n = typeof data === 'string' ? data.length : (data as ArrayBufferView).byteLength;
    this.#pending.push(n);
    this.peak = Math.max(this.peak, this.bufferedAmount);
    this.#schedule();
  }

  close(): void {
    this.readyState = 'closed';
    this.#emit('close');
  }

  addEventListener(type: string, cb: () => void): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.#listeners.get(type)?.delete(cb);
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.drain) return;
      if (this.latencyTicks > 0) {
        this.latencyTicks--;
        this.#schedule();
        return;
      }
      // Порог проверяется ДО уменьшения: событие по спеке срабатывает при
      // переходе выше порога в «не выше», а не при каждом уменьшении.
      const wasAbove = this.bufferedAmount > this.bufferedAmountLowThreshold;
      let budget = this.bytesPerTick;
      while (budget > 0 && this.#pending.length > 0) {
        const head = this.#pending[0] as number;
        const take = Math.min(head, budget);
        this.#pending[0] = head - take;
        budget -= take;
        if (head - take === 0) this.#pending.shift();
      }
      if (wasAbove && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.#emit('bufferedamountlow');
      }
      if (this.#pending.length > 0) this.#schedule();
    }, 1);
  }

  #emit(type: string): void {
    for (const cb of [...(this.#listeners.get(type) ?? [])]) cb();
  }

  /** Отключить таймер, чтобы тест не ждал его в конце. */
  stopTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

function makeSender(ch: FakeDataChannel, opts = {}): { sender: ChannelSender; trace: string[] } {
  const trace: string[] = [];
  const sender = new ChannelSender('rd-file', { onTrace: (m) => trace.push(m), ...opts });
  sender.attach(ch as never);
  return { sender, trace };
}

const CHUNK = 16 * 1024;

describe('ChannelSender: backpressure', () => {
  it('ставит порог события ниже отметки, до которой доходит очередь', () => {
    const ch = new FakeDataChannel();
    const { sender } = makeSender(ch, { highWaterMark: 256 * 1024, lowWaterMark: 128 * 1024 });

    // Ключевая гарантия: порог события обязан быть НИЖЕ high-water, иначе
    // `bufferedamountlow` не сработает никогда и отправитель встанет навсегда.
    expect(ch.bufferedAmountLowThreshold).toBeLessThan(sender.highWaterMark);
    expect(ch.bufferedAmountLowThreshold).toBe(128 * 1024);
  });

  it('не отправляет новое, пока очередь выше порога', async () => {
    const ch = new FakeDataChannel();
    ch.bytesPerTick = 4 * 1024; // сеть медленнее отправителя
    const { sender } = makeSender(ch, { highWaterMark: 64 * 1024, lowWaterMark: 32 * 1024 });

    let sent = 0;
    for (let i = 0; i < 20; i++) {
      while (!sender.hasCapacity) {
        const ok = await sender.waitForCapacity(1000, `чанк #${i}`);
        expect(ok).toBe(true);
      }
      sender.send(new Uint8Array(CHUNK));
      sent++;
    }
    ch.stopTimer();

    // 20 чанков по 16 КиБ — 320 КиБ, но в пике в канале не должно быть больше
    // отметки плюс один чанк: иначе память уходит на получателя.
    expect(ch.peak).toBeLessThanOrEqual(64 * 1024 + CHUNK);
    expect(sent).toBe(20);
  });

  it('освобождает ожидание по событию bufferedamountlow', async () => {
    const ch = new FakeDataChannel();
    ch.bytesPerTick = 8 * 1024;
    const { sender } = makeSender(ch, { highWaterMark: 64 * 1024, lowWaterMark: 32 * 1024 });

    // Забиваем очередь выше порога — только тогда событие вообще может сработать.
    while (sender.hasCapacity) sender.send(new Uint8Array(CHUNK));
    expect(ch.bufferedAmount).toBeGreaterThan(ch.bufferedAmountLowThreshold);

    const waited = sender.waitForCapacity(1000, 'проверка события');
    await waited;
    ch.stopTimer();

    // Ожидание снимается, когда очередь опустела ниже high-water — событие
    // служит лишь сигналом «проверь буфер», а не условием выхода.
    expect(ch.bufferedAmount).toBeLessThan(sender.highWaterMark);
    expect(sender.hasCapacity).toBe(true);
  });

  it('освобождает ожидание опросом, даже если событие не приходит', async () => {
    const ch = new FakeDataChannel();
    ch.bytesPerTick = 8 * 1024;
    // Порог 0: событие по спеке не сработает НИКОГДА — буфер никогда не был
    // строго выше нуля после первого заполнения. Именно такой канал раньше
    // вешал передачу навсегда.
    const { sender } = makeSender(ch, { highWaterMark: 64 * 1024, lowWaterMark: 1, pollIntervalMs: 5 });
    expect(ch.bufferedAmountLowThreshold).toBe(1);

    while (sender.hasCapacity) sender.send(new Uint8Array(CHUNK));
    const started = Date.now();
    const ok = await sender.waitForCapacity(2000, 'проверка опроса');
    ch.stopTimer();

    expect(ok).toBe(true);
    // Вышло по опросу, а не по событию: событие здесь физически невозможно.
    expect(ch.bufferedAmount).toBeLessThanOrEqual(sender.highWaterMark);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('возвращает false по таймауту, если канал перестал забирать данные', async () => {
    const ch = new FakeDataChannel();
    ch.drain = false; // сеть мертва
    const { sender, trace } = makeSender(ch, { highWaterMark: 32 * 1024, lowWaterMark: 16 * 1024 });

    while (sender.hasCapacity) sender.send(new Uint8Array(CHUNK));
    const ok = await sender.waitForCapacity(120, 'проверка таймаута');
    ch.stopTimer();

    // Зависать здесь нельзя: иначе передача стоит молча и пользователь не
    // понимает, что происходит.
    expect(ok).toBe(false);
    expect(trace.some((m) => m.includes('ТАЙМАУТ'))).toBe(true);
  });

  it('освобождает ожидание при закрытии канала', async () => {
    const ch = new FakeDataChannel();
    ch.drain = false;
    const { sender } = makeSender(ch, { highWaterMark: 32 * 1024, lowWaterMark: 16 * 1024 });

    while (sender.hasCapacity) sender.send(new Uint8Array(CHUNK));
    const pending = sender.waitForCapacity(5000, 'проверка закрытия');
    ch.close();
    const ok = await pending;
    ch.stopTimer();

    expect(ok).toBe(false);
    expect(sender.hasCapacity).toBe(false);
  });

  it('не копит ожидания: каждый таймер снимается', async () => {
    const ch = new FakeDataChannel();
    ch.bytesPerTick = 8 * 1024;
    const { sender } = makeSender(ch, { highWaterMark: 64 * 1024, lowWaterMark: 32 * 1024 });

    while (sender.hasCapacity) sender.send(new Uint8Array(CHUNK));
    // Пять ожиданий подряд: если таймеры не снимаются, тестprocess не завершится.
    await Promise.all([0, 1, 2, 3, 4].map(() => sender.waitForCapacity(2000, 'нагрузка')));
    ch.stopTimer();
    expect(sender.hasCapacity).toBe(true);
  });
});