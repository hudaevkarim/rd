/**
 * Рендерер блоков книги в DOM — БЕЗ `innerHTML`.
 *
 * Это ключевое решение по безопасности. Содержимое EPUB недоверенное: в него
 * кладут `<script>`, `onerror=...`, `javascript:`-ссылки и CSS-импорты. Обычный
 * путь «взять строку и вставить через innerHTML» требует санитайзера, и вся
 * защита держится на том, что санитайзер не пропустил новый вектор.
 *
 * Здесь вместо этого DOM строится через `createElement` + `textContent` из
 * разобранного дерева, и разрешён только закрытый белый список тегов. Пути
 * для выполнения кода просто нет: текст книги попадает в `textContent`, где он
 * всегда остаётся текстом, а атрибуты вроде `style` и `onclick` не копируются
 * вообще. Отсюда же бесплатно получается защита от mXSS и «mutation XSS».
 *
 * Единственное исключение — ссылка `<a href>`, для которой href всё-таки
 * копируется, поэтому там стоит отдельная проверка схемы.
 */

import { INLINE_TAGS, type EpubBlock, type ParsedEpub } from './epub.js';
import { isElement, isText, type XmlElement, type XmlNode } from './xml.js';

/** Разрешённые схемы ссылок. `data:` и `javascript:` исключены намеренно. */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Приводит href из книги к безопасному виду.
 * `javascript:alert(1)`, `data:text/html,...` и протокол-относительные ссылки
 * (`//evil.example`) отбрасываются: они не несут пользы внутри читалки.
 */
export function safeHref(raw: string, baseDir: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Протокол-относительная ссылка без схемы — уводит на чужой хост.
  if (trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('#')) return trimmed;

  try {
    const url = new URL(trimmed, `https://epub.local/${baseDir}`);
    if (!SAFE_SCHEMES.has(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

const BLOCK_TAGS: Record<string, string> = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  p: 'p',
  li: 'li',
  blockquote: 'blockquote',
  pre: 'pre',
  td: 'div',
  th: 'div',
  caption: 'figcaption',
};

const INLINE_TO_HTML: Record<string, string> = {
  em: 'em',
  strong: 'strong',
  i: 'em',
  b: 'strong',
  u: 'u',
  small: 'small',
  s: 's',
  sub: 'sub',
  sup: 'sup',
  code: 'code',
  mark: 'mark',
  br: 'br',
  span: 'span',
  a: 'a',
};

export interface RenderOptions {
  /** Базовый каталог главы — нужен для разрешения относительных ссылок. */
  baseDir?: string;
  /** Идентификатор блока в DOM: `data-block`. */
  blockAttr?: string;
}

/**
 * Строит DOM-элемент для одного блока.
 * Возвращает `null` для разделителей, которые не должны быть в потоке текста.
 */
export function renderBlock(block: EpubBlock, opts: RenderOptions = {}): HTMLElement | null {
  const doc = globalThis.document;
  if (doc === undefined) throw new Error('renderBlock доступен только в браузере');

  if (block.kind === 'hr') {
    const hr = doc.createElement('hr');
    applyBlockMeta(hr, block, opts);
    return hr;
  }

  const tag = BLOCK_TAGS[block.kind] ?? 'p';
  const el = doc.createElement(tag);
  if (block.kind === 'li') el.className = 'rd-li';
  if (block.kind === 'td' || block.kind === 'th') el.className = 'rd-cell';

  const nodes = block.kind === 'p' && block.node.name === 'p' ? block.node.children : block.node.children;
  for (const child of nodes) appendInline(el, child, doc, opts);

  // Пустой абзац в разметке книг — обычное дело (разделители, отступы).
  // Убираем, чтобы не плодить вертикальные пустоты.
  if ((el.textContent ?? '').trim() === '' && el.childElementCount === 0) return null;

  applyBlockMeta(el, block, opts);
  return el;
}

function applyBlockMeta(el: HTMLElement, block: EpubBlock, opts: RenderOptions): void {
  const attr = opts.blockAttr ?? 'data-block';
  el.setAttribute(attr, `${block.index}`);
}

/**
 * Рекурсивно строит инлайновые узлы. Ключевой момент: разрешённый тег
 * превращается в «безопасный эквивалент» (i → em, b → strong), а всё
 * остальное разворачивается в plain text с сохранением содержимого.
 */
function appendInline(parent: HTMLElement, node: XmlNode, doc: Document, opts: RenderOptions): void {
  if (isText(node)) {
    // textContent, а не innerHTML: любой '<script>' останется текстом.
    parent.appendChild(doc.createTextNode(node.text));
    return;
  }
  if (!isElement(node)) return;

  if (node.name === 'br') {
    parent.appendChild(doc.createElement('br'));
    return;
  }
  if (node.name === 'img' || node.name === 'image') {
    // Изображения внутри EPUB тянут за собой отдельный кэш и свою систему
    // путей. Для MVP показываем alt-текст, чтобы не терять смысл.
    const alt = node.attrs['alt'];
    if (typeof alt === 'string' && alt.trim() !== '') {
      parent.appendChild(doc.createTextNode(`[${alt.trim()}]`));
    }
    return;
  }

  if (node.name === 'a' && typeof node.attrs['href'] === 'string') {
    const href = safeHref(node.attrs['href'], opts.baseDir ?? '');
    if (href === null) {
      for (const child of node.children) appendInline(parent, child, doc, opts);
      return;
    }
    const a = doc.createElement('a');
    a.setAttribute('href', href);
    // rel=noopener: ссылка из чужой книги не должна получить доступ к окну.
    if (href.startsWith('http')) a.setAttribute('rel', 'noopener noreferrer nofollow');
    for (const child of node.children) appendInline(a, child, doc, opts);
    parent.appendChild(a);
    return;
  }

  const mapped = INLINE_TO_HTML[node.name];
  if (mapped !== undefined && INLINE_TAGS.has(node.name)) {
    const el = doc.createElement(mapped);
    for (const child of node.children) appendInline(el, child, doc, opts);
    parent.appendChild(el);
    return;
  }

  // Неизвестный тег: содержимое сохраняем, сам тег отбрасываем.
  for (const child of node.children) appendInline(parent, child, doc, opts);
}

/** Рендерит всю главу. */
export function renderChapter(chapter: { blocks: EpubBlock[] }, opts: RenderOptions = {}): DocumentFragment {
  const doc = globalThis.document;
  if (doc === undefined) throw new Error('renderChapter доступен только в браузере');
  const fragment = doc.createDocumentFragment();
  for (const block of chapter.blocks) {
    const el = renderBlock(block, opts);
    if (el !== null) fragment.appendChild(el);
  }
  return fragment;
}

export type { XmlElement };

/**
 * Переводит выделение браузера в координаты блока.
 *
 * Инвариант, на котором держится вся система якорей: рендерер строит DOM из
 * нормализованного дерева, поэтому `blockEl.textContent === block.text` и
 * смещение в DOM равно смещению в тексте блока. Если бы мы рендерили исходный
 * XHTML с его `"\n   "`, все якоря разъехались бы.
 */
export function locateSelection(
  container: HTMLElement,
  range: Range,
): { blockIndex: number; start: number; end: number } | null {
  const doc = globalThis.document;
  const startEl = closestWithBlockAttr(range.startContainer, container);
  if (startEl === null) return null;
  const endEl = closestWithBlockAttr(range.endContainer, container);

  const start = offsetInBlock(doc, startEl, range.startContainer, range.startOffset);
  const end = endEl !== null ? offsetInBlock(doc, endEl, range.endContainer, range.endOffset) : start;
  return { blockIndex: Number(startEl.getAttribute('data-block')), start, end: Math.max(start, end) };
}

function offsetInBlock(doc: Document, blockEl: HTMLElement, node: Node, offset: number): number {
  const range = doc.createRange();
  range.selectNodeContents(blockEl);
  try {
    range.setEnd(node, offset);
  } catch {
    // Узел принадлежит другому блоку (выделение началось в соседнем абзаце).
    return 0;
  }
  return range.toString().length;
}

function closestWithBlockAttr(node: Node, container: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null && current !== container) {
    if (current instanceof HTMLElement && current.hasAttribute('data-block')) return current;
    current = current.parentNode;
  }
  return current instanceof HTMLElement && current.hasAttribute('data-block') ? current : null;
}

export type { EpubBlock, ParsedEpub };
