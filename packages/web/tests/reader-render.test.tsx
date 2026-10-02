// @vitest-environment jsdom
/**
 * Регрессия на пустую страницу при смене книги.
 *
 * ─── Что ловится ──────────────────────────────────────────────────────────────
 *
 * Пользователь переключал книгу (и уходил в аудиокнигу и обратно) — текст не
 * появлялся: пустая страница с кнопками «Предыдущая»/«Следующая». Нажатие
 * «Следующая» помогало: текст отрисовывался, причём со следующей главы.
 *
 * Причина — не в разборе книги и не в пустых главах, а в порядке коммитов
 * React. Эффект отрисовки главы зависит от `[chapter]` и работает с
 * `hostRef.current`. Но `<article ref={hostRef}>` монтировался только в
 * «успешной» ветке рендера, а `chapter` приходил в состояние раньше, чем
 * снимался флаг `loading`. В момент срабатывания эффекта хоста ещё не было в
 * DOM, эффект выходил по `hostRef.current === null` и больше не повторялся —
 * `chapter` уже не менялся. Нажатие «Следующая» меняло `chapter`, и эффект
 * срабатывал уже при смонтированном хосте.
 *
 * Отсюда и главная проверка: хост обязан быть в DOM на любой стадии. Иначе
 * отрисовка главы зависит от того, успел ли React закоммитить состояние раньше
 * разметки, — то есть от внутреннего порядка, а не от данных.
 *
 * Тест поднимает настоящий DOM (jsdom) и рендерит настоящий компонент.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { newId } from '@rd/protocol';
import { MockRtcNetwork } from '../../p2p/tests/mock-webrtc.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { createLibraryStore, parseEpub } from '@rd/library';
import { RoomSession } from '../src/room-session.js';
import { Reader } from '../src/reader.js';

beforeAll(() => {
  // act() требует явного признака тестового окружения, иначе React ругается.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom не знает про IntersectionObserver, а читалка на него подписана для
  // отслеживания прокрутки. Заглушка молчит: проверяется отрисовка, а не
  // позиция, и молчащий наблюдатель на неё не влияет.
  if (typeof globalThis.IntersectionObserver === 'undefined') {
    class NoopObserver {
      readonly root: Element | null = null;
      readonly rootMargin = '';
      readonly thresholds: ReadonlyArray<number> = [];
      disconnect(): void {}
      observe(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = NoopObserver;
  }

  // Прокрутки в jsdom нет: без заглушки восстановление места упало бы с
  // «scrollIntoView is not a function» — то есть тест проверял бы jsdom, а не
  // читалку.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: () => {}, writable: true });
  }

  // У Blob в jsdom нет arrayBuffer(), а на нём построено всё чтение файлов —
  // и импорт книги, и разбор EPUB. Читаем через FileReader, который в jsdom есть.
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

/** Настоящий EPUB из одной главы: заголовок и заданные абзацы. */
function makeEpubFile(paragraphs: string[]): File {
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
  const chapter = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Глава один</h1>${paragraphs
    .map((p) => `<p>${p}</p>`)
    .join('')}</body></html>`;

  return buildStoredZip([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', container],
    ['OEBPS/content.opf', opf],
    ['OEBPS/ch1.xhtml', chapter],
  ]);
}

/** Минимальный zip без сжатия: разбору EPUB этого достаточно. */
function buildStoredZip(files: Array<[string, string]>): File {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x0403_4b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x0201_4b50, true);
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

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x0605_4b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...central, end]) {
    all.set(part, at);
    at += part.length;
  }
  return new File([all.buffer as ArrayBuffer], 'test.epub', { type: 'application/epub+zip' });
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

async function makeSession(): Promise<RoomSession> {
  const store = createLibraryStore(`reader-${Math.random().toString(36).slice(2)}`);
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

/**
 * Кладёт EPUB на диск и объявляет его в каталоге комнаты.
 *
 * Через настоящий `importBook`: выдумывать тестовые методы ради проверки
 * значило бы тестировать не тот код, который работает у пользователя.
 */
async function putBook(session: RoomSession, paragraphs: string[]): Promise<string> {
  const file = makeEpubFile(paragraphs);
  // Проверяем, что EPUB собран верно: иначе падал бы разбор, а не рендер.
  expect(parseEpub(new Uint8Array(await file.arrayBuffer())).chapters.length).toBeGreaterThan(0);
  return session.importBook(file);
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

function readerNode(session: RoomSession, bookId: string): ReactNode {
  return createElement(Reader, {
    session,
    bookId,
    index: session.bookIndex(bookId),
    selection: null,
    goto: null,
    onSelection: () => {},
    onClearSelection: () => {},
  });
}

/** Разбор книги асинхронный: даём эффектам и промису разойтись. */
async function settleRender(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe('читалка: текст появляется при смене книги', () => {
  it('рисует текст сразу, без нажатия «Следующая»', async () => {
    // Итог пользователя: глава выбрана, а на странице пусто.
    //
    // Честное ограничение этого теста: симптом зависит от того, как React
    // сгруппирует обновления `chapter` и `loading`, и иногда проходит даже на
    // сломанном коде. Гарантированно ловит причину следующий тест, про хост в
    // DOM; этот остаётся проверкой результата.
    const session = await makeSession();
    const bookId = await putBook(session, ['Первый абзац книги.', 'Второй абзац книги.']);
    expect(await session.openBook(bookId)).not.toBeNull();

    const { container } = mount(readerNode(session, bookId));
    await settleRender();

    const article = container.querySelector('article.rd-prose');
    expect(article, 'хост главы должен быть в DOM').not.toBeNull();
    expect(article?.textContent ?? '').toContain('Первый абзац книги.');
  });

  it('хост главы в DOM на любой стадии, включая загрузку', async () => {
    // ─── Регрессия, которая ловит баг всегда ────────────────────────────────────
    //
    // Хост обязан существовать всегда. Иначе эффект отрисовки главы
    // (`[chapter]` + `hostRef.current`) выходит на пустой разметке, и глава уже
    // никогда не отрисуется: `chapter` ведь больше не меняется. Именно так
    // выглядело «пустая страница, помогает только "Следующая"».
    //
    // Проверка синхронная, сразу после первого коммита, — на сломанном коде
    // `<article>` в этот момент ещё не смонтирован.
    const session = await makeSession();
    const bookId = await putBook(session, ['Абзац.']);

    const { container } = mount(readerNode(session, bookId));
    // Синхронно после первого коммита: разбор ещё шёл, но хост уже есть.
    expect(container.querySelector('article.rd-prose'), 'хост обязан быть и на стадии загрузки').not.toBeNull();

    await settleRender();
    expect(container.querySelector('article.rd-prose')).not.toBeNull();
    expect(container.querySelector('article.rd-prose')?.textContent ?? '').toContain('Абзац.');
  });

  it('переключает книгу и показывает текст новой', async () => {
    // Возврат из аудиокниги в книгу — тот же путь: меняется bookId.
    const session = await makeSession();
    const first = await putBook(session, ['Текст первой книги.']);
    const second = await putBook(session, ['Текст второй книги.']);

    const view = mount(readerNode(session, first));
    await settleRender();
    expect(view.container.textContent ?? '').toContain('Текст первой книги.');

    // Та же компонентная инстанция, другая книга — как при переключении в UI.
    await act(async () => {
      view.root.render(readerNode(session, second));
      await new Promise((r) => setTimeout(r, 60));
    });

    const article = view.container.querySelector('article.rd-prose');
    expect(article?.textContent ?? '').toContain('Текст второй книги.');
    // Текст прошлой книги не должен остаться на экране.
    expect(view.container.textContent ?? '').not.toContain('Текст первой книги.');
  });

  it('возвращается на сохранённый абзац, а не в начало главы', async () => {
    const session = await makeSession();
    const bookId = await putBook(session, ['Первый абзац книги.', 'Второй абзац книги.', 'Третий абзац книги.']);

    const view = mount(readerNode(session, bookId));
    await settleRender();
    // Читаем до третьего абзаца, как это делает наблюдатель прокрутки.
    session.setPosition(bookId, 0, 2, 0.3);

    await act(async () => {
      view.root.render(createElement(Reader, {
        session,
        bookId: null,
        index: null,
        selection: null,
        goto: null,
        onSelection: () => {},
        onClearSelection: () => {},
      }));
    });
    await act(async () => {
      view.root.render(readerNode(session, bookId));
      await new Promise((r) => setTimeout(r, 60));
    });

    const text = view.container.querySelector('article.rd-prose')?.textContent ?? '';
    expect(text).toContain('Третий абзац книги.');
    // Место в сохранённом виде должно быть именно этим абзацем.
    expect(session.positionOf(bookId)?.blockIndex).toBe(2);
  });
});
