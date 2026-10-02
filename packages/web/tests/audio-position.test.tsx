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
    { store, transport: (d) => new MemorySignalTransport(d, signalRoom), rtc: network.factory, kdfIterations: 1_000 },
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
