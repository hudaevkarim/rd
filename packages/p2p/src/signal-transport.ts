/**
 * Транспорт signaling: WSS-клиент с автопереподключением.
 *
 * Вынесено за интерфейс `SignalTransport`, потому что в тестах комнату удобнее
 * собрать из двух in-memory транспортов, чем поднимать сервер. Реальный класс
 * ниже — единственное место в клиенте, которое знает про `WebSocket`.
 *
 * Переподключение: экспоненциальная задержка с джиттером. Джиттер обязателен —
 * без него все участники, у которых одновременно отвалился сервер, вернутся
 * одной волной и снова положат его.
 *
 * Идентификатор пира ПЕРЕСОЗДАЁТСЯ при каждом подключении. Осознанно: после
 * обрыва все DataChannel мертвы, и участник для соседей — новый человек с
 * пустым состоянием. Переиспользование id заставило бы mesh отличать
 * «переподключился» от «вошёл заново», а Yjs и так сам дошлёт недостающее.
 * При этом пара ключей Ed25519/X25519 сохраняется — код безопасности не меняется.
 */

import { PROTOCOL_VERSION, type ClientMessage, type PeerDescriptor, type PeerId, type RoomId, type ServerMessage } from '@rd/protocol';
import { newId } from '@rd/protocol';
import { Emitter } from './emitter.js';

export interface SignalTransportEvents extends Record<string, unknown> {
  message: ServerMessage;
  /** Транспорт готов отправлять (соединение открыто и `join` отправлен). */
  ready: void;
  closed: { code: number; reason: string; willReconnect: boolean };
  warning: { message: string };
}

export interface SignalTransport {
  send(msg: ClientMessage): void;
  /** Открывает соединение (или переподключается). Идемпотентно. */
  start(): void;
  close(): void;
  on<K extends keyof SignalTransportEvents>(event: K, handler: (p: SignalTransportEvents[K]) => void): () => void;
  readonly connected: boolean;
}

// ─── Минимальный WebSocket-интерфейс (чтобы можно было подставить мок) ─────────

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', cb: () => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;

export interface WebSocketSignalOptions {
  url: string;
  room: RoomId;
  peer: Omit<PeerDescriptor, 'id'> & { id?: PeerId };
  /** Что делать при переподключении: тот же id или новый. По умолчанию — новый. */
  newPeerId?: () => PeerId;
  webSocket?: WebSocketFactory;
  maxBackoffMs?: number;
  /** Задержки переподключения; можно подставить детерминированные в тестах. */
  backoff?: (attempt: number) => number;
}

export class WebSocketSignalTransport implements SignalTransport {
  readonly events = new Emitter<SignalTransportEvents>();
  readonly room: RoomId;
  readonly url: string;

  #socket: WebSocketLike | null = null;
  #peer: PeerDescriptor;
  #closed = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #wsFactory: WebSocketFactory;
  readonly #newPeerId: () => PeerId;
  readonly #backoff: (attempt: number) => number;
  #joined = false;

  constructor(opts: WebSocketSignalOptions) {
    this.url = opts.url;
    this.room = opts.room;
    this.#peer = { id: opts.peer.id ?? (opts.newPeerId?.() ?? newId()), ...stripUndefined(opts.peer) };
    const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    const factory = opts.webSocket;
    if (factory) {
      this.#wsFactory = factory;
    } else {
      if (!ctor) throw new Error('WebSocket недоступен: проверьте схему (wss://) и поддержку браузера');
      this.#wsFactory = (url) => new ctor(url);
    }
    this.#newPeerId = opts.newPeerId ?? (() => newId());
    this.#backoff = opts.backoff ?? defaultBackoff;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.readyState === OPEN;
  }

  /** Текущее публичное описание пира (id может смениться при переподключении). */
  get peer(): PeerDescriptor {
    return this.#peer;
  }

  start(): void {
    this.#connect();
  }

  on<K extends keyof SignalTransportEvents>(event: K, handler: (p: SignalTransportEvents[K]) => void): () => void {
    return this.events.on(event, handler);
  }

  send(msg: ClientMessage): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  close(): void {
    this.#closed = true;
    this.#clearTimer();
    this.#socket?.close(1000, 'client-closed');
    this.#socket = null;
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #connect(): void {
    if (this.#closed) return;
    let socket: WebSocketLike;
    try {
      socket = this.#wsFactory(this.url);
    } catch (err) {
      this.events.emit('warning', { message: `не удалось открыть signaling: ${(err as Error).message}` });
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#attempt = 0;
      // Новый id на каждое подключение: см. комментарий в шапке файла.
      this.#peer = { ...this.#peer, id: this.#newPeerId() };
      this.send({ t: 'join', room: this.room, peer: this.#peer, protocol: PROTOCOL_VERSION });
    });

    socket.addEventListener('message', (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerMessage;
      } catch {
        this.events.emit('warning', { message: 'сервер прислал нечитаемое сообщение' });
        return;
      }
      if (msg.t === 'welcome' || msg.t === 'peer-joined') this.#joined = true;
      this.events.emit('message', msg);
    });

    socket.addEventListener('close', (ev) => {
      const willReconnect = !this.#closed;
      this.#socket = null;
      this.#joined = false;
      this.events.emit('closed', { code: ev.code, reason: ev.reason, willReconnect });
      if (willReconnect) this.#scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // Детали ошибки браузер намеренно не отдаёт. Сообщаем только факт:
      // обычно это CORS, прокси или неверный протокол.
      this.events.emit('warning', { message: 'ошибка WebSocket signaling (проверьте wss:// и прокси)' });
    });
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    const delay = this.#backoff(this.#attempt++);
    this.#clearTimer();
    this.#timer = setTimeout(() => this.#connect(), delay);
  }

  get joined(): boolean {
    return this.#joined;
  }
}

/** 500 мс → 30 с, экспонента с полным джиттером. */
function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** Math.min(attempt, 10));
  return Math.floor(Math.random() * base);
}

function stripUndefined(peer: Omit<PeerDescriptor, 'id'> & { id?: PeerId }): Omit<PeerDescriptor, 'id'> {
  return {
    name: peer.name,
    color: peer.color,
    identityKey: peer.identityKey,
    agreeKey: peer.agreeKey,
  };
}
