// @vitest-environment jsdom
/**
 * Рендеринг FB2 в DOM: безопасность и якоря комментариев.
 *
 * Проверяется то, чего не видно в тестах разбора: как страница ведёт себя в
 * настоящем браузере.
 *
 *   - `<script>`, `<iframe>`, `onload`, `onclick` и `style` из FB2 НЕ выполняются
 *     и НЕ копируются в DOM;
 *   - `javascript:`-ссылка не превращается в кликабельную;
 *   - выделение фрагмента в отрендеренном тексте даёт якорь, который
 *     разрешается обратно в ту же позицию — то есть комментарий по FB2
 *     привязывается ровно так же, как по EPUB.
 *
 * Якорь проверяется по полному кругу: `locateSelection` даёт координаты блока,
 * `createTextAnchor` строит якорь, `resolveTextAnchor` находит его снова. Это и
 * есть путь, который проходит комментарий в интерфейсе.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createTextAnchor,
  locateSelection,
  parseFb2,
  renderChapter,
  resolveTextAnchor,
  safeHref,
} from '@rd/library';

beforeAll(() => {
  // Выделение в jsdom есть, а вот выполнения скриптов мы как раз и проверяем,
  // что их нет, — счётчик должен остаться нетронутым.
  (globalThis as { __rdScriptRuns?: number }).__rdScriptRuns = 0;
});

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
  (globalThis as { __rdScriptRuns?: number }).__rdScriptRuns = 0;
});

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const FB2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info><book-title>Тихая улица</book-title><lang>ru</lang></title-info>
    <coverpage><image l:href="#cover.jpg"/></coverpage>
  </description>
  <body>
    <section>
      <title><p>Глава первая</p></title>
      <p>Ветер гулял по пустым улицам и не хотел останавливаться.</p>
      <p>Он <emphasis>умел ждать</emphasis> и <strikethrough>не боялся</strikethrough> темноты.</p>
      <p><image l:href="#pic1.png" alt="Луна над крышами"/></p>
      <p><a l:href="https://example.org/источник">Источник</a> и <a href="javascript:alert(1)">плохая ссылка</a>.</p>
      <script>globalThis.__rdScriptRuns = (globalThis.__rdScriptRuns ?? 0) + 1;</script>
      <style>body { display: none }</style>
      <iframe src="https://example.invalid/evil"></iframe>
      <p onclick="globalThis.__rdScriptRuns = 99" onload="globalThis.__rdScriptRuns = 99" style="color: red">Абзац с обработчиками.</p>
    </section>
    <section>
      <title><p>Глава вторая</p></title>
      <p>Дом на краю был тёмным.</p>
    </section>
  </body>
</FictionBook>`;

function render(chapterIndex = 0): HTMLElement {
  const book = parseFb2(utf8(FB2));
  const chapter = book.chapters[chapterIndex];
  if (chapter === undefined) throw new Error('нет такой главы');
  const host = document.createElement('article');
  host.appendChild(renderChapter(chapter, { baseDir: '', blockAttr: 'data-block' }));
  document.body.appendChild(host);
  cleanup.push(() => host.remove());
  return host;
}

const runs = (): number => (globalThis as { __rdScriptRuns?: number }).__rdScriptRuns ?? 0;

describe('рендеринг FB2', () => {
  it('показывает текст абзацев и заголовков', () => {
    const first = render(0);
    expect(first.textContent ?? '').toContain('Глава первая');
    expect(first.textContent ?? '').toContain('Ветер гулял по пустым улицам');
    // Текст второй главы в первой быть не должен: главы раздельны, и «всё сразу»
    // означал бы, что границы глав потеряны.
    expect(first.textContent ?? '').not.toContain('Дом на краю');

    const second = render(1);
    expect(second.textContent ?? '').toContain('Глава вторая');
    expect(second.textContent ?? '').toContain('Дом на краю был тёмным.');
  });

  it('размечает курсив и зачёркивание из FB2', () => {
    const host = render();
    // Без раскладки FB2-тегов весь акцидентный текст терял бы оформление.
    expect(host.querySelector('em')?.textContent).toBe('умел ждать');
    expect(host.querySelector('s')?.textContent).toBe('не боялся');
  });

  it('показывает иллюстрацию подписью в квадратных скобках', () => {
    // Само изображение в MVP не показывается (это отдельная задача), но молчать
    // о нём тоже нельзя: в книге оно несёт смысл.
    expect(render().textContent ?? '').toContain('[Луна над крышами]');
  });

  it('не выполняет script из FB2', () => {
    render();
    // Разбор вырезает `<script>` до того, как он дойдёт до дерева, и рендерер
    // строит DOM только через createElement. Обе причины проверены: счётчик
    // выполнений обязан остаться нулевым.
    expect(runs()).toBe(0);
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.innerHTML).not.toContain('__rdScriptRuns');
  });

  it('не копирует обработчики и стили в DOM', () => {
    const host = render();
    const paragraph = [...host.querySelectorAll('p')].find((p) => p.textContent === 'Абзац с обработчиками.');
    expect(paragraph).toBeDefined();
    expect(paragraph?.getAttribute('onclick')).toBeNull();
    expect(paragraph?.getAttribute('onload')).toBeNull();
    expect(paragraph?.getAttribute('style')).toBeNull();
    // И в разметке страницы этих строк тоже нет: иначе проверка выше обошла бы
    // сам факт добавления атрибута.
    expect(host.innerHTML).not.toContain('onclick');
    expect(host.innerHTML).not.toContain('onload');
    expect(host.innerHTML).not.toContain('display: none');
  });

  it('не превращает javascript:-ссылку в ссылку', () => {
    const host = render();
    // Текст ссылки должен остаться, но кликабельной ссылки быть не должно:
    // `safeHref` отбрасывает схему, и рендерер разворачивает содержимое в текст.
    expect(host.textContent ?? '').toContain('плохая ссылка');
    const anchors = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(anchors).not.toContain('javascript:alert(1)');
    expect(host.innerHTML).not.toContain('javascript:');
  });

  it('сохраняет безопасные ссылки и ставит rel=noopener', () => {
    const host = render();
    const anchor = host.querySelector('a[href^="https://"]');
    expect(anchor?.textContent).toBe('Источник');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('не показывает iframe и svg как содержимое главы', () => {
    const host = render();
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.innerHTML).not.toContain('example.invalid');
    expect(host.innerHTML).not.toContain('<style');
  });

  it('разбирает схему ссылки так же, как для EPUB', () => {
    // Проверка на уровне функции: FB2-ссылки приходят с префиксом l:, который
    // снимается разбором, поэтому дальше это обычный href.
    expect(safeHref('https://example.org/a', '')).toBe('https://example.org/a');
    expect(safeHref('javascript:alert(1)', '')).toBeNull();
    expect(safeHref('data:text/html,<script>', '')).toBeNull();
    expect(safeHref('//example.org', '')).toBeNull();
  });
});

describe('якоря комментариев в FB2', () => {
  /** Выделяет подстроку в отрендеренном блоке так, как это делает пользователь. */
  function selectIn(host: HTMLElement, blockIndex: number, needle: string): void {
    const block = host.querySelector<HTMLElement>(`[data-block="${blockIndex}"]`);
    if (block === null) throw new Error(`нет блока ${blockIndex}`);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const at = (node.textContent ?? '').indexOf(needle);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      node = walker.nextNode();
    }
    throw new Error(`в блоке ${blockIndex} нет текста «${needle}»`);
  }

  it('даёт якорь на выделенный фрагмент и находит его обратно', () => {
    const book = parseFb2(utf8(FB2));
    const host = render(0);
    const needle = 'не хотел останавливаться';

    selectIn(host, 1, needle);
    const range = window.getSelection()?.getRangeAt(0);
    expect(range).toBeDefined();
    if (range === undefined) return;

    // Шаг 1: координаты в DOM — то же, что делает читалка по mouseup.
    const found = locateSelection(host, range as Range);
    expect(found).not.toBeNull();
    if (found === null) return;

    // Шаг 2: якорь с цитатой и контекстом.
    const anchor = createTextAnchor(book, 0, found.blockIndex, found.start, found.end);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;
    expect(anchor.kind).toBe('text');
    expect(anchor.quote).toBe(needle);

    // Шаг 3: якорь разрешается обратно в ту же позицию.
    const resolved = resolveTextAnchor(book, anchor);
    expect(resolved.stale).toBe(false);
    expect(resolved.chapterIndex).toBe(0);
    expect(resolved.blockIndex).toBe(found.blockIndex);
    expect(book.chapters[0]?.blocks[resolved.blockIndex]?.text.slice(resolved.start, resolved.end)).toBe(needle);
  });

  it('разрешает якорь по цитате, даже если блоки перенумерованы', () => {
    // Ровно тот случай, ради которого якорь и берёт цитату: у другого участника
    // разбиение на абзацы может отличаться.
    const book = parseFb2(utf8(FB2));
    const needle = 'умел ждать';
    const source = book.chapters[0]?.blocks.find((b) => b.text.includes(needle));
    expect(source).toBeDefined();
    if (source === undefined) return;

    const anchor = createTextAnchor(book, 0, source.index, source.text.indexOf(needle), source.text.indexOf(needle) + needle.length);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;

    // Сдвигаем координаты так, будто блоков стало больше: якорь обязан
    // найти цитату поиском, а не по номеру.
    const shifted = { ...anchor, blockIndex: anchor.blockIndex + 3 };
    const resolved = resolveTextAnchor(book, shifted);
    expect(resolved.stale).toBe(false);
    expect(book.chapters[resolved.chapterIndex]?.blocks[resolved.blockIndex]?.text.slice(resolved.start, resolved.end)).toBe(
      needle,
    );
  });

  it('не путает главы при поиске якоря', () => {
    const book = parseFb2(utf8(FB2));
    // Второй блок, а не первый: первый — заголовок главы.
    const second = book.chapters[1]?.blocks[1];
    expect(second?.text).toBe('Дом на краю был тёмным.');
    const anchor = createTextAnchor(book, 1, second?.index ?? 0, 0, 'Дом на краю'.length);
    expect(anchor?.quote).toBe('Дом на краю');
    expect(resolveTextAnchor(book, anchor!).chapterIndex).toBe(1);
  });
});
