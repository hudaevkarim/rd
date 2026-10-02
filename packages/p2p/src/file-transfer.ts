/**
 * Передача файлов (книги, аудио) по WebRTC Data Channel, чанками с докачкой.
 *
 * Потоковая модель: файл НИКОГДА не читается целиком в память. Отправитель
 * делает `source.slice(offset, offset + CHUNK_SIZE)`, получатель пишет куски в
 * свой Blob-источник. Для аудиокниги на 800 МБ пиковая память остаётся порядка
 * размера одного чанка.
 *
 * Контрольная сумма. SHA-256 от всего файла требует держать файл в памяти, а
 * `crypto.subtle.digest` вообще не умеет инкрементально. Поэтому используется
 * составная: `root = SHA-256( SHA-256(chunk₀) ‖ SHA-256(chunk₁) ‖ … )`.
 * Обе стороны считают её одинаково, проверка стриминговая, а побайтовый
 * перебор (нужный для сравнения с «эталонной» копией) невозможен.
 *
 * Backpressure. `mesh.waitFileDrained(peerId)` ждёт, пока SCTP-очередь
 * опустеет. Без этого отправитель залил бы в канал весь файл за секунду и
 * «съел» бы память получателя.
 *
 * Докачка. Получатель, у которого уже есть частичный файл с тем же transferId,
 * отвечает `file-resume {offset}` вместо `file-accept`, и отправитель
 * продолжает с нужного места. Это то, что нужно при обрыве связи на середине
 * аудиокниги.
 */

import {
  CHUNK_SIZE,
  uuidToBytes,
  type CtrlMessage,
  type FileOffer,
  type PeerId,
  newId,
} from '@rd/protocol';
import { sha256, toHex, concat } from '@rd/crypto';
import { Emitter } from './emitter.js';
import type { RoomMesh } from './room-mesh.js';

/** Префикс идентификатора для журнала: полные UUID нечитаемы в логе. */
function short(id: string): string {
  return id.slice(0, 8);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Источник файла: умеет отдать кусок, не читая файл целиком. */
export interface TransferSource {
  readonly size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
}

/**
 * Приёмник файла: пишет куски в постоянное хранилище.
 *
 * `hashes()` нужен для докачки. Контрольная сумма файла считается как
 * SHA-256 от конкатенации хешей чанков, поэтому после обрыва получатель
 * обязан помнить хеши уже принятых кусков — иначе проверить целостность
 * собранного файла невозможно. Хранение хешей стоит 32 байта на 16 КиБ
 * (0.2 % от файла) и экономит повторную передачу мегабайтов.
 */
export interface TransferSink {
  /** Сколько байт уже принято. */
  readonly received: number;
  /** Хеши принятых чанков в порядке следования. */
  hashes(): Promise<Uint8Array[]>;
  write(offset: number, data: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface FileTransferEvents extends Record<string, unknown> {
  /** Пришло предложение файла. UI решает, показывать ли вопрос пользователю. */
  incoming: { from: PeerId; offer: FileOffer };
  progress: { transferId: string; peerId: PeerId; done: number; total: number; direction: 'in' | 'out' };
  complete: { transferId: string; offer: FileOffer; direction: 'in' | 'out' };
  error: { transferId: string; message: string };
  /** Отправитель закончил, получатель подтвердил контрольную сумму. */
  verified: { transferId: string; root: string };
}

export interface FileTransferOptions {
  mesh: RoomMesh;
  chunkSize?: number;
  /** Создаёт приёмник для входящего файла. null — принять нельзя. */
  createSink(offer: FileOffer, from: PeerId): Promise<TransferSink | null>;
  /** Есть ли у нас локальная копия с тем же transferId и ненулевым объёмом. */
  findPartial(offer: FileOffer): Promise<number>;
  /** Отправитель хочет отправить файл. */
  resolveSource(transferId: string): Promise<{ offer: FileOffer; source: TransferSource } | null>;
  /** Пользователь разрешил/запретил. null — спросить в UI. */
  autoAccept?(offer: FileOffer, from: PeerId): Promise<boolean>;
  /** Краткие события для интерфейса: показываются пользователю. */
  onLog?(message: string): void;
  /**
   * Подробный журнал передачи.
   *
   * Разделение с `onLog` неформальное: `onLog` идёт в UI, поэтому туда попадают
   * только события, которые стоит показать человеку, а сюда — весь ход передачи:
   * номера чанков, размер буфера, паузы, таймауты подтверждений. Именно эти
   * строки нужны, чтобы понять, на каком чанке передача встала.
   */
  onTrace?(message: string): void;
  /** Окно передачи в байтах. По умолчанию DEFAULT_WINDOW_BYTES. */
  windowBytes?: number;
  /** Таймаут ожидания места в буфере. По умолчанию CAPACITY_TIMEOUT_MS. */
  capacityTimeoutMs?: number;
  /** Таймаут ожидания ACK. По умолчанию ACK_TIMEOUT_MS. */
  ackTimeoutMs?: number;
}

interface SendJob {
  offer: FileOffer;
  source: TransferSource;
  peers: Set<PeerId>;
  sentTo: Set<PeerId>;
  cancelled: boolean;
  /**
   * Запрошенная докачка: смещение, с которого пир хочет продолжить.
   *
   * Насос на пару должен быть ровно один. Если бы запрос докачки начинал новый
   * цикл отправки поверх идущего, два цикла отправляли бы чанки вперемешку, и
   * получатель видел бы «перепрыгивание» смещений — то самое, из-за которого он
   * и просит докачку. Получается петля: запрос → новый цикл → рассинхрон →
   * запрос → … Поток один, а смещение меняет.
   */
  resumeAt: number | null;
  /** Идёт ли сейчас отправка этой паре. */
  pumping: boolean;
}

interface ReceiveJob {
  offer: FileOffer;
  from: PeerId;
  sink: TransferSink;
  rootParts: Uint8Array[];
  expectedNext: number;
}

const OFFER_TIMEOUT_MS = 60_000;
const MAX_INCOMING_CHUNKS_BEFORE_ACCEPT = 4;

export class FileTransferManager {
  readonly events = new Emitter<FileTransferEvents>();
  readonly #opts: FileTransferOptions;
  readonly #chunkSize: number;
  readonly #windowBytes: number;
  readonly #capacityTimeoutMs: number;
  readonly #ackTimeoutMs: number;
  /** Кто и сколько подтвердил: нужно, чтобы знать, можно ли двигать окно. */
  readonly #acked = new Map<string, Map<PeerId, number>>();
  /** Передачи, о которых уже сообщили об ошибке: не даём повторять сообщение. */
  readonly #failed = new Set<string>();
  readonly #sending = new Map<string, SendJob>();
  readonly #receiving = new Map<string, ReceiveJob>();
  /** Пиры, уже подтвердившие получение. */
  readonly #accepted = new Map<string, Set<PeerId>>();
  /**
   * Пиры, подтвердившие, что файл у них целиком (пришло `file-finish`).
   *
   * Отдельные от `#accepted`, и это принципиально. Согласие на приём — это
   * «я готов», а не «я получил»: между ними файл ещё летит, и получатель в
   * любой момент может обнаружить нехватку данных и попросить докачку.
   *
   * Раньше задача удалялась по `#accepted`, то есть сразу после того, как все
   * согласились. Докачка после этого приходила в `#sending.get(...)` и
   * молча игнорировалась (`job === undefined` → `return`), а получатель тем
   * временем ждал недостающий кусок вечно: ни ошибки, ни прогресса, ни конца.
   */
  readonly #verified = new Map<string, Set<PeerId>>();
  readonly #offerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #unsubscribe: Array<() => void> = [];
  /**
   * Менеджер остановлен (пользователь вышел из комнаты).
   *
   * Отдельный флаг, а не проверка `this.#sending.size === 0`: у отправки есть
   * окно, и пока файл качается, задача жива. При выходе из комнаты цикл отправки
   * просыпался уже на разорванном канале, `send()` бросал исключение, и
   * пользователь получал ошибку «передача прервана» в момент, когда он сам
   * выходил. Ошибки не было бы, если бы цикл заметил остановку до отправки.
   */
  #stopped = false;
  /**
   * Очередь обработки входящих чанков.
   *
   * Обработка каждого чанка асинхронна: запись в IndexedDB и вычисление SHA-256
   * занимают время, за которое успевает прийти следующий кадр. Если обрабатывать
   * их параллельно, второй чанк увидит `expectedNext` предыдущего, решит, что
   * данные «перепрыгнули», и попросит докачку с места, которого ещё нет. На
   * быстром железе (и в тестах) гонка проявлялась примерно в 15 % запусков, на
   * реальном диске — почти всегда.
   */
  #receiveChain: Promise<void> = Promise.resolve();

  #enqueueReceive(task: () => Promise<void>): void {
    this.#receiveChain = this.#receiveChain.then(task, task).catch((err: unknown) => {
      this.events.emit('error', { transferId: '', message: `приём прерван: ${(err as Error).message}` });
    });
  }

  constructor(opts: FileTransferOptions) {
    this.#opts = opts;
    this.#chunkSize = opts.chunkSize ?? CHUNK_SIZE;
    this.#windowBytes = Math.max(this.#chunkSize, opts.windowBytes ?? DEFAULT_WINDOW_BYTES);
    this.#capacityTimeoutMs = opts.capacityTimeoutMs ?? CAPACITY_TIMEOUT_MS;
    this.#ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  }

  /** Подробный журнал: подробности хода передачи, не показывается в UI. */
  #trace(message: string): void {
    this.#opts.onTrace?.(message);
  }

  

  /** Сколько байт пир подтвердил как принятые. */
  ackedBytes(transferId: string, peerId: PeerId): number {
    return this.#acked.get(transferId)?.get(peerId) ?? 0;
  }

  get activeSends(): number {
    return this.#sending.size;
  }

  get activeReceives(): number {
    return this.#receiving.size;
  }

  start(): void {
    if (this.#unsubscribe.length > 0) return;
    this.#unsubscribe.push(
      this.#opts.mesh.events.on('ctrl', ({ peerId, payload }) => {
        if (payload.kind === 'json') void this.#onCtrl(peerId, payload.msg);
      }),
      this.#opts.mesh.events.on('fileChunk', (chunk) => {
        // Строго по одному чанку за раз — см. комментарий у #receiveChain.
        this.#enqueueReceive(() => this.#onChunk(chunk));
      }),
    );
  }

  stop(): void {
    // Ставится первым: циклы отправки должны увидеть флаг до того, как
    // разорвутся каналы. Иначе проснувшийся насос отправит кадр в закрытый
    // канал и сообщит об ошибке в момент штатного выхода из комнаты.
    this.#stopped = true;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe.length = 0;
    for (const timer of this.#offerTimers.values()) clearTimeout(timer);
    this.#offerTimers.clear();
    for (const job of this.#receiving.values()) void job.sink.abort('соединение закрыто');
    this.#receiving.clear();
    this.#sending.clear();
    this.#accepted.clear();
    this.events.clear();
  }

  // ─── Отправка ────────────────────────────────────────────────────────────────

  /**
   * Предлагает файл всем готовым пирам и отправляет тем, кто согласился.
   * `source` читается лениво, поэтому файл может лежать на диске.
   */
  async share(params: {
    bookId: string;
    name: string;
    mime: string;
    source: TransferSource;
    /** Ссылка на объект для расчёта контрольной суммы; обычно это Blob. */
    root?: string;
  }): Promise<FileOffer> {
    const transferId = newId();
    const root = params.root ?? (await computeRoot(params.source, this.#chunkSize));
    const offer: FileOffer = {
      transferId,
      bookId: params.bookId,
      name: params.name,
      size: params.source.size,
      mime: params.mime,
      chunkSize: this.#chunkSize,
      chunkCount: Math.ceil(params.source.size / this.#chunkSize),
      root,
    };

    const peers = new Set(this.#opts.mesh.readyPeers);
    if (peers.size === 0) throw new Error('нет готовых соединений для передачи файла');

    this.#failed.delete(transferId);
    this.#acked.delete(transferId);
    this.#verified.set(transferId, new Set());
    this.#sending.set(transferId, {
      offer,
      source: params.source,
      peers,
      sentTo: new Set(),
      cancelled: false,
      resumeAt: null,
      pumping: false,
    });
    this.#accepted.set(transferId, new Set());

    for (const peerId of peers) {
      this.#opts.mesh.sendCtrlTo(peerId, { k: 'file-offer', offer });
    }

    this.#armOfferTimeout(transferId, () => {
      this.#fail(transferId, 'никто не принял файл за отведённое время');
    });

    return offer;
  }

  cancel(transferId: string, reason = 'отменено пользователем'): void {
    const job = this.#sending.get(transferId);
    if (job === undefined) return;
    job.cancelled = true;
    for (const peerId of job.peers) {
      this.#opts.mesh.sendCtrlTo(peerId, { k: 'file-cancel', transferId, reason });
    }
    this.#clearOfferTimer(transferId);
    this.#sending.delete(transferId);
    this.#accepted.delete(transferId);
  }

  #armOfferTimeout(transferId: string, onTimeout: () => void): void {
    this.#clearOfferTimer(transferId);
    const timer = setTimeout(onTimeout, OFFER_TIMEOUT_MS);
    timer.unref?.();
    this.#offerTimers.set(transferId, timer);
  }

  #clearOfferTimer(transferId: string): void {
    const timer = this.#offerTimers.get(transferId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#offerTimers.delete(transferId);
    }
  }

  async #onCtrl(peerId: PeerId, msg: CtrlMessage): Promise<void> {
    switch (msg.k) {
      case 'file-accept': {
        const job = this.#sending.get(msg.transferId);
        if (job === undefined) return;
        this.#accepted.get(msg.transferId)?.add(peerId);
        this.#clearOfferTimer(msg.transferId);
        // Отправка по каждому пиру тоже последовательна: иначе два параллельных
        // seal() перемешают порядок чанков в канале.
        void this.#pump(job, peerId).catch(() => {});
        return;
      }
      case 'file-decline': {
        this.#opts.onLog?.(`пир ${peerId.slice(0, 8)} отклонил файл: ${msg.reason}`);
        return;
      }
      case 'file-resume': {
        const job = this.#sending.get(msg.transferId);
        if (job === undefined) {
          // Задачи нет только если файл уже подтвердили все, кто его принял:
          // тогда докачка невозможна и просить её не о чем.
          this.#trace(`докачка от ${short(peerId)} проигнорирована: передача ${short(msg.transferId)} уже закрыта`);
          return;
        }
        this.#accepted.get(msg.transferId)?.add(peerId);
        this.#clearOfferTimer(msg.transferId);
        this.#trace(`докачка ${short(msg.transferId)} от ${short(peerId)} с ${msg.offset}`);
        void this.#pump(job, peerId, msg.offset).catch(() => {});
        return;
      }
      case 'file-ack': {
        // Кумулятивное подтверждение: сдвигает окно отправителя. Сообщение
        // может прийти и для уже завершённой передачи (оно идёт по ctrl-каналу
        // вместе со всем остальным), поэтому отсутствие задачи — не ошибка.
        let byPeer = this.#acked.get(msg.transferId);
        if (byPeer === undefined) {
          byPeer = new Map();
          this.#acked.set(msg.transferId, byPeer);
        }
        const prev = byPeer.get(peerId) ?? 0;
        if (msg.offset > prev) byPeer.set(peerId, msg.offset);
        return;
      }
      case 'file-finish': {
        this.#opts.onLog?.(`передача ${msg.transferId.slice(0, 8)} подтверждена пиром ${peerId.slice(0, 8)}`);
        this.events.emit('verified', { transferId: msg.transferId, root: msg.root });
        // Пир подтвердил, что файл у него целиком и контрольная сумма сошлась.
        // Только теперь он больше не попросит докачку, и задачу можно убрать.
        this.#verified.get(msg.transferId)?.add(peerId);
        this.#dropIfFullyVerified(msg.transferId);
        return;
      }
      case 'file-offer': {
        // Объявление тоже идёт через очередь: пока идёт докачка, новое
        // объявление по тому же transferId не должно создать второй приёмник.
        this.#enqueueReceive(() => this.#onOffer(peerId, msg.offer));
        return;
      }
      case 'file-cancel': {
        const job = this.#receiving.get(msg.transferId);
        if (job !== undefined) {
          await job.sink.abort(msg.reason);
          this.#receiving.delete(msg.transferId);
          this.#fail(msg.transferId, `отправитель прервал передачу: ${msg.reason}`);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Отправляет чанки одному пиру.
   *
   * ─── Почему здесь окно, а не «отправил и жди» ───────────────────────────────
   *
   * Прежний вариант работал так: отправить чанк → дождаться, пока буфер канала
   * опустеет полностью (`waitFileDrained`). На живом DataChannel это давало две
   * беды, обе проявлялись только в реальной сети:
   *
   *   1. Ожидание `bufferedAmount === 0` не срабатывало никогда — событие
   *      `bufferedamountlow` настроено на порог 256 КиБ, а очередь никогда не
   *      доходила до него. Отправитель зависал намертво после первого чанка, у
   *      которого буфер не успел опустеть. В тестах этого не видно: там
   *      `bufferedAmount` всегда 0.
   *   2. Даже если бы ожидание срабатывало, один чанк за раз — это 16 КиБ на
   *      RTT, то есть ~200 КБ/с при 60 мс задержке. Книга читается веками.
   *
   * Теперь работает скользящее окно: шлём, пока
   *   (a) в канале есть место (`hasFileCapacity`), и
   *   (b) неподтверждённых данных меньше `windowBytes`.
   *
   * Условие (b) важно и для памяти: локальный буфер SCTP освобождается, когда
   * байты ушли в сокет получателя, а не когда он их записал. Окно по ACK держит
   * реальное число «повисших» чанков в узде получателя.
   */
  async #pump(job: SendJob, peerId: PeerId, startOffset?: number): Promise<void> {
    // На пару — ровно один цикл отправки. Запрос докачки от уже идущей передачи
    // не должен плодить второй цикл: см. комментарий у SendJob.resumeAt.
    if (job.pumping) {
      if (startOffset !== undefined) job.resumeAt = startOffset;
      return;
    }
    job.pumping = true;
    job.sentTo.add(peerId);

    const transferId = job.offer.transferId;
    const transferIdRaw = uuidToBytes(transferId);
    const chunkSize = this.#chunkSize;
    let offset = Math.max(0, Math.min(startOffset ?? 0, job.offer.size));
    // Нижняя граница окна: подтверждённое получателем смещение.
    let acked = Math.max(offset, this.ackedBytes(transferId, peerId));
    let chunkIndex = Math.floor(offset / chunkSize);
    let lastTrace = 0;
    let stalls = 0;

    this.#trace(
      `отправка ${short(transferId)} → ${short(peerId)}: с ${offset} из ${job.offer.size}, окно ${this.#windowBytes} Б`,
    );

    try {
      for (;;) {
        // Пир попросил докачку с другого места: переносим начало, но цикл
        // остаётся тем же — параллельных отправителей не появляется.
        if (job.resumeAt !== null) {
          const from = Math.max(0, Math.min(job.resumeAt, job.offer.size));
          job.resumeAt = null;
          if (from !== offset) {
            this.#trace(`докачка ${short(transferId)} → ${short(peerId)}: перенос с ${offset} на ${from}`);
            offset = from;
            acked = Math.min(acked, from);
            chunkIndex = Math.floor(offset / chunkSize);
            lastTrace = 0;
          }
        }
        if (offset >= job.offer.size) break;
        if (job.cancelled || this.#stopped) return;
        // 1. Окно по подтверждениям: ждём, пока получатель запишет уже отправленное.
        while (offset - acked >= this.#windowBytes && !job.cancelled && !this.#stopped) {
          const buffer = this.#opts.mesh.fileBufferOf(peerId);
          stalls++;
          if (stalls === 1 || stalls % 10 === 0) {
            this.#trace(
              `ждём окно: не подтверждено ${offset - acked} Б из ${this.#windowBytes}, буфер ${buffer.buffered} Б, отправлено ${offset} из ${job.offer.size}`,
            );
          }
          const progressed = await this.#waitForAck(transferId, peerId, () => acked, (v) => {
            acked = v;
          });
          if (!progressed) {
            this.#fail(
              transferId,
              `пир ${short(peerId)} не подтвердил приём за ${this.#ackTimeoutMs} мс (окно встало на ${offset} из ${job.offer.size})`,
            );
            return;
          }
        }
        if (job.cancelled || this.#stopped) return;

        // 2. Место в буфере канала. Здесь и был главный источник зависания.
        while (!this.#opts.mesh.hasFileCapacity(peerId) && !job.cancelled && !this.#stopped) {
          const buffer = this.#opts.mesh.fileBufferOf(peerId);
          stalls++;
          if (stalls === 1 || stalls % 10 === 0) {
            this.#trace(
              `пауза буфера: ${short(peerId)} = ${buffer.buffered} Б (порог ${buffer.high}), отправлено ${offset} из ${job.offer.size}`,
            );
          }
          const wait = await this.#opts.mesh.waitFileCapacity(
            peerId,
            this.#capacityTimeoutMs,
            `чанк #${chunkIndex} (${offset} из ${job.offer.size} Б)`,
          );
          if (!wait.ok) {
            // Закрытый канал — это не зависание передачи, а выход из комнаты или
            // обрыв. Сообщение об ошибке здесь было бы ложью: пользователь сам
            // закрыл комнату, а ему показывали «буфер не опустел за 20 с».
            if (wait.closed) {
              this.#trace(`передача ${short(transferId)} → ${short(peerId)} прервана: соединение закрыто`);
              return;
            }
            const again = this.#opts.mesh.fileBufferOf(peerId);
            this.#fail(
              transferId,
              `буфер отправки ${short(peerId)} не опустел за ${this.#capacityTimeoutMs} мс (${again.buffered} Б при пороге ${again.high})`,
            );
            return;
          }
        }
        if (job.cancelled || this.#stopped) return;

        // 3. Отправляем чанк.
        const end = Math.min(offset + chunkSize, job.offer.size);
        const data = await job.source.slice(offset, end);
        // slice асинхронен (файл читается с диска), и за это время мог выйти из
        // комнаты. Без проверки кадр ушёл бы в закрытый канал и породил ошибку
        // «передача прервана» в момент штатного выхода.
        if (this.#stopped || job.cancelled) return;
        await this.#opts.mesh.sendFileChunk(peerId, transferIdRaw, offset, data);
        offset = end;

        this.events.emit('progress', {
          transferId,
          peerId,
          done: offset,
          total: job.offer.size,
          direction: 'out',
        });

        // 4. Журнал: по номеру чанка, но не чаще, чем раз в TRACE_MIN_INTERVAL_MS.
        const now = Date.now();
        if (chunkIndex % TRACE_EVERY_CHUNKS === 0 || now - lastTrace >= TRACE_MIN_INTERVAL_MS) {
          lastTrace = now;
          const buffer = this.#opts.mesh.fileBufferOf(peerId);
          this.#trace(
            `чанк #${chunkIndex} ${offset}/${job.offer.size} · буфер ${buffer.buffered}/${buffer.high} Б · в окне ${offset - acked} Б · пауз ${stalls}`,
          );
        }
        chunkIndex++;
      }
    } catch (err) {
      job.pumping = false;
      // Ошибка на закрытом канале после stop() — это не сбой передачи, а
      // штатный выход из комнаты. Сообщать о нём незачем и вредно.
      if (this.#stopped) {
        this.#trace(`передача ${short(transferId)} → ${short(peerId)} прервана выходом из комнаты`);
        return;
      }
      this.#fail(transferId, `передача пиру ${short(peerId)} прервана: ${errText(err)}`);
      return;
    }

    // Цикл завершён: снимаем флаг, чтобы запрос докачки после этого смог
    // запустить новый цикл с нуля.
    job.pumping = false;
    if (job.resumeAt !== null || job.cancelled || this.#stopped) return;
    if (offset < job.offer.size) return;

    this.#trace(`отправка ${short(transferId)} → ${short(peerId)} завершена: ${offset} Б, пауз ${stalls}`);
    this.#opts.mesh.sendCtrlTo(peerId, { k: 'file-finish', transferId, root: job.offer.root });
    this.events.emit('complete', { transferId, offer: job.offer, direction: 'out' });
    // Задачу убираем только когда все пиры ПОДТВЕРДИЛИ получение, а не когда
    // согласились его принять: до этого они вправе попросить докачку.
    this.#dropIfFullyVerified(transferId);
  }

  /**
   * Убирает задачу, если файл подтвердили все, кто его принял.
   *
   * Условие — по пирам, принявшим файл, а не по всем готовым соединениям: пир,
   * отклонивший книгу, докачку просить не станет, и ждать его подтверждения
   * можно было бы вечно.
   */
  #dropIfFullyVerified(transferId: string): void {
    const job = this.#sending.get(transferId);
    if (job === undefined) return;
    const accepted = this.#accepted.get(transferId);
    if (accepted === undefined || accepted.size === 0) return;
    const verified = this.#verified.get(transferId);
    if (verified === undefined) return;
    for (const peerId of accepted) {
      if (!verified.has(peerId)) return;
    }
    this.#sending.delete(transferId);
    this.#accepted.delete(transferId);
    this.#verified.delete(transferId);
  }

  /**
   * Ждёт, пока получатель подтвердит данные, сдвигая окно.
   *
   * Опрос вместо события: ACK приходят через ctrl-канал, и на загруженном
   * ctrl-канале они могут задержаться на сотни миллисекунд. Таймаут обязателен —
   * иначе «молчащий» получатель держит передачу открытой вечно.
   *
   * @returns true — окно сдвинулось; false — таймаут или отмена.
   */
  async #waitForAck(
    transferId: string,
    peerId: PeerId,
    read: () => number,
    write: (value: number) => void,
  ): Promise<boolean> {
    const start = read();
    const deadline = Date.now() + this.#ackTimeoutMs;
    while (Date.now() < deadline) {
      const current = this.ackedBytes(transferId, peerId);
      if (current > start) {
        write(current);
        return true;
      }
      await sleep(ACK_POLL_MS);
    }
    const final = this.ackedBytes(transferId, peerId);
    if (final > start) {
      write(final);
      return true;
    }
    return false;
  }

  // ─── Приём ───────────────────────────────────────────────────────────────────

  async #onOffer(from: PeerId, offer: FileOffer): Promise<void> {
    if (offer.chunkSize !== this.#chunkSize) {
      this.#fail(offer.transferId, `пир предлагает другой размер чанка: ${offer.chunkSize}`);
      return;
    }
    if (this.#receiving.has(offer.transferId)) return; // дубликат объявления

    this.events.emit('incoming', { from, offer });

    const partial = await this.#opts.findPartial(offer);

    if (partial > 0 && partial < offer.size) {
      // Докачка после обрыва. Приёмник за время обрыва был закрыт, поэтому его
      // нужно создать заново и восстановить уже принятые хеши: без них
      // итоговую контрольную сумму не собрать.
      const sink = await this.#opts.createSink(offer, from);
      if (sink === null) {
        this.#opts.mesh.sendCtrlTo(from, {
          k: 'file-decline',
          transferId: offer.transferId,
          reason: 'не удалось продолжить приём',
        });
        return;
      }
      const restored = await sink.hashes();
      this.#receiving.set(offer.transferId, {
        offer,
        from,
        sink,
        rootParts: restored,
        expectedNext: sink.received,
      });
      this.#opts.mesh.sendCtrlTo(from, { k: 'file-resume', transferId: offer.transferId, offset: sink.received });
      return;
    }

    let allowed: boolean;
    if (this.#opts.autoAccept) {
      allowed = await this.#opts.autoAccept(offer, from);
    } else {
      allowed = true;
    }
    if (!allowed) {
      this.#opts.mesh.sendCtrlTo(from, { k: 'file-decline', transferId: offer.transferId, reason: 'пользователь отказал' });
      return;
    }

    const sink = await this.#opts.createSink(offer, from);
    if (sink === null) {
      this.#opts.mesh.sendCtrlTo(from, { k: 'file-decline', transferId: offer.transferId, reason: 'нет места или формат не поддерживается' });
      return;
    }
    this.#receiving.set(offer.transferId, { offer, from, sink, rootParts: [], expectedNext: sink.received });
    this.#opts.mesh.sendCtrlTo(from, { k: 'file-accept', transferId: offer.transferId });
  }

  async #onChunk(chunk: { peerId: PeerId; transferId: string; offset: number; data: Uint8Array }): Promise<void> {
    const job = this.#receiving.get(chunk.transferId);
    if (job === undefined) return; // чанк без согласия — игнорируем

    if (chunk.offset !== job.expectedNext) {
      // Канал надёжный и упорядоченный, поэтому рассинхронизация означает
      // повреждённое состояние. Просим докачку с нужного места.
      this.#trace(
        `принят чанк с ${chunk.offset}, а ожидался ${job.expectedNext} из ${job.offer.size} — просим докачку`,
      );
      this.#opts.mesh.sendCtrlTo(job.from, { k: 'file-resume', transferId: chunk.transferId, offset: job.expectedNext });
      return;
    }

    try {
      await job.sink.write(chunk.offset, chunk.data);
      job.rootParts.push(await sha256(chunk.data));
      job.expectedNext += chunk.data.length;
      this.events.emit('progress', {
        transferId: chunk.transferId,
        peerId: chunk.peerId,
        done: job.expectedNext,
        total: job.offer.size,
        direction: 'in',
      });

      // Кумулятивное подтверждение. Отправляется каждый чанк: ctrl-канал
      // отдельный и не блокируется файловым, а без ACK окно отправителя не
      // сдвинется. Сообщение крошечное (около 60 байт), на скорости передачи
      // это доли процента трафика.
      this.#opts.mesh.sendFileAck(job.from, chunk.transferId, job.expectedNext);

      if (chunk.offset % (TRACE_EVERY_CHUNKS * this.#chunkSize) === 0) {
        this.#trace(
          `приём ${short(chunk.transferId)} ← ${short(chunk.peerId)}: ${job.expectedNext}/${job.offer.size} Б`,
        );
      }

      if (job.expectedNext >= job.offer.size) {
        await this.#finishReceive(job);
      }
    } catch (err) {
      this.#fail(chunk.transferId, `запись не удалась: ${errText(err)}`);
    }
  }

  async #finishReceive(job: ReceiveJob): Promise<void> {
    const root = toHex(await sha256(concat(...job.rootParts)));
    if (root !== job.offer.root) {
      await job.sink.abort('несовпадение контрольной суммы');
      this.#receiving.delete(job.offer.transferId);
      this.#fail(job.offer.transferId, 'файл повреждён при передаче: контрольная сумма не совпала');
      return;
    }
    await job.sink.finish();
    this.#receiving.delete(job.offer.transferId);
    this.#opts.mesh.sendCtrlTo(job.from, { k: 'file-finish', transferId: job.offer.transferId, root });
    this.events.emit('complete', { transferId: job.offer.transferId, offer: job.offer, direction: 'in' });
  }

  #fail(transferId: string, message: string): void {
    // Повторное сообщение об одной и той же передаче в UI не приносит пользы:
    // список передач всё равно один. При обрыве сети несколько ожиданий могут
    // сработать почти одновременно, и без этой проверки пользователь получил бы
    // десяток одинаковых уведомлений.
    if (this.#failed.has(transferId)) return;
    this.#failed.add(transferId);
    this.#clearOfferTimer(transferId);
    this.#sending.delete(transferId);
    this.#accepted.delete(transferId);
    this.events.emit('error', { transferId, message });
  }
}

/**
 * `root = SHA-256(SHA-256(chunk₀) ‖ … ‖ SHA-256(chunkₙ))`.
 * Один проход по файлу, память O(размер хеша).
 */
export async function computeRoot(source: TransferSource, chunkSize = CHUNK_SIZE): Promise<string> {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < source.size; offset += chunkSize) {
    const data = await source.slice(offset, Math.min(offset + chunkSize, source.size));
    parts.push(await sha256(data));
  }
  return toHex(await sha256(concat(...parts)));
}

/** UUID (8-4-4-4-12) ↔ 16 байт для заголовка CHUNK-кадра. */
export { uuidToBytes, uuidFromBytes } from '@rd/protocol';

export { CHUNK_SIZE };

/**
 * Окно передачи в байтах.
 *
 * 256 КиБ = 16 чанков по 16 КиБ. Совпадает с FILE_HIGH_WATER_MARK намеренно: окно
 * должно быть не больше очереди канала, иначе смысл backpressure теряется —
 * отправитель забивает канал, но получатель всё равно не успевает забирать.
 *
 * Ниже 128 КиБ окно становится слишком узким для мобильных сетей (RTT 150 мс даёт
 * ~1,7 МБ/с), выше 512 КиБ — очередь начинает давить на память получателя.
 */
export const DEFAULT_WINDOW_BYTES = 256 * 1024;

/**
 * Таймаут ожидания свободного места в буфере отправки.
 *
 * Заведомо больше нормального времени: буфер опустошается за единицы
 * миллисекунд на нормальном канале. Превышение означает, что канал мёртв
 * (обрыв без закрытия — типично для мобильной сети), и ждать дальше бессмысленно.
 */
export const CAPACITY_TIMEOUT_MS = 20_000;

/**
 * Таймаут ожидания подтверждения приёма.
 *
 * Отправитель шлёт чанки и ждёт, пока получатель подтвердит запись. Если за это
 * время ACK не пришёл, принимающая сторона зависла (тяжёлый диск, вкладка в фоне,
 * разрыв сети) — и передачу надо перезапустить с подтверждённого места, а не
 * молча стоять.
 */
export const ACK_TIMEOUT_MS = 20_000;

/** Как часто проверять, не пришёл ли ACK, пока ждём окно. */
const ACK_POLL_MS = 50;

/** Как часто писать в журнал ход передачи. По чанку — слишком шумно. */
const TRACE_EVERY_CHUNKS = 8;

/** Не чаще этого журнал отправки, даже если чанки идут часто. */
const TRACE_MIN_INTERVAL_MS = 400;
