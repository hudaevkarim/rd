/**
 * Сквозной тест P2P-стека: две «ноды» в одной комнате проходят путь
 * подключение → E2EE-рукопожатие → Yjs-синхронизация → передача файла.
 *
 * Это самый ценный тест проекта: он проверяет не отдельные функции, а то, что
 * они стыкуются. Ошибки, которые он ловит (несовпадение направлений ключей,
 * потерянный заголовок кадра, зацикливание broadcast), невозможно увидеть в
 * юнит-тестах по отдельности.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, newId, type PeerDescriptor } from '@rd/protocol';
import { createPeerIdentity, derivePassKey, sha256, toHex, concat } from '@rd/crypto';
import {
  FileTransferManager,
  RoomMesh,
  YRoomProvider,
  computeRoot,
  uuidToBytes,
  type RoomPeerInfo,
  type TransferSink,
  type TransferSource,
} from '@rd/p2p';
import { RoomDoc } from '@rd/library';
import { MockRtcNetwork } from './mock-webrtc.js';
import { MemorySignalRoom, makeTransport, waitFor } from './loopback-signal.js';

const FAST_KDF = 1_000;

interface Node {
  mesh: RoomMesh;
  provider: YRoomProvider;
  room: RoomDoc;
  peers: RoomPeerInfo[];
  chats: string[];
  warnings: string[];
  safety: Map<string, string>;
  dispose(): void;
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    try {
      fn?.();
    } catch {
      // Тест уже падает или проходит — уборка не должна его маскировать.
    }
  }
});

async function makeNode(params: {
  roomId: string;
  passKey: Uint8Array;
  network: MockRtcNetwork;
  signalRoom: MemorySignalRoom;
  identity: Awaited<ReturnType<typeof createPeerIdentity>>;
  name: string;
  color: string;
}): Promise<Node> {
  const descriptor: PeerDescriptor = {
    id: newId(),
    name: params.name,
    color: params.color,
    identityKey: toHex(params.identity.identityPubRaw),
    agreeKey: toHex(params.identity.agreePubRaw),
  };
  const transport = makeTransport(params.signalRoom, params.name, params.color, descriptor);

  const mesh = new RoomMesh({
    roomId: params.roomId,
    passKey: params.passKey,
    self: params.identity,
    transport,
    rtc: params.network.factory,
    pingIntervalMs: 60_000,
  });

  const peers: RoomPeerInfo[] = [];
  const chats: string[] = [];
  const warnings: string[] = [];
  const safety = new Map<string, string>();

  mesh.events.on('peers', (list) => {
    peers.length = 0;
    peers.push(...list);
  });
  mesh.events.on('ctrl', ({ peerId, payload }) => {
    if (payload.kind === 'json' && payload.msg.k === 'chat') {
      chats.push(`${peerId.slice(0, 4)}:${payload.msg.text}`);
    }
  });
  mesh.events.on('warning', (w) => warnings.push(w.message));
  mesh.events.on('safety', ({ peerId, code }) => safety.set(peerId, code));

  const room = new RoomDoc();
  // Провайдер обязан работать с ДОКУМЕНТОМ КОМНАТЫ, а не создавать свой:
  // иначе синхронизируется пустой документ, а комментарии остаются локальными.
  const provider = new YRoomProvider({ mesh, doc: room.doc });

  // Имя в presence проставляем после welcome: id пира известен только тогда.
  mesh.events.on('open', () => {
    provider.setLocalField('user', { name: params.name, color: params.color, peerId: mesh.self });
  });

  mesh.start();

  const node: Node = {
    mesh,
    provider,
    room,
    peers,
    chats,
    warnings,
    safety,
    dispose(): void {
      provider.destroy();
      mesh.stop();
      room.destroy();
    },
  };
  cleanup.push(() => node.dispose());
  return node;
}

async function pair(): Promise<{ a: Node; b: Node }> {
  const roomId = newId();
  const passphrase = 'север-берег-звезда-улица';
  const passKey = await derivePassKey(passphrase, roomId, FAST_KDF);
  const network = new MockRtcNetwork();
  const signalRoom = new MemorySignalRoom();

  const identityA = await createPeerIdentity();
  const identityB = await createPeerIdentity();

  // Второй заходит в комнату первым, первый подключается вторым: так проверяется
  // ветка «новый участник инициирует offer», а не только «оба сразу готовы».
  const b = await makeNode({ roomId, passKey, network, signalRoom, identity: identityB, name: 'Борис', color: '#f59e0b' });
  const a = await makeNode({ roomId, passKey, network, signalRoom, identity: identityA, name: 'Аня', color: '#3b82f6' });

  await waitFor(() => a.mesh.readyPeerCount === 1, 'пир A не готов');
  await waitFor(() => b.mesh.readyPeerCount === 1, 'пир B не готов');
  return { a, b };
}

describe('mesh из двух пиров', () => {
  it('устанавливает соединение и рукопожатие', async () => {
    const { a, b } = await pair();
    expect(a.mesh.peerCount).toBe(1);
    expect(b.mesh.peerCount).toBe(1);
    expect(a.mesh.readyPeers).toHaveLength(1);

    // Код безопасности обязан совпасть у обеих сторон: он выводится из
    // отсортированной пары ключей и не зависит от того, кто подключился первым.
    const codeA = [...a.safety.values()][0];
    const codeB = [...b.safety.values()][0];
    expect(codeA).toBeDefined();
    expect(codeA).toBe(codeB);
    expect(codeA).toMatch(/^\d{5} \d{5}$/);

    // Никаких предупреждений о рукопожатии быть не должно.
    expect(a.warnings).toEqual([]);
    expect(b.warnings).toEqual([]);
  });

  it('передаёт зашифрованные управляющие сообщения', async () => {
    const { a, b } = await pair();
    const peerB = a.mesh.readyPeers[0] as string;
    a.mesh.sendCtrlTo(peerB, { k: 'chat', id: newId(), text: 'привет из шифротекста', at: Date.now() });

    await waitFor(() => b.chats.length > 0, 'сообщение не доставлено');
    expect(b.chats[0]).toContain('привет из шифротекста');
  });

  it('синхронизирует комментарий между документами Yjs', async () => {
    const { a, b } = await pair();
    const bookId = a.room.addBook({
      title: 'Книга',
      author: 'Автор',
      format: 'epub',
      size: 10,
      mime: 'application/epub+zip',
      root: 'a'.repeat(64),
      addedBy: a.mesh.self,
      durationSec: null,
      note: '',
    });

    await waitFor(() => b.room.listBooks().length === 1, 'каталог не синхронизирован');
    expect(b.room.bookEntry(bookId)?.title).toBe('Книга');

    a.room.addComment({
      bookId,
      anchor: { kind: 'text', chapterIndex: 1, blockIndex: 4, start: 0, end: 5, quote: 'привет', prefix: '', suffix: '' },
      body: 'Вот тут я споткнулся',
      authorId: a.mesh.self,
      authorName: 'Аня',
    });

    await waitFor(() => b.room.commentsForBook(bookId).length === 1, 'комментарий не пришёл');
    const got = b.room.commentsForBook(bookId)[0];
    expect(got?.body).toBe('Вот тут я споткнулся');
    expect(got?.anchor.kind).toBe('text');
  });

  it('обменивается комментариями в обе стороны без конфликта', async () => {
    const { a, b } = await pair();
    const bookId = a.room.addBook({
      title: 'Книга',
      author: 'Автор',
      format: 'epub',
      size: 10,
      mime: 'application/epub+zip',
      root: 'b'.repeat(64),
      addedBy: a.mesh.self,
      durationSec: null,
      note: '',
    });
    await waitFor(() => b.room.bookEntry(bookId) !== undefined, 'каталог не синхронизирован');

    // Оба пира пишут ОДНОВРЕМЕННО. Yjs должен дать оба комментария.
    a.room.addComment({
      bookId,
      anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 3, quote: 'раз', prefix: '', suffix: '' },
      body: 'от Ани',
      authorId: a.mesh.self,
      authorName: 'Аня',
    });
    b.room.addComment({
      bookId,
      anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 3, quote: 'два', prefix: '', suffix: '' },
      body: 'от Бориса',
      authorId: b.mesh.self,
      authorName: 'Борис',
    });

    await waitFor(() => a.room.commentsForBook(bookId).length === 2, 'Аня не увидела комментарий Бориса');
    await waitFor(() => b.room.commentsForBook(bookId).length === 2, 'Борис не увидел комментарий Ани');

    const bodiesA = a.room.commentsForBook(bookId).map((c) => c.body).sort();
    expect(bodiesA).toEqual(['от Ани', 'от Бориса']);
  });

  it('передаёт файл чанками и проверяет контрольную сумму', async () => {
    const { a, b } = await pair();

    // 100 КиБ — это 7 чанков по 16 КиБ, то есть проверяется и частичная
    // передача, и граница между последним полным и коротким чанком.
    const size = 100_000;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31) % 251;

    const source: TransferSource = {
      size,
      slice: async (start, end) => bytes.subarray(start, Math.min(end, size)),
    };
    const expectedRoot = await computeRoot(source, CHUNK_SIZE);

    const received: Uint8Array[] = [];
    let finishedRoot: string | null = null;
    let abortReason: string | null = null;
    const sink: TransferSink = {
      received: 0,
      hashes: async () => [],
      write: async (offset, data) => {
        expect(offset).toBe(received.reduce((sum, part) => sum + part.length, 0));
        received.push(data.slice());
      },
      finish: async () => {
        const joined = new Uint8Array(received.reduce((sum, part) => sum + part.length, 0));
        let pos = 0;
        for (const part of received) {
          joined.set(part, pos);
          pos += part.length;
        }
        expect(joined.length).toBe(size);
        expect(Array.from(joined.subarray(0, 32))).toEqual(Array.from(bytes.subarray(0, 32)));
        expect(Array.from(joined.subarray(size - 16))).toEqual(Array.from(bytes.subarray(size - 16)));
        finishedRoot = toHex(await sha256OfChunks(received));
      },
      abort: async (reason) => {
        abortReason = reason;
      },
    };

    const transfersA = new FileTransferManager({
      mesh: a.mesh,
      createSink: async () => sink,
      findPartial: async () => 0,
      resolveSource: async () => null,
    });
    const transfersB = new FileTransferManager({
      mesh: b.mesh,
      createSink: async () => sink,
      findPartial: async () => 0,
      resolveSource: async () => null,
    });
    const failures: string[] = [];
    transfersA.events.on('error', (e) => failures.push(`A: ${e.message}`));
    transfersB.events.on('error', (e) => failures.push(`B: ${e.message}`));
    transfersA.start();
    transfersB.start();
    cleanup.push(() => {
      transfersA.stop();
      transfersB.stop();
    });

    const offer = await transfersA.share({
      bookId: newId(),
      name: 'книга.epub',
      mime: 'application/epub+zip',
      source,
      root: expectedRoot,
    });

    expect(offer.chunkCount).toBe(Math.ceil(size / CHUNK_SIZE));
    await waitFor(() => finishedRoot !== null || failures.length > 0, `файл не докачан (прервано: ${String(abortReason)})`);
    expect(failures).toEqual([]);
    expect(abortReason).toBeNull();
    expect(finishedRoot).toBe(expectedRoot);
  });

  it('докачивает файл с места обрыва', async () => {
    const { a, b } = await pair();
    const size = 50_000;
    const bytes = new Uint8Array(size).fill(9);
    const source: TransferSource = { size, slice: async (s, e) => bytes.subarray(s, Math.min(e, size)) };
    const root = await computeRoot(source, CHUNK_SIZE);

    // Получатель «уже имеет» первые два чанка от прошлой попытки, вместе с их
    // хешами: без них общую контрольную сумму не собрать.
    const partial = CHUNK_SIZE * 2;
    const preHashes: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) preHashes.push(await sha256(bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)));
    // Уже принятые данные лежат ДВУМЯ кусками по 16 КиБ, а не одним блоком:
    // хеш-цепочка строится по границам чанков, иначе контрольная сумма не сойдётся.
    const received: Uint8Array[] = [bytes.slice(0, CHUNK_SIZE), bytes.slice(CHUNK_SIZE, partial)];
    let abortReason: string | null = null;
    const sink: TransferSink = {
      received: partial,
      hashes: async () => preHashes,
      write: async (offset, data) => {
        expect(offset).toBe(partial + received.reduce((s, p) => s + p.length, 0) - partial);
        received.push(data.slice());
      },
      finish: async () => {
        expect(toHex(await sha256OfChunks(received))).toBe(root);
      },
      abort: async (reason) => {
        abortReason = reason;
      },
    };

    const transfersA = new FileTransferManager({
      mesh: a.mesh,
      createSink: async () => sink,
      findPartial: async () => 0,
      resolveSource: async () => null,
    });
    const transfersB = new FileTransferManager({
      mesh: b.mesh,
      createSink: async () => sink,
      // Отвечаем, что у нас уже есть 32 КиБ.
      findPartial: async () => partial,
      resolveSource: async () => null,
    });
    transfersA.start();
    transfersB.start();
    cleanup.push(() => {
      transfersA.stop();
      transfersB.stop();
    });

    let done = false;
    transfersB.events.on('complete', () => {
      done = true;
    });
    // Ошибки передачи не должны оставаться незамеченными: иначе тест падает
    // по таймауту «докачка не завершилась» без указания настоящей причины.
    const failures: string[] = [];
    transfersA.events.on('error', (e) => failures.push(`A: ${e.message}`));
    transfersB.events.on('error', (e) => failures.push(`B: ${e.message}`));

    await transfersA.share({ bookId: newId(), name: 'book.epub', mime: 'application/epub+zip', source, root });
    await waitFor(() => done || failures.length > 0, 'докачка не завершилась');
    expect(failures).toEqual([]);
    expect(abortReason).toBeNull();
  });

  it('передаёт UUID трансфера в кадре без потерь', () => {
    const id = newId();
    expect(Array.from(uuidToBytes(id))).toHaveLength(16);
    expect(uuidToBytes(id)[6]).toBe(parseInt(id.slice(14, 16), 16));
  });
});

async function sha256OfChunks(parts: Uint8Array[]): Promise<Uint8Array> {
  const hashes: Uint8Array[] = [];
  for (const part of parts) hashes.push(await sha256(part));
  return sha256(concat(...hashes));
}
