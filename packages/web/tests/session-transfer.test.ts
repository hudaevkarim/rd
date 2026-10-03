/**
 * Сквозной тест настоящей RoomSession: две сессии в одной комнате, реальный
 * FileTransferManager, реальный Dexie поверх fake-indexeddb, настоящий Yjs.
 *
 * Подменён только WebRTC (in-memory) и WebSocket-сигналинг (память). Всё
 * остальное — боевой код сессии, включая `createSink`, `shareBook`,
 * `importBook` и проверку каталога. Это единственный способ поймать баг,
 * который живёт на стыке web-слоя и передачи файлов: по отдельности каждый
 * кусок проходил проверки.
 *
 * ─── Что ловилось ─────────────────────────────────────────────────────────────
 *
 * Пользователь загружал аудиокнигу, оба участника видели «передать участникам»,
 * но файл не доходил. При этом запись КНИГИ в каталоге приезжала — то есть CRDT
 * работал, а сама передача начиналась и не завершалась.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, newId } from '@rd/protocol';
import { MockRtcNetwork } from '../../p2p/tests/mock-webrtc.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { blobSource, createLibraryStore, RoomDoc } from '@rd/library';
import type { TransferSource } from '@rd/p2p';
import { RoomSession } from '../src/room-session.js';

const cleanup: Array<() => void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    try {
      await fn?.();
    } catch {
      // Уборка не должна маскировать результат теста.
    }
  }
});

async function waitFor(pred: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Pair {
  anna: RoomSession;
  boris: RoomSession;
}

async function makeSessions(): Promise<Pair> {
  const roomId = newId();
  const passphrase = 'север-берег-звезда-улица';
  const network = new MockRtcNetwork({ mode: 'instant' });
  const signalRoom = new MemorySignalRoom();

  // У каждой сессии своя база: иначе они видели бы одну и ту же «память»,
  // и приём выглядел бы успешным без всякой передачи.
  const make = async (name: string, color: string): Promise<RoomSession> => {
    const store = createLibraryStore(`sess-${name}-${Math.random().toString(36).slice(2)}`);
    const session = await RoomSession.create(
      {
        roomId,
        passphrase,
        name,
        color,
        signalingUrl: 'ws://неиспользуется.invalid',
      },
      () => {},
      {
        store,
        // Сигналинг в памяти: transport получает свой descriptor от сессии.
        transport: (descriptor) => new MemorySignalTransport(descriptor, signalRoom),
        rtc: network.factory,
        // 600 тысяч итераций PBKDF2 на каждый тест — минута ожидания вместо
        // десятков миллисекунд. Криптография проверена отдельно.
        kdfIterations: 1_000,
        iceServers: [],
      },
    );
    cleanup.push(async () => {
      await session.stop();
      await store.clearRoom(roomId).catch(() => {});
      await store.db.delete().catch(() => {});
    });
    return session;
  };

  // Второй заходит первым: так проверяется ветка «новый участник инициирует
  // предложение», а не только «оба подключились одновременно».
  const boris = await make('Борис', '#f59e0b');
  const anna = await make('Аня', '#3b82f6');

  await waitFor(
    () => anna.state.peers.some((p) => p.state === 'ready') && boris.state.peers.some((p) => p.state === 'ready'),
    'пиры не соединились',
  );
  return { anna, boris };
}

/** Файл для импорта: Node не умеет File, поэтому собираем подобие. */
function fakeFile(name: string, size: number, type: string): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 17) % 251;
  const blob = new Blob([bytes as unknown as ArrayBuffer], { type });
  // File в Node 22 есть, но без полного API — достаточно имени, типа и arrayBuffer.
  return Object.assign(blob, { name, lastModified: Date.now() }) as unknown as File;
}

/**
 * Полный путь передачи по требованию: получатель просит, владелец соглашается.
 *
 * Вынесено, потому что порядок именно такой и нарушение его — отдельный баг
 * (книга уезжала всем подряд, минуя запрос). Повторять его вручную в каждом
 * тесте значило бы однажды забыть и снова получить молчаливую передачу.
 */
async function requestAndShare(owner: RoomSession, receiver: RoomSession, bookId: string): Promise<void> {
  receiver.requestBook(bookId);
  await waitFor(
    () => (owner.state.incomingRequests[bookId] ?? []).length > 0,
    'владелец не увидел запрос',
    20_000,
  );
  await owner.shareBook(bookId);
}

describe('передача файла между настоящими сессиями', () => {
  it('доставляет аудиокнигу получателю целиком', async () => {
    const { anna, boris } = await makeSessions();

    // Имя короче лимита протокола (200 символов): длинное имя отбрасывалось
    // валидацией у получателя, и предложение не доходило вовсе. Это отдельная
    // проверка — см. local-files.test.ts.
    const size = 400_000;
    const file = fakeFile('Лекции.mp3', size, 'audio/mpeg');
    const bookId = await anna.importBook(file);

    // Каталог едет по CRDT сам, но для надёжности теста ждём его появления:
    // без записи в каталоге получатель по замыслу отклоняет файл.
    await waitFor(() => boris.state.books.some((b) => b.id === bookId), 'каталог не синхронизирован');
    expect(boris.state.localFiles).not.toContain(bookId);

    // Передача по требованию: сначала запрос, потом согласие владельца.
    await requestAndShare(anna, boris, bookId);

    await waitFor(
      () => boris.state.localFiles.includes(bookId),
      `файл не доехал; ошибки: ${boris.state.warnings.join(' | ')}`,
      40_000,
    );

    const stored = await boris.readLocalBook(bookId);
    expect(stored).not.toBeNull();
    expect(stored?.blob?.size).toBe(size);

    // Байты совпадают: перемешание чанков дало бы верный размер и чужое
    // содержимое, что заметно только при сравнении.
    if (stored?.blob !== null && stored?.blob !== undefined) {
      const got = new Uint8Array(await stored.blob.arrayBuffer());
      const want = new Uint8Array(await file.arrayBuffer());
      expect(hash(got)).toBe(hash(want));
    }

    // Предупреждений быть не должно. Проверяем именно факт ошибок передачи,
    // а не пустой список: в Node нет <audio>, поэтому импорт аудио честно
    // предупреждает, что длительность не определилась. Это другое сообщение.
    expect(transferErrors(anna)).toEqual([]);
    expect(transferErrors(boris)).toEqual([]);
  }, 90_000);

  it('доставляет EPUB так же, как аудиокнигу', async () => {
    // Маршрут общий; проверяем оба формата, чтобы правка одного не сломала
    // другой.
    const { anna, boris } = await makeSessions();

    // Минимальный валидный EPUB: zip с container.xml и OPF. Размер известен
    // только после сборки, поэтому сверяем с фактическим.
    const epub = buildMinimalEpub(120_000);
    const expectedSize = epub.size;
    const bookId = await anna.importBook(epub);
    await waitFor(() => boris.state.books.some((b) => b.id === bookId), 'каталог не синхронизирован');

    await requestAndShare(anna, boris, bookId);
    await waitFor(
      () => boris.state.localFiles.includes(bookId),
      `epub не доехал; ошибки: ${boris.state.warnings.join(' | ')}`,
      40_000,
    );

    const stored = await boris.readLocalBook(bookId);
    expect(stored?.blob?.size).toBe(expectedSize);
    expect(transferErrors(boris)).toEqual([]);
  }, 90_000);

  it('передаёт книгу с длинным названием', async () => {
    // Регрессия на молчаливую потерю передачи.
    //
    // Имя файла приходит с диска и не ограничено ничем: 204 символа плюс
    // расширение превышали лимит протокола (200), предложение отбрасывалось
    // валидацией у получателя — и вместе с ним рвался весь канал управления.
    // Снаружи это выглядело так: каталог синхронизировался (значит, «файл
    // передался»), а сам файл не доходил никогда.
    const { anna, boris } = await makeSessions();
    const longName = `${'Очень длинное название аудиокниги '.repeat(9).trim()}.mp3`;
    expect(longName.length).toBeGreaterThan(200);

    const bookId = await anna.importBook(fakeFile(longName, 150_000, 'audio/mpeg'));
    await waitFor(() => boris.state.books.some((b) => b.id === bookId), 'каталог не синхронизирован');
    await requestAndShare(anna, boris, bookId);

    await waitFor(
      () => boris.state.localFiles.includes(bookId),
      `файл с длинным именем не доехал; ошибки: ${transferErrors(boris).join(' | ')}`,
      40_000,
    );
    expect((await boris.readLocalBook(bookId))?.blob?.size).toBe(150_000);
    expect(transferErrors(boris)).toEqual([]);
  }, 90_000);

  it('отклоняет файл, которого нет в каталоге комнаты', async () => {
    // Защита от забивания диска чужими файлами: без записи в общем каталоге
    // предложение не принимается.
    //
    // Каталог у получателя намеренно очищается ДО передачи. Проверять на гонке
    // «успел ли CRDT-обмен» бессмысленно: обмен занимает доли секунды, и такой
    // тест проверял бы тайминг, а не защиту.
    const { anna, boris } = await makeSessions();
    const bookId = await anna.importBook(fakeFile('Тайная.mp3', 100_000, 'audio/mpeg'));
    await waitFor(() => boris.state.books.some((b) => b.id === bookId), 'каталог не синхронизирован');

    // Убираем запись у получателя. Через CRDT она вернулась бы немедленно,
    // поэтому правим документ напрямую и сразу шлём предложение.
    (boris as unknown as { doc: RoomDoc }).doc.removeBook(bookId);
    await new Promise((r) => setTimeout(r, 200));
    expect(boris.state.books.some((b) => b.id === bookId)).toBe(false);

    // Предложение отправляем напрямую: shareBook у отправителя проверяет
    // КАТАЛОГ СВОЕГО документа, а там запись есть. Проверяется именно защита
    // приёма у получателя.
    const stored = await anna.readLocalBook(bookId);
    expect(stored?.blob).not.toBeNull();
    await anna.transfers.share({
      bookId,
      name: 'Тайная.mp3',
      mime: stored?.mime ?? 'audio/mpeg',
      source: blobSource(stored?.blob as Blob) as TransferSource,
    });

    await new Promise((r) => setTimeout(r, 1500));

    expect(boris.state.localFiles).not.toContain(bookId);
    expect(await boris.readLocalBook(bookId)).toBeNull();
  }, 60_000);

  it('передаёт книгу, добавленную после синхронизации каталога', async () => {
    // Обратный случай предыдущего теста: каталог дошёл, значит файл принимается.
    // Вместе они показывают, что решает именно наличие записи, а не гонка.
    const { anna, boris } = await makeSessions();
    const bookId = await anna.importBook(fakeFile('Поздняя.mp3', 120_000, 'audio/mpeg'));
    await waitFor(() => boris.state.books.some((b) => b.id === bookId), 'каталог не синхронизирован');
    await requestAndShare(anna, boris, bookId);
    await waitFor(() => boris.state.localFiles.includes(bookId), 'не доехало', 40_000);
  }, 90_000);

  it('передаёт две книги подряд', async () => {
    // Состояние предложения не должно «залипать» после первой передачи:
    // вторую книгу отправить можно было нельзя.
    const { anna, boris } = await makeSessions();

    for (const [name, size] of [
      ['Первая.mp3', 150_000],
      ['Вторая.mp3', 200_000],
    ] as const) {
      const bookId = await anna.importBook(fakeFile(name, size, 'audio/mpeg'));
      await waitFor(() => boris.state.books.some((b) => b.id === bookId), `каталог не синхронизирован: ${name}`);
      await requestAndShare(anna, boris, bookId);
      await waitFor(
        () => boris.state.localFiles.includes(bookId),
        `${name} не доехала; ошибки: ${boris.state.warnings.join(' | ')}`,
        40_000,
      );
      expect((await boris.readLocalBook(bookId))?.blob?.size).toBe(size);
    }
    expect(transferErrors(anna)).toEqual([]);
  }, 120_000);

  it('не теряет порядок чанков на файле в 10+ чанков', async () => {
    const { anna, boris } = await makeSessions();
    const size = CHUNK_SIZE * 12 + 5;
    const file = fakeFile('Длинная.mp3', size, 'audio/mpeg');
    const bookId = await anna.importBook(file);
    await waitFor(() => boris.state.books.some((b) => b.id === bookId), 'каталог не синхронизирован');

    await requestAndShare(anna, boris, bookId);
    await waitFor(() => boris.state.localFiles.includes(bookId), 'не доехало', 40_000);

    const stored = await boris.readLocalBook(bookId);
    const got = new Uint8Array(await (stored?.blob as Blob).arrayBuffer());
    const want = new Uint8Array(await file.arrayBuffer());
    expect(got).toHaveLength(want.length);
    expect(Array.from(got)).toEqual(Array.from(want));
  }, 90_000);
});

/** Минимальный EPUB нужного размера: zip с mimetype, container.xml и OPF. */
function buildMinimalEpub(totalSize: number): File {
  const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Тест</dc:title><dc:creator>А</dc:creator></metadata>
  <manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  const padding = Math.max(0, totalSize - container.length - opf.length - 64);
  const chapter = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${'я'.repeat(
    Math.max(1, Math.floor(padding / 2)),
  )}</p></body></html>`;

  // Собираем zip вручную: без stored-методов достаточно «магических» сигнатур.
  const files: Array<[string, string]> = [
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', container],
    ['OEBPS/content.opf', opf],
    ['OEBPS/ch1.xhtml', chapter],
  ];
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // версия
    lv.setUint16(8, 0, true); // без сжатия
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    parts.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    all.set(p, at);
    at += p.length;
  }
  return new File([all as unknown as ArrayBuffer], 'test.epub', { type: 'application/epub+zip' });
}

/**
 * Ошибки передачи, а не все предупреждения.
 *
 * В Node нет `<audio>`, поэтому импорт аудиокниги честно предупреждает, что
 * длительность не определилась. Это не ошибка передачи, и проверять её здесь
 * незачем — она покрыта отдельно.
 */
function transferErrors(session: RoomSession): string[] {
  // Пока идёт проверка, состояние сессии содержит и служебные сообщения:
  // без <audio> длительность не определяется, а по окончании теста соединение
  // закрывается. Ошибки передачи узнаём по конкретным словам, а не по слову
  // «файл» — оно встречается и в безобидных сообщениях.
  return session.state.warnings.filter((w) =>
    /прервана|не опустел|не подтвердил|повреждён|докачк|не принял/i.test(w),
  );
}

/** Короткий дайджест для сравнения: полный массив в выводе нечитаем. */
function hash(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${data.length}:${h.toString(16)}`;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] as number;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}