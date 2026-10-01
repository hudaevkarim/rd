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
 * ─── Backpressure ────────────────────────────────────────────────────────────
 *
 * По умолчанию буфер мгновенно поглощает всё (`net: 'instant'`), иначе передача
 * файла на 40 КБ превратилась бы в сотни вызовов setTimeout.
 *
 * Но instant-режим принципиально не проверяет код backpressure: при нём
 * `bufferedAmount` всегда 0, `hasCapacity` всегда true, и весь механизм пауз
 * не исполняется ни разу. Из-за этого настоящий баг (передача вставала на живом
 * DataChannel) жил незамеченным при зелёных тестах.
 *
 * Поэтому есть режимы `net: 'throttled' | 'slow'`: очередь реально растёт,
 * `bufferedamountlow` срабатывает СТРОГО по спеке WebRTC, а принимающая сторона
 * может задерживать обработку сообщений. На них и построены тесты передачи.
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

/** Поведение сети в mock-канале. */
export type MockNetMode =
  /** Буфер мгновенно поглощает всё: `bufferedAmount` всегда 0. */
  | 'instant'
  /** Очередь растёт и убывает по тикам, `bufferedamountlow` по спеке. */
  | 'throttled'
  /** То же, но с задержкой доставки сообщений получателю. */
  | 'slow';

export interface MockNetConfig {
  mode?: MockNetMode;
  /** Сколько байт уходит в сеть за тик. Для 'throttled'/'slow'. */
  bytesPerTick?: number;
  /** Задержка обработки входящего сообщения, мс. Для 'slow'. */
  deliverDelayMs?: number;
  /**
   * Полностью остановить слив очереди: канал принимает `send()`, но ничего не
   * отправляет. Моделирует сеть, которая не умерла, а перестала забирать данные
   * (залипший Wi-Fi, ушедшая в фон вкладка) — самый неприятный случай, потому
   * что закрытия канала не происходит.
   *
   * Если заданы `stallLabels`, замирают только перечисленные каналы: ctrl-канал
   * должен продолжать работать, иначе до файла дело не дойдёт.
   */
  stall?: boolean;
  /** Остановить слив только у этих меток каналов. */
  stallLabels?: string[];
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
  /** Буфер отправки: ещё не ушедшие в сеть части кадров. */
  readonly #outQueue: ArrayBuffer[] = [];
  readonly #net: MockNetConfig & { mode: MockNetMode; bytesPerTick: number; deliverDelayMs: number };
  #drainTimer: ReturnType<typeof setTimeout> | null = null;
  /** Накопленный бюджет сети: байты, которые можно отдать в ближайших тиках. */
  #budget = 0;
  /** Пиковая отметка очереди — по ней тесты судят, что backpressure работал. */
  peakBuffered = 0;
  /** Сколько раз сработал `bufferedamountlow`. */
  lowEvents = 0;

  readonly #listeners = new Map<string, Set<Listener>>();
  /**
   * Сообщения, пришедшие ДО того, как получатель навесил обработчик.
   * Настоящий DataChannel буферизует их внутри себя: поток SCTP согласован
   * ещё в SDP, поэтому отправитель может слать сразу после open, а получатель
   * поднимет ondatachannel чуть позже. Без этой буферизации mock терял бы
   * первые кадры рукопожатия — и тест падал бы по причине, которой нет в жизни.
   */
  #inbox: unknown[] = [];

  constructor(
    readonly label: string,
    net?: MockNetConfig,
  ) {
    // Ссылка на объект конфигурации СОХРАНЯЕТСЯ, а не копируется: тесты
    // переключают поведение сети уже после создания каналов (например, «сеть
    // замерла сразу после рукопожатия»). При копировании такие переключения
    // молча не действовали бы, и тест проверял бы не то.
    this.#net = Object.assign(net ?? {}, {
      mode: net?.mode ?? 'instant',
      bytesPerTick: net?.bytesPerTick ?? 64 * 1024,
      deliverDelayMs: net?.deliverDelayMs ?? 0,
    });
  }

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
    if (this.#net.mode === 'instant') {
      target.#inbox.push(copy);
      target.#flushInbox();
      return;
    }

    // Ограниченный канал: кадр копится в буфере отправки и уходит в сеть по
    // тикам. Именно этот рост `bufferedAmount` и создаёт давление на
    // отправителя, которого нет в instant-режиме.
    this.#outQueue.push(copy.slice().buffer as ArrayBuffer);
    // Буфер пересчитывается СРАЗУ: иначе отправитель, показывающий `bufferedAmount`
    // после синхронного send(), увидит ноль и решит, что места сколько угодно.
    // Настоящий канал увеличивает счётчик в том же такте.
    this.#recomputeBuffered();
    this.#drain();
  }

  #recomputeBuffered(): void {
    let sum = 0;
    for (const frame of this.#outQueue) sum += frame.byteLength;
    this.bufferedAmount = sum;
    this.peakBuffered = Math.max(this.peakBuffered, sum);
  }

  /** Один тик сети: часть очереди уходит, при достижении порога — событие. */
  #drain(): void {
    if (this.#drainTimer !== null) return;
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = null;
      if (this.readyState !== 'open') return;
      // Сеть перестала забирать: принимаем кадры в буфер, но не отправляем.
      const stalled =
        this.#net.stall === true ||
        (this.#net.stallLabels?.includes(this.label) ?? false);
      if (stalled) {
        // Продолжаем тикать: когда сеть оживёт, очередь уйдёт сама.
        this.#drain();
        return;
      }
      // Событие по спеке срабатывает при переходе СТРОГО выше порога в
      // «не выше». Проверяем до уменьшения — иначе тест перестанет ловить
      // баг, ради которого этот режим и добавлен.
      const wasAbove = this.bufferedAmount > this.bufferedAmountLowThreshold;
      // Бюджет НАКАПЛИВАЕТСЯ между тиками. Иначе кадр размером больше
      // `bytesPerTick` (а чанк у нас 16 КиБ, бюджет в тестах бывает 1–4 КиБ) не
      // ушёл бы никогда: пришлось бы либо дробить сообщение, либо отправлять
      // кадр целиком мимо лимита. Накопление даёт честную среднюю скорость и не
      // ломает атомарность сообщения.
      this.#budget += this.#net.bytesPerTick;
      while (this.#outQueue.length > 0 && this.#budget > 0) {
        const frame = this.#outQueue[0] as ArrayBuffer;
        // Сообщение DataChannel АТОМАРНО: получатель либо получает кадр целиком,
        // либо не получает ничего. Резать его на куски нельзя — на приёмной
        // стороне окажется обрывок, и протокол будет разбирать мусор.
        // Фрагментация есть внутри SCTP, но приложения она не видна.
        if (this.#budget < frame.byteLength) break;
        this.#budget -= frame.byteLength;
        this.#outQueue.shift();
        this.#deliver(frame);
      }
      this.#recomputeBuffered();
      if (wasAbove && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.lowEvents++;
        this.#emit('bufferedamountlow', undefined as never);
      }
      if (this.#outQueue.length > 0) this.#drain();
    }, 1);
  }

  /** Отдать кадр получателю: с задержкой для режима 'slow'. */
  #deliver(part: ArrayBuffer): void {
    const target = this.#peer;
    if (target === null) return;
    const push = (): void => {
      target.#inbox.push(new Uint8Array(part));
      target.#flushInbox();
    };
    if (this.#net.deliverDelayMs > 0) {
      const timer = setTimeout(push, this.#net.deliverDelayMs);
      timer.unref?.();
    } else {
      push();
    }
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    if (this.#drainTimer !== null) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = null;
    }
    this.#outQueue.length = 0;
    this.#budget = 0;
    this.bufferedAmount = 0;
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
  /** Все созданные DataChannel'ы: тесты проверяют по ним backpressure. */
  channels: MockDataChannel[];
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
  readonly #net: MockNetConfig;
  #sdp = '';
  #closed = false;

  constructor(link: Link, side: 'a' | 'b', net?: MockNetConfig) {
    this.#link = link;
    this.#side = side;
    this.#net = net ?? {};
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
    const mine = new MockDataChannel(label, this.#net);
    const theirs = new MockDataChannel(label, this.#net);
    mine.side = this.#side;
    theirs.side = this.#side === 'a' ? 'b' : 'a';
    mine.link(theirs);
    theirs.link(mine);
    this.#trackChannels(mine, theirs);

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

  /** Сообщить сети о новых каналах — она ведёт список для тестов. */
  #trackChannels(...list: MockDataChannel[]): void {
    this.#link.channels.push(...list);
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
  #link: Link = { a: null, b: null, channels: [], pending: [] };
  #next: 0 | 1 = 0;
  readonly #net: MockNetConfig;
  /** Все созданные каналы: тестам нужны для проверки backpressure. */
  get channels(): MockDataChannel[] {
    return this.#link.channels;
  }

  constructor(net?: MockNetConfig) {
    this.#net = net ?? {};
  }

  readonly factory: RtcFactory = (_config: RtcConfig): RtcPeerConnection => {
    const side = this.#next === 0 ? 'a' : 'b';
    this.#next = this.#next === 0 ? 1 : 0;
    const pc = new MockPeerConnection(this.#link, side, this.#net);
    this.#link[side] = pc;
    return pc;
  };

  get created(): number {
    return (this.#link.a === null ? 0 : 1) + (this.#link.b === null ? 0 : 1);
  }

  /** Каналы с заданной меткой: удобно смотреть буфер именно файлового. */
  channelsLabelled(label: string): MockDataChannel[] {
    return this.channels.filter((c) => c.label === label);
  }

  /** Наибольший пик очереди отправки по всем файловым каналам. */
  peakBuffered(): number {
    return this.channelsLabelled('rd-file').reduce((max, c) => Math.max(max, c.peakBuffered), 0);
  }
}

export { MockDataChannel, MockPeerConnection };
