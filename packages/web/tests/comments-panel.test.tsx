// @vitest-environment jsdom
/**
 * Панель комментариев показывает комментарии открытой книги и переключается
 * вместе с ней.
 *
 * ─── Что ловится ──────────────────────────────────────────────────────────────
 *
 * Пользователь переключал книгу, а в панели оставались комментарии ПРЕДЫДУЩЕЙ
 * книги. Чтобы увидеть правильные, он должен был что-то написать в поле
 * комментария — то есть список обновлялся только после правки в документе.
 *
 * Причина была не в панели, а в сессии: список считался для книги из позиции
 * чтения (`state.position.bookId`), то есть для той, которую читают СЕЙЧАС, а
 * не для той, которая открыта. Открытая книга от него не зависела, и список
 * пересобирался только по событию изменения документа.
 *
 * Тест рендерит настоящую панель и переключает книгу так же, как это делает
 * интерфейс: сменой пропса `bookId` на том же экземпляре компонента.
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
import { CommentsPanel } from '../src/comments.js';

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
  const store = createLibraryStore(`comments-${Math.random().toString(36).slice(2)}`);
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

function textAnchor(chapterIndex: number): Parameters<RoomSession['addComment']>[0]['anchor'] {
  return {
    kind: 'text',
    chapterIndex,
    blockIndex: 0,
    start: 0,
    end: 4,
    quote: 'текст',
    prefix: '',
    suffix: '',
  };
}

interface Mounted {
  root: Root;
  container: HTMLElement;
}

function mount(node: ReactNode): Mounted {
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

function panelNode(session: RoomSession, bookId: string): ReactNode {
  return createElement(CommentsPanel, {
    session,
    bookId,
    selection: null,
    onClearSelection: () => {},
  });
}

async function switchTo(root: Root, session: RoomSession, bookId: string): Promise<void> {
  await act(async () => {
    root.render(panelNode(session, bookId));
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe('панель комментариев', () => {
  it('показывает комментарии той книги, которая открыта', async () => {
    const session = await makeSession();
    session.addComment({ bookId: 'книга-1', anchor: textAnchor(1), body: 'комментарий к первой', spoiler: false });
    session.addComment({ bookId: 'книга-2', anchor: textAnchor(2), body: 'комментарий ко второй', spoiler: false });

    const first = mount(panelNode(session, 'книга-1'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(first.container.textContent ?? '').toContain('комментарий к первой');
    expect(first.container.textContent ?? '').not.toContain('комментарий ко второй');

    // Переключение книги — без единой правки в документе.
    await switchTo(first.root, session, 'книга-2');
    expect(first.container.textContent ?? '').toContain('комментарий ко второй');
    expect(first.container.textContent ?? '').not.toContain('комментарий к первой');
  });

  it('обновляется при переключении книги, а не только при правке', async () => {
    // ─── Регрессия ─────────────────────────────────────────────────────────────
    //
    // «Чтобы комментарии подтянулись, надо что-то написать» — значит список
    // пересобирался только по событию изменения документа. Здесь ни одной
    // правки нет: меняется только открытая книга.
    const session = await makeSession();
    session.addComment({ bookId: 'книга-1', anchor: textAnchor(1), body: 'из первой', spoiler: false });
    session.addComment({ bookId: 'книга-2', anchor: textAnchor(2), body: 'из второй', spoiler: false });

    const view = mount(panelNode(session, 'книга-1'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // Счётчик в заголовке обязан совпадать с числом комментариев открытой книги.
    expect(view.container.textContent ?? '').toContain('Комментарии · 1');

    await switchTo(view.root, session, 'книга-2');
    expect(view.container.textContent ?? '').toContain('Комментарии · 1');
    expect(view.container.textContent ?? '').toContain('из второй');
  });

  it('считает только комментарии открытой книги, даже если их много', async () => {
    const session = await makeSession();
    for (let i = 0; i < 3; i++) {
      session.addComment({ bookId: 'книга-1', anchor: textAnchor(i), body: `первая ${i}`, spoiler: false });
    }
    for (let i = 0; i < 5; i++) {
      session.addComment({ bookId: 'книга-2', anchor: textAnchor(i), body: `вторая ${i}`, spoiler: false });
    }

    const view = mount(panelNode(session, 'книга-2'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(view.container.textContent ?? '').toContain('Комментарии · 5');
    expect(view.container.textContent ?? '').not.toContain('первая 0');
  });

  it('не тащит ответ в тред чужой книги', async () => {
    // Ответ, начатый на одной книге, не должен уехать в другую: иначе это
    // сообщение от вашего имени в чужом треде.
    const session = await makeSession();
    const rootId = session.addComment({ bookId: 'книга-1', anchor: textAnchor(1), body: 'корень', spoiler: false });
    session.addComment({ bookId: 'книга-2', anchor: textAnchor(1), body: 'чужая', spoiler: false });
    expect(rootId).not.toBe('');

    const view = mount(panelNode(session, 'книга-2'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    // В панели второй книги нет кнопки «ответить» у комментария первой —
    // он вообще не отображается, а значит и ответить на него нельзя.
    expect(view.container.textContent ?? '').not.toContain('корень');
  });

  it('пустая книга показывает честное «пока нет», а не чужие комментарии', async () => {
    const session = await makeSession();
    session.addComment({ bookId: 'книга-1', anchor: textAnchor(1), body: 'чужие', spoiler: false });

    const view = mount(panelNode(session, 'книга-3'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(view.container.textContent ?? '').toContain('Комментариев пока нет');
    expect(view.container.textContent ?? '').not.toContain('чужие');
  });
});
