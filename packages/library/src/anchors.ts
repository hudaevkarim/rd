/**
 * Якоря комментариев и вычисление прогресса.
 *
 * Якорь к тексту — это НЕ координаты в пикселях и не CFI, а
 * (глава, блок, смещение) ПЛЮС цитата с окружающим контекстом. Такой якорь
 * переживает:
 *   - другую вёрстку и переносы строк (цитата ищется по тексту, а не по DOM);
 *   - перенумерацию блоков, если книгу пересобрали из другого издания;
 *   - правку соседних абзацев.
 *
 * Поиск идёт от «точного» к «широкому»: сначала точные координаты, потом цитата
 * внутри исходного блока, потом в главе, потом по всей книге. Широкий поиск
 * нужен для книг, у которых у разных участников немного разное разбиение на
 * абзацы (разные издания, разные читалки).
 *
 * Проблема пробелов: у одного человека в тексте «неразлучны», у другого
 * «не­раз­лучны» с мягкими переносами. Поэтому поиск идёт по тексту без
 * пробелов, а найденные позиции переводятся обратно в исходные координаты через
 * таблицу соответствия. Это ровно то, за что в W3C Web Annotation отвечает
 * селектор TextQuoteSelector.
 */

import type { ParsedEpub } from './epub.js';

export interface TextAnchor {
  kind: 'text';
  chapterIndex: number;
  blockIndex: number;
  start: number;
  end: number;
  /** Точный выделенный текст. */
  quote: string;
  /** Контекст слева и справа — помогает отличить повторяющиеся цитаты. */
  prefix: string;
  suffix: string;
}

export interface AudioAnchor {
  kind: 'audio';
  /** Позиция в секундах от начала аудиокниги. */
  timeSec: number;
  /** Необязательная цитата: реплика, имя персонажа, название главы. */
  quote?: string;
}

export type CommentAnchor = TextAnchor | AudioAnchor;

const CONTEXT_LEN = 32;

// ─── Устойчивый поиск цитаты ───────────────────────────────────────────────────

interface Stripped {
  text: string;
  /** offsets[i] — индекс в исходной строке i-го непробельного символа. */
  offsets: number[];
}

// Кэш нужен потому, что resolveTextAnchor прогоняет цитату по сотням блоков, и
// одни и те же строки встречаются многократно. Ограничение по размеру, чтобы
// при перелистывании большой книги не течь по памяти.
const STRIP_CACHE = new Map<string, Stripped>();
const STRIP_CACHE_MAX = 4_000;

const WS_RE = /[\s ]+/g;
const WS_CHAR_RE = /[\s ]/;

function strip(text: string): Stripped {
  const hit = STRIP_CACHE.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (WS_CHAR_RE.test(ch)) continue;
    out += ch;
    offsets.push(i);
  }
  const result: Stripped = { text: out, offsets };
  if (STRIP_CACHE.size >= STRIP_CACHE_MAX) STRIP_CACHE.clear();
  STRIP_CACHE.set(text, result);
  return result;
}

function squeeze(text: string): string {
  return text.replace(WS_RE, '');
}

export interface QuoteMatch {
  start: number;
  end: number;
  /** Насколько совпадение широкое: 0 — точные координаты, 1 — цитата с учётом контекста. */
  confidence: 0 | 1;
}

/**
 * Ищет цитату в строке. Сначала точное вхождение, затем — по тексту без
 * пробелов. Возвращает координаты В ИСХОДНОЙ строке.
 */
export function findQuote(
  haystack: string,
  quote: string,
  context: { prefix?: string; suffix?: string } = {},
): QuoteMatch | null {
  if (quote === '') return null;

  const direct = haystack.indexOf(quote);
  if (direct >= 0) return { start: direct, end: direct + quote.length, confidence: 0 };

  const needle = squeeze(quote);
  if (needle === '') return null;

  const s = strip(haystack);
  let at = s.text.indexOf(needle);
  if (at < 0 && (context.prefix !== undefined || context.suffix !== undefined)) {
    // Пробуем с контекстом: цитата вроде «сказал он» встречается в книге
    // десятки раз, а вот «сказал он, и все замолчали» — один раз.
    const head = squeeze(context.prefix ?? '').slice(-CONTEXT_LEN);
    const tail = squeeze(context.suffix ?? '').slice(0, CONTEXT_LEN);
    const full = head + needle + tail;
    const atFull = s.text.indexOf(full);
    if (atFull >= 0) {
      at = atFull + head.length;
      const first = s.offsets[at];
      const last = s.offsets[at + needle.length - 1];
      if (first === undefined || last === undefined) return null;
      return { start: first, end: last + 1, confidence: 1 };
    }
    return null;
  }
  if (at < 0) return null;

  const first = s.offsets[at];
  const last = s.offsets[at + needle.length - 1];
  if (first === undefined || last === undefined) return null;
  return { start: first, end: last + 1, confidence: 1 };
}

// ─── Создание якоря ────────────────────────────────────────────────────────────

export function createTextAnchor(
  book: ParsedEpub,
  chapterIndex: number,
  blockIndex: number,
  start: number,
  end: number,
): TextAnchor | null {
  const chapter = book.chapters[chapterIndex];
  const block = chapter?.blocks[blockIndex];
  if (chapter === undefined || block === undefined) return null;
  const quote = block.text.slice(start, end);
  if (quote.trim() === '') return null;
  return {
    kind: 'text',
    chapterIndex,
    blockIndex,
    start,
    end,
    quote,
    prefix: block.text.slice(Math.max(0, start - CONTEXT_LEN), start),
    suffix: block.text.slice(end, end + CONTEXT_LEN),
  };
}

export interface ResolvedAnchor {
  chapterIndex: number;
  blockIndex: number;
  start: number;
  end: number;
  confidence: 0 | 1 | 2;
  /** Якорь перестал соответствовать книге (цитата не найдена). */
  stale: boolean;
}

/**
 * Восстанавливает положение якоря в конкретной копии книги.
 * `stale: true` означает, что цитату найти не удалось: комментарий показываем
 * как «привязанный к неизвестному месту», а не молча выбрасываем — потерять
 * чужое мнение молча хуже, чем показать его с пометкой.
 */
export function resolveTextAnchor(book: ParsedEpub, anchor: TextAnchor): ResolvedAnchor {
  // 1. Точные координаты.
  const exactBlock = book.chapters[anchor.chapterIndex]?.blocks[anchor.blockIndex];
  if (exactBlock !== undefined && exactBlock.text.slice(anchor.start, anchor.end) === anchor.quote) {
    return {
      chapterIndex: anchor.chapterIndex,
      blockIndex: anchor.blockIndex,
      start: anchor.start,
      end: anchor.end,
      confidence: 0,
      stale: false,
    };
  }

  // 2. Цитата внутри исходного блока.
  if (exactBlock !== undefined) {
    const local = findQuote(exactBlock.text, anchor.quote, { prefix: anchor.prefix, suffix: anchor.suffix });
    if (local !== null) {
      return {
        chapterIndex: anchor.chapterIndex,
        blockIndex: anchor.blockIndex,
        start: local.start,
        end: local.end,
        confidence: 0,
        stale: false,
      };
    }
  }

  // 3. Цитата в той же главе.
  const chapter = book.chapters[anchor.chapterIndex];
  if (chapter !== undefined) {
    for (const block of chapter.blocks) {
      const found = findQuote(block.text, anchor.quote, { prefix: anchor.prefix, suffix: anchor.suffix });
      if (found !== null) {
        return {
          chapterIndex: anchor.chapterIndex,
          blockIndex: block.index,
          start: found.start,
          end: found.end,
          confidence: 1,
          stale: false,
        };
      }
    }
  }

  // 4. Цитата где-то ещё в книге.
  for (const ch of book.chapters) {
    for (const block of ch.blocks) {
      const found = findQuote(block.text, anchor.quote, { prefix: anchor.prefix, suffix: anchor.suffix });
      if (found !== null) {
        return { chapterIndex: ch.index, blockIndex: block.index, start: found.start, end: found.end, confidence: 2, stale: false };
      }
    }
  }

  return {
    chapterIndex: anchor.chapterIndex,
    blockIndex: anchor.blockIndex,
    start: anchor.start,
    end: anchor.end,
    confidence: 0,
    stale: true,
  };
}

// ─── Прогресс ──────────────────────────────────────────────────────────────────

/**
 * Глобальный «прогресс по книге» в долях от 0 до 1.
 *
 * Считается по числу блоков, а не по страницам: вёрстка у каждого своя, а блоки
 * — это то, что реально совпадает у всех участников. Для аудио используется
 * та же шкала, но по времени.
 */
export class BookIndex {
  readonly book: ParsedEpub;
  readonly #chapterStart: number[];
  readonly #total: number;

  constructor(book: ParsedEpub) {
    this.book = book;
    this.#total = book.totalBlocks;
    const starts: number[] = [];
    let acc = 0;
    for (const chapter of book.chapters) {
      starts.push(acc);
      acc += chapter.blocks.length;
    }
    this.#chapterStart = starts;
  }

  get totalBlocks(): number {
    return this.#total;
  }

  get chapterCount(): number {
    return this.book.chapters.length;
  }

  /** Глобальная доля 0..1 для позиции внутри блока. */
  progressOf(chapterIndex: number, blockIndex: number, charOffset?: number): number {
    if (this.#total === 0) return 0;
    const chapter = this.book.chapters[chapterIndex];
    if (chapter === undefined) return 0;
    const clampedBlock = Math.max(0, Math.min(blockIndex, Math.max(0, chapter.blocks.length - 1)));
    const block = chapter.blocks[clampedBlock];
    if (block === undefined) return 0;
    const start = (this.#chapterStart[chapterIndex] ?? 0) + clampedBlock;
    const within = charOffset === undefined || block.text.length === 0 ? 0 : Math.min(1, Math.max(0, charOffset / block.text.length));
    return Math.min(1, Math.max(0, (start + within) / this.#total));
  }

  /** Доля для аудиоякоря. `durationSec` обязателен: без него шкала бессмысленна. */
  progressOfAudio(anchor: AudioAnchor, durationSec: number): number {
    if (durationSec <= 0) return 0;
    return Math.min(1, Math.max(0, anchor.timeSec / durationSec));
  }

  progressOfAnchor(anchor: CommentAnchor, audioDurationSec?: number): number {
    if (anchor.kind === 'audio') return this.progressOfAudio(anchor, audioDurationSec ?? 0);
    return this.progressOf(anchor.chapterIndex, anchor.blockIndex, anchor.start);
  }

  /** Обратное преобразование: доля 0..1 → (глава, блок). */
  locate(progress: number): { chapterIndex: number; blockIndex: number } {
    if (this.#total === 0 || this.#chapterStart.length === 0) return { chapterIndex: 0, blockIndex: 0 };
    const target = Math.min(this.#total - 1, Math.max(0, Math.round(progress * this.#total)));
    for (let i = 0; i < this.#chapterStart.length; i++) {
      const start = this.#chapterStart[i] ?? 0;
      const len = this.book.chapters[i]?.blocks.length ?? 0;
      if (len === 0) continue;
      if (target < start + len) return { chapterIndex: i, blockIndex: target - start };
    }
    const last = this.#chapterStart.length - 1;
    return { chapterIndex: last, blockIndex: Math.max(0, (this.book.chapters[last]?.blocks.length ?? 1) - 1) };
  }
}

/**
 * Допуск при сравнении прогресса. Без него комментарий появлялся бы в момент,
 * когда читатель пролистал мимо на пару строк, а не когда дочитал.
 */
export const SPOILER_TOLERANCE = 0.005;

/**
 * Спойлер скрыт, пока читатель не добрался до места комментария.
 * Само содержимое при этом никуда не девается — оно замаскировано в интерфейсе.
 */
export function isSpoilerHidden(
  anchor: CommentAnchor,
  readerProgress: number,
  index: BookIndex,
  audioDurationSec?: number,
): boolean {
  return index.progressOfAnchor(anchor, audioDurationSec) > readerProgress + SPOILER_TOLERANCE;
}
