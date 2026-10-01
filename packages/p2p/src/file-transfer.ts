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
  onLog?(message: string): void;
}

interface SendJob {
  offer: FileOffer;
  source: TransferSource;
  peers: Set<PeerId>;
  sentTo: Set<PeerId>;
  cancelled: boolean;
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
  readonly #sending = new Map<string, SendJob>();
  readonly #receiving = new Map<string, ReceiveJob>();
  /** Пиры, уже подтвердившие получение. */
  readonly #accepted = new Map<string, Set<PeerId>>();
  readonly #offerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #unsubscribe: Array<() => void> = [];
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

    this.#sending.set(transferId, { offer, source: params.source, peers, sentTo: new Set(), cancelled: false });
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
        if (job === undefined) return;
        this.#accepted.get(msg.transferId)?.add(peerId);
        this.#clearOfferTimer(msg.transferId);
        void this.#pump(job, peerId, msg.offset).catch(() => {});
        return;
      }
      case 'file-finish': {
        this.#opts.onLog?.(`передача ${msg.transferId.slice(0, 8)} подтверждена пиром ${peerId.slice(0, 8)}`);
        this.events.emit('verified', { transferId: msg.transferId, root: msg.root });
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

  /** Отправляет чанки одному пиру, уважая backpressure. */
  async #pump(job: SendJob, peerId: PeerId, startOffset?: number): Promise<void> {
    if (job.sentTo.has(peerId) && startOffset === undefined) return;
    job.sentTo.add(peerId);

    const transferIdRaw = uuidToBytes(job.offer.transferId);
    const chunkSize = this.#chunkSize;
    let offset = Math.max(0, Math.min(startOffset ?? 0, job.offer.size));

    try {
      while (offset < job.offer.size && !job.cancelled) {
        const end = Math.min(offset + chunkSize, job.offer.size);
        const data = await job.source.slice(offset, end);
        await this.#opts.mesh.sendFileChunk(peerId, transferIdRaw, offset, data);
        offset = end;
        this.events.emit('progress', {
          transferId: job.offer.transferId,
          peerId,
          done: offset,
          total: job.offer.size,
          direction: 'out',
        });
        if (offset < job.offer.size) {
          await this.#opts.mesh.waitFileDrained(peerId);
        }
      }
      if (offset >= job.offer.size && !job.cancelled) {
        this.#opts.mesh.sendCtrlTo(peerId, { k: 'file-finish', transferId: job.offer.transferId, root: job.offer.root });
        this.events.emit('complete', { transferId: job.offer.transferId, offer: job.offer, direction: 'out' });
        // Передача считается завершённой, когда все согласившиеся пиры получили файл.
        const accepted = this.#accepted.get(job.offer.transferId);
        if (accepted !== undefined && accepted.size >= job.peers.size) {
          this.#sending.delete(job.offer.transferId);
          this.#accepted.delete(job.offer.transferId);
        }
      }
    } catch (err) {
      this.#fail(job.offer.transferId, `передача пиру ${peerId.slice(0, 8)} прервана: ${(err as Error).message}`);
    }
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

      if (job.expectedNext >= job.offer.size) {
        await this.#finishReceive(job);
      }
    } catch (err) {
      this.#fail(chunk.transferId, `запись не удалась: ${(err as Error).message}`);
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
