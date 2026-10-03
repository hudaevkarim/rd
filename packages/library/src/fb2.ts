/**
 * Разбор FB2 в ту же структуру «главы → блоки», что и EPUB.
 *
 * ─── Почему результат тот же ───────────────────────────────────────────────────
 *
 * Отдельный тип для FB2 заводить незачем и вредно: рендерер, якоря комментариев,
 * прогресс, спойлеры и передача файла работают со структурой «глава → блоки» и
 * ничего не знают о формате. Если FB2 разбирается в `ParsedEpub`-совместимый
 * объект, вся машинерия комментариев работает с ним бесплатно и без отдельной
 * ветки «а если формат fb2». Так и сделано: `parseFb2` возвращает `ParsedBook`.
 *
 * ─── Отличия FB2 от EPUB, которые пришлось учесть ─────────────────────────────
 *
 *   - **`<title>` — это заголовок главы**, а не `<title>` из `<head>`. В EPUB он
 *     пропускается, здесь наоборот: пропустив, мы бы потеряли все заголовки.
 *   - **`<empty-line/>`** — пустая строка между абзацами (разбивка строф в
 *     стихах). См. `KNOWN_LIMITATIONS`: в текущей версии он не даёт отдельного
 *     блока, потому что любой «пустой» блок нарушает инвариант рендерера
 *     (см. `isBlockVisible` в reader.ts) — вместо этого он просто разделяет
 *     абзацы.
 *   - **`<binary>`** — картинки и шрифты внутри того же файла, в Base64. Для
 *     разбора это шум: пропускаем, чтобы Base64 не попал в текст книги.
 *   - **Разметка часто невалидна**: незакрытые `<p>`, «голые» ампersandы,
 *     `<?xml?>` без кавычек, комментарии без `--`. Разбор настроен на
 *     терпимость, но не на доверчивость: внешние сущности и DTD отключены.
 *
 * ─── Безопасность ─────────────────────────────────────────────────────────────
 *
 * Как и в EPUB, из файла извлекаются только узлы и текст: ни один атрибут из
 * книги не попадает в DOM напрямую (см. `reader.ts`, где всё строится через
 * `createElement`/`textContent`). Поэтому `<script>`, `onload` и `style` внутри
 * FB2 физически не могут выполниться — не потому, что санитайзер их отфильтровал,
 * а потому, что для них нет пути в разметку.
 */

import { XMLParser } from 'fast-xml-parser';
import {
  descendants,
  findElement,
  firstChildElement,
  isElement,
  normalizePreserved,
  textOf,
  type XmlElement,
  type XmlNode,
} from './xml.js';
import { decodeFb2, type DecodedText } from './encoding.js';
import {
  extractBlocks,
  extractBlocksOf,
  normalizeText,
  type EpubBlock,
  type EpubChapter,
  type ParsedEpub,
  type TocEntry,
} from './epub.js';

/** Имя формата, для которого написан этот разбор. */
export type BookFormatName = 'epub' | 'fb2';

export class Fb2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Fb2Error';
  }
}

/**
 * Похоже ли содержимое на FB2.
 *
 * Нужен, потому что тип файла у книг скачанных от соседа ненадёжен, а `.fb2`
 * в расширении есть не всегда. Признак один и очень характерный: корневой тег
 * `FictionBook`.
 */
export function looksLikeFb2(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048)).toLowerCase();
  return head.includes('<fictionbook');
}

// ─── Разбор ────────────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Пространства имён в FB2 встречаются, но смысла в них для нас нет: нужны
  // `title`, `p`, `section`, `image`. Префикс `l:href` станет `href`.
  removeNSPrefix: true,
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  // DTD и внешние сущности в FB2 не нужны, а их обработка — вектор атаки
  // (billion laughs, XXE). Разбираем только то, что реально встречается.
  processEntities: false,
  htmlEntities: true,
  // FB2 часто содержит самодостаточные теги вроде `<empty-line/>` без значения,
  // и строгий разбор на этом падает.
  allowBooleanAttributes: true,
  // Base64-полезная нагрузка картинок: берём только атрибут `id`, содержимое
  // пропускаем целиком. Иначе в файл попал бы мегабайт Base64 и разбор встал бы
  // на файлах с иллюстрациями.
  stopNodes: ['binary.*'],
});

/**
 * Убирает то, что ломает разбор, но не является содержимым книги.
 *
 * Список невелик и берётся из практики: FB2-файлы из разных изданий пестрят
 * необязательными конструкциями, каждая из которых роняет строгий XML-разбор
 * целиком — то есть теряется вся книга из-за одной строки в шапке.
 */
function preprocess(text: string): string {
  return text
    // `<binary>` — Base64-полезная нагрузка иллюстраций, встроенных в тот же
    // файл. Вырезаем ДО разбора: полезной нагрузки нам всё равно не нужно, а
    // `stopNodes` парсера в режиме preserveOrder отсекает только вложенные
    // элементы, но не текст, и килобайты Base64 попадали в текст книги.
    .replace(/<binary\b[^>]*>[\s\S]*?<\/binary\s*>/gi, '')
    .replace(/<binary\b[^>]*\/>/gi, '')
    // `<script>`, `<style>`, `<iframe>`, `<svg>` — вырезаем целиком вместе с
    // содержимым, а не только теги.
    //
    // Почему не полагаемся на пропуск тегов в `extractBlocks`: там элемент
    // пропускается, и его текст не попадает в блоки. Но в режиме preserveOrder
    // содержимое `<script>` приходит отдельным текстовым узлом, и при некоторых
    // сочетаниях соседних тегов оказывалось уже вне пропущенного элемента —
    // тогда код автора попадал в текст книги и попадал бы в поиск цитат.
    // Здесь это невозможно: к разбору просто не доходит ничего подобного.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    // `<?xml ... ?>`, `<?php ... ?>`, `<?xml-stylesheet ...?>`: инструкции,
    // которые fast-xml-parser и так пропускает, но с битым содержимым внутри
    // (`?>` в атрибуте) он спотыкается.
    .replace(/<\?[\s\S]*?\?>/g, '')
    // HTML-комментарии. Закрытые вырезаем целиком.
    .replace(/<!--[\s\S]*?-->/g, '')
    // Незакрытый `<!--` — а в FB2 это встречается — схлопнул бы в «до конца
    // файла» и унёс бы с собой всю книгу: `<body>`, все `<section>` и текст.
    // Потеря всей книги из-за одной забытой пары дефисов — неприемлемая цена,
    // поэтому незакрытый комментарий убирается только до конца строки: хвост
    // файла остаётся читаемым.
    .replace(/<!--[^\n]*/g, '')
    // CDATA: содержимое не разбираем, а текст оттуда в книгу не нужен.
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    // `<!DOCTYPE ...>`: внешние DTD мы всё равно не читаем, а встроенная
    // таблица сущностей — это как раз billion laughs.
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '')
    // Оставшиеся «голые» инструкции (`<!ENTITY ...>` и подобные).
    .replace(/<![^>]*>/g, '');
}

function parseXml(text: string): XmlNode[] {
  return normalizePreserved(parser.parse(preprocess(text)) as unknown);
}

/** Книжный текст с разобранного FB2. */
export interface ParsedFb2 {
  book: ParsedEpub;
  /** Как была прочитана кодировка: для журнала и диагностики. */
  decoded: DecodedText;
}

export function parseFb2(bytes: Uint8Array): ParsedEpub {
  return parseFb2Detailed(bytes).book;
}

export function parseFb2Detailed(bytes: Uint8Array): ParsedFb2 {
  const decoded = decodeFb2(bytes);
  const nodes = parseXml(decoded.text);

  const root = nodes.find(isElement);
  if (root === undefined) throw new Fb2Error('FB2: файл пуст или не содержит элементов');
  if (root.name !== 'fictionbook') {
    throw new Fb2Error(`FB2: корневой элемент <${root.name}>, а ожидался <FictionBook>`);
  }

  return { book: buildFb2(root), decoded };
}

/**
 * Теги, содержимое которых не является книжным текстом.
 *
 * Отличие от EPUB в том, что `title` здесь пропускать нельзя: это заголовок
 * главы. Зато добавляется `binary` — Base64-полезная нагрузка иллюстраций.
 */
const FB2_SKIP_TAGS: ReadonlySet<string> = new Set([
  'head', 'meta', 'link', 'base', 'style', 'script', 'noscript',
  'svg', 'math', 'template', 'col', 'colgroup', 'binary',
  'description', 'title-info', 'document-info', 'publish-info', 'custom-info',
  'genre', 'author', 'book-title', 'lang', 'coverpage', 'seq', 'empty-line',
  'annotation', 'keywords', 'translator', 'empty',
]);

const FB2_IMAGE_TAGS: ReadonlySet<string> = new Set(['image', 'img']);

function buildFb2(root: XmlElement): ParsedEpub {
  const title = firstBookTitle(root);
  const author = firstAuthor(root);
  const language = firstTextDeep(root, 'lang');
  const coverHref = findCoverHref(root);

  const chapters: EpubChapter[] = [];
  const body = firstChildElement(root, 'body');
  if (body !== null) {
    // Разделы верхнего уровня — главы. Вложенные `<section>` внутри главы
    // остаются её частью: у FB2 глава может состоять из подразделов, и дробить
    // её на каждый `<section>` значило бы создать главы по одному абзацу.
    let index = 0;
    for (const child of body.children) {
      if (!isElement(child) || child.name !== 'section') continue;
      const blocks = extractSectionBlocks(child);
      chapters.push({ index, id: sectionId(child, index), href: `#section-${index}`, blocks });
      index++;
    }
    // Книга без единого `<section>`: весь body читается как одна глава.
    if (chapters.length === 0) {
      const blocks = extractBlocks([body], { skipTags: FB2_SKIP_TAGS, imageTags: FB2_IMAGE_TAGS });
      chapters.push({ index: 0, id: 'body', href: '#body', blocks });
    }
  }

  const toc = buildToc(body, chapters);
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

/**
 * Блоки главы: заголовок, подзаголовок, содержимое и вложенные разделы.
 *
 * `<title>` в FB2 содержит `<p>`, поэтому он разбирается как обычные блоки —
 * так заголовок попадает в поток текста и на него можно поставить якорь
 * комментария, как на любой другой абзац.
 */
function extractSectionBlocks(section: XmlElement): EpubBlock[] {
  const blocks: EpubBlock[] = [];
  const opts = { skipTags: FB2_SKIP_TAGS, imageTags: FB2_IMAGE_TAGS };
  for (const child of section.children) {
    if (!isElement(child)) continue;
    if (child.name === 'section') {
      // Вложенный раздел: его заголовок идёт в ту же главу, но помечается как
      // подзаголовок, иначе он неотличим от заголовка главы.
      for (const inner of extractSectionBlocks(child)) {
        blocks.push({ ...inner, index: blocks.length });
      }
      continue;
    }
    if (child.name === 'title' || child.name === 'subtitle') {
      // Уровень задаётся по тегу, а не по содержимому: внутри `<title>` лежит
      // `<p>`, и без подмены заголовок главы выглядел бы как обычный абзац —
      // и в потоке текста, и в оглавлении.
      const level = child.name === 'title' ? 'h2' : 'h3';
      for (const block of extractBlocksOf(child, opts)) {
        blocks.push({ ...block, index: blocks.length, kind: level as EpubBlock['kind'] });
      }
      continue;
    }
    for (const block of extractBlocksOf(child, opts)) {
      blocks.push({ ...block, index: blocks.length });
    }
  }
  return blocks;
}

function sectionId(section: XmlElement, index: number): string {
  const id = section.attrs['id'];
  return id !== undefined && id !== '' ? id : `section-${index}`;
}

// ─── Метаданные ────────────────────────────────────────────────────────────────

/**
 * Название книги.
 *
 * Внутри `<book-title>` разрешено форматирование (`<emphasis>`), поэтому берём
 * текст поддерева, а не только текст прямого потомка.
 */
function firstBookTitle(root: XmlElement): string {
  const titles = descendants(root, 'book-title');
  for (const el of titles) {
    const text = normalizeText(textOf(el));
    if (text !== '') return text;
  }
  return '';
}

/**
 * Автор: `first-name` + `middle-name` + `last-name`, через запятую с `nickname`.
 *
 * Порядок элементов в файле не задан, а набор может быть любым, поэтому
 * собираем все известные поля и соединяем в читаемом виде.
 */
function firstAuthor(root: XmlElement): string {
  const authors = descendants(root, 'author');
  for (const author of authors) {
    const parts: string[] = [];
    for (const field of ['last-name', 'first-name', 'middle-name', 'nickname']) {
      const text = normalizeText(textOfInField(author, field));
      if (text !== '') parts.push(text);
    }
    if (parts.length > 0) return parts.join(' ').slice(0, 200);
  }
  return '';
}

function textOfInField(parent: XmlElement, field: string): string {
  const el = findElement(parent, field);
  return el === null ? '' : textOf(el);
}

function firstTextDeep(root: XmlElement, name: string): string {
  const el = findElement(root, name);
  return el === null ? '' : normalizeText(textOf(el));
}

/**
 * Обложка: `<coverpage><image href="#id"/></coverpage>`.
 *
 * Возвращаем ССЫЛКУ (`#id`), а не сам id: так рендерер может показать подпись
 * `[обложка]`, а разбирать Base64 целиком мы не будем в любом случае. В FB2 нет
 * путей внутри архива, поэтому никакого `resolveZipPath` здесь не нужно.
 */
function findCoverHref(root: XmlElement): string | null {
  const coverpage = findElement(root, 'coverpage');
  if (coverpage !== null) {
    for (const image of descendants(coverpage, 'image')) {
      const href = image.attrs['href'];
      if (typeof href === 'string' && href !== '') return href;
    }
  }
  // Встречается и без обёртки `<coverpage>`.
  for (const image of descendants(root, 'image')) {
    const href = image.attrs['href'];
    if (typeof href === 'string' && href.startsWith('#')) return href;
  }
  return null;
}

// ─── Оглавление ────────────────────────────────────────────────────────────────

/**
 * Оглавление из заголовков разделов.
 *
 * У FB2 нет аналога `nav`/NCX: единственный источник — `<title>` и `<subtitle>`
 * внутри `<section>`. Порядок и вложенность разделов совпадают с оглавлением
 * книги, поэтому берём верхний уровень и, для полноты, подзаголовки.
 */
function buildToc(body: XmlElement | null, chapters: EpubChapter[]): TocEntry[] {
  if (body === null) return fallbackToc(chapters);
  const out: TocEntry[] = [];

  for (const child of body.children) {
    if (!isElement(child) || child.name !== 'section') continue;
    const blocks = extractSectionBlocks(child);
    const heading = blocks.findIndex((b) => b.kind === 'h2' || b.kind === 'h3');
    if (heading < 0) continue;
    const block = blocks[heading] as EpubBlock;
    const chapter = chapters.find((c) => c.index === out.length);
    if (chapter === undefined) continue;
    out.push({
      label: block.text,
      href: chapter.href,
      chapterIndex: chapter.index,
      blockIndex: block.index,
    });
  }

  return out.length > 0 ? out : fallbackToc(chapters);
}

function fallbackToc(chapters: EpubChapter[]): TocEntry[] {
  return chapters.map((chapter) => {
    const heading = chapter.blocks.find((b) => b.kind === 'h2' || b.kind === 'h3');
    return {
      label: heading === undefined ? `Глава ${chapter.index + 1}` : heading.text,
      href: chapter.href,
      chapterIndex: chapter.index,
      blockIndex: heading === undefined ? 0 : heading.index,
    };
  });
}

export type { ParsedEpub };
