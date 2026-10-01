/**
 * Минимальный типизированный эмиттер.
 *
 * Не используем `EventEmitter` из Node: P2P-слой работает и в браузере, где
 * node:events недоступен без бандлера-полифилла. Своя реализация — 40 строк.
 */

export type Handler<T> = (payload: T) => void;
export type Unsubscribe = () => void;

export class Emitter<Events extends Record<string, unknown>> {
  readonly #handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): Unsubscribe {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): Unsubscribe {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.#handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#handlers.get(event);
    if (!set) return;
    // Копия набора: обработчик может отписаться прямо во время рассылки.
    for (const handler of [...set]) {
      try {
        (handler as Handler<Events[K]>)(payload);
      } catch (err) {
        // Ошибка одного подписчика не должна ломать рассылку остальным и не
        // должна «съедать» необработанное исключение в обработчике DataChannel.
        reportListenerError(String(event), err);
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
  }
}

let listenerErrorSink: ((event: string, err: unknown) => void) | null = null;

export function onListenerError(sink: (event: string, err: unknown) => void): void {
  listenerErrorSink = sink;
}

function reportListenerError(event: string, err: unknown): void {
  if (listenerErrorSink) listenerErrorSink(String(event), err);
  else if (typeof console !== 'undefined') console.error(`[p2p] ошибка обработчика ${event}:`, err);
}
