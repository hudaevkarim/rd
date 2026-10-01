/**
 * PeerLink = одно WebRTC-соединение с одним пиром: два DataChannel, рукопожатие
 * E2EE и perfect negotiation.
 *
 * Раскладка по каналам:
 *   rd-ctrl — рукопожатие, Yjs-синхронизация, presence, чат, управление передачей;
 *   rd-file — только чанки файлов.
 *
 * Почему два канала, а не один: чанк книги в 16 КиБ, отправленных подряд,
 * мгновенно создают очередь на DataChannel. Если в этой же очереди лежит
 * обновление presence или комментарий, оно встанет за десятки мегабайт файла —
 * и пользователь увидит «приложение зависло» в момент, когда кто-то передаёт
 * аудиокнигу. Раздельные каналы решают это на уровне транспорта.
 *
 * Perfect negotiation (паттерн из W3C) нужен для пересогласования: ICE-restart,
 * смена сети, повторное добавление канала. «Вежливый» пир уступает при коллизии
 * предложений, «невежливый» — настаивает. Вежливость определяется сравнением
 * идентификаторов, поэтому обе стороны приходят к одному выводу без координации.
 *
 * Кто создаёт DataChannel: тот, кто отправляет offer. Это не украшение —
 * m-line'ы данных попадают в SDP только у инициатора. В нашей схеме offer
 * отправляет НОВЫЙ участник (сервер отдаёт ему список существующих в `welcome`),
 * поэтому при первичном соединении коллизий не бывает вовсе.
 */

import {
  CHUNK_SIZE,
  encodeCtrl,
  FrameType,
  MAX_CTRL_FRAME_BYTES,
  MAX_FILE_FRAME_BYTES,
  parseCtrl,
  parseHello,
  readFrame,
  uuidFromBytes,
  uuidToBytes,
  type CtrlMessage,
  type IceCandidatePayload,
  type PeerDescriptor,
  type PeerId,
} from '@rd/protocol';
import {
  AeadChannel,
  AeadError,
  PairHandshake,
  type PairKeys,
  type PeerIdentity,
  type PassKey,
} from '@rd/crypto';
import { toHex } from '@rd/crypto';
import { Emitter } from './emitter.js';
import { ChannelSender } from './channel-sender.js';
import type { RtcConfig, RtcDataChannel, RtcFactory, RtcPeerConnection, SessionDescription } from './transport.js';

/** Сколько зашифрованных кадров копим, пока идёт рукопожатие. */
const MAX_PENDING_CTRL_FRAMES = 64;

/**
 * Границы очереди файлового канала.
 *
 * High-water — сколько неподтверждённых байт допустимо держать в канале: 256 КиБ
 * это 16 чанков по 16 КиБ, то есть ровно столько, сколько влезает в окно
 * передачи без риска переполнить получателя.
 *
 * Low-water намеренно вдвое меньше. Между high и low событие `bufferedamountlow`
 * НЕ срабатывает (оно срабатывает только при пересечении самого порога), а
 * ждать следующего чанка приходится именно в этой зоне — следовательно, порог
 * обязан совпадать с low-water, иначе отправитель встанет здесь навсегда.
 */
export const FILE_HIGH_WATER_MARK = 256 * 1024;
export const FILE_LOW_WATER_MARK = 128 * 1024;

export const CTRL_CHANNEL = 'rd-ctrl';
export const FILE_CHANNEL = 'rd-file';

export type LinkState = 'new' | 'negotiating' | 'handshaking' | 'ready' | 'failed' | 'closed';

export type SignalOut =
  | { kind: 'offer' | 'answer'; to: PeerId; sdp: string }
  | { kind: 'candidate'; to: PeerId; candidate: IceCandidatePayload };

export type CtrlPayload =
  | { kind: 'json'; msg: CtrlMessage }
  | { kind: 'yjs-sync'; data: Uint8Array }
  | { kind: 'yjs-awareness'; data: Uint8Array };

export interface LinkEvents extends Record<string, unknown> {
  state: LinkState;
  ctrl: CtrlPayload;
  fileChunk: { transferId: string; offset: number; data: Uint8Array };
  /** Код безопасности — доступен сразу после первой стадии рукопожатия. */
  safety: string;
  warn: { code: string; message: string };
  error: { fatal: boolean; message: string };
}

export interface PeerLinkOptions {
  selfId: PeerId;
  self: PeerIdentity;
  peer: PeerDescriptor;
  roomId: string;
  passKey: PassKey;
  rtc: RtcFactory;
  rtcConfig: RtcConfig;
  signal: (out: SignalOut) => void;
  onTrace?(message: string): void;
}

export class PeerLink {
  readonly peerId: PeerId;
  readonly descriptor: PeerDescriptor;
  /** Вежливый ли пир: при коллизии предложений он уступает. */
  readonly polite: boolean;

  readonly events = new Emitter<LinkEvents>();

  readonly #pc: RtcPeerConnection;
  readonly #handshake: PairHandshake;
  readonly #signal: (out: SignalOut) => void;
  readonly #ctrlOut: ChannelSender;
  readonly #fileOut: ChannelSender;

  #state: LinkState = 'new';
  #ctrlIn: RtcDataChannel | null = null;
  #aeadCtrl: AeadChannel | null = null;
  #aeadFile: AeadChannel | null = null;
  #channelsCreated = false;
  #offerSent = false;
  #stage1Sent = false;
  #stage2Sent = false;
  #makingOffer = false;
  #ignoreOffer = false;
  #closed = false;
  /**
   * Очередь переговоров.
   *
   * `createDataChannel` дважды подряд ставит браузеру событие
   * `negotiationneeded` в очередь задач, а оно срабатывает уже после того, как
   * мы сами начали переговоры в `startAsOfferer`. Без очереди получается
   * параллельный `setLocalDescription` с двумя offer'ами, и Chromium
   * отвергает второй с «The order of m-lines in subsequent offer doesn't match
   * order» — соединение молча не устанавливается. Очередь делает переговоры
   * строго последовательными, что и требуется от SDP-состояния.
   */
  #negotiation: Promise<void> = Promise.resolve();
  /** Сигналы, пришедшие до создания соединения (пир упомянут раньше, чем мы о нём узнали). */
  readonly #pendingCandidates: IceCandidatePayload[] = [];
  /** Зашифрованные кадры, пришедшие до установки ключей: гонка завершения рукопожатия. */
  readonly #pendingCtrl: Uint8Array[] = [];

  constructor(opts: PeerLinkOptions) {
    this.peerId = opts.peer.id;
    this.descriptor = opts.peer;
    this.polite = opts.selfId > opts.peer.id;
    this.#signal = opts.signal;
    this.#handshake = new PairHandshake({
      roomId: opts.roomId,
      self: opts.self,
      passKey: opts.passKey,
    });

    this.#ctrlOut = new ChannelSender(CTRL_CHANNEL, { onTrace: opts.onTrace });
    // Файловый канал — самый чувствительный к backpressure, поэтому пороги
    // задаются явно, а не «как получится».
    this.#fileOut = new ChannelSender(FILE_CHANNEL, {
      highWaterMark: FILE_HIGH_WATER_MARK,
      lowWaterMark: FILE_LOW_WATER_MARK,
      onTrace: opts.onTrace,
    });

    this.#pc = opts.rtc(opts.rtcConfig);
    this.#pc.addEventListener('icecandidate', (ev) => this.#onIceCandidate(ev.candidate));
    this.#pc.addEventListener('datachannel', (ev) => this.#attachChannel(ev.channel));
    this.#pc.addEventListener('connectionstatechange', () => this.#onConnectionState());
    this.#pc.addEventListener('negotiationneeded', () => void this.#negotiate());

    this.#setState('new');
  }

  get state(): LinkState {
    return this.#state;
  }

  get isReady(): boolean {
    return this.#state === 'ready';
  }

  get connectionState(): string {
    return this.#pc.connectionState;
  }

  /**
   * Состояние ICE. Показывается в интерфейсе: «не подключается» — самый
   * частый вопрос пользователя, и без различения «идёт обмен кандидатами»,
   * «соединение установлено, но DTLS не поднялся» и «сеть заблокирована»
   * ответить на него нечем.
   */
  get iceState(): string {
    return this.#pc.iceConnectionState;
  }

  get fileSender(): ChannelSender {
    return this.#fileOut;
  }

  get ctrlSender(): ChannelSender {
    return this.#ctrlOut;
  }

  get aeadStats(): { sealed: number; opened: number; rejected: number } | null {
    const s = this.#aeadCtrl?.stats;
    return s ? { sealed: s.sealed, opened: s.opened, rejected: s.rejected } : null;
  }

  /** Создаёт каналы и отправляет offer. Вызывается только новым участником. */
  async startAsOfferer(): Promise<void> {
    if (this.#closed || this.#offerSent) return;
    this.#offerSent = true;
    this.#ensureChannels();
    // Кандидаты, пришедшие до offer, добавим сразу после него: иначе
    // addIceCandidate упадёт на пустом remoteDescription.
    const flush = this.#flushPendingCandidates();
    await this.#negotiate();
    await flush;
  }

  // ─── Perfect negotiation ─────────────────────────────────────────────────────

  async handleDescription(desc: { kind: 'offer' | 'answer'; sdp: string }): Promise<void> {
    if (this.#closed) return;
    // Сначала даём завершиться собственным переговорам, если они идут прямо
    // сейчас: применять удалённое описание, пока наше ещё не зафиксировано,
    // браузер не даст.
    await this.#negotiation;

    const incoming: SessionDescription = { type: desc.kind, sdp: desc.sdp };

    // Коллизия: мы сами предлагали, ИЛИ уже не в стабильном состоянии.
    const offerCollision =
      desc.kind === 'offer' && (this.#makingOffer || this.#pc.signalingState !== 'stable');
    this.#ignoreOffer = !this.polite && offerCollision;
    if (this.#ignoreOffer) return;

    try {
      await this.#pc.setRemoteDescription(incoming);
      if (desc.kind === 'offer') {
        // Наша сторона — отвечающая, поэтому свои каналы НЕ создаём: их m-line'ы
        // уже пришли в offer, браузер поднимет ondatachannel.
        this.#setState('handshaking');
        await this.#pc.setLocalDescription(await this.#pc.createAnswer());
        const local = this.#pc.localDescription;
        this.#signal({ to: this.peerId, kind: 'answer', sdp: local?.sdp ?? '' });
      }
      await this.#flushPendingCandidates();
    } catch (err) {
      this.#fail(`не удалось применить ${desc.kind}: ${(err as Error).message}`);
    }
  }

  async handleCandidate(candidate: IceCandidatePayload): Promise<void> {
    if (this.#closed) return;
    if (this.#pc.remoteDescription === null) {
      // Кандидат пришёл раньше offer — буферизуем, иначе addIceCandidate упадёт.
      this.#pendingCandidates.push(candidate);
      return;
    }
    try {
      await this.#pc.addIceCandidate(candidate);
    } catch (err) {
      // Во время коллизии ошибки ожидаемы: offer, который мы проигнорировали,
      // мог принести кандидаты, не относящиеся к нашему соединению.
      if (!this.#ignoreOffer) {
        this.#fail(`не удалось добавить ICE-кандидат: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Ставит переговоры в очередь: возвращает промис, который завершится после
   * текущего и всех уже поставленных в очередь.
   */
  #negotiate(): Promise<void> {
    this.#negotiation = this.#negotiation.then(
      () => this.#negotiateOnce(),
      () => this.#negotiateOnce(),
    );
    return this.#negotiation;
  }

  async #negotiateOnce(): Promise<void> {
    if (this.#closed) return;
    // Предлагать имеет смысл только из стабильного состояния: иначе мы либо
    // уже ждём ответа, либо нас перебили входящим offer.
    if (this.#pc.signalingState !== 'stable') return;
    try {
      this.#makingOffer = true;
      this.#setState('negotiating');
      await this.#pc.setLocalDescription(await this.#pc.createOffer());
      const local = this.#pc.localDescription;
      this.#signal({ kind: 'offer', to: this.peerId, sdp: local?.sdp ?? '' });
    } catch (err) {
      this.#fail(`не удалось создать offer: ${(err as Error).message}`);
    } finally {
      this.#makingOffer = false;
    }
  }
  async #flushPendingCandidates(): Promise<void> {
    while (this.#pendingCandidates.length > 0) {
      const cand = this.#pendingCandidates.shift();
      if (cand === undefined) break;
      try {
        await this.#pc.addIceCandidate(cand);
      } catch {
        // Кандидат может оказаться от проигранного offer — это нормально.
      }
    }
  }

  #onIceCandidate(candidate: IceCandidatePayload | null): void {
    if (candidate === null) return; // конец сбора — пересылать нечего
    // Сервер — не почтовый ящик для мусора: relay- и TCP-кандидаты в приватном
    // приложении бесполезны, а трафика и лимитов на них уходит заметно больше,
    // чем от host/srflx.
    if (!/ typ (host|srflx|prflx)\b/.test(candidate.candidate)) return;
    this.#signal({ kind: 'candidate', to: this.peerId, candidate });
  }

  #onConnectionState(): void {
    const state = this.#pc.connectionState;
    if (state === 'failed' || state === 'closed') {
      this.#fail(`соединение ${state}`);
    } else if (state === 'disconnected') {
      // Не рвём сразу: ICE может восстановиться сам за пару секунд.
      this.events.emit('warn', { code: 'ice-disconnected', message: 'связь прервана, ожидаем восстановления' });
    }
  }

  // ─── Каналы и рукопожатие ────────────────────────────────────────────────────

  #ensureChannels(): void {
    if (this.#channelsCreated) return;
    this.#channelsCreated = true;
    // Порядок важен только для читаемости: m-line'ы ctrl и file должны идти
    // в SDP в том же порядке, в котором мы их перечислили.
    this.#attachChannel(this.#pc.createDataChannel(CTRL_CHANNEL, { ordered: true }));
    this.#attachChannel(this.#pc.createDataChannel(FILE_CHANNEL, { ordered: true }));
  }

  #attachChannel(channel: RtcDataChannel): void {
    channel.binaryType = 'arraybuffer';
    if (channel.label === CTRL_CHANNEL) {
      this.#ctrlIn = channel;
      this.#ctrlOut.attach(channel);
      channel.addEventListener('message', (ev) => this.#onCtrlMessage(ev.data));
      channel.addEventListener('open', () => this.#startHandshake());
      // Если канал успел открыться ДО того, как мы навесили обработчик (бывает
      // в моках и при агрессивном кэшировании SDP), событие 'open' уже не
      // придёт — стартуем рукопожатие явно.
      if (channel.readyState === 'open') this.#startHandshake();
    } else if (channel.label === FILE_CHANNEL) {
      this.#fileOut.attach(channel);
      channel.addEventListener('message', (ev) => this.#onFileMessage(ev.data));
    } else {
      // Неизвестный канал от пира закрываем: никаких «на всякий случай».
      channel.close();
      return;
    }
    channel.addEventListener('close', () => {
      if (this.#state !== 'closed' && this.#state !== 'failed') {
        this.#fail('канал закрыт пиром');
      }
    });
  }

  /**
   * Первая стадия E2EE-рукопожатия: публикуем свои ключи и nonce.
   * Отправляется ровно один раз — при появлении первого открытого ctrl-канала.
   * Без этого шага пиры навсегда остаются в состоянии «рукопожатие»: ключи
   * согласовать нечем.
   */
  #startHandshake(): void {
    if (this.#stage1Sent) return;
    this.#stage1Sent = true;
    this.#setState('handshaking');
    this.#sendPlainHello(this.#handshake.stage1);
  }

  #onCtrlMessage(raw: unknown): void {
    void this.#handleCtrl(raw);
  }

  async #handleCtrl(raw: unknown): Promise<void> {
    const bytes = toBytes(raw);
    if (bytes === null) return;
    try {
      const head = readFrame(bytes);

      if (head.type === FrameType.Hello && !head.sealed) {
        await this.#onHello(head.json);
        return;
      }

      // Гонка: пир, который на микросекунды раньше закончил рукопожатие, уже
      // шлёт Yjs-данные, а мы ещё не установили ключи. Рукопожатие идёт в два
      // раунда, поэтому кадры копятся — буферизуем их. Канал надёжный и
      // упорядоченный, так что порядок сохранится.
      if (this.#aeadCtrl === null) {
        if (this.#pendingCtrl.length >= MAX_PENDING_CTRL_FRAMES) {
          this.#fail('слишком много кадров до завершения рукопожатия');
          return;
        }
        this.#pendingCtrl.push(bytes.slice());
        return;
      }

      const opened = await this.#aeadCtrl.open(bytes);
      this.#dispatchCtrl(opened.type, opened.json, opened.body);
    } catch (err) {
      this.#reportFrameError(err);
    }
  }

  #onFileMessage(raw: unknown): void {
    const bytes = toBytes(raw);
    if (bytes === null) return;
    const aead = this.#aeadFile;
    if (aead === null) {
      this.#fail('пришёл зашифрованный чанк до завершения рукопожатия');
      return;
    }
    void aead
      .open(bytes)
      .then((opened) => {
        if (opened.chunk === undefined) {
          this.events.emit('warn', { code: 'unexpected-file-frame', message: 'в файловом канале ожидался CHUNK' });
          return;
        }
        this.events.emit('fileChunk', {
          // Идентификатор приводится к каноническому виду С ДЕФИСАМИ: по нему
          // получатель ищет активную передачу. Без этого файл докачивается, но
          // не собирается: ключи не совпадут.
          transferId: uuidFromBytes(opened.chunk.transferId),
          offset: opened.chunk.offset,
          data: opened.body,
        });
      })
      .catch((err: unknown) => this.#reportFrameError(err));
  }

  async #onHello(json: unknown): Promise<void> {
    const hello = parseHello(json);
    if (hello.x !== this.descriptor.agreeKey || hello.e !== this.descriptor.identityKey) {
      // Ключи из рукопожатия обязаны совпадать с теми, что сервер анонсировал.
      // Расхождение означает подмену прямо в канале.
      throw new AeadError('ключи в рукопожатии не совпадают с анонсированными сервером');
    }

    const keys = await this.#handshake.accept(hello);
    if (keys === null) {
      this.events.emit('safety', await this.#handshake.safetyCode());
      if (!this.#stage2Sent) {
        this.#stage2Sent = true;
        this.#sendPlainHello(await this.#handshake.stage2());
      }
      return;
    }
    this.#installKeys(keys);
  }

  #installKeys(keys: PairKeys): void {
    if (this.#aeadCtrl !== null) return; // уже установлены (повторный stage 2)
    this.#aeadCtrl = new AeadChannel({ send: keys.ctrlSend, recv: keys.ctrlRecv });
    this.#aeadFile = new AeadChannel({ send: keys.fileSend, recv: keys.fileRecv });
    this.#setState('ready');
    this.events.emit('safety', keys.safetyCode);

    // Разбираем всё, что пришло во время рукопожатия. Порядок сохранён.
    const queued = this.#pendingCtrl.splice(0, this.#pendingCtrl.length);
    for (const frame of queued) {
      void this.#aeadCtrl
        .open(frame)
        .then((opened) => this.#dispatchCtrl(opened.type, opened.json, opened.body))
        .catch((err: unknown) => this.#reportFrameError(err));
    }
  }

  #dispatchCtrl(type: number, json: unknown, body: Uint8Array): void {
    switch (type) {
      case FrameType.Json:
        this.events.emit('ctrl', { kind: 'json', msg: parseCtrl(body) });
        return;
      case FrameType.YjsSync:
        this.events.emit('ctrl', { kind: 'yjs-sync', data: body });
        return;
      case FrameType.YjsAwareness:
        this.events.emit('ctrl', { kind: 'yjs-awareness', data: body });
        return;
      default:
        // Неизвестный тип в защищённом канале — это баг обеих сторон, но
        // рвать соединение из-за него нельзя: это DoS-вектор.
        this.events.emit('warn', { code: 'unknown-frame', message: `неизвестный тип кадра ${type}` });
    }
  }

  #sendPlainHello(payload: unknown): void {
    if (this.#ctrlOut.closed) return;
    this.#ctrlOut.send(AeadChannel.plainJson(FrameType.Hello, payload));
  }

  // ─── Отправка ────────────────────────────────────────────────────────────────

  /**
   * Управляющее сообщение (чат, файл-оффер, понги) уходит в ЗАШИФРОВАННОЕ тело.
   *
   * Это не украшение: заголовок кадра передаётся открытым (он нужен как AAD, и
   * шифровать его нельзя — AEAD требует AAD до шифрования). Если положить
   * сообщение в заголовок, весь чат комнаты утечёт в открытом виде прямо в
   * DataChannel, и шифрование окажется декоративным.
   */
  sendCtrlJson(msg: CtrlMessage): void {
    void this.#sealAndSend(this.#aeadCtrl as AeadChannel, this.#ctrlOut, FrameType.Json, encodeCtrl(msg));
  }

  /**
   * Подтверждение приёма чанков. Отдельный метод, а не поле в `sendCtrlJson`,
   * потому что именно этот тип сообщений отправляется пачками: сливать его с
   * чатом нельзя — на забитом ctrl-канале подтверждения встают в очередь за
   * сообщениями и передача файла зависает, хотя файл-канал свободен.
   */
  sendFileAck(transferIdRaw: Uint8Array, offset: number): void {
    const aead = this.#aeadCtrl;
    if (aead === null || this.#state !== 'ready') return;
    void this.#sealAndSend(
      aead,
      this.#ctrlOut,
      FrameType.Json,
      encodeCtrl({ k: 'file-ack', transferId: uuidFromBytes(transferIdRaw), offset }),
    );
  }

  sendYjsSync(data: Uint8Array): void {
    this.#requireReady();
    void this.#sealAndSend(this.#aeadCtrl as AeadChannel, this.#ctrlOut, FrameType.YjsSync, data);
  }

  sendYjsAwareness(data: Uint8Array): void {
    this.#requireReady();
    void this.#sealAndSend(this.#aeadCtrl as AeadChannel, this.#ctrlOut, FrameType.YjsAwareness, data);
  }

  /** Пингуем даже до завершения рукопожатия: это полезно для измерения задержки. */
  sendPing(id: number, at: number): void {
    if (this.#state !== 'ready') return;
    this.sendCtrlJson({ k: 'ping', id, at });
  }

  async sendFileChunk(transferIdRaw: Uint8Array, offset: number, data: Uint8Array): Promise<void> {
    const aead = this.#aeadFile;
    if (aead === null || this.#state !== 'ready') throw new Error('канал файлов не готов');
    const frame = await aead.sealChunk(transferIdRaw, offset, data);
    if (frame.length > MAX_FILE_FRAME_BYTES) {
      throw new Error(`кадр файла ${frame.length} байт превышает лимит ${MAX_FILE_FRAME_BYTES}`);
    }
    this.#fileOut.send(frame);
  }

  /** Есть ли место в очереди файлового канала прямо сейчас. */
  get hasFileCapacity(): boolean {
    return this.#fileOut.hasCapacity;
  }

  /**
   * Ждёт места в очереди файлового канала. Основа backpressure передачи файла.
   * @returns false по таймауту или при закрытии — вызывающий обязан это учесть.
   */
  waitFileCapacity(timeoutMs: number, reason = ''): Promise<boolean> {
    return this.#fileOut.waitForCapacity(timeoutMs, reason);
  }

  get fileBuffer(): { buffered: number; queued: number; high: number; low: number; waits: number } {
    return this.#fileOut.stats;
  }

  async #sealAndSend(aead: AeadChannel, out: ChannelSender, type: number, body: Uint8Array): Promise<void> {
    try {
      // Тип кадра идёт в открытый заголовок, содержимое — в зашифрованное тело.
      // JSON в заголовке не кладём принципиально: заголовок виден всем.
      const frame = await aead.sealBody(type, body);
      if (frame.length > MAX_CTRL_FRAME_BYTES) {
        this.events.emit('warn', { code: 'frame-too-large', message: 'кадр превысил лимит, разрываем' });
        this.#fail('кадр слишком велик');
        return;
      }
      out.send(frame);
    } catch (err) {
      this.#reportFrameError(err);
    }
  }

  #requireReady(): void {
    if (this.#state === 'ready') return;
    throw new Error(`соединение с пиром ${this.peerId} не готово (состояние ${this.#state})`);
  }

  #reportFrameError(err: unknown): void {
    if (err instanceof AeadError) {
      // Ошибка AEAD почти всегда означает чужой или повреждённый кадр.
      // Соединение закрываем: доверять потоку дальше нельзя.
      this.#fail(`кадр не прошёл проверку: ${err.message}`);
      return;
    }
    this.events.emit('error', { fatal: false, message: (err as Error).message });
  }

  #fail(reason: string): void {
    if (this.#state === 'closed' || this.#state === 'failed') return;
    this.#setState('failed');
    this.events.emit('error', { fatal: true, message: reason });
    this.close();
  }

  #setState(state: LinkState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.events.emit('state', state);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#setState('closed');
    this.#ctrlOut.close();
    this.#fileOut.close();
    this.#pc.close();
    this.events.clear();
  }
}

function toBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
  }
  return null;
}

export { CHUNK_SIZE, MAX_FILE_FRAME_BYTES };