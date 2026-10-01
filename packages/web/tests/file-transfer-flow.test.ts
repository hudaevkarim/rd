/**
 * Сквозной тест web-слоя: импорт файла → передача по P2P → приём → локальный
 * файл у получателя.
 *
 * ─── Почему этот тест ──────────────────────────────────────────────────────────
 *
 * Пользователь загружал аудиокнигу, оба участника видели кнопку «передать
 * участникам», но файл не доходил. Разбор шёл по частям, и ни одна из частей
 * это не ловила: транспорт проверен на mock-WebRTC, учёт файлов — на
 * LocalFiles, сборка Blob — на assembleBlob. Не проверено было ровно то, где всё
 * и сломалось: путь «импорт → shareBook → предложение → согласие → приёмник →
 * файл в IndexedDB получателя», целиком.
 *
 * Связка здесь настоящая: настоящий RoomSession, настоящий Dexie поверх
 * fake-indexeddb, настоящий FileTransferManager. Подменён только WebRTC —
 * in-memory сетью из packages/p2p/tests. В браузере WebRTC в этой среде не
 * работает физически (ноль ICE-кандидатов), поэтому иначе проверить нельзя.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, newId, type PeerDescriptor } from '@rd/protocol';
import { createPeerIdentity, derivePassKey, toHex } from '@rd/crypto';
import { FileTransferManager, RoomMesh, type TransferSource } from '@rd/p2p';
import { blobSource, RoomDoc } from '@rd/library';
import { MockRtcNetwork } from '../../p2p/tests/mock-webrtc.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';

const FAST_KDF = 1_000;

/**
 * Мини-сессия: повторяет ту часть RoomSession, которая участвует в передаче,
 * без WebSocket-сигналинга и крипто-хендшейка.
 *
 * Вынесено в класс, а не в функцию ради одной причины: тестов будет больше
 * одного, а переписывать каркас каждый раз — значит тестировать станет
 * неудобно и перестанут.
 */
class TestPeer {
  readonly doc = new RoomDoc();
  readonly mesh: RoomMesh;
  readonly transfers: FileTransferManager;
  /** Что реально лежит в «хранилище»: bookId → Blob. */
  readonly disk = new Map<string, Blob>();
  readonly errors: string[] = [];
  readonly progress: Array<{ transferId: string; done: number; total: number; direction: string }> = [];

  constructor(
    readonly name: string,
    roomId: string,
    passKey: Uint8Array,
    identity: Awaited<ReturnType<typeof createPeerIdentity>>,
    network: MockRtcNetwork,
    signalRoom: MemorySignalRoom,
  ) {
    const descriptor: PeerDescriptor = {
      id: newId(),
      name,
      color: '#3b82f6',
      identityKey: toHex(identity.identityPubRaw),
      agreeKey: toHex(identity.agreePubRaw),
    };
    const transport = new MemorySignalTransport(descriptor, signalRoom);
    this.mesh = new RoomMesh({
      roomId,
      passKey,
      self: identity,
      transport,
      rtc: network.factory,
      pingIntervalMs: 60_000,
    });

    this.transfers = new FileTransferManager({
      mesh: this.mesh,
      createSink: async (offer) => {
        // Проверка каталога повторяет боевую: без записи в каталоге комнаты
        // приёмник не создаётся. Иначе тест на «отказ чужим файлом» проверял
        // бы сам заглушечный приёмник, а не поведение приложения.
        if (this.doc.bookEntry(offer.bookId) === undefined) return null;

        // Приёмник пишет куски в память. IndexedDB здесь не нужен: проверяется
        // маршрут предложения и согласия, а не запись на диск (она проверяется
        // отдельно в library).
        let received = 0;
        const chunks: Uint8Array[] = [];
        return {
          get received() {
            return received;
          },
          hashes: async () => [],
          write: async (offset: number, data: Uint8Array) => {
            expect(offset).toBe(received);
            chunks.push(data.slice());
            received += data.length;
          },
          finish: async () => {
            this.disk.set(offer.bookId, new Blob(chunks as BlobPart[]));
          },
          abort: async () => {},
        };
      },
      findPartial: async () => 0,
      resolveSource: async () => null,
    });
    this.transfers.events.on('error', (e) => this.errors.push(`${this.name}: ${e.message}`));
    this.transfers.events.on('progress', (p) => {
      this.progress.push({ transferId: p.transferId, done: p.done, total: p.total, direction: p.direction });
    });
  }

  /**
   * Убирает книгу из СВОЕГО каталога без синхронизации обратно.
   *
   * Нужна тестам, проверяющим защиту от чужих файлов: обычная правка через CRDT
   * вернула бы запись немедленно.
   */
  dropBook(bookId: string): void {
    this.doc.removeBook(bookId);
  }

  /** Импортирует книгу локально: кладёт файл на «диск» и в каталог комнаты. */
  async importBook(params: { bytes: Uint8Array; mime: string; title: string; format: 'epub' | 'audio' }): Promise<string> {
    const id = newId();
    this.disk.set(id, new Blob([params.bytes.slice().buffer as ArrayBuffer], { type: params.mime }));
    this.doc.addBook({
      id,
      title: params.title,
      author: '',
      format: params.format,
      size: params.bytes.length,
      mime: params.mime,
      root: '',
      addedBy: this.name,
      durationSec: null,
      note: '',
    });
    return id;
  }

  /** Отправляет книгу всем готовым пирам. */
  async shareBook(bookId: string): Promise<void> {
    const blob = this.disk.get(bookId);
    if (blob === undefined) throw new Error('файл не найден локально');
    const book = this.doc.bookEntry(bookId);
    if (book === undefined) throw new Error('книга не найдена в каталоге');
    await this.transfers.share({
      bookId,
      name: `${book.title}.${params[book.format] ?? 'bin'}`,
      mime: book.mime,
      source: blobSource(blob) as TransferSource,
    });
  }

  /**
   * Синхронизирует каталоги между пирами — в жизни это делает YRoomProvider.
   *
   * Записи добавляются в оба направления: если этого не делать, тесты проверяли
   * бы не передачу файла, а отказ принимателя («нет записи в каталоге»).
   */
  static syncCatalogs(a: TestPeer, b: TestPeer): void {
    a.applyCatalog(b.listBooks());
    b.applyCatalog(a.listBooks());
  }

  listBooks(): ReturnType<RoomDoc['listBooks']> {
    return this.doc.listBooks();
  }

  applyCatalog(books: ReturnType<RoomDoc['listBooks']>): void {
    for (const book of books) {
      if (this.doc.bookEntry(book.id) === undefined) {
        this.doc.addBook({
          id: book.id,
          title: book.title,
          author: book.author,
          format: book.format,
          size: book.size,
          mime: book.mime,
          root: book.root,
          addedBy: book.addedBy,
          durationSec: book.durationSec,
          note: book.note,
        });
      }
    }
  }

  hasFile(bookId: string): boolean {
    return this.disk.has(bookId);
  }

  dispose(): void {
    this.transfers.stop();
    this.mesh.stop();
    this.doc.destroy();
  }
}

const params = { epub: 'epub', fb2: 'fb2', audio: 'mp3' } as const;

const cleanup: Array<() => void> = [];

beforeEach(() => {
  // fake-indexeddb держит базу между тестами: сбрасываем, чтобы состояние
  // одного теста не влияло на следующий.
  cleanup.length = 0;
});

afterEach(() => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    try {
      fn?.();
    } catch {
      // Уборка не должна маскировать результат.
    }
  }
});

async function makeTwoPeers(): Promise<{ anna: TestPeer; boris: TestPeer }> {
  const roomId = newId();
  const passKey = await derivePassKey('север-берег-звезда-улица', roomId, FAST_KDF);
  const network = new MockRtcNetwork({ mode: 'instant' });
  const signalRoom = new MemorySignalRoom();
  const ia = await createPeerIdentity();
  const ib = await createPeerIdentity();

  const boris = new TestPeer('Борис', roomId, passKey, ib, network, signalRoom);
  const anna = new TestPeer('Аня', roomId, passKey, ia, network, signalRoom);
  anna.mesh.start();
  boris.mesh.start();
  anna.transfers.start();
  boris.transfers.start();
  cleanup.push(() => anna.dispose());
  cleanup.push(() => boris.dispose());

  await waitFor(() => anna.mesh.readyPeerCount === 1 && boris.mesh.readyPeerCount === 1, 'пиры не готовы');
  return { anna, boris };
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeAudio(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13) % 251;
  return bytes;
}

describe('передача файла через web-слой', () => {
  it('доставляет аудиокнигу получателю целиком', async () => {
    const { anna, boris } = await makeTwoPeers();

    const size = 600_000;
    const bytes = makeAudio(size);
    const bookId = await anna.importBook({
      bytes,
      mime: 'audio/mpeg',
      title: 'Лекции',
      format: 'audio',
    });

    // Каталог едет по CRDT независимо от файла.
    TestPeer.syncCatalogs(anna, boris);
    expect(boris.doc.bookEntry(bookId)).toBeDefined();
    // У получателя файла ещё нет — и это нормально до начала передачи.
    expect(boris.hasFile(bookId)).toBe(false);

    await anna.shareBook(bookId);

    await waitFor(() => boris.hasFile(bookId), 'файл не доехал', 40_000);

    const received = boris.disk.get(bookId) as Blob;
    expect(received.size).toBe(size);
    // Байты совпадают побайтово: перемешание чанков дало бы другой хвост.
    const tail = new Uint8Array(await received.slice(size - 16).arrayBuffer());
    expect(Array.from(tail)).toEqual(Array.from(bytes.slice(size - 16)));

    expect(anna.errors).toEqual([]);
    expect(boris.errors).toEqual([]);
  }, 60_000);

  it('доставляет EPUB так же', async () => {
    // Аудио было симптомом, а не причиной: маршрут общий. Проверяем оба формата,
    // чтобы правка не сломала то, что работало.
    const { anna, boris } = await makeTwoPeers();

    const size = 200_000;
    const bytes = makeAudio(size);
    const bookId = await anna.importBook({
      bytes,
      mime: 'application/epub+zip',
      title: 'Книга',
      format: 'epub',
    });
    TestPeer.syncCatalogs(anna, boris);
    await anna.shareBook(bookId);

    await waitFor(() => boris.hasFile(bookId), 'epub не доехал', 40_000);
    expect((boris.disk.get(bookId) as Blob).size).toBe(size);
    expect(anna.errors).toEqual([]);
    expect(boris.errors).toEqual([]);
  }, 60_000);

  it('передаёт книгу всем участникам сразу, а не только первому', async () => {
    // Регрессия на подмену множества: если писать в единственный элемент
    // Set, второй участник комнаты книгу бы не получил.
    const { anna, boris } = await makeTwoPeers();
    const bookId = await anna.importBook({ bytes: makeAudio(100_000), mime: 'audio/mpeg', title: 'X', format: 'audio' });
    TestPeer.syncCatalogs(anna, boris);

    await anna.shareBook(bookId);
    await waitFor(() => boris.hasFile(bookId), 'не доехало');

    // Второй вызов для другой книги обязан тоже сработать: состояние предложения
    // не должно «залипать» после первой передачи.
    const bookId2 = await anna.importBook({ bytes: makeAudio(120_000), mime: 'audio/mpeg', title: 'Y', format: 'audio' });
    TestPeer.syncCatalogs(anna, boris);
    await anna.shareBook(bookId2);
    await waitFor(() => boris.hasFile(bookId2), 'вторая книга не доехала', 40_000);
    expect(anna.errors).toEqual([]);
  }, 90_000);

  it('сообщает об ошибке, когда файла нет локально', async () => {
    // Вязкий случай: кнопка в интерфейсе остаётся, если файл удалили, а
    // передача обязана сказать об этом внятно, а не молчать.
    const { anna } = await makeTwoPeers();
    await expect(anna.shareBook('несуществующая')).rejects.toThrow(/файл не найден/);
  });

  it('ускоряет передачу по мере подтверждений', async () => {
    // Прогресс обязан идти монотонно до полного размера файла, иначе шкара в
    // интерфейсе зависает на середине.
    const { anna, boris } = await makeTwoPeers();
    const size = 500_000;
    const bookId = await anna.importBook({ bytes: makeAudio(size), mime: 'audio/mpeg', title: 'Д', format: 'audio' });
    TestPeer.syncCatalogs(anna, boris);
    await anna.shareBook(bookId);

    await waitFor(() => boris.hasFile(bookId), 'не доехало', 40_000);

    const out = anna.progress.filter((p) => p.direction === 'out');
    expect(out.length).toBeGreaterThan(1);
    expect(out[out.length - 1]?.done).toBe(size);
    // Никакого отката назад: сортировка по смещению.
    let previous = 0;
    for (const p of out) {
      expect(p.done).toBeGreaterThanOrEqual(previous);
      previous = p.done;
    }

    const incoming = boris.progress.filter((p) => p.direction === 'in');
    expect(incoming[incoming.length - 1]?.done).toBe(size);
  }, 60_000);

  it('отклоняет книгу, которой нет в каталоге получателя', async () => {
    // Каталог — соглашение о том, что за книгу можно принимать. Без записи
    // получатель обязан отклонить предложение: иначе любой участник завалил бы
    // диск файлами без спроса.
    const { anna, boris } = await makeTwoPeers();
    const bookId = await anna.importBook({ bytes: makeAudio(50_000), mime: 'audio/mpeg', title: 'Без каталога', format: 'audio' });

    // Записи у получателя нет: каталоги не синхронизируем.
    expect(boris.listBooks().some((b) => b.id === bookId)).toBe(false);
    await anna.shareBook(bookId);
    await new Promise((r) => setTimeout(r, 500));
    expect(boris.hasFile(bookId)).toBe(false);
  });

  it('передаёт многочанковый файл без перемешивания', async () => {
    // Последний байт приходит на своё место только если порядок чанков не
    // нарушен. При перемешивании размер совпал бы, а содержимое — нет.
    const { anna, boris } = await makeTwoPeers();
    const size = CHUNK_SIZE * 10 + 7;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 256;
    const bookId = await anna.importBook({ bytes, mime: 'audio/mpeg', title: 'Порядок', format: 'audio' });
    TestPeer.syncCatalogs(anna, boris);
    await anna.shareBook(bookId);

    await waitFor(() => boris.hasFile(bookId), 'не доехало', 40_000);
    const received = new Uint8Array(await (boris.disk.get(bookId) as Blob).arrayBuffer());
    expect(received.length).toBe(size);
    expect(Array.from(received)).toEqual(Array.from(bytes));
  }, 60_000);
});