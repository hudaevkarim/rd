/**
 * Token bucket и скользящее окно — своя реализация вместо готового плагина.
 *
 * Почему не @fastify/rate-limit: он работает на уровне HTTP-запросов, а нам
 * нужно ограничивать именно ПОТОК сообщений внутри уже установленного WebSocket
 * (иначе один клиент зальёт сервер тысячами `signal` в секунду). Своя
 * реализация вдобавок тестируется в изоляции, без HTTP-обвязки.
 *
 * Время внедряется через параметр, чтобы тесты не зависели от системных часов.
 */

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export interface BucketOptions {
  /** Сколько токенов можно накопить (размер пачки). */
  capacity: number;
  /** Скорость пополнения, токенов в секунду. */
  refillPerSec: number;
  clock?: Clock;
}

export class TokenBucket {
  #tokens: number;
  #updatedAt: number;
  readonly #capacity: number;
  readonly #refillPerSec: number;
  readonly #clock: Clock;

  constructor(opts: BucketOptions) {
    this.#capacity = opts.capacity;
    this.#refillPerSec = opts.refillPerSec;
    this.#clock = opts.clock ?? systemClock;
    this.#tokens = opts.capacity;
    this.#updatedAt = this.#clock();
  }

  #refill(): void {
    const now = this.#clock();
    const elapsedSec = (now - this.#updatedAt) / 1000;
    if (elapsedSec <= 0) return;
    this.#updatedAt = now;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsedSec * this.#refillPerSec);
  }

  /** Пытается списать n токенов. true — можно пропустить, false — превышен лимит. */
  take(n = 1): boolean {
    this.#refill();
    if (this.#tokens >= n) {
      this.#tokens -= n;
      return true;
    }
    return false;
  }

  get available(): number {
    this.#refill();
    return this.#tokens;
  }
}

/**
 * Скользящее окно по ключу (IP-адрес). Нужен для ограничения числа
 * ОТКРЫТИЙ соединений: иначе один клиент откроет тысячу WebSocket'ов и съест
 * память сервера, не отправив ни одного сообщения.
 */
export class KeyedWindowLimiter {
  readonly #entries = new Map<string, { bucket: TokenBucket; lastSeen: number }>();
  readonly #capacity: number;
  readonly #refillPerSec: number;
  readonly #clock: Clock;
  readonly #maxKeys: number;

  constructor(opts: { capacity: number; refillPerSec: number; maxKeys?: number; clock?: Clock }) {
    this.#capacity = opts.capacity;
    this.#refillPerSec = opts.refillPerSec;
    this.#clock = opts.clock ?? systemClock;
    this.#maxKeys = opts.maxKeys ?? 10_000;
  }

  take(key: string, n = 1): boolean {
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= this.#maxKeys) this.#evictOldest();
      entry = { bucket: new TokenBucket({ capacity: this.#capacity, refillPerSec: this.#refillPerSec, clock: this.#clock }), lastSeen: 0 };
      this.#entries.set(key, entry);
    }
    entry.lastSeen = this.#clock();
    return entry.bucket.take(n);
  }

  /** Периодический вызов: не даём карте расти бесконечно из-за спуфинга адресов. */
  evictStale(maxIdleMs: number): number {
    const now = this.#clock();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastSeen > maxIdleMs) {
        this.#entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** При переполнении карты выкидываем самые старые записи — проще, чем LRU с переупорядочиванием. */
  #evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#entries) {
      if (entry.lastSeen < oldestAt) {
        oldestAt = entry.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.#entries.delete(oldestKey);
  }
}
