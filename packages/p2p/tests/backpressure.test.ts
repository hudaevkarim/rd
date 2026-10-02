/**
 * Регрессия: передача файла не должна вставать на живом WebRTC-канале.
 *
 * ─── Что здесь ловится ────────────────────────────────────────────────────────
 *
 * Старый код отправлял чанк и ждал `waitFileDrained()` — полного опустошения
 * очереди. Ожидание снималось событием `bufferedamountlow`, настроенным на
 * порог 256 КиБ, тогда как очередь никогда не превышала один чанк (16 КиБ).
 * По спецификации WebRTC это событие срабатывает ТОЛЬКО при переходе строго
 * выше порога, поэтому оно не приходило никогда: передача зависала намертво
 * после первого чанка, у которого буфер не успел опустеть.
 *
 * В `mock-webrtc.ts` в режиме `instant` бафа уходят мгновенно, поэтому старый
 * код проходил тесты. Ниже сеть настоящая: очередь растёт, убывает по тикам,
 * событие ведёт себя по спеке, а получатель задерживает обработку — то есть
 * давление на отправителя ровно такое, как в жизни.
 *
 * Проверяется не «тест зелёный», а конкретные свойства: файл доехал целиком,
 * очередь не переполнилась, событие действительно срабатывало, а паузы
 * отправителя происходили (иначе тест прошёл бы и с мёртвым backpressure).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, newId, type PeerDescriptor } from '@rd/protocol';
import { createPeerIdentity, derivePassKey, toHex } from '@rd/crypto';
import {
  ACK_TIMEOUT_MS,
  CAPACITY_TIMEOUT_MS,
  DEFAULT_WINDOW_BYTES,
  FileTransferManager,
  RoomMesh,
  computeRoot,
  FILE_HIGH_WATER_MARK,
  FILE_LOW_WATER_MARK,
  type TransferSink,
  type TransferSource,
} from '@rd/p2p';
import { MockRtcNetwork, type MockNetConfig } from './mock-webrtc.js';
import { MemorySignalRoom, makeTransport, waitFor } from './loopback-signal.js';

const FAST_KDF = 1_000;
const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    try {
      fn?.();
    } catch {
      // Уборка не должна маскировать результат теста.
    }
  }
});

interface Pair {
  a: RoomMesh;
  b: RoomMesh;
  network: MockRtcNetwork;
}

/** Две ноды в комнате, соединённые через mock-сеть с заданным поведением. */
async function makePair(net: MockNetConfig): Promise<Pair> {
  const roomId = newId();
  const passKey = await derivePassKey('север-берег-звезда-улица', roomId, FAST_KDF);
  const network = new MockRtcNetwork(net);
  const signalRoom = new MemorySignalRoom();

  const identityA = await createPeerIdentity();
  const identityB = await createPeerIdentity();

  const build = async (identity: typeof identityA, name: string, color: string): Promise<RoomMesh> => {
    const descriptor: PeerDescriptor = {
      id: newId(),
      name,
      color,
      identityKey: toHex(identity.identityPubRaw),
      agreeKey: toHex(identity.agreePubRaw),
    };
    const mesh = new RoomMesh({
      roomId,
      passKey,
      self: identity,
      transport: makeTransport(signalRoom, name, color, descriptor),
      rtc: network.factory,
      pingIntervalMs: 60_000,
    });
    mesh.start();
    cleanup.push(() => mesh.stop());
    return mesh;
  };

  const b = await build(identityB, 'Борис', '#f59e0b');
  const a = await build(identityA, 'Аня', '#3b82f6');
  await waitFor(() => a.readyPeerCount === 1, 'пир A не готов');
  await waitFor(() => b.readyPeerCount === 1, 'пир B не готов');
  return { a, b, network };
}

interface TransferResult {
  received: Uint8Array[];
  root: string | null;
  abortReason: string | null;
  failures: string[];
  /** Момент времени, когда приём завершился, мс. */
  doneAt: number;
  startedAt: number;
}

async function transferFile(
  pair: Pair,
  bytes: Uint8Array,
  opts: { writeDelayMs?: number } = {},
): Promise<TransferResult> {
  const startedAt = Date.now();
  const size = bytes.length;
  const source: TransferSource = {
    size,
    slice: async (s, e) => bytes.subarray(s, Math.min(e, size)),
  };
  const expectedRoot = await computeRoot(source, CHUNK_SIZE);

  const received: Uint8Array[] = [];
  const failures: string[] = [];
  let root: string | null = null;
  let abortReason: string | null = null;
  let doneAt = 0;

  const sink: TransferSink = {
    received: 0,
    hashes: async () => [],
    write: async (_offset, data) => {
      // Искусственная задержка записи — получатель «тяжёлый», как на реальном
      // диске или в фоновой вкладке. Из-за неё ACK приходят медленно, и окно
      // отправителя обязано сузиться, а не забить получателя.
      if (opts.writeDelayMs !== undefined && opts.writeDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.writeDelayMs));
      }
      received.push(data.slice());
    },
    finish: async () => {
      const joined = new Uint8Array(received.reduce((s, p) => s + p.length, 0));
      let pos = 0;
      for (const part of received) {
        joined.set(part, pos);
        pos += part.length;
      }
      const { sha256 } = await import('@rd/crypto');
      const hashes: Uint8Array[] = [];
      for (let i = 0; i < joined.length; i += CHUNK_SIZE) {
        hashes.push(await sha256(joined.subarray(i, Math.min(i + CHUNK_SIZE, joined.length))));
      }
      const { concat } = await import('@rd/crypto');
      root = toHex(await sha256(concat(...hashes)));
      doneAt = Date.now();
    },
    abort: async (reason) => {
      abortReason = reason;
    },
  };

  const sender = new FileTransferManager({ mesh: pair.a, createSink: async () => null, findPartial: async () => 0, resolveSource: async () => null });
  const receiver = new FileTransferManager({
    mesh: pair.b,
    createSink: async () => sink,
    findPartial: async () => 0,
    resolveSource: async () => null,
  });
  sender.events.on('error', (e) => failures.push(`A: ${e.message}`));
  receiver.events.on('error', (e) => failures.push(`B: ${e.message}`));
  sender.start();
  receiver.start();
  cleanup.push(() => {
    sender.stop();
    receiver.stop();
  });

  await sender.share({
    bookId: newId(),
    name: 'книга.epub',
    mime: 'application/epub+zip',
    source,
    root: expectedRoot,
  });

  await waitFor(
    () => root !== null || abortReason !== null || failures.length > 0,
    'файл не докачан',
    60_000,
  );

  return { received, root, abortReason, failures, doneAt, startedAt };
}

function makeBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31) % 251;
  return bytes;
}

describe('передача файла на ограниченном канале', () => {
  it('пишет в журнал номер чанка, размер буфера и паузы', async () => {
    // Пользователь при зависшей передаче должен видеть, ГДЕ именно она встала.
    // Без журнала диагностика сводится к «передача не идёт», а по исходному
    // багу это была зависшая блокировка — её невозможно отличить по картинке.
    const traces: string[] = [];
    // Сеть заметно медленнее отправителя, но не настолько, чтобы время теста
    // зависело от скорости машины. Раньше здесь было 4 КиБ за тик и 900 КиБ
    // файла: это ~220 тиков по 1 мс плюс ожидания, и на загруженной машине тест
    // доходил до потолка 60 с, не проверив ничего. Свойство, которое тут
    // проверяется, — СОДЕРЖИМОЕ журнала, а для него достаточно файла заметно
    // больше окна (256 КиБ) и сети, которая не успевает за отправителем.
    const pair = await makePair({ mode: 'throttled', bytesPerTick: 16 * 1024 });

    const bytes = makeBytes(500_000);
    const source: TransferSource = {
      size: bytes.length,
      slice: async (s, e) => bytes.subarray(s, Math.min(e, bytes.length)),
    };
    const sink: TransferSink = {
      received: 0,
      hashes: async () => [],
      write: async (_o, d) => void d,
      finish: async () => {},
      abort: async () => {},
    };

    const sender = new FileTransferManager({
      mesh: pair.a,
      createSink: async () => null,
      findPartial: async () => 0,
      resolveSource: async () => null,
      onTrace: (m) => traces.push(m),
    });
    const receiver = new FileTransferManager({
      mesh: pair.b,
      createSink: async () => sink,
      findPartial: async () => 0,
      resolveSource: async () => null,
      onTrace: (m) => traces.push(m),
    });
    sender.events.on('error', () => {});
    receiver.events.on('error', () => {});
    sender.start();
    receiver.start();
    cleanup.push(() => {
      sender.stop();
      receiver.stop();
    });

    await sender.share({
      bookId: newId(),
      name: 'книга.epub',
      mime: 'application/epub+zip',
      source,
      root: await computeRoot(source, CHUNK_SIZE),
    });
    await waitFor(() => traces.some((m) => m.includes('завершена')), 'передача не завершилась', 30_000);

    const joined = traces.join('\n');
    // Номер чанка и текущий объём — по ним видно точку остановки.
    expect(joined).toMatch(/чанк #\d+/);
    expect(joined).toMatch(/\d+\/\d+/);
    // Размер буфера отправки вместе с порогом.
    expect(joined).toMatch(/буфер \d+\/\d+/);
    // Сеть медленнее отправителя, поэтому отправитель обязан был где-то
    // притормозить: либо по окну подтверждений, либо по буферу канала.
    expect(joined).toMatch(/пауз [1-9]\d*/);
  }, 60_000);

  it('доезжает целиком, когда сеть медленнее отправителя', async () => {
    // Сеть отдаёт 8 КиБ за тик, чанк — 16 КиБ: отправитель заведомо быстрее
    // канала, и буфер обязан расти. Старый код на этом зависал.
    const pair = await makePair({ mode: 'throttled', bytesPerTick: 8 * 1024 });
    const bytes = makeBytes(300_000); // ~19 чанков

    const result = await transferFile(pair, bytes);

    expect(result.failures).toEqual([]);
    expect(result.abortReason).toBeNull();
    expect(result.root).not.toBeNull();
    expect(result.received.reduce((s, p) => s + p.length, 0)).toBe(bytes.length);

    // Очередь отправки не должна была переполниться: backpressure обязан
    // сработать. Без него пик упирается в размер всего файла.
    const peak = pair.network.peakBuffered();
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(FILE_HIGH_WATER_MARK + CHUNK_SIZE);

    // И событие действительно сработало — ради него весь механизм и затевался.
    const lowEvents = pair.network.channelsLabelled('rd-file').reduce((n, c) => n + c.lowEvents, 0);
    expect(lowEvents).toBeGreaterThan(0);
  }, 60_000);

  it('не ждёт полного опустошения буфера между чанками', async () => {
    const pair = await makePair({ mode: 'throttled', bytesPerTick: 64 * 1024 });
    const bytes = makeBytes(400_000); // 25 чанков

    const started = Date.now();
    const result = await transferFile(pair, bytes);
    const elapsed = Date.now() - started;

    expect(result.failures).toEqual([]);
    expect(result.root).not.toBeNull();

    // При поштучном ожидании опустошения каждый чанк ждал бы полный тик сети.
    // Скользящее окно отправляет пачками, поэтому 400 КБ на быстром mock-е
    // обязаны уложиться в разумное время, а не в сотни тиков.
    expect(elapsed).toBeLessThan(15_000);
    // Окно позволяло держать в канале больше, чем один чанк: значит, передача
    // шла пачками, а не «отправил-подождал».
    expect(pair.network.peakBuffered()).toBeGreaterThan(CHUNK_SIZE);
  }, 60_000);

  it('передаёт файл, когда получатель медленно пишет в хранилище', async () => {
    // Окно по ACK — то, что удерживает получателя: без него отправитель забил бы
    // канал, пока тот пишет в IndexedDB.
    const pair = await makePair({ mode: 'slow', bytesPerTick: 16 * 1024, deliverDelayMs: 2 });
    const bytes = makeBytes(200_000);

    const result = await transferFile(pair, bytes, { writeDelayMs: 3 });

    expect(result.failures).toEqual([]);
    expect(result.abortReason).toBeNull();
    expect(result.root).not.toBeNull();
    expect(result.received.reduce((s, p) => s + p.length, 0)).toBe(bytes.length);
  }, 60_000);

  it('не плодит циклы отправки, когда пир просит докачку', async () => {
    // Регрессия на петлю: запрос докачки поверх идущей передачи запускал второй
    // цикл отправки. Два цикла отправляли чанки вперемешку, получатель видел
    // рассинхрон и просил докачку ещё раз — на каждый запрос рождался новый цикл.
    // На быстром mock это успевало затушить, на медленном сети ловило минутную
    // серию ошибок.
    const traces: string[] = [];
    const pair = await makePair({ mode: 'slow', bytesPerTick: 16 * 1024, deliverDelayMs: 2 });

    const bytes = makeBytes(400_000);
    const source: TransferSource = {
      size: bytes.length,
      slice: async (s, e) => bytes.subarray(s, Math.min(e, bytes.length)),
    };
    let received = 0;
    let done = false;
    const sink: TransferSink = {
      received: 0,
      hashes: async () => [],
      write: async () => {
        await new Promise((r) => setTimeout(r, 2));
        received++;
      },
      finish: async () => {
        done = true;
      },
      abort: async () => {},
    };

    const sender = new FileTransferManager({
      mesh: pair.a,
      createSink: async () => null,
      findPartial: async () => 0,
      resolveSource: async () => null,
      onTrace: (m) => traces.push(m),
    });
    const receiver = new FileTransferManager({
      mesh: pair.b,
      createSink: async () => sink,
      findPartial: async () => 0,
      resolveSource: async () => null,
      onTrace: (m) => traces.push(m),
    });
    const failures: string[] = [];
    sender.events.on('error', (e) => failures.push(`A: ${e.message}`));
    receiver.events.on('error', (e) => failures.push(`B: ${e.message}`));
    sender.start();
    receiver.start();
    cleanup.push(() => {
      sender.stop();
      receiver.stop();
    });

    await sender.share({
      bookId: newId(),
      name: 'книга.epub',
      mime: 'application/epub+zip',
      source,
      root: await computeRoot(source, CHUNK_SIZE),
    });
    await waitFor(() => done || failures.length > 0, 'передача не завершилась', 45_000);

    expect(failures).toEqual([]);
    expect(done).toBe(true);
    expect(received).toBe(Math.ceil(bytes.length / CHUNK_SIZE));

    // Цикл отправки на пару ровно один: «отправка … завершена» появляется один
    // раз, а переносов докачки быть не должно вовсе.
    const starts = traces.filter((m) => m.startsWith('отправка') && m.includes('с 0 из')).length;
    expect(starts).toBeLessThanOrEqual(1);
  }, 60_000);

  it('сообщает об ошибке, а не зависает, если сеть перестала забирать данные', async () => {
    // Буфер принимает кадры, но не убывает: send() не бросает исключение и
    // readyState остаётся 'open'. Обрыва не было, поэтому и close()-а не будет —
    // отправитель обязан сдаться по собственному таймауту.
    const net: MockNetConfig = { mode: 'throttled', bytesPerTick: 64 * 1024 };
    const pair = await makePair(net);
    const bytes = makeBytes(400_000);

    const errors: string[] = [];
    const sender = new FileTransferManager({
      mesh: pair.a,
      createSink: async () => null,
      findPartial: async () => 0,
      resolveSource: async () => null,
      // Короткие таймауты вместо боевых: тест не должен ждать 15 секунд.
      capacityTimeoutMs: 150,
      ackTimeoutMs: 150,
    });
    // Приёмник обязан согласиться, иначе он ответит file-decline и передача
    // не начнётся: проверяем именно зависание уже начавшейся отправки.
    const receiver = new FileTransferManager({
      mesh: pair.b,
      createSink: async () => ({
        received: 0,
        hashes: async () => [],
        write: async () => {},
        finish: async () => {},
        abort: async () => {},
      }),
      findPartial: async () => 0,
      resolveSource: async () => null,
    });
    sender.events.on('error', (e) => errors.push(e.message));
    receiver.events.on('error', (e) => errors.push(e.message));
    sender.start();
    receiver.start();
    cleanup.push(() => {
      sender.stop();
      receiver.stop();
    });

    // Замораживаем ТОЛЬКО файловый канал: ctrl-канал должен работать, иначе
    // файл-оффер не дойдёт и передача не начнётся вовсе.
    net.stallLabels = ['rd-file'];

    const source: TransferSource = { size: bytes.length, slice: async (s, e) => bytes.subarray(s, e) };
    await sender.share({
      bookId: newId(),
      name: 'книга.epub',
      mime: 'application/epub+zip',
      source,
      root: await computeRoot(source, CHUNK_SIZE),
    });

    await waitFor(() => errors.length > 0, 'отправитель не сообщил об ошибке', 15_000);

    // Сообщение должно называть причину и время ожидания, а не быть пустым:
    // иначе в интерфейсе пользователь увидит просто «ошибка передачи».
    const joined = errors.join(' ');
    expect(joined).toMatch(/мс/);
    expect(joined).toMatch(/буфер|окно|подтверд/i);
  }, 30_000);

  it('слушает докачку, пока файл не подтверждён получателем', async () => {
    // ─── Регрессия на вечно висящую передачу ────────────────────────────────────
    //
    // Согласие на приём — это «я готов», а не «я получил». Между ними файл ещё
    // летит, и получатель в любой момент может обнаружить нехватку данных и
    // попросить докачку.
    //
    // Раньше задача отправителя удалялась, как только все СОГЛАСИЛИСЬ принять
    // файл. Докачка после этого приходила, но `#sending.get()` возвращал
    // undefined, сообщение молча игнорировалось, и получатель оставался ждать
    // недостающий кусок — без ошибки, без прогресса, навсегда.
    //
    // Сценарий собран руками и полностью детерминирован: получателя-менеджера
    // здесь нет, поэтому он не пришлёт `file-finish`, и задача отправителя
    // обязана остаться живой.
    const pair = await makePair({ mode: 'instant' });
    const bytes = makeBytes(200_000);
    const size = bytes.length;
    const source: TransferSource = { size, slice: async (s, e) => bytes.subarray(s, Math.min(e, size)) };

    const sender = new FileTransferManager({
      mesh: pair.a,
      createSink: async () => null,
      findPartial: async () => 0,
      resolveSource: async () => null,
    });
    sender.events.on('error', () => {});
    sender.start();
    cleanup.push(() => sender.stop());

    // Считаем чанки, дошедшие до второй стороны: они приходят событием
    // 'fileChunk' на её ссылке.
    let delivered = 0;
    pair.b.events.on('fileChunk', () => {
      delivered++;
    });

    const peerId = (pair.a.peers[0] as { id: string } | undefined)?.id ?? '';
    const offer = await sender.share({
      bookId: newId(),
      name: 'книга.epub',
      mime: 'application/epub+zip',
      source,
      root: await computeRoot(source, CHUNK_SIZE),
    });

    // Согласие вручную: так видно момент, начиная с которого задача обязана жить.
    pair.a.events.emit('ctrl', {
      peerId,
      payload: { kind: 'json', msg: { k: 'file-accept', transferId: offer.transferId } },
    });
    await waitFor(() => delivered >= Math.ceil(size / CHUNK_SIZE), 'файл не долетел', 20_000);

    // Отправитель всё отдал и ждёт подтверждения. Задача обязана существовать.
    expect(sender.activeSends).toBe(1);

    const before = delivered;
    // Докачка с нуля: получатель обнаружил, что ему нужно переслать всё.
    pair.a.events.emit('ctrl', {
      peerId,
      payload: { kind: 'json', msg: { k: 'file-resume', transferId: offer.transferId, offset: 0 } },
    });
    await waitFor(() => delivered > before, 'отправитель проигнорировал докачку', 10_000);

    // И только после подтверждения задача исчезает.
    pair.a.events.emit('ctrl', {
      peerId,
      payload: { kind: 'json', msg: { k: 'file-finish', transferId: offer.transferId, root: offer.root } },
    });
    await waitFor(() => sender.activeSends === 0, 'задача не убралась после подтверждения', 10_000);
  }, 60_000);

  it('не сообщает об ошибке при выходе из комнаты', async () => {
    // Регрессия на сообщение, которого не должно быть.
  //
    // При выходе из комнаты цикл отправки просыпался уже на разорванном
  // канале: send() бросал исключение, и пользователь получал ошибку
  // «передача прервана: канал закрыт» в момент, когда он сам нажал «Выйти».
  //
  // Здесь сценарий настоящий: рвём соединение посреди передачи большого файла.
  const pair = await makePair({ mode: 'throttled', bytesPerTick: 8 * 1024 });
  const bytes = makeBytes(900_000);

  const errors: string[] = [];
  const sender = new FileTransferManager({
    mesh: pair.a,
    createSink: async () => null,
    findPartial: async () => 0,
    resolveSource: async () => null,
  });
  const receiver = new FileTransferManager({
    mesh: pair.b,
    createSink: async () => ({
      received: 0,
      hashes: async () => [],
      write: async () => {},
      finish: async () => {},
      abort: async () => {},
    }),
    findPartial: async () => 0,
    resolveSource: async () => null,
  });
  sender.events.on('error', (e) => errors.push((e as { message: string }).message));
  receiver.events.on('error', (e) => errors.push((e as { message: string }).message));
  sender.start();
  receiver.start();
  cleanup.push(() => {
    sender.stop();
    receiver.stop();
  });

  const source: TransferSource = {
    size: bytes.length,
    slice: async (s, e) => bytes.subarray(s, Math.min(e, bytes.length)),
  };
  await sender.share({
    bookId: newId(),
    name: 'выход.epub',
    mime: 'application/epub+zip',
    source,
    root: await computeRoot(source, CHUNK_SIZE),
  });

  // Немного ждём, чтобы передача набрала темп, затем выходим.
  await new Promise((r) => setTimeout(r, 120));

  // Порядок как в RoomSession.stop(): сначала передачи, потом сеть.
  sender.stop();
  receiver.stop();
  pair.a.stop();
  pair.b.stop();

  // Даём циклам отправки проснуться: если бы они не смотрели на флаг остановки,
  // ошибка пришла бы именно сейчас.
  await new Promise((r) => setTimeout(r, 300));
  expect(errors).toEqual([]);
});

it('не забивает канал сверх окна', async () => {
    // Размер и скорость подобраны так, чтобы тест проверял свойство, а не
    // скорость машины. Окно 256 КиБ, файл 700 КиБ — это почти три окна, то
    // есть backpressure точно срабатывает несколько раз. При 4 КиБ за тик файл
    // уходил бы минуту, и на загруженной машине тест падал бы по таймауту,
    // не проверив ничего.
    const pair = await makePair({ mode: 'throttled', bytesPerTick: 32 * 1024 });
    const bytes = makeBytes(700_000); // ~43 чанка

    const result = await transferFile(pair, bytes);

    expect(result.failures).toEqual([]);
    expect(result.root).not.toBeNull();

    // Файл втрое больше окна. Если бы backpressure не работал, в канале
    // скопилась бы вся передача или больше — память уходила бы на отправителя и
    // получателя. Проверяем именно верхнюю границу, а не «меньше половины
    // файла»: окно и есть ожидаемый предел.
    const peak = pair.network.peakBuffered();
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(FILE_HIGH_WATER_MARK + CHUNK_SIZE);

    // Границы согласованы: порог события ниже high-water, окно не больше
    // high-water, high-water в разумных пределах.
    expect(FILE_LOW_WATER_MARK).toBeLessThan(FILE_HIGH_WATER_MARK);
    expect(DEFAULT_WINDOW_BYTES).toBeLessThanOrEqual(FILE_HIGH_WATER_MARK);
    expect(FILE_HIGH_WATER_MARK).toBeLessThanOrEqual(256 * 1024);
    // Оба таймаута обязательны: без них «молчащий» пир держит передачу открытой
    // навсегда, и пользователь не отличит зависание от долгой передачи.
    expect(CAPACITY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ACK_TIMEOUT_MS).toBeGreaterThan(0);
  }, 90_000);
});