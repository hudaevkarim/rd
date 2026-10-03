/**
 * In-memory WebRTC для произвольного числа участников.
 *
 * ─── Зачем рядом с `MockRtcNetwork` ────────────────────────────────────────────
 *
 * `MockRtcNetwork` держит ровно две стороны соединения — этого хватало, пока
 * топология была mesh из двух пиров. Star-топология с relay требует, чтобы
 * подключений было много: relay соединяется с каждым листом, значит в одном
 * тесте живут три и более `RTCPeerConnection` одновременно.
 *
 * Переписывать проверенную сеть было бы рискованно: на ней держатся десятки
 * существующих тестов, включая проверку backpressure. Поэтому здесь новая,
 * независимая реализация, а `MockRtcNetwork` остаётся нетронутой.
 *
 * ─── Как устроено спаривание ──────────────────────────────────────────────────
 *
 * Настоящий браузер знает адресата из signaling. Mock знает только описание
 * (SDP), поэтому сопоставление сделано по симметрии offer/answer:
 *
 *   1. `setLocalDescription(offer)` кладёт offer в очередь ткани;
 *   2. `setRemoteDescription(offer)` находит offer по строке SDP и соединяет
 *      его владельца с вызывающим;
 *   3. `setLocalDescription(answer)` уходит владельцу найденного offer.
 *
 * Для произвольной топологии этого достаточно: адресат всегда отвечает на
 * конкретный offer, поэтому неоднозначности не возникает даже при десятке
 * одновременных предложений.
 */

import type {
  ConnectionState,
  IceState,
  RtcConfig,
  RtcDataChannel,
  RtcFactory,
  RtcPeerConnection,
  SessionDescription,
  SessionDescriptionType,
  SignalingState,
} from '@rd/p2p';
import type { IceCandidatePayload } from '@rd/protocol';
import { MockDataChannel, type MockNetConfig } from './mock-webrtc.js';

type Listener = (ev: never) => void;

interface PendingOffer {
  owner: FabricPeer;
  sdp: string;
}

interface Pairing {
  a: FabricPeer;
  b: FabricPeer;
}

/** Ткань: держит всех участников и соединяет их попарно по offer/answer. */
export class MockRtcFabric {
  readonly #net: MockNetConfig;
  readonly #peers: FabricPeer[] = [];
  #pending: PendingOffer[] = [];
  readonly #pairs = new Set<Pairing>();
  #seq = 0;

  constructor(net?: MockNetConfig) {
    this.#net = net ?? {};
  }

  /** Фабрика для передачи в `RoomSession.create({ rtc })`. */
  readonly factory: RtcFactory = (_config: RtcConfig): RtcPeerConnection => {
    const peer = new FabricPeer(this, this.#net);
    this.#peers.push(peer);
    return peer;
  };

  get created(): number {
    return this.#peers.length;
  }

  /** Сколько соединений (пар) действительно установлено. */
  get pairCount(): number {
    return this.#pairs.size;
  }

  /** Все каналы всех соединений — тестам нужно для проверки backpressure. */
  channels(): MockDataChannel[] {
    const out: MockDataChannel[] = [];
    for (const pair of this.#pairs) {
      for (const ch of pair.a.outgoing) out.push(ch);
    }
    return out;
  }

  register(peer: FabricPeer): void {
    if (!this.#peers.includes(peer)) this.#peers.push(peer);
  }

  /** Offer ждёт, пока на него ответят. */
  postOffer(owner: FabricPeer, sdp: string): void {
    this.#pending.push({ owner, sdp });
  }

  /**
   * Кто прислал этот offer. Возвращает null, если описание не наше — в mock
   * такого быть не должно, и это лучше видно в тесте, чем молчаливое игнорирование.
   */
  findOffer(sdp: string): PendingOffer | null {
    for (const item of this.#pending) if (item.sdp === sdp) return item;
    return null;
  }

  dropOffer(offer: PendingOffer): void {
    const at = this.#pending.indexOf(offer);
    if (at >= 0) this.#pending.splice(at, 1);
  }

  /**
   * Устанавливает remote description у отвечающей стороны.
   *
   * Здесь и происходит соединение: обе стороны получают по каналу на каждое
   * `createDataChannel` отправителя, а у отвечающего дополнительно приходит
   * событие `datachannel` — как в настоящем браузере.
   *
   * Возвращается именно та пара, к которой относится принятый offer. Это
   * принципиально: у пира может быть несколько соединений одновременно, и
   * ответ уходит тому, чьё предложение было принято, — а не «первому попавшемуся».
   */
  acceptRemote(answerer: FabricPeer, sdp: string): Pairing {
    const offer = this.findOffer(sdp);
    if (offer === null) throw new Error('ткань: предложение не найдено');
    this.dropOffer(offer);
    const offerer = offer.owner;

    const pair: Pairing = { a: offerer, b: answerer };
    this.#pairs.add(pair);
    offerer.connect(pair);
    answerer.connect(pair);
    return pair;
  }

  /** Соединение больше не существует: каналы закрываются с обеих сторон. */
  dropPair(pair: Pairing): void {
    this.#pairs.delete(pair);
  }

  nextToken(): number {
    return this.#seq++;
  }
}

/** Участник ткани: пара RTCPeerConnection. */
class FabricPeer implements RtcPeerConnection {
  localDescription: SessionDescription | null = null;
  remoteDescription: SessionDescription | null = null;
  connectionState: ConnectionState = 'new';
  iceConnectionState: IceState = 'new';

  /** Каналы, созданные ЭТИМ пиром: его экземпляр и встречный экземпляр. */
  readonly outgoing: MockDataChannel[] = [];
  /** Встречные экземпляры — их получает партнёр через `datachannel`. */
  readonly mirrors: MockDataChannel[] = [];
  #incoming: MockDataChannel[] = [];
  #pair: Pairing | null = null;
  /**
   * Пара, к которой относится принятый нами offer.
   *
   * Ответ уходит именно ей. Искать пару «ту, что с этим пиром» нельзя: в
   * star-топологии у relay одновременно несколько соединений, и первый
   * попавшийся в переборе был бы не тем — рукопожатие зависало бы навсегда.
   */
  #answeringPair: Pairing | null = null;

  readonly #listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly fabric: MockRtcFabric,
    readonly net: MockNetConfig,
  ) {
    fabric.register(this);
  }

  get signalingState(): SignalingState {
    if (this.connectionState === 'closed') return 'closed';
    if (this.#answeringPair !== null) return 'have-local-offer';
    if (this.remoteDescription !== null && this.localDescription === null) return 'have-remote-offer';
    return 'stable';
  }

  /**
   * Канал создаётся сразу и сразу же открывается — вместе со встречной
   * стороной, до того как состоялось соединение.
   *
   * Так же устроен и настоящий DataChannel: он существует и переносит данные с
   * момента создания, а разрыв приходит только при закрытии. Соединение влияет
   * лишь на то, КОГДА партнёр узнает о канале через `datachannel`. Если бы канал
   * появлялся только при спаривании, рукопожатие не началось бы: партнёр ещё не
   * знает о канале, а инициатор уже ждёт ответа в нём.
   */
  createDataChannel(label: string): RtcDataChannel {
    const mine = new MockDataChannel(label, this.net);
    const theirs = new MockDataChannel(label, this.net);
    mine.link(theirs);
    theirs.link(mine);
    mine.openLater();
    theirs.openLater();
    this.outgoing.push(mine);
    this.mirrors.push(theirs);
    return mine;
  }

  async createOffer(): Promise<SessionDescription> {
    return { type: 'offer', sdp: `offer:${this.fabric.nextToken()}` };
  }

  async createAnswer(): Promise<SessionDescription> {
    return { type: 'answer', sdp: `answer:${this.fabric.nextToken()}` };
  }

  async setLocalDescription(desc: SessionDescription): Promise<void> {
    this.localDescription = desc;
    if (desc.type === 'offer' && desc.sdp !== undefined) {
      // ICE-кандидат порождается сразу, как и в настоящемPeerConnection:
      // сигналинг должен успеть переслать его вместе с offer.
      queueMicrotask(() => {
        this.#emit('icecandidate', {
          candidate: {
            candidate: 'candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0,
          },
        });
      });
      this.fabric.postOffer(this, desc.sdp);
      return;
    }
    if (desc.type === 'answer' && desc.sdp !== undefined) {
      // Ответ адресуется владельцу принятого нами предложения, а не «первому
      // попавшемуся соединению».
      const pair = this.#answeringPair;
      if (pair === null) throw new Error('ткань: ответ без принятого предложения');
      pair.a.receiveAnswer(desc.sdp);
      this.#answeringPair = null;
    }
  }

  async setRemoteDescription(desc: SessionDescription): Promise<void> {
    this.remoteDescription = desc;
    if (desc.type === 'offer' && desc.sdp !== undefined) {
      this.#answeringPair = this.fabric.acceptRemote(this, desc.sdp);
    }
  }

  async addIceCandidate(_candidate: IceCandidatePayload): Promise<void> {
    // Кандидаты не моделируются: в mock единственный «маршрут» — прямая связь.
  }

  close(): void {
    const pair = this.#pair;
    if (pair === null) return;
    for (const ch of this.outgoing) ch.close();
    for (const ch of this.#incoming) ch.close();
    this.fabric.dropPair(pair);
    this.#pair = null;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    this.#emit('connectionstatechange');
  }

  /**
   * Соединение установлено.
   *
   * Каналы создаёт ТОЛЬКО инициатор (`createDataChannel` вызывает он), поэтому
   * встречные каналы и событие `datachannel` достаются ПАРТНЁРУ — ровно так же,
   * как в браузере. Если отдать их инициатору, тот получит событие о каналах,
   * которых не создавал, и в тестах появились бы каналы-призраки.
   */
  connect(pair: Pairing): void {
    this.#pair = pair;
    const partner = pair.a === this ? pair.b : pair.a;
    // Каналы создал инициатор; партнёр получает встречные экземпляры.
    for (const mirror of this.mirrors) {
      partner.#incoming.push(mirror);
      setTimeout(() => partner.#emit('datachannel', { channel: mirror }), 0);
    }
    this.connectionState = 'connected';
    this.iceConnectionState = 'completed';
    this.#emit('connectionstatechange');
  }

  receiveAnswer(sdp: string): void {
    this.remoteDescription = { type: 'answer', sdp };
    this.connectionState = 'connected';
    this.iceConnectionState = 'completed';
    this.#emit('connectionstatechange');
  }

  addEventListener(type: string, cb: Listener): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)?.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.#listeners.get(type)?.delete(cb);
  }

  #emit(type: string, ev?: unknown): void {
    for (const cb of [...(this.#listeners.get(type) ?? [])]) {
      (cb as unknown as (e: unknown) => void)(ev);
    }
  }
}