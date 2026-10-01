/**
 * Локальное хранилище: IndexedDB через Dexie.
 *
 * Границы намеренно узкие. Приложение НИКОГДА не ходит в файловую систему
 * напрямую: выбор файлов делает пользователь через <input type="file"> или
 * File System Access API, и мы берём только те объекты, которые он передал.
 * Никаких «../», никаких symlink-обходов, никакого сканирования каталогов —
 * эти риски просто не возникают, потому что их некому реализовать.
 *
 * Куски файла пишутся в отдельные записи `chunks` и в конце собираются в Blob.
 * Зачем так, а не «держать файл в памяти и сохранить целиком»:
 *   - передача аудиокниги на 800 МБ не должна занимать 800 МБ RAM;
 *   - при обрыве связи принятые куски уже в IndexedDB, докачка их не перезаливает;
 *   - Blob, собранный из сохранённых кусков, IndexedDB хранит без полного
 *     копирования в память — чтение потом ленивое.
 */

import Dexie, { type Table } from 'dexie';
import { CHUNK_SIZE } from '@rd/protocol';
import { fromHex, sha256Hex } from '@rd/crypto';
import type { TransferSink } from '@rd/p2p';

/** Книга: метаданные + содержимое. */
export interface StoredBook {
  id: string;
  roomId: string;
  title: string;
  author: string;
  format: 'epub' | 'fb2' | 'audio';
  size: number;
  mime: string;
  root: string;
  /** Собранное содержимое. null, пока файл принят не полностью. */
  blob: Blob | null;
  /** Сколько байт уже принято — для докачки и прогресс-бара. */
  received: number;
  complete: boolean;
  savedAt: number;
  /** Локальный момент последнего открытия — для сортировки «недавние». */
  lastOpenedAt: number | null;
}

/** Незавершённый кусок входящей передачи. */
export interface StoredChunk {
  /** Составной первичный ключ `${roomId}:${transferId}:${part}`. */
  key: string;
  roomId: string;
  transferId: string;
  part: number;
  data: Blob;
  /** SHA-256 куска (hex). Нужен, чтобы после обрыва собрать общую контрольную сумму. */
  hash: string;
}

/** Состояние CRDT между сессиями: офлайн-работа и быстрый старт. */
export interface StoredYState {
  roomId: string;
  update: Uint8Array;
  savedAt: number;
}

export interface StoredSetting {
  key: string;
  value: unknown;
}

class RdDatabase extends Dexie {
  books!: Table<StoredBook, string>;
  chunks!: Table<StoredChunk, string>;
  ystate!: Table<StoredYState, string>;
  settings!: Table<StoredSetting, string>;

  constructor(name = 'rd') {
    super(name);
    // Составной первичный ключ для chunks: IndexedDB отдаёт записи по ключу
    // без сканирования, поэтому докачка читает только недостающие куски.
    this.version(1).stores({
      books: 'id, roomId, [roomId+complete], lastOpenedAt',
      chunks: '[roomId+transferId+part]',
      ystate: 'roomId',
      settings: 'key',
    });
  }
}

export interface LibraryStore {
  readonly db: Dexie;
  putBook(book: StoredBook): Promise<void>;
  getBook(roomId: string, bookId: string): Promise<StoredBook | undefined>;
  listBooks(roomId: string): Promise<StoredBook[]>;
  deleteBook(roomId: string, bookId: string): Promise<void>;
  /** Сколько байт уже принято для незавершённой передачи. */
  partialBytes(roomId: string, transferId: string): Promise<number>;
  createSink(params: {
    roomId: string;
    transferId: string;
    bookId: string;
    title: string;
    author: string;
    format: 'epub' | 'fb2' | 'audio';
    mime: string;
    size: number;
    root: string;
    chunkSize?: number;
  }): TransferSink;
  saveYState(roomId: string, update: Uint8Array): Promise<void>;
  loadYState(roomId: string): Promise<Uint8Array | null>;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;
  clearRoom(roomId: string): Promise<void>;
}

export function createLibraryStore(dbName = 'rd'): LibraryStore {
  const db = new RdDatabase(dbName);
  return new DexieLibraryStore(db);
}

class DexieLibraryStore implements LibraryStore {
  constructor(readonly db: RdDatabase) {}

  async putBook(book: StoredBook): Promise<void> {
    await this.db.books.put(book);
  }

  getBook(roomId: string, bookId: string): Promise<StoredBook | undefined> {
    return this.db.books.get(bookId).then((book) => (book !== undefined && book.roomId === roomId ? book : undefined));
  }

  async listBooks(roomId: string): Promise<StoredBook[]> {
    const all = await this.db.books.where('roomId').equals(roomId).toArray();
    return all.sort((a, b) => (b.lastOpenedAt ?? b.savedAt) - (a.lastOpenedAt ?? a.savedAt));
  }

  async deleteBook(roomId: string, bookId: string): Promise<void> {
    const book = await this.getBook(roomId, bookId);
    if (book === undefined) return;
    await this.db.books.delete(bookId);
    // Куски могут остаться от прерванной передачи — чистим по transferId
    // всех незавершённых записей этой книги.
    const orphans = await this.db.chunks.where('roomId').equals(roomId).toArray();
    await this.db.transaction('rw', this.db.chunks, async () => {
      for (const chunk of orphans) {
        if (chunk.transferId === bookId) await this.db.chunks.delete(chunk.key);
      }
    });
  }

  async partialBytes(roomId: string, transferId: string): Promise<number> {
    const chunks = await this.db.chunks.where('[roomId+transferId+part]').between(
      [roomId, transferId, Dexie.minKey],
      [roomId, transferId, Dexie.maxKey],
    ).toArray();
    let total = 0;
    for (const chunk of chunks) total += chunk.data.size;
    return total;
  }

  createSink(params: {
    roomId: string;
    transferId: string;
    bookId: string;
    title: string;
    author: string;
    format: 'epub' | 'fb2' | 'audio';
    mime: string;
    size: number;
    root: string;
    chunkSize?: number;
  }): TransferSink {
    return new ChunkedBlobSink(this.db, { ...params, chunkSize: params.chunkSize ?? CHUNK_SIZE });
  }

  async saveYState(roomId: string, update: Uint8Array): Promise<void> {
    await this.db.ystate.put({ roomId, update, savedAt: Date.now() });
  }

  async loadYState(roomId: string): Promise<Uint8Array | null> {
    const row = await this.db.ystate.get(roomId);
    return row?.update ?? null;
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    const row = await this.db.settings.get(key);
    return row?.value as T | undefined;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.settings.put({ key, value });
  }

  async clearRoom(roomId: string): Promise<void> {
    const books = await this.db.books.where('roomId').equals(roomId).toArray();
    await this.db.transaction('rw', [this.db.books, this.db.chunks, this.db.ystate], async () => {
      for (const book of books) await this.db.books.delete(book.id);
      await this.db.chunks.where('roomId').equals(roomId).delete();
      await this.db.ystate.delete(roomId);
    });
  }
}

/**
 * Приёмник файла, пишущий куски в IndexedDB.
 *
 * Собранный Blob хранится в записи книги. Проверка контрольной суммы делается
 * в FileTransferManager до вызова finish(), поэтому здесь достаточно собрать
 * куски в правильном порядке.
 */
class ChunkedBlobSink implements TransferSink {
  #received = 0;
  #done = false;

  constructor(
    private readonly db: DexieDatabase,
    private readonly meta: {
      roomId: string;
      transferId: string;
      bookId: string;
      title: string;
      author: string;
      format: 'epub' | 'fb2' | 'audio';
      mime: string;
      size: number;
      root: string;
      chunkSize: number;
    },
  ) {}

  get received(): number {
    return this.#received;
  }

  /** Восстанавливает состояние незавершённой передачи после обрыва связи. */
  async resume(): Promise<void> {
    if (this.#received > 0) return;
    const existing = await this.#loadChunks();
    this.#received = existing.reduce((sum, c) => sum + c.data.size, 0);
  }

  async hashes(): Promise<Uint8Array[]> {
    const existing = await this.#loadChunks();
    return existing.map((c) => fromHex(c.hash));
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    if (this.#done) throw new Error('приёмник уже закрыт');
    if (offset !== this.#received) {
      // Порядок нарушен: перезаписывать нечего, а пропуск означал бы дыру в
      // файле. FileTransferManager в этом случае присылает file-resume.
      throw new Error(`ожидалось смещение ${this.#received}, получено ${offset}`);
    }
    const part = Math.floor(offset / this.meta.chunkSize);
    const blob = new Blob([data.slice().buffer as ArrayBuffer]);
    const hash = await sha256Hex(data);
    await this.db.chunks.put({
      key: chunkKey(this.meta.roomId, this.meta.transferId, part),
      roomId: this.meta.roomId,
      transferId: this.meta.transferId,
      part,
      data: blob,
      hash,
    });
    this.#received += data.length;
  }

  async finish(): Promise<void> {
    if (this.#done) return;
    this.#done = true;

    const stored = await this.#loadChunks();
    const blob = assembleBlob(stored.map((c) => c.data), this.meta.mime);

    await this.db.books.put({
      id: this.meta.bookId,
      roomId: this.meta.roomId,
      title: this.meta.title,
      author: this.meta.author,
      format: this.meta.format,
      size: this.meta.size,
      mime: this.meta.mime,
      root: this.meta.root,
      blob,
      received: this.#received,
      complete: true,
      savedAt: Date.now(),
      lastOpenedAt: null,
    });

    // Куски больше не нужны: освобождаем место сразу, а не по кнопке «очистить».
    for (const chunk of stored) await this.db.chunks.delete(chunk.key);
  }

  async abort(_reason: string): Promise<void> {
    this.#done = true;
    // Куски оставляем: при обрыве связи докачка продолжит с них. Удаляем
    // только если исчезла сама книга — это делает deleteBook.
  }

  #loadChunks(): Promise<StoredChunk[]> {
    return this.db.chunks
      .where('[roomId+transferId+part]')
      .between(
        [this.meta.roomId, this.meta.transferId, Dexie.minKey],
        [this.meta.roomId, this.meta.transferId, Dexie.maxKey],
      )
      .toArray()
      .then((rows) => rows.sort((a, b) => a.part - b.part));
  }
}

/**
 * Собирает принятые куски в один Blob.
 *
 * Вынесено отдельной функцией не для красоты, а потому что здесь терялся тип
 * файла, и потеря была молчаливой. Blob, собранный из кусков, наследует ПУСТОЙ
 * тип. Браузер для `<audio>` без распознаваемого type просто не начинает
 * воспроизведение: файл лежит на диске, звука нет, в консоли чисто. Для EPUB
 * это безразлично (его читает наш парсер, который тип не смотрит), а для
 * аудиокниги — фатально.
 *
 * Тип берётся из записи книги, а не из кусков: куски сохранялись без него.
 */
export function assembleBlob(chunks: Blob[], mime: string): Blob {
  const type = mime.trim();
  return new Blob(chunks, type === '' ? undefined : { type });
}

/** Имя таблицы `books` для транзакций Dexie. */
type DexieDatabase = DexieLibraryStore['db'];

function chunkKey(roomId: string, transferId: string, part: number): string {
  return `${roomId}:${transferId}:${part.toString().padStart(8, '0')}`;
}

// ─── Источник для отправки ─────────────────────────────────────────────────────

/**
 * Потоковый источник поверх File/Blob: читает по кускам, не грузит целиком.
 * `File` и `Blob` умеют отдавать срез без чтения в память, поэтому на диске
 * лежащий файл на 800 МБ так и не попадёт в RAM целиком.
 */
export function blobSource(blob: Blob): { size: number; slice(start: number, end: number): Promise<Uint8Array> } {
  return {
    size: blob.size,
    async slice(start: number, end: number): Promise<Uint8Array> {
      const part = blob.slice(start, Math.min(end, blob.size));
      return new Uint8Array(await part.arrayBuffer());
    },
  };
}

/** Читаемый источник из уже загруженных байтов — для тестов и малых файлов. */
export function bytesSource(bytes: Uint8Array): { size: number; slice(start: number, end: number): Promise<Uint8Array> } {
  return {
    size: bytes.length,
    async slice(start: number, end: number): Promise<Uint8Array> {
      return bytes.subarray(start, Math.min(end, bytes.length));
    },
  };
}

export { Dexie };
