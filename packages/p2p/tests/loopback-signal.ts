/**
 * In-memory signaling для тестов: повторяет семантику реального сервера
 * (welcome со списком пиров, relay сигналов, peer-joined/peer-left), но без сети.
 *
 * Зачем дублировать сервер, если можно поднять настоящий? Проверки mesh'а,
 * криптографии и Yjs не должны падать из-за проблем с портом или прокси.
 * Отдельный интеграционный тест поднимает настоящий сервер — но уже для
 * проверки самого сервера, а не mesh'а.
 */

import { Emitter, type SignalTransport, type SignalTransportEvents } from '@rd/p2p';
import { newId, PROTOCOL_VERSION, type ClientMessage, type PeerDescriptor, type RoomId, type ServerMessage } from '@rd/protocol';

export class MemorySignalRoom {
  readonly #members = new Map<string, MemorySignalTransport>();

  join(transport: MemorySignalTransport): void {
    const peer = transport.descriptor;
    this.#members.set(peer.id, transport);
    const others: PeerDescriptor[] = [...this.#members.values()]
      .filter((t) => t.descriptor.id !== peer.id)
      .map((t) => t.descriptor);
    transport.deliver({
      t: 'welcome',
      self: peer,
      peers: others,
      protocol: PROTOCOL_VERSION,
      serverTime: Date.now(),
    });
    for (const other of this.#members.values()) {
      if (other.descriptor.id === peer.id) continue;
      other.deliver({ t: 'peer-joined', peer });
    }
  }

  leave(id: string): void {
    if (!this.#members.delete(id)) return;
    for (const other of this.#members.values()) {
      other.deliver({ t: 'peer-left', id, reason: 'left' });
    }
  }

  relay(fromId: string, msg: ServerMessage): void {
    this.#members.get(fromId)?.deliver(msg);
  }

  target(fromId: string, toId: string, msg: ServerMessage): void {
    this.#members.get(toId)?.deliver(msg);
  }

  broadcast(fromId: string, msg: ServerMessage): void {
    for (const [id, member] of this.#members) {
      if (id === fromId) continue;
      member.deliver(msg);
    }
  }

  get size(): number {
    return this.#members.size;
  }
}

export class MemorySignalTransport implements SignalTransport {
  readonly events = new Emitter<SignalTransportEvents>();
  readonly #room: MemorySignalRoom;
  #started = false;
  #closed = false;

  constructor(
    public descriptor: PeerDescriptor,
    room: MemorySignalRoom,
  ) {
    this.#room = room;
  }

  get connected(): boolean {
    return this.#started && !this.#closed;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#room.join(this);
  }

  send(msg: ClientMessage): void {
    if (this.#closed) return;
    switch (msg.t) {
      case 'signal':
        this.#room.target(this.descriptor.id, msg.to, { t: 'signal', from: this.descriptor.id, kind: msg.kind, sdp: msg.sdp });
        return;
      case 'candidate':
        this.#room.target(this.descriptor.id, msg.to, { t: 'candidate', from: this.descriptor.id, candidate: msg.candidate });
        return;
      case 'rename':
        this.descriptor = { ...this.descriptor, name: msg.name, color: msg.color };
        this.#room.broadcast(this.descriptor.id, { t: 'renamed', id: this.descriptor.id, name: msg.name, color: msg.color });
        return;
      case 'ping':
        this.deliver({ t: 'pong', id: msg.id, at: msg.at, serverTime: Date.now() });
        return;
      case 'leave':
        this.close();
        return;
      default:
        return;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#room.leave(this.descriptor.id);
    this.events.emit('closed', { code: 1000, reason: 'closed', willReconnect: false });
  }

  on<K extends keyof SignalTransportEvents>(event: K, handler: (p: SignalTransportEvents[K]) => void): () => void {
    return this.events.on(event, handler);
  }

  /** Прямая доставка сообщения в транспорт — так же, как это делает сервер. */
  deliver(msg: ServerMessage): void {
    if (this.#closed) return;
    queueMicrotask(() => this.events.emit('message', msg));
  }
}

/** Готовая пара «пир + транспорт» для тестов. */
export function makeTransport(room: MemorySignalRoom, name: string, color: string, keys: { identityKey: string; agreeKey: string }): MemorySignalTransport {
  return new MemorySignalTransport(
    { id: newId(), name, color, identityKey: keys.identityKey, agreeKey: keys.agreeKey },
    room,
  );
}

/** Ждёт выполнения условия. Тесты с реальной асинхронностью обязаны иметь потолок. */
export async function waitFor(
  predicate: () => boolean,
  description = 'условие',
  timeoutMs = 8_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
