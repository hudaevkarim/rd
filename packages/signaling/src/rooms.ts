/**
 * Реестр комнат и участников.
 *
 * ЭТО ЕДИНСТВЕННОЕ СОСТОЯНИЕ СЕРВЕРА, и оно намеренно минимально:
 *   - id комнаты (из UUIDv4 клиента — сервер его не генерирует и не проверяет
 *     никакой «важностью», просто проверяет формат);
 *   - описание пира: id, отображаемое имя, цвет и два ПУБЛИЧНЫХ ключа.
 *
 * Чего здесь нет и не должно появиться: содержимого книг, комментариев,
 * прогресса чтения, парольных фраз, ключей шифрования, самих SDP (они
 * пролетают транзитом и не сохраняются). Всё это либо живёт только в памяти
 * пира, либо вообще не покидает его устройство.
 *
 * Смысл хранить имя/цвет/ключи в реестре — маршрутизация: новый участник
 * должен узнать, кому слать offer, а кому — свои открытые ключи для
 * рукопожатия. Это публичные данные, которые и так раскрываются всем в комнате.
 */

import {
  MAX_ROOM_PEERS,
  ROOM_IDLE_EVICT_MS,
  type ErrorCode,
  type PeerDescriptor,
  type PeerId,
  type RoomId,
  type ServerMessage,
} from '@rd/protocol';
import type { TokenBucket } from './rate-limit.js';

export interface Peer {
  readonly id: PeerId;
  name: string;
  color: string;
  readonly identityKey: string;
  readonly agreeKey: string;
  readonly room: Room;
  readonly limiter: TokenBucket;
  /** Отправка через обёртку, которая сама следит за readyState и backpressure. */
  send: (msg: ServerMessage) => void;
  /** Закрытие транспорта. Вызывается при выходе из комнаты и при превышении лимитов. */
  close: (code: number, reason: string) => void;
  readonly joinedAt: number;
  sentOffers: number;
}

export class Room {
  readonly id: RoomId;
  readonly peers = new Map<PeerId, Peer>();
  readonly createdAt: number;
  /** Лимит участников задаётся конфигом сервера, а не константой протокола. */
  readonly maxPeers: number;
  lastActivity: number;

  constructor(id: RoomId, now: number, maxPeers: number = MAX_ROOM_PEERS) {
    this.id = id;
    this.maxPeers = maxPeers;
    this.createdAt = now;
    this.lastActivity = now;
  }

  get size(): number {
    return this.peers.size;
  }

  get isFull(): boolean {
    return this.peers.size >= this.maxPeers;
  }

  add(peer: Peer): void {
    this.peers.set(peer.id, peer);
    this.lastActivity = Date.now();
  }

  remove(id: PeerId): Peer | undefined {
    const peer = this.peers.get(id);
    if (peer) {
      this.peers.delete(id);
      this.lastActivity = Date.now();
    }
    return peer;
  }

  /** Снимок публичных описаний всех пиров, кроме указанного. */
  others(except: PeerId): PeerDescriptor[] {
    const out: PeerDescriptor[] = [];
    for (const p of this.peers.values()) {
      if (p.id === except) continue;
      out.push({ id: p.id, name: p.name, color: p.color, identityKey: p.identityKey, agreeKey: p.agreeKey });
    }
    return out;
  }
}

export class RoomRegistry {
  readonly #rooms = new Map<RoomId, Room>();
  readonly #onEvict: (room: Room) => void;
  readonly #maxPeers: number;
  #pendingEvictions = new Set<RoomId>();

  constructor(opts: { maxPeers?: number; onEvict?: (room: Room) => void } = {}) {
    this.#maxPeers = opts.maxPeers ?? MAX_ROOM_PEERS;
    this.#onEvict = opts.onEvict ?? (() => {});
  }

  get(roomId: RoomId): Room | undefined {
    return this.#rooms.get(roomId);
  }

  /** Возвращает существующую комнату или создаёт пустую. */
  ensure(roomId: RoomId, now: number): Room {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, now, this.#maxPeers);
      this.#rooms.set(roomId, room);
    }
    this.#pendingEvictions.delete(roomId);
    return room;
  }

  release(room: Room, delayMs = ROOM_IDLE_EVICT_MS): void {
    if (room.peers.size === 0) this.scheduleEvict(room.id, delayMs);
  }

  /**
   * Пустые комнаты удаляем не сразу, а с задержкой: при кратковременном
   * обрыве связи (переключение Wi-Fi, сворачивание вкладки) участник
   * возвращается в ту же комнату и не теряет список пиров.
   */
  scheduleEvict(roomId: RoomId, delayMs: number): void {
    if (this.#pendingEvictions.has(roomId)) return;
    this.#pendingEvictions.add(roomId);
    const timer = setTimeout(() => {
      this.#pendingEvictions.delete(roomId);
      const room = this.#rooms.get(roomId);
      if (room && room.peers.size === 0) {
        this.#rooms.delete(roomId);
        this.#onEvict(room);
      }
    }, delayMs);
    // Не держать процесс живым из-за таймера вытеснения.
    timer.unref?.();
  }

  /** Полная очистка пустых комнат. Вызывается по таймеру в main.ts. */
  sweep(now: number, maxIdleMs: number): number {
    let removed = 0;
    for (const [id, room] of this.#rooms) {
      if (room.peers.size === 0 && now - room.lastActivity > maxIdleMs) {
        this.#rooms.delete(id);
        this.#onEvict(room);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#rooms.size;
  }

  get peerCount(): number {
    let n = 0;
    for (const room of this.#rooms.values()) n += room.peers.size;
    return n;
  }

  stats(): { rooms: number; peers: number } {
    return { rooms: this.size, peers: this.peerCount };
  }
}

export class RoomError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'RoomError';
  }
}
