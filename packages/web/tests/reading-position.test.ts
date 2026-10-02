/**
 * Личное место чтения по книгам: запоминается, переживает перезагрузку и не
 * путается между книгами.
 *
 * ─── Что ловилось ─────────────────────────────────────────────────────────────
 *
 * Позиция была ОДНА на комнату (`state.position`), и в ней лежала та книга,
 * которую читают сейчас. Открыли вторую книгу — место в первой потерялось, и
 * возвращаться приходилось листать с начала. Для аудиокниги было хуже: там
 * позиция вообще бралась из заметки в каталоге комнаты, то есть из значения,
 * общего для всех участников, — своё место там не выжить было в принципе.
 *
 * Здесь проверяется новое правило: место хранится ПО КНИГЕ, живёт в IndexedDB
 * (не в CRDT — личная история чтения не должна быть видна соседям) и
 * переживает пересоздание сессии.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@rd/protocol';
import { MockRtcNetwork } from '../../p2p/tests/mock-webrtc.js';
import { MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { createLibraryStore } from '@rd/library';
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

/** Один участник в комнате, которой больше никого не нужно. */
async function makeSession(roomId: string, dbName: string, store = createLibraryStore(dbName)): Promise<RoomSession> {
  const signalRoom = new (await import('../../p2p/tests/loopback-signal.js')).MemorySignalRoom();
  const network = new MockRtcNetwork({ mode: 'instant' });
  const session = await RoomSession.create(
    {
      roomId,
      passphrase: 'север-берег-звезда-улица',
      name: 'Аня',
      color: '#3b82f6',
      signalingUrl: 'ws://неиспользуется.invalid',
    },
    () => {},
    {
      store,
      transport: (descriptor) => new MemorySignalTransport(descriptor, signalRoom),
      rtc: network.factory,
      kdfIterations: 1_000,
    },
  );
  cleanup.push(async () => {
    await session.stop();
  });
  return session;
}

/** Хранилище, которое считает записи по ключу — нужно для проверки троттлинга. */
function countingStore(dbName: string, isInteresting: (key: string) => boolean): { store: ReturnType<typeof createLibraryStore>; writes: () => number } {
  const store = createLibraryStore(dbName);
  let writes = 0;
  const realSet = store.setSetting.bind(store);
  store.setSetting = (key: string, value: unknown) => {
    if (isInteresting(key)) writes++;
    return realSet(key, value);
  };
  cleanup.push(async () => {
    await store.db.delete().catch(() => {});
  });
  return { store, writes: () => writes };
}

/** Пауза, достаточная, чтобы отработал троттлинг записи на диск. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('личное место чтения', () => {
  it('помнит место в каждой книге отдельно', async () => {
    const roomId = newId();
    const session = await makeSession(roomId, `pos-${Math.random().toString(36).slice(2)}`);

    session.setPosition('книга-1', 7, 3, 0.7);
    session.setPosition('книга-2', 1, 0, 0.1);
    // Возврат в первую: место обязано остаться прежним.
    session.setPosition('книга-1', 7, 4, 0.71);

    expect(session.positionOf('книга-1')).toMatchObject({ chapterIndex: 7, blockIndex: 4 });
    expect(session.positionOf('книга-2')).toMatchObject({ chapterIndex: 1, blockIndex: 0 });
    expect(session.positionOf('не-открывали')).toBeNull();
  });

  it('у позиции каждой книги своя доля прочтения', async () => {
    // Именно это и терялось: процент наверху показывал место в той книге,
    // которую открыли последней, а не в той, которую читают.
    const roomId = newId();
    const session = await makeSession(roomId, `pos-${Math.random().toString(36).slice(2)}`);

    session.setPosition('книга-1', 9, 0, 0.9);
    session.setPosition('книга-2', 0, 0, 0.05);

    expect(session.positionOf('книга-1')?.progress).toBeCloseTo(0.9, 5);
    expect(session.positionOf('книга-2')?.progress).toBeCloseTo(0.05, 5);
    // Активная позиция — та, что последней открыли.
    expect(session.state.position.bookId).toBe('книга-2');
  });

  it('хранит секунды аудиокниги отдельно от глав', async () => {
    const roomId = newId();
    const session = await makeSession(roomId, `pos-${Math.random().toString(36).slice(2)}`);

    session.setAudioPosition('аудио-1', 321, 0.4);

    const saved = session.positionOf('аудио-1');
    expect(saved?.audioSec).toBe(321);
    // У аудио нет ни глав, ни блоков: их нули не должны вытеснять секунды.
    expect(saved?.chapterIndex).toBe(0);
    expect(saved?.blockIndex).toBe(0);
  });

  it('аудиопозиция не затирает место в текстовой книге и наоборот', async () => {
    // Общий счётчик секунд в setPosition раньше затирал место в главе: аудио
    // писало главу 0, а потом книга открывалась в начале.
    const roomId = newId();
    const session = await makeSession(roomId, `pos-${Math.random().toString(36).slice(2)}`);

    session.setPosition('книга-1', 5, 2, 0.5);
    session.setAudioPosition('аудио-1', 100, 0.2);
    session.setPosition('книга-1', 6, 0, 0.6);

    expect(session.positionOf('книга-1')).toMatchObject({ chapterIndex: 6, audioSec: null });
    expect(session.positionOf('аудио-1')?.audioSec).toBe(100);
  });

  it('переживает перезапуск сессии в той же комнате', async () => {
    // Главный сценарий: закрыл вкладку, открыл снова — и должен продолжить с
    // того же места, а не с начала.
    const roomId = newId();
    const dbName = `pos-restart-${Math.random().toString(36).slice(2)}`;

    const first = await makeSession(roomId, dbName);
    first.setPosition('книга-1', 12, 5, 0.62);
    first.setAudioPosition('аудио-1', 742, 0.31);
    // Место обязано попасть на диск до выхода из комнаты.
    first.flushPositions();
    await first.stop();

    const second = await makeSession(roomId, dbName);
    expect(second.positionOf('книга-1')).toMatchObject({ chapterIndex: 12, blockIndex: 5 });
    expect(second.positionOf('аудио-1')?.audioSec).toBe(742);
  });

  it('запоминает место при выходе из комнаты', async () => {
    // Выход — обычный сценарий, и потерянная на нём позиция означала бы
    // именно то, что чинили: открываешь книгу заново и листаешь с начала.
    const roomId = newId();
    const dbName = `pos-stop-${Math.random().toString(36).slice(2)}`;
    const first = await makeSession(roomId, dbName);
    first.setPosition('книга-1', 4, 2, 0.4);
    await first.stop();

    const second = await makeSession(roomId, dbName);
    expect(second.positionOf('книга-1')).toMatchObject({ chapterIndex: 4, blockIndex: 2 });
  });

  it('не пишет на диск на каждый кадр прокрутки', async () => {
    // Наблюдатель сообщает о пересечении десятки раз в секунду. Запись в
    // IndexedDB на каждый абзац забивала бы диск и тормозила интерфейс.
    const roomId = newId();
    const { store, writes } = countingStore(`pos-throttle-${Math.random().toString(36).slice(2)}`, (key) =>
      key.startsWith('positions:'),
    );

    const session = await makeSession(roomId, 'unused', store);
    for (let i = 0; i < 200; i++) {
      session.setPosition('книга-1', 3, i, i / 1000);
    }
    await settle();
    // Ни одной записи: 200 вызовов склеились в одну отложенную.
    expect(writes()).toBe(0);

    session.flushPositions();
    await settle();
    // Ровно одна: место обязано где-то оказаться, иначе возврат в книгу
    // отбросил бы в начало.
    expect(writes()).toBe(1);
  });

  it('выбрасывает битое место с диска, а не роняет книгу', async () => {
    // База могла остаться от прежней версии или от другой комнаты. Место с
    // NaN в секундах или главой из миллиона хуже, чем его отсутствие.
    const roomId = newId();
    const dbName = `pos-bad-${Math.random().toString(36).slice(2)}`;
    const store = createLibraryStore(dbName);
    await store.setSetting(`positions:${roomId}`, {
      'хорошая': { chapterIndex: 3, blockIndex: 1, audioSec: null, progress: 0.3, updatedAt: 1 },
      'без-главы': { blockIndex: 1, progress: 0.3 },
      'строка-вместо-объекта': 'всё хорошо',
      'отрицательные': { chapterIndex: -5, blockIndex: -2, audioSec: -10, progress: 7, updatedAt: 1 },
      'nan': { chapterIndex: Number.NaN, blockIndex: 0, progress: 0.1, updatedAt: 1 },
    });
    cleanup.push(async () => {
      await store.db.delete().catch(() => {});
    });

    const session = await makeSession(roomId, dbName);
    expect(session.positionOf('хорошая')).toMatchObject({ chapterIndex: 3, blockIndex: 1, progress: 0.3 });
    // Нет главы или блока — запись не восстановить.
    expect(session.positionOf('без-главы')).toBeNull();
    expect(session.positionOf('строка-вместо-объекта')).toBeNull();
    expect(session.positionOf('nan')).toBeNull();
    // Отрицательные значения зажимаются, а не уходят в запрос главы.
    expect(session.positionOf('отрицательные')).toMatchObject({
      chapterIndex: 0,
      blockIndex: 0,
      audioSec: 0,
      progress: 1,
    });
  });

  it('переживает недоступное хранилище', async () => {
    // Приватный режим браузера отдаёт ошибку на любую запись. Позиция в этом
    // случае не сохранится, но сессия обязана продолжать работать.
    const roomId = newId();
    const store = createLibraryStore(`pos-ro-${Math.random().toString(36).slice(2)}`);
    store.setSetting = () => Promise.reject(new Error('IndexedDB недоступна'));
    store.getSetting = () => Promise.reject(new Error('IndexedDB недоступна'));
    cleanup.push(async () => {
      await store.db.delete().catch(() => {});
    });

    const signalRoom = new (await import('../../p2p/tests/loopback-signal.js')).MemorySignalRoom();
    const network = new MockRtcNetwork({ mode: 'instant' });
    const session = await RoomSession.create(
      {
        roomId,
        passphrase: 'север-берег-звезда-улица',
        name: 'Аня',
        color: '#3b82f6',
        signalingUrl: 'ws://неиспользуется.invalid',
      },
      () => {},
      { store, transport: (d) => new MemorySignalTransport(d, signalRoom), rtc: network.factory, kdfIterations: 1_000 },
    );
    cleanup.push(async () => {
      await session.stop();
    });

    expect(() => session.setPosition('книга-1', 2, 0, 0.2)).not.toThrow();
    await settle();
    session.flushPositions();
    expect(session.positionOf('книга-1')?.chapterIndex).toBe(2);
  });
});

describe('комментарии по открытой книге', () => {
  it('список в состоянии содержит комментарии всех книг комнаты', async () => {
    // Панель фильтрует по открытой книге сама. Если бы сессия продолжала
    // фильтровать по позиции чтения, панель зависела бы от того, что читают,
    // а не от того, что открыто.
    const roomId = newId();
    const session = await makeSession(roomId, `cmt-${Math.random().toString(36).slice(2)}`);

    session.addComment({ bookId: 'книга-1', anchor: textAnchor(1), body: 'первая', spoiler: false });
    session.addComment({ bookId: 'книга-2', anchor: textAnchor(2), body: 'вторая', spoiler: false });

    const byBook = (id: string): string[] => session.state.comments.filter((c) => c.bookId === id).map((c) => c.body);
    expect(byBook('книга-1')).toEqual(['первая']);
    expect(byBook('книга-2')).toEqual(['вторая']);
  });

  it('комментарии чужой книги не исчезают из состояния при смене позиции', async () => {
    // Именно это и выглядело как «надо что-то написать, чтобы подтянулось»:
    // список пересобирался только по правке документа и по позиции чтения.
    const roomId = newId();
    const session = await makeSession(roomId, `cmt2-${Math.random().toString(36).slice(2)}`);

    session.addComment({ bookId: 'книга-1', anchor: textAnchor(1), body: 'из первой', spoiler: false });
    session.addComment({ bookId: 'книга-2', anchor: textAnchor(2), body: 'из второй', spoiler: false });
    const before = session.state.comments.length;

    // Переключились на чтение другой книги — список комнатных комментариев
    // обязан остаться тем же.
    session.setPosition('книга-2', 4, 0, 0.4);
    session.setPosition('книга-1', 0, 0, 0);

    expect(session.state.comments.length).toBe(before);
    expect(session.state.comments.map((c) => c.bookId).sort()).toEqual(['книга-1', 'книга-2']);
  });
});

function textAnchor(chapterIndex: number): { kind: 'text'; chapterIndex: number; blockIndex: number; start: number; end: number; quote: string; prefix: string; suffix: string } {
  return {
    kind: 'text',
    chapterIndex,
    blockIndex: 0,
    start: 0,
    end: 3,
    quote: '...',
    prefix: '',
    suffix: '',
  };
}
