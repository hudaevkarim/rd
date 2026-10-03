/**
 * Разбор EPUB в плоскую структуру «главы → блоки».
 *
 * Почему свой разбор, а не epub.js: epub.js рассчитан на потоковую загрузку из
 * сети, в нём свой рендерер с iframe и своя система CFI. Для приложения, где
 * книга уже лежит локально и должна синхронизироваться между устройствами,
 * выгоднее предсказуемый разбор в блоки: их можно показывать, на них можно
 * ставить якоря комментариев и по ним считать прогресс.
 *
 * Точность CFI здесь сознательно не воспроизводится. Вместо него якорь —
 * тройка (глава, блок, смещение) ПЛЮС цитата с префиксом и суффиксом. Цитата
 * делает якорь устойчивым к любой переразметке: якорь ищется не по координатам,
 * а по тексту. Это ровно тот подход, который использует W3C Web Annotation.
 *
 * Безопасность: из книги извлекаются только узлы и текст. Атрибуты вида
 * `onclick`, `style`, `javascript:href` в рендерер не попадают вообще — см.
 * reader.ts, где DOM строится через createElement.
 */

import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import {
  descendants,
  findElement,
  isElement,
  isText,
  normalizePreserved,
  textOf,
  type XmlElement,
  type XmlNode,
} from './xml.js';

export type BlockKind =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'li'
  | 'blockquote'
  | 'pre'
  | 'td'
  | 'th'
  | 'caption'
  | 'hr';

export interface EpubBlock {
  /** Порядковый номер блока внутри главы, начиная с 0. */
  index: number;
  kind: BlockKind;
  /** Исходный узел — из него рендерер строит DOM. */
  node: XmlElement;
  /** Нормализованный текст блока: по нему ищем якоря и считаем смещения. */
  text: string;
}

export interface EpubChapter {
  index: number;
  id: string;
  href: string;
  blocks: EpubBlock[];
}

export interface TocEntry {
  label: string;
  href: string;
  chapterIndex: number;
  blockIndex: number;
}

export interface ParsedEpub {
  title: string;
  author: string;
  language: string;
  /** Путь к файлу обложки внутри архива, null если не найдена. */
  coverHref: string | null;
  chapters: EpubChapter[];
  toc: TocEntry[];
  totalBlocks: number;
}

export class EpubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubError';
  }
}

// ─── Разрешение путей внутри архива ────────────────────────────────────────────

/**
 * Разрешает href относительно базовой директории внутри ZIP-архива.
 * Отличается от `new URL(href, base)`: в архиве нет хоста, зато есть
 * `../`, `./`, якоря и процентное кодирование.
 */
export function resolveZipPath(baseDir: string, href: string): string {
  const clean = href.split('#')[0] ?? '';
  if (clean === '') return '';
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Некорректное кодирование: используем как есть, путь просто не найдётся.
  }
  if (decoded.startsWith('/')) return normalizeSegments(decoded.slice(1).split('/'));

  const parts = baseDir === '' ? [] : baseDir.split('/');
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function normalizeSegments(segments: string[]): string {
  const out: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

// ─── Нормализация текста ───────────────────────────────────────────────────────

/** NBSP и прочие «невидимые» пробелы → обычный пробел, схлопывание серий. */
export function normalizeText(input: string): string {
  return input
    .replace(/[   ⁠]/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

// ─── Разбор ────────────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  // Внешние сущности и DTD в EPUB не нужны, а их обработка — вектор атаки
  // (billion laughs, XXE). Разбираем только то, что реально встречается.
  processEntities: false,
  htmlEntities: true,
});

function parseXml(text: string): XmlNode[] {
  return normalizePreserved(parser.parse(text) as unknown);
}

const decoder = new TextDecoder('utf-8');

function readEntry(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path];
  if (bytes === undefined) return null;
  return decoder.decode(bytes);
}

export function parseEpub(bytes: Uint8Array): ParsedEpub {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    throw new EpubError(`файл не является ZIP-архивом EPUB: ${(err as Error).message}`);
  }

  const containerText = readEntry(files, 'META-INF/container.xml');
  if (containerText === null) throw new EpubError('в архиве нет META-INF/container.xml');
  const opfPath = findOpfPath(containerText);
  if (opfPath === null) throw new EpubError('в container.xml нет rootfile');
  const opfText = readEntry(files, opfPath);
  if (opfText === null) throw new EpubError(`OPF не найден: ${opfPath}`);

  return buildBook(files, opfPath, parseXml(opfText));
}

function findOpfPath(containerText: string): string | null {
  const roots = parseXml(containerText);
  for (const node of roots) {
    if (!isElement(node)) continue;
    for (const rootfile of descendants(node, 'rootfile')) {
      const fullPath = rootfile.attrs['full-path'];
      if (typeof fullPath === 'string' && fullPath !== '') return fullPath;
    }
  }
  return null;
}

function buildBook(files: Record<string, Uint8Array>, opfPath: string, opf: XmlNode[]): ParsedEpub {
  const pkg = opf.find(isElement);
  if (pkg === undefined) throw new EpubError('OPF: нет корневого элемента package');

  const opfDir = dirname(opfPath);
  const metadata = findElement(pkg, 'metadata');
  const manifestEl = findElement(pkg, 'manifest');
  const spineEl = findElement(pkg, 'spine');

  const items = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of manifestEl === null ? [] : descendants(manifestEl, 'item')) {
    const id = item.attrs['id'];
    const href = item.attrs['href'];
    if (id === undefined || href === undefined) continue;
    items.set(id, {
      href: resolveZipPath(opfDir, href),
      mediaType: item.attrs['media-type'] ?? '',
      properties: item.attrs['properties'] ?? '',
    });
  }

  const title = metadata === null ? '' : firstText(metadata, 'title');
  const author = metadata === null ? '' : firstText(metadata, 'creator');
  const language = metadata === null ? '' : firstText(metadata, 'language');
  const coverHref = findCoverHref(pkg, items);

  const chapters: EpubChapter[] = [];
  if (spineEl !== null) {
    let index = 0;
    for (const itemref of descendants(spineEl, 'itemref')) {
      const idref = itemref.attrs['idref'];
      if (idref === undefined) continue;
      // linear="no" — вспомогательные файлы (сноски, колофон), их не читаем.
      if (itemref.attrs['linear'] === 'no') continue;
      const item = items.get(idref);
      if (item === undefined) continue;
      const xhtml = readEntry(files, item.href);
      if (xhtml === null) continue;
      const blocks = extractBlocks(parseXml(xhtml));
      chapters.push({ index, id: idref, href: item.href, blocks });
      index++;
    }
  }

  const toc = buildToc(files, opfDir, items, chapters);
  const totalBlocks = chapters.reduce((sum, c) => sum + c.blocks.length, 0);

  return {
    title: title === '' ? 'Без названия' : title,
    author: author === '' ? 'Неизвестный автор' : author,
    language,
    coverHref,
    chapters,
    toc,
    totalBlocks,
  };
}

function firstText(parent: XmlElement, name: string): string {
  for (const child of parent.children) {
    if (isElement(child) && child.name === name) return normalizeText(textOf(child));
  }
  return '';
}

/** Обложка: сначала свойство manifest (EPUB 3), потом устаревшая meta-ссылка. */
function findCoverHref(pkg: XmlElement, items: Map<string, { href: string; mediaType: string; properties: string }>): string | null {
  for (const item of items.values()) {
    if (item.properties.split(/\s+/).includes('cover-image')) return item.href;
  }
  const metadata = findElement(pkg, 'metadata');
  if (metadata !== null) {
    for (const meta of descendants(metadata, 'meta')) {
      if (meta.attrs['name'] === 'cover') {
        const id = meta.attrs['content'];
        const item = id === undefined ? undefined : items.get(id);
        if (item !== undefined) return item.href;
      }
    }
  }
  return null;
}

// ─── Оглавление ────────────────────────────────────────────────────────────────

function buildToc(
  files: Record<string, Uint8Array>,
  opfDir: string,
  items: Map<string, { href: string; mediaType: string; properties: string }>,
  chapters: EpubChapter[],
): TocEntry[] {
  const byHref = new Map<string, { chapterIndex: number; blockIndex: number }>();
  for (const chapter of chapters) {
    if (!byHref.has(chapter.href)) byHref.set(chapter.href, { chapterIndex: chapter.index, blockIndex: 0 });
  }

  for (const item of items.values()) {
    if (item.properties.split(/\s+/).includes('nav')) {
      const navText = readEntry(files, item.href);
      if (navText !== null) {
        const entries = parseNavDoc(navText, dirname(item.href), byHref);
        if (entries.length > 0) return entries;
      }
    }
  }

  // EPUB 2: оглавление лежит в NCX.
  for (const item of items.values()) {
    if (!item.mediaType.includes('ncx') && !item.href.toLowerCase().endsWith('.ncx')) continue;
    const ncxText = readEntry(files, item.href);
    if (ncxText === null) continue;
    const entries = parseNcx(ncxText, dirname(item.href), byHref);
    if (entries.length > 0) return entries;
  }

  // Запасной вариант: названия глав из первых заголовков.
  return chapters.map((chapter) => {
    const heading = chapter.blocks.find((b) => b.kind === 'h1' || b.kind === 'h2');
    return {
      label: heading === undefined ? `Глава ${chapter.index + 1}` : heading.text,
      href: chapter.href,
      chapterIndex: chapter.index,
      blockIndex: heading === undefined ? 0 : heading.index,
    };
  });
}

function parseNavDoc(text: string, baseDir: string, index: Map<string, { chapterIndex: number; blockIndex: number }>): TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (node: XmlNode): void => {
    if (!isElement(node)) return;
    if (node.name === 'a' && typeof node.attrs['href'] === 'string') {
      const href = resolveZipPath(baseDir, node.attrs['href'] as string);
      const label = normalizeText(textOf(node));
      if (label !== '') out.push(toTocEntry(label, href, index));
    }
    for (const child of node.children) walk(child);
  };
  for (const root of parseXml(text)) walk(root);
  return out;
}

function parseNcx(text: string, baseDir: string, index: Map<string, { chapterIndex: number; blockIndex: number }>): TocEntry[] {
  const out: TocEntry[] = [];
  for (const root of parseXml(text)) {
    if (!isElement(root)) continue;
    for (const navPoint of descendants(root, 'navpoint')) {
      const labelEl = findElement(navPoint, 'navlabel');
      const content = findElement(navPoint, 'content');
      const label = labelEl === null ? '' : normalizeText(textOf(labelEl));
      const src = content?.attrs['src'];
      if (label === '' || src === undefined) continue;
      out.push(toTocEntry(label, resolveZipPath(baseDir, src), index));
    }
  }
  return out;
}

function toTocEntry(label: string, href: string, index: Map<string, { chapterIndex: number; blockIndex: number }>): TocEntry {
  const target = index.get(href) ?? { chapterIndex: 0, blockIndex: 0 };
  return { label, href, chapterIndex: target.chapterIndex, blockIndex: target.blockIndex };
}

// ─── Извлечение блоков ─────────────────────────────────────────────────────────

/**
 * Элементы, содержимое которых не является книжным текстом.
 *
 * `<head>` с `<title>` особенно коварен: его текст идёт в потоке раньше первого
 * абзаца, и без явного пропуска каждая глава начинается с блока «глава» —
 * заголовка из метаданных браузера.
 */
const SKIP_TAGS = new Set([
  'head', 'title', 'meta', 'link', 'base', 'style', 'script', 'noscript',
  'svg', 'math', 'template', 'col', 'colgroup',
]);

/** Теги, содержимое которых имеет смысл отдать рендереру как инлайновое. */
export const INLINE_TAGS = new Set([
  'em', 'strong', 'i', 'b', 'u', 'small', 's', 'sub', 'sup', 'code', 'span', 'a', 'br', 'mark',
  // FB2: курсив, зачёркивание и цитата. Без них акцидентный текст FB2 терял бы
  // оформление при разборе.
  'emphasis', 'strikethrough', 'cite',
]);

/** Теги, из которых получается абзац/заголовок. */
const LEAF_BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'figcaption',
  'dd', 'dt', 'caption', 'li', 'td', 'th',
]);

export interface BlockExtractionOptions {
  /**
   * Теги, содержимое которых не является книжным текстом.
   *
   * Вынесено в параметр из-за FB2: там `<title>` — это заголовок главы, а не
   * `<title>` из `<head>`, и пропуск его молча выкинул бы все заголовки книги.
   */
  skipTags?: ReadonlySet<string>;
  /**
   * Картинки: из них берётся подпись. В EPUB это `<img>`, в FB2 — `<image>` с
   * ссылкой на `<binary>`.
   */
  imageTags?: ReadonlySet<string>;
}

const DEFAULT_SKIP_TAGS: ReadonlySet<string> = SKIP_TAGS;
const DEFAULT_IMAGE_TAGS: ReadonlySet<string> = new Set(['img', 'image']);

/**
 * Атрибуты, которые вообще могут попасть в дерево блока.
 *
 * Именно белый список, а не «убрать опасное». Разница принципиальная: при
 * блоклисте всё, чего автор блоклиста не знал, проходит насквозь — сюда попадают
 * `onclick`, `onload`, `style`, `srcset`, `formaction` и любые новые атрибуты,
 * которые придумают в следующей версии HTML. Здесь перечислено ровно то, что
 * нужно рендереру, и всё остальное отбрасывается по построению.
 *
 * Практически это значит:
 *   - `href` у `<a>` — иначе в книге не работают ссылки и внутренние переходы;
 *   - `alt` у картинок — иначе иллюстрация в FB2 не показывает подпись.
 *
 * Раньше здесь был `attrs: {}` для всех элементов, из-за чего ветка рендерера
 * для `<a href>` и `<img alt>` была недостижимой: атрибуты терялись на разборе,
 * и ссылка в книге выглядела как обычный текст.
 */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href']),
  img: new Set(['alt', 'title']),
  image: new Set(['alt', 'title']),
};

function allowedAttrs(name: string, attrs: Record<string, string>): Record<string, string> {
  const allowed = ALLOWED_ATTRS[name];
  if (allowed === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Нормализует инлайновое содержимое блока так, чтобы СКЛЕЕННЫЙ ТЕКСТ дерева
 * побайтово совпадал с `block.text`.
 *
 * Это не косметика. Комментарий привязывается к смещению внутри `block.text`,
 * а пользователь выделяет его в DOM. Если в дереве останется `"\n   "`, а в
 * `block.text` будет `" "`, то смещения разъедутся и якорь уедет на произвольное
 * расстояние. Нормализуя дерево на этапе разбора, мы получаем инвариант:
 *   текст(дерево) === block.text   →   и DOM-смещения равны координатам якоря.
 */
export function normalizeInline(node: XmlNode): XmlNode {
  if (isText(node)) {
    return { name: '#text', text: node.text.replace(/[ \t\r\n\f\v]+/g, ' '), attrs: {}, children: [] };
  }
  // Содержимое script/style выбрасываем целиком: его текст не является
  // книжным и не должен ни попасть в block.text, ни быть отрендерен.
  if (SKIP_TAGS.has(node.name)) return { name: node.name, attrs: {}, children: [] };
  const children = node.children.map(normalizeInline);

  const first = children[0];
  if (first !== undefined && isText(first)) {
    children[0] = { ...first, text: first.text.replace(/^ +/, '') };
  }
  const last = children[children.length - 1];
  if (last !== undefined && isText(last)) {
    children[children.length - 1] = { ...last, text: last.text.replace(/ +$/, '') };
  }
  // Схлопываем пробел на стыке двух текстовых узлов: `<em>a</em> <em>b</em>`
  // и `<em>a</em><em>b</em>` должны давать одинаковый текст.
  for (let i = 1; i < children.length; i++) {
    const prev = children[i - 1];
    const cur = children[i];
    if (prev === undefined || cur === undefined) continue;
    if (!isText(prev) || !isText(cur)) continue;
    if (prev.text.endsWith(' ') && cur.text.startsWith(' ')) {
      children[i] = { ...cur, text: cur.text.replace(/^ +/, '') };
    }
  }
  return { name: node.name, attrs: allowedAttrs(node.name, node.attrs), children };
}

/**
 * Блоки из содержимого ОДНОГО элемента.
 *
 * Отдельный метод, потому что `extractBlocks` обходит потомков переданных узлов,
 * а не их сами: на верхнем уровне ему отдают корень документа. Передать ему
 * `<p>` напрямую — значит обойти его содержимое и потерять сам абзац: инлайн
 * схлопнется в один блок, заголовок станет обычным текстом, а `<image>` внутри
 * абзаца исчезнет совсем.
 */
export function extractBlocksOf(element: XmlNode, opts: BlockExtractionOptions = {}): EpubBlock[] {
  const wrapper: XmlElement = { name: '#fragment', attrs: {}, children: [element] };
  return extractBlocks([wrapper], opts);
}

export function extractBlocks(nodes: XmlNode[], opts: BlockExtractionOptions = {}): EpubBlock[] {
  const skipTags = opts.skipTags ?? DEFAULT_SKIP_TAGS;
  const imageTags = opts.imageTags ?? DEFAULT_IMAGE_TAGS;
  const blocks: EpubBlock[] = [];
  let pending = '';

  /** Абзац из «свободного» текста, накопившегося между блочными тегами. */
  const pushPlain = (text: string): void => {
    const node: XmlElement = {
      name: 'p',
      attrs: {},
      children: [{ name: '#text', text, attrs: {}, children: [] }],
    };
    blocks.push({ index: blocks.length, kind: 'p', node, text });
  };

  const flush = (): void => {
    const text = normalizeText(pending);
    pending = '';
    if (text !== '') pushPlain(text);
  };

  const walk = (parent: XmlNode): void => {
    for (const child of parent.children) {
      if (isText(child)) {
        pending += child.text;
        continue;
      }
      if (child.name === 'br') {
        pending += ' ';
        continue;
      }
      if (skipTags.has(child.name)) continue;
      if (child.name === 'hr') {
        flush();
        blocks.push({ index: blocks.length, kind: 'hr', node: { name: 'hr', attrs: {}, children: [] }, text: '' });
        continue;
      }
      if (imageTags.has(child.name)) {
        // Изображения: подпись в книге обычно идёт рядом, само изображение
        // пропускаем. В MVP поддержка иллюстраций — отдельная задача.
        continue;
      }
      if (LEAF_BLOCK_TAGS.has(child.name)) {
        flush();
        const node = normalizeInline(child) as XmlElement;
        const text = textOf(node);
        // Пустые не-p абзацы выбрасываем: в вёрстке книг они часто остаются
        // от разметки и только добавляют вертикальные пустоты.
        if (text !== '' || child.name === 'p') {
          blocks.push({ index: blocks.length, kind: child.name as BlockKind, node, text });
        }
        continue;
      }
      // Всё остальное (div, section, span, таблицы, списки-обёртки) — контейнер,
      // в который спускаемся. Проверять «есть ли вложенные блоки» не нужно: если
      // их нет, весь инлайн накопится в pending и превратится в абзац при flush().
      walk(child);
    }
  };

  for (const node of nodes) walk(node);
  flush();
  return blocks;
}
