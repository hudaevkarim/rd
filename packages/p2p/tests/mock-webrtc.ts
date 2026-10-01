/**
 * In-memory реализация WebRTC для тестов.
 *
 * Это не «заглушка», а полноценный loopback: две RTCPeerConnection соединяются
 * напрямую, DataChannel'ы действительно доставляют сообщения асинхронно,
 * signalingState меняется по правилам, ICE-кандидаты порождаются. Благодаря
 * этому тестами покрывается весь протокол целиком — рукопожатие, AEAD,
 * синхронизация Yjs, передача файлов с докачкой — без браузера и без сети.
 *
 * Что намеренно НЕ моделируется (и почему это не страшно для тестов):
 *   - реальный ICE (STUN/TURN, NAT-траверс) — не наша логика, её проверяет
 *     только браузер;
 *   - реальный SCTP с фрагментацией и переупорядочиванием — порядок доставки
 *     здесь гарантирован, как и в реальном канале (мы его открываем ordered);
 *   - потери пакетов — для этого есть отдельные тесты с ручной сборкой кадров.
 *
 * Backpressure моделируется нулевым bufferedAmount: иначе передача файла на
 * 40 КБ превратилась бы в 40 вызовов setTimeout. Сама логика пауз проверяется
 * отдельным тестом ChannelSender с подставным каналом.
 */

import type {
  ChannelReadyState,
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

type Listener = (ev: never) => void;



function toBytes(data: ArrayBufferView | ArrayBuffer | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
}

class MockDataChannel implements RtcDataChannel {
  readyState: ChannelReadyState = 'connecting';
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly maxMessageSize = 262_144;
  /** Сторона-владелец: помогает отличать свои каналы от чужих при разборе тестов. */
  side: 'a' | 'b' = 'a';

  #peer: MockDataChannel | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();
  /**
   * Сообщения, пришедшие ДО того, как получатель навесил обработчик.
   * Настоящий DataChannel буферизует их внутри себя: поток SCTP согласован
   * ещё в SDP, поэтому отправитель может слать сразу после open, а получатель
   * поднимет ondatachannel чуть позже. Без этой буферизации mock терял бы
   * первые кадры рукопожатия — и тест падал бы по причине, которой нет в жизни.
   */
  #inbox: unknown[] = [];

  constructor(readonly label: string) {}

  link(peer: MockDataChannel): void {
    this.#peer = peer;
  }

  send(data: ArrayBufferView | ArrayBuffer | string): void {
    if (this.readyState !== 'open') {
      // Так же ведёт себя настоящий браузер: отправка в неоткрытый канал — ошибка.
      throw new Error(`DataChannel ${this.label}: попытка отправки в состоянии ${this.readyState}`);
    }
    // Копия: отправитель вправе переиспользовать свой буфер сразу после send().
    const copy = toBytes(data);
    const target = this.#peer;
    if (target === null) return;

    // Настоящий DataChannel не выбрасывает сообщение, если канал получателя ещё
    // не открыт или получатель не успел навесить обработчик: поток SCTP уже
    // согласован в SDP, данные копятся внутри. Повторяем это поведение, иначе
    // mock теряет первые кадры рукопожатия по причине, которой нет в жизни.
    target.#inbox.push(copy);
    target.#flushInbox();
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.#emit('close', undefined as never);
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
    if (type === 'message') this.#flushInbox();
  }

  removeEventListener(type: string, cb: Listener): void {
    this.#listeners.get(type)?.delete(cb);
  }

  #hasListener(type: string): boolean {
    return (this.#listeners.get(type)?.size ?? 0) > 0;
  }

  /** Отдаёт накопленное, сохраняя порядок, как только канал готов. */
  #flushInbox(): void {
    if (this.#inbox.length === 0) return;
    if (this.readyState !== 'open' || !this.#hasListener('message')) return;
    const queued = this.#inbox.splice(0, this.#inbox.length);
    queueMicrotask(() => {
      for (const data of queued) {
        if (this.readyState !== 'open') return;
        this.#emit('message', { data } as never);
      }
    });
  }

  #emit(type: string, ev: unknown): void {
    for (const cb of [...(this.#listeners.get(type) ?? [])]) {
      (cb as unknown as (e: unknown) => void)(ev);
    }
  }

  /** Открываем канал изнутри теста, чтобы проверить очередь ChannelSender. */
  openLater(delayTicks = 2): void {
    let ticks = delayTicks;
    const step = (): void => {
      if (ticks-- > 0) {
        setTimeout(step, 0);
        return;
      }
      this.readyState = 'open';
      this.#emit('open', undefined as never);
      this.#flushInbox();
    };
    setTimeout(step, 0);
  }
}

interface Link {
  a: MockPeerConnection | null;
  b: MockPeerConnection | null;
  /**
   * Каналы, созданные одной стороной ДО того, как другая сторона появилась.
   * В реальном WebRTC такого не бывает (обе стороны существуют с начала
   * соединения), но в тесте порядок создания PeerConnection определяется тем,
   * кто первым обработал `welcome`, поэтому канал может «опередить» вторую
   * сторону. Держим их и отдаём, как только вторая сторона появится.
   */
  pending: Array<{ owner: 'a' | 'b'; channel: MockDataChannel }>;
}

let sdpCounter = 0;

class MockPeerConnection implements RtcPeerConnection {
  localDescription: SessionDescription | null = null;
  remoteDescription: SessionDescription | null = null;
  signalingState: SignalingState = 'stable';
  connectionState: ConnectionState = 'new';
  iceConnectionState: IceState = 'new';

  readonly #link: Link;
  readonly #side: 'a' | 'b';
  readonly #listeners = new Map<string, Set<Listener>>();
  #sdp = '';
  #closed = false;

  constructor(link: Link, side: 'a' | 'b') {
    this.#link = link;
    this.#side = side;
    this.#link[side] = this;
    // Отдаём каналы, которые создала другая сторона раньше нас.
    const waiting = this.#link.pending.filter((item) => item.owner !== side);
    this.#link.pending = this.#link.pending.filter((item) => item.owner === side);
    for (const item of waiting) {
      setTimeout(() => {
        if (this.#closed) return;
        this.#emit('datachannel', { channel: item.channel } as never);
      }, 0);
    }
  }

  createDataChannel(label: string): RtcDataChannel {
    const mine = new MockDataChannel(label);
    const theirs = new MockDataChannel(label);
    mine.side = this.#side;
    theirs.side = this.#side === 'a' ? 'b' : 'a';
    mine.link(theirs);
    theirs.link(mine);

    mine.openLater();
    theirs.openLater();

    const remote = this.#link[this.#side === 'a' ? 'b' : 'a'];
    if (remote === null) {
      // Вторая сторона ещё не создана — отложим доставку.
      this.#link.pending.push({ owner: this.#side, channel: theirs });
    } else {
      // Настоящий браузер поднимает ondatachannel у ОТВЕТЧИКА, когда тот
      // обработал offer. Отдаём канал с задержкой в один тик — этого хватает,
      // чтобы PeerLink успел навесить обработчики после setRemoteDescription.
      setTimeout(() => {
        if (this.#closed) return;
        remote.#emit('datachannel', { channel: theirs } as never);
      }, 0);
    }

    return mine;
  }

  async createOffer(): Promise<SessionDescription> {
    // SDP помечаем числом каналов: реальный формат тут не важен, важна
    // неизменность между offer/answer.
    this.#sdp = `v=0\r\no=- ${sdpCounter++} 2 IN IP4 127.0.0.1\r\nm=application 9 DTLS/SCTP webrtc-datachannel\r\n`;
    return { type: 'offer', sdp: this.#sdp };
  }

  async createAnswer(): Promise<SessionDescription> {
    this.#sdp = `v=0\r\no=- ${sdpCounter++} 2 IN IP4 127.0.0.1\r\nm=application 9 DTLS/SCTP webrtc-datachannel\r\n`;
    return { type: 'answer', sdp: this.#sdp };
  }

  async setLocalDescription(desc: SessionDescription): Promise<void> {
    this.localDescription = desc;
    this.#setSignaling(desc.type);
    if (desc.type === 'offer' || desc.type === 'answer') this.#emitIceCandidate();
  }

  async setRemoteDescription(desc: SessionDescription): Promise<void> {
    this.remoteDescription = desc;
    this.#setSignaling(desc.type);
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
  }

  async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
    if (typeof candidate.candidate !== 'string' || candidate.candidate === '') {
      throw new Error('пустой ICE-кандидат');
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    this.signalingState = 'closed';
    this.#emit('connectionstatechange', undefined as never);
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.#listeners.get(type)?.delete(cb);
  }

  #setSignaling(type: SessionDescriptionType): void {
    if (type === 'offer') this.signalingState = 'have-local-offer';
    else if (type === 'answer') this.signalingState = 'stable';
  }

  #emitIceCandidate(): void {
    setTimeout(() => {
      if (this.#closed) return;
      this.#emit('icecandidate', {
        candidate: {
          candidate: 'candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      } as never);
    }, 0);
  }

  #emit(type: string, ev: unknown): void {
    for (const cb of [...(this.#listeners.get(type) ?? [])]) {
      (cb as unknown as (e: unknown) => void)(ev);
    }
  }
}

/**
 * Фабрика, выдающая связанные между собой соединения.
 * Первый вызов создаёт сторону A, второй — сторону B, третий и далее снова A:
 * этого достаточно, чтобы в одном тесте смоделировать сразу две комнаты.
 */
export class MockRtcNetwork {
  #link: Link = { a: null, b: null, pending: [] };
  #next: 0 | 1 = 0;

  readonly factory: RtcFactory = (_config: RtcConfig): RtcPeerConnection => {
    const side = this.#next === 0 ? 'a' : 'b';
    this.#next = this.#next === 0 ? 1 : 0;
    const pc = new MockPeerConnection(this.#link, side);
    this.#link[side] = pc;
    return pc;
  };

  get created(): number {
    return (this.#link.a === null ? 0 : 1) + (this.#link.b === null ? 0 : 1);
  }
}

export { MockDataChannel, MockPeerConnection };
