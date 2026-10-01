/**
 * RoomMesh — полносвязная (mesh) сеть пиров комнаты.
 *
 * Топология: каждый связан с каждым напрямую, без ретрансляции. Для MVP с
 * ограничением в 8 участников это 28 соединений — приемлемо, и это единственная
 * схема, при которой ни один узел не видит чужой трафик «по пути».
 *
 * Кто предлагает соединение: новый участник. Он получает в `welcome` список
 * присутствующих и отправляет offer каждому, существующие пиры только отвечают.
 * Так коллизия предложений при первичном соединении невозможна by construction;
 * perfect negotiation в PeerLink остаётся на случай пересогласования (ICE-restart).
 *
 * Сообщения, пришедшие для ещё неизвестного пира, ставятся в очередь: порядок
 * доставки через signaling-сервер не гарантирован, и на быстром канале `signal`
 * вполне может прийти раньше `peer-joined`.
 */

import type { IceCandidatePayload, PeerDescriptor, PeerId, RoomId, ServerMessage } from '@rd/protocol';
import type { CtrlMessage } from '@rd/protocol';
import type { PassKey, PeerIdentity } from '@rd/crypto';
import { Emitter } from './emitter.js';
import { PeerLink, type CtrlPayload, type LinkState, type SignalOut } from './peer-link.js';
import type { SignalTransport } from './signal-transport.js';
import type { RtcConfig, RtcFactory } from './transport.js';

export interface RoomPeerInfo {
  id: PeerId;
  name: string;
  color: string;
  state: LinkState;
  identityKey: string;
  safetyCode: string | null;
  warn: string | null;
  rttMs: number | null;
  /** Диагностика WebRTC: показывается, когда соединение не готово. */
  iceState: string;
  connectionState: string;
}

export interface RoomMeshEvents extends Record<string, unknown> {
  peers: RoomPeerInfo[];
  ctrl: { peerId: PeerId; payload: CtrlPayload };
  fileChunk: { peerId: PeerId; transferId: string; offset: number; data: Uint8Array };
  safety: { peerId: PeerId; code: string };
  warning: { message: string };
  open: { at: number };
  closed: { reason: string };
}

export interface RoomMeshOptions {
  roomId: RoomId;
  passKey: PassKey;
  self: PeerIdentity;
  transport: SignalTransport;
  rtc: RtcFactory;
  rtcConfig?: RtcConfig;
  /** Интервал ping для измерения задержки, мс. */
  pingIntervalMs?: number;
  /** Сколько неотвеченных пингов допускаем на пира, прежде чем перестать мерить. */
  maxPendingPings?: number;
}

type QueuedSignal =
  | { kind: 'signal'; type: 'offer' | 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: IceCandidatePayload };

interface PeerRecord {
  descriptor: PeerDescriptor;
  link: PeerLink | null;
  safetyCode: string | null;
  warn: string | null;
  rttMs: number | null;
  pendingPings: Map<number, number>;
}

const MAX_QUEUED_PEERS = 64;
const MAX_QUEUED_PER_PEER = 32;

export class RoomMesh {
  readonly events = new Emitter<RoomMeshEvents>();

  readonly #roomId: RoomId;
  readonly #passKey: PassKey;
  readonly #self: PeerIdentity;
  readonly #transport: SignalTransport;
  readonly #rtc: RtcFactory;
  readonly #rtcConfig: RtcConfig;
  readonly #pingIntervalMs: number;
  readonly #maxPendingPings: number;

  readonly #peers = new Map<PeerId, PeerRecord>();
  readonly #queue = new Map<PeerId, QueuedSignal[]>();
  #unsubscribe: Array<() => void> = [];

  #selfId: PeerId | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pingSeq = 0;
  #stopped = false;

  constructor(opts: RoomMeshOptions) {
    this.#roomId = opts.roomId;
    this.#passKey = opts.passKey;
    this.#self = opts.self;
    this.#transport = opts.transport;
    this.#rtc = opts.rtc;
    this.#rtcConfig = opts.rtcConfig ?? {};
    this.#pingIntervalMs = opts.pingIntervalMs ?? 5_000;
    this.#maxPendingPings = opts.maxPendingPings ?? 4;
  }

  /** Идентификатор, присвоенный signaling-сервером этому подключению. */
  get self(): PeerId {
    if (this.#selfId === null) throw new Error('соединение с комнатой ещё не установлено');
    return this.#selfId;
  }

  get isOpen(): boolean {
    return this.#selfId !== null;
  }

  get peerCount(): number {
    return this.#peers.size;
  }

  get readyPeerCount(): number {
    let n = 0;
    for (const rec of this.#peers.values()) if (rec.link?.isReady === true) n++;
    return n;
  }

  /**
   * Диагностический доступ к соединению с пиром: состояние канала, очередь
   * отправки, статистика AEAD. UI показывает это в панели «соединение», тесты
   * используют для проверки внутренних состояний.
   */
  linkOf(peerId: PeerId): PeerLink | null {
    return this.#peers.get(peerId)?.link ?? null;
  }

  get peers(): RoomPeerInfo[] {
    const out: RoomPeerInfo[] = [];
    for (const [id, rec] of this.#peers) {
      out.push({
        id,
        name: rec.descriptor.name,
        color: rec.descriptor.color,
        state: rec.link?.state ?? 'new',
        identityKey: rec.descriptor.identityKey,
        safetyCode: rec.safetyCode,
        warn: rec.warn,
        rttMs: rec.rttMs,
        iceState: rec.link?.iceState ?? 'new',
        connectionState: rec.link?.connectionState ?? 'new',
      });
    }
    return out;
  }

  get readyPeers(): PeerId[] {
    const out: PeerId[] = [];
    for (const [id, rec] of this.#peers) if (rec.link?.isReady === true) out.push(id);
    return out;
  }

  /** Сведения об одном пире. Именованный метод, а не геттер: геттер с
   *  аргументом в TypeScript невозможен, а `get peer(id)` читается как свойство. */
  peerInfo(id: PeerId): RoomPeerInfo | undefined {
    const rec = this.#peers.get(id);
    if (rec === undefined) return undefined;
    return {
      id,
      name: rec.descriptor.name,
      color: rec.descriptor.color,
      state: rec.link?.state ?? 'new',
      identityKey: rec.descriptor.identityKey,
      safetyCode: rec.safetyCode,
      warn: rec.warn,
      rttMs: rec.rttMs,
      iceState: rec.link?.iceState ?? 'new',
      connectionState: rec.link?.connectionState ?? 'new',
    };
  }

  start(): void {
    this.#unsubscribe.push(
      this.#transport.on('message', (msg) => this.#onServerMessage(msg)),
      this.#transport.on('closed', (info) => {
        // Все PeerConnection мертвы вместе с signaling-соединением.
        for (const rec of this.#peers.values()) rec.link?.close();
        this.#peers.clear();
        this.#queue.clear();
        this.#stopPing();
        this.#selfId = null;
        this.#emitPeers();
        this.events.emit('closed', { reason: info.willReconnect ? 'переподключение к signaling' : info.reason });
      }),
      this.#transport.on('warning', (w) => this.events.emit('warning', w)),
    );
    this.#transport.start();
  }

  stop(): void {
    this.#stopped = true;
    this.#stopPing();
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    for (const rec of this.#peers.values()) rec.link?.close();
    this.#peers.clear();
    this.#queue.clear();
    this.#transport.close();
    this.events.clear();
  }

  // ─── Обработка signaling ─────────────────────────────────────────────────────

  #onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.#selfId = msg.self.id;
        // Мы — новый участник: инициируем соединение со всеми, кто уже здесь.
        for (const descriptor of msg.peers) {
          this.#upsert(descriptor);
          this.#ensureLink(descriptor.id)?.startAsOfferer().catch(() => {});
        }
        this.#startPing();
        this.#emitPeers();
        this.events.emit('open', { at: msg.serverTime });
        return;
      }
      case 'peer-joined': {
        this.#upsert(msg.peer);
        // Существующий пир: только отвечаем на offer, свои каналы не создаём.
        this.#ensureLink(msg.peer.id);
        this.#emitPeers();
        return;
      }
      case 'peer-left': {
        const rec = this.#peers.get(msg.id);
        if (rec !== undefined) {
          rec.link?.close();
          this.#peers.delete(msg.id);
          this.#queue.delete(msg.id);
          this.#emitPeers();
        }
        return;
      }
      case 'renamed': {
        const rec = this.#peers.get(msg.id);
        if (rec !== undefined) {
          rec.descriptor = { ...rec.descriptor, name: msg.name, color: msg.color };
          this.#emitPeers();
        }
        return;
      }
      case 'signal': {
        const link = this.#ensureLink(msg.from);
        if (link) void link.handleDescription({ kind: msg.kind, sdp: msg.sdp });
        else this.#queueSignal(msg.from, { kind: 'signal', type: msg.kind, sdp: msg.sdp });
        return;
      }
      case 'candidate': {
        const link = this.#ensureLink(msg.from);
        if (link) void link.handleCandidate(msg.candidate);
        else this.#queueSignal(msg.from, { kind: 'candidate', candidate: msg.candidate });
        return;
      }
      case 'error': {
        this.events.emit('warning', { message: `signaling: ${msg.message}` });
        if (msg.fatal) this.#transport.close();
        return;
      }
      case 'ping':
      case 'pong':
        return;
      default:
        return;
    }
  }

  #upsert(descriptor: PeerDescriptor): PeerRecord {
    const existing = this.#peers.get(descriptor.id);
    if (existing !== undefined) {
      existing.descriptor = descriptor;
      return existing;
    }
    const rec: PeerRecord = {
      descriptor,
      link: null,
      safetyCode: null,
      warn: null,
      rttMs: null,
      pendingPings: new Map(),
    };
    this.#peers.set(descriptor.id, rec);
    return rec;
  }

  #ensureLink(peerId: PeerId): PeerLink | null {
    const rec = this.#peers.get(peerId);
    if (rec === undefined) return null;
    if (rec.link !== null) return rec.link;

    const link = new PeerLink({
      selfId: this.self,
      self: this.#self,
      peer: rec.descriptor,
      roomId: this.#roomId,
      passKey: this.#passKey,
      rtc: this.#rtc,
      rtcConfig: this.#rtcConfig,
      signal: (out) => this.#sendSignal(out),
    });

    link.events.on('state', () => this.#emitPeers());
    link.events.on('ctrl', (payload) => this.events.emit('ctrl', { peerId, payload }));
    link.events.on('fileChunk', (chunk) =>
      this.events.emit('fileChunk', { peerId, transferId: chunk.transferId, offset: chunk.offset, data: chunk.data }),
    );
    link.events.on('safety', (code) => {
      // Код приходит дважды: после первой стадии рукопожатия (чтобы показать его
      // как можно раньше) и после установки ключей. Повтор не пересылаем —
      // иначе UI перерисовывается и «прыгает» без причины.
      if (rec.safetyCode === code) return;
      rec.safetyCode = code;
      this.events.emit('safety', { peerId, code });
      this.#emitPeers();
    });
    link.events.on('warn', (w) => {
      rec.warn = w.message;
      this.#emitPeers();
    });
    link.events.on('error', (e) => {
      rec.warn = e.message;
      this.#emitPeers();
      if (e.fatal) this.events.emit('warning', { message: `пир ${peerId}: ${e.message}` });
    });

    rec.link = link;
    this.#drainQueue(peerId, link);
    return link;
  }

  /** Проигрывает сигналы, пришедшие раньше, чем мы узнали о пире. */
  #drainQueue(peerId: PeerId, link: PeerLink): void {
    const pending = this.#queue.get(peerId);
    if (pending === undefined) return;
    this.#queue.delete(peerId);
    for (const item of pending) {
      if (item.kind === 'signal') void link.handleDescription({ kind: item.type, sdp: item.sdp });
      else void link.handleCandidate(item.candidate);
    }
  }

  #sendSignal(out: SignalOut): void {
    if (out.kind === 'candidate') {
      this.#transport.send({ t: 'candidate', to: out.to, candidate: out.candidate });
    } else {
      this.#transport.send({ t: 'signal', to: out.to, kind: out.kind, sdp: out.sdp });
    }
  }
  /**
   * Очередь ограничена: signaling-сервер не проверяет, существует ли адресат,
   * иначе сообщения для несуществующих пиров копились бы у нас в памяти.
   */
  #queueSignal(peerId: PeerId, item: QueuedSignal): void {
    if (this.#queue.size >= MAX_QUEUED_PEERS) return;
    const list = this.#queue.get(peerId);
    if (list === undefined) {
      this.#queue.set(peerId, [item]);
      return;
    }
    if (list.length < MAX_QUEUED_PER_PEER) list.push(item);
  }

  #emitPeers(): void {
    this.events.emit('peers', this.peers);
  }

  // ─── Отправка данных ─────────────────────────────────────────────────────────

  sendCtrlTo(peerId: PeerId, msg: CtrlMessage): void {
    this.#peers.get(peerId)?.link?.sendCtrlJson(msg);
  }

  broadcastCtrl(msg: CtrlMessage): void {
    for (const rec of this.#peers.values()) {
      if (rec.link?.isReady === true) rec.link.sendCtrlJson(msg);
    }
  }

  broadcastYjsSync(data: Uint8Array): void {
    for (const rec of this.#peers.values()) {
      if (rec.link?.isReady === true) rec.link.sendYjsSync(data);
    }
  }

  sendYjsSyncTo(peerId: PeerId, data: Uint8Array): void {
    this.#peers.get(peerId)?.link?.sendYjsSync(data);
  }

  sendYjsAwarenessTo(peerId: PeerId, data: Uint8Array): void {
    this.#peers.get(peerId)?.link?.sendYjsAwareness(data);
  }

  broadcastYjsAwareness(data: Uint8Array): void {
    for (const rec of this.#peers.values()) {
      if (rec.link?.isReady === true) rec.link.sendYjsAwareness(data);
    }
  }

  async sendFileChunk(peerId: PeerId, transferIdRaw: Uint8Array, offset: number, data: Uint8Array): Promise<void> {
    const link = this.#peers.get(peerId)?.link;
    if (link === undefined || link === null) throw new Error(`нет соединения с пиром ${peerId}`);
    await link.sendFileChunk(transferIdRaw, offset, data);
  }

  waitFileDrained(peerId: PeerId): Promise<void> {
    const link = this.#peers.get(peerId)?.link;
    return link === undefined || link === null ? Promise.resolve() : link.waitFileDrained();
  }

  // ─── RTT ─────────────────────────────────────────────────────────────────────

  #startPing(): void {
    this.#stopPing();
    this.#pingTimer = setInterval(() => this.#pingAll(), this.#pingIntervalMs);
    this.#pingTimer.unref?.();
  }

  #stopPing(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #pingAll(): void {
    if (this.#stopped) return;
    for (const rec of this.#peers.values()) {
      const link = rec.link;
      if (link === null || !link.isReady) continue;
      if (rec.pendingPings.size >= this.#maxPendingPings) continue; // канал забит
      const id = this.#pingSeq++;
      rec.pendingPings.set(id, Date.now());
      link.sendPing(id, Date.now());
    }
  }

  /** Вызывается провайдером при получении `pong`. */
  handlePong(peerId: PeerId, id: number): void {
    const rec = this.#peers.get(peerId);
    if (rec === undefined) return;
    const sentAt = rec.pendingPings.get(id);
    if (sentAt === undefined) return;
    rec.pendingPings.delete(id);
    const rtt = Date.now() - sentAt;
    // Медленно дрейфующее RTT не должно дёргать интерфейс: обновляем только
    // при заметном изменении или первом замере.
    if (rec.rttMs === null || Math.abs(rec.rttMs - rtt) >= 40) {
      rec.rttMs = rtt;
      this.#emitPeers();
    }
  }
}
