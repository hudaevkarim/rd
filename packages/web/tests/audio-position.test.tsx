// @vitest-environment jsdom
/**
 * Аудиокнига открывается на том месте, где её остановили.
 *
 * ─── Что ловится ──────────────────────────────────────────────────────────────
 *
 * Пользователь перематывал аудиокнигу, закрывал вкладку, возвращался — и каждый
 * раз начинал с нуля.
 *
 * У позиции аудиоплеера было две проблемы. Первая: она бралась из заметки в
 * каталоге комнаты, то есть из значения, общего для всех участников, — своё
 * место там не выжить было в принципе, чужая перемотка его обнуляла, а
 * перезагрузку оно не переживало. Вторая, и совсем неочевидная: заметка хранила
 * долю 0..1, а в `seek()` уходило это значение как секунды. То есть восстановление
 * не просто было неточным — оно прыгало на первые полсекунды записи.
 *
 * Здесь проверяется, что на элемент уходит именно секунда из личного места.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { newId } from '@rd/protocol';
import { MockRtcNetwork } from '../../p2p/tests/mock-webrtc.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { createLibraryStore } from '@rd/library';
import { RoomSession } from '../src/room-session.js';
import { AudioView } from '../src/audio-view.js';
import { formatTimecode } from '../src/audio-core.js';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, writable: true });
  }
  if (typeof Blob.prototype.arrayBuffer !== 'function') {
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      writable: true,
      value(this: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error ?? new Error('чтение Blob не удалось'));
          reader.readAsArrayBuffer(this);
        });
      },
    });
  }
  // jsdom не умеет создавать объектные URL, а плеер их использует для src.
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:тест', writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true });
  }
  // Загрузка и воспроизведение медиа в jsdom не реализованы: без заглушек
  // каждый тест засорял бы вывод «Not implemented». Позиция при этом
  // выставляется как обычно — `currentTime` в jsdom работает.
  for (const method of ['load', 'play', 'pause'] as const) {
    if (typeof HTMLMediaElement.prototype[method] !== 'function') continue;
    Object.defineProperty(HTMLMediaElement.prototype, method, { value: () => {}, writable: true, configurable: true });
  }
});

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    try {
      await cleanup.pop()?.();
    } catch {
      // Уборка не должна маскировать результат теста.
    }
  }
});

async function makeSession(): Promise<RoomSession> {
  const store = createLibraryStore(`audio-pos-${Math.random().toString(36).slice(2)}`);
  const signalRoom = new MemorySignalRoom();
  const network = new MockRtcNetwork({ mode: 'instant' });
  const session = await RoomSession.create(
    {
      roomId: newId(),
      passphrase: 'север-берег-звезда-улица',
      name: 'Аня',
      color: '#3b82f6',
      signalingUrl: 'ws://неиспользуется.invalid',
    },
    () => {},
    { store, transport: (d) => new MemorySignalTransport(d, signalRoom), rtc: network.factory, kdfIterations: 1_000, iceServers: [] },
  );
  cleanup.push(async () => {
    await session.stop();
    await store.db.delete().catch(() => {});
  });
  return session;
}

/** Импортирует аудиокнигу: важна только регистрация в каталоге и на диске. */
async function putAudio(session: RoomSession, name = 'аудиокнига.mp3'): Promise<string> {
  // Подлинный MP3 не нужен: плеер читает заголовок глав, а при неудаче честно
  // говорит, что глав нет. Проверяется восстановление позиции.
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const file = new File([bytes.buffer as ArrayBuffer], name, { type: 'audio/mpeg' });
  return session.importBook(file);
}

function mount(node: ReactNode): { root: Root; container: HTMLElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  cleanup.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return { root, container };
}

function audioNode(session: RoomSession, bookId: string): ReactNode {
  return createElement(AudioView, { session, bookId, onAddComment: () => {} });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });
}

/** Две сессии в одной комнате: нужны, чтобы проверить присутствие соседа. */
async function makeTwoSessions(): Promise<{ anna: RoomSession; boris: RoomSession }> {
  const roomId = newId();
  const network = new MockRtcNetwork({ mode: 'instant' });
  const signalRoom = new MemorySignalRoom();
  const make = async (name: string, color: string): Promise<RoomSession> => {
    const store = createLibraryStore(`audio-pos-${name}-${Math.random().toString(36).slice(2)}`);
    const session = await RoomSession.create(
      { roomId, passphrase: 'север-берег-звезда-улица', name, color, signalingUrl: 'ws://неиспользуется.invalid' },
      () => {},
      { store, transport: (d) => new MemorySignalTransport(d, signalRoom), rtc: network.factory, kdfIterations: 1_000, iceServers: [] },
    );
    cleanup.push(async () => {
      await session.stop();
      await store.db.delete().catch(() => {});
    });
    return session;
  };
  const boris = await make('Борис', '#f59e0b');
  const anna = await make('Аня', '#3b82f6');
  await waitFor(
    () => anna.state.peers.some((p) => p.state === 'ready') && boris.state.peers.some((p) => p.state === 'ready'),
    'участники не соединились',
  );
  return { anna, boris };
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Загружает запись в плеер сессии напрямую.
 *
 * Так делается намеренно: для проверки присутствия не нужно, чтобы файл
 * реально доехал по P2P — нужна только позиция в awareness. Полная передача
 * проверяется в `session-transfer.test.ts`, и тащить её сюда значило бы
 * тестировать два разных механизма в одном тесте.
 */
async function loadIntoPlayer(session: RoomSession, bookId: string, name: string): Promise<void> {
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/mpeg' });
  await session.audio.load({ bookId, title: name.replace(/\.[^.]+$/, ''), blob, mime: 'audio/mpeg' });
  expect(session.audio.bookId).toBe(bookId);
}

describe('аудиокнига: возврат на сохранённое место', () => {
  it('перематывает на сохранённую секунду', async () => {
    const session = await makeSession();
    const bookId = await putAudio(session);
    // Личное место: остановились на 742-й секунде.
    session.setAudioPosition(bookId, 742, 0.4);

    mount(audioNode(session, bookId));
    await settle();

    // Элемент `<audio>` живёт внутри плеера и в разметку не попадает, поэтому
    // проверяем то, что видит пользователь, — позицию плеера.
    expect(session.audio.bookId).toBe(bookId);
    // Именно секунда, а не доля: доля 0.4 в seek() уехала бы на 0.4 секунды.
    expect(session.audio.positionSec).toBeCloseTo(742, 1);
  });

  it('начинает с нуля, если место ещё не задано', async () => {
    const session = await makeSession();
    const bookId = await putAudio(session);

    mount(audioNode(session, bookId));
    await settle();

    expect(session.audio.positionSec).toBe(0);
  });

  it('не путает аудиокниги: место берётся из открытой', async () => {
    const session = await makeSession();
    const first = await putAudio(session, 'первая.mp3');
    const second = await putAudio(session, 'вторая.mp3');
    session.setAudioPosition(first, 100, 0.1);
    session.setAudioPosition(second, 900, 0.9);

    mount(audioNode(session, second));
    await settle();

    expect(session.audio.positionSec).toBeCloseTo(900, 1);
  });

  it('показывает позицию только у того, кто слушает эту же запись', async () => {
    // ─── Регрессия ─────────────────────────────────────────────────────────────
    //
    // Я слушаю первую запись, сосед — вторую, а в моём плеере у него отмечалась
    // его секунда: цифра выглядела правдоподобно и была бессмысленной, потому
    // что относилась к другой книге. Причина — в списке бралось поле времени
    // без оглядки на то, КАКУЮ книгу слушает сосед.
    //
    // Проверяется на двух настоящих сессиях: сосед публикует позицию через
    // awareness, и мы смотрим, что дошло до моего снимка состояния. Именно
    // `audioBookId` решает, попадёт ли позиция в список «кто где слушает».
    const { anna, boris } = await makeTwoSessions();
    const first = await putAudio(anna, 'моя.mp3');
    const second = await putAudio(anna, 'чужая.mp3');
    await waitFor(() => boris.state.books.length >= 2, 'каталог не синхронизирован');

    // Соседу достаточно загрузить запись в свой плеер: проверяется присутствие,
    // а не доставка файла (она покрыта отдельно в session-transfer).
    await loadIntoPlayer(boris, second, 'чужая.mp3');
    boris.audio.seek(300);
    boris.syncAudioPositions();

    await waitFor(
      () => anna.state.others[boris.selfId]?.audioBookId === second,
      `позиция соседа не дошла; others=${JSON.stringify(anna.state.others)}`,
      45_000,
    );
    const peer = anna.state.others[boris.selfId];
    // Книга видна та, которую слушает ОН, а не та, которая открыта у меня.
    expect(peer?.audioBookId).toBe(second);
    expect(peer?.audioBookId).not.toBe(first);

    // И моя запись отфильтрована: список «кто слушает эту» пуст.
    mount(audioNode(anna, first));
    await settle();
    // Проверяем не текст целиком, а конкретную кнопку перемотки: длительность
    // самой записи тоже выводится таймкодом и при совпадении секунд дала бы
    // ложное срабатывание.
    const jumpButtons = [...document.querySelectorAll('button[title="Перемотать к этому участнику"]')];
    expect(jumpButtons.map((b) => b.textContent ?? '')).toEqual([]);
    const text = document.body.textContent ?? '';
    // Подпись берём той же функцией, что использует интерфейс: жёстко
    // зашитый «05:00» молчал бы в vacuously-зелёный тест, стоит формату
    // измениться (formatDuration не ставит ведущий ноль).
    expect(text).not.toContain(formatTimecode(300));
    // Но видно, что он слушает — просто другую запись.
    expect(text).toContain('Борис');
    expect(text).toContain('чужая');
  });

  it('показывает позицию соседа, если он слушает ту же запись', async () => {
    const { anna, boris } = await makeTwoSessions();
    const first = await putAudio(anna, 'моя.mp3');
    await waitFor(() => boris.state.books.some((b) => b.id === first), 'каталог не синхронизирован');
    await loadIntoPlayer(boris, first, 'моя.mp3');

    boris.audio.seek(305);
    boris.syncAudioPositions();

    await waitFor(
      () => anna.state.others[boris.selfId]?.audioBookId === first,
      `позиция соседа не дошла; others=${JSON.stringify(anna.state.others)}`,
      45_000,
    );
    expect(anna.state.others[boris.selfId]?.audioTimeSec).toBeCloseTo(305, 1);

    // И кнопка перемотки к нему есть: та же запись, значит его позиция уместна.
    mount(audioNode(anna, first));
    await settle();
    const jumpButtons = [...document.querySelectorAll('button[title="Перемотать к этому участнику"]')];
    expect(jumpButtons.map((b) => b.textContent ?? '')).toEqual([`${formatTimecode(305)} (пауза)`]);
  }, 90_000);

  it('сохраняет место при выходе из комнаты', async () => {
    // Кнопка «Выйти» — обычный сценарий, и потерянная на нём позиция означала
    // бы именно то, что чинили: открываешь заново и перематываешь с нуля.
    const session = await makeSession();
    const bookId = await putAudio(session);
    mount(audioNode(session, bookId));
    await settle();

    act(() => {
      session.audio.seek(515);
    });
    await session.stop();

    expect(session.positionOf(bookId)?.audioSec).toBe(515);
  });

  it('показывает комментарии только своей книги', async () => {
    // Список в сессии содержит комментарии всей комнаты; в плеере должны быть
    // только таймкоды открытой записи.
    const session = await makeSession();
    const first = await putAudio(session, 'первая.mp3');
    const second = await putAudio(session, 'вторая.mp3');
    session.addComment({ bookId: first, anchor: { kind: 'audio', timeSec: 42 }, body: 'таймкод первой', spoiler: false });
    session.addComment({ bookId: second, anchor: { kind: 'audio', timeSec: 43 }, body: 'таймкод второй', spoiler: false });

    const view = mount(audioNode(session, second));
    await settle();

    const text = view.container.textContent ?? '';
    expect(text).toContain('таймкод второй');
    expect(text).not.toContain('таймкод первой');
  });
});
