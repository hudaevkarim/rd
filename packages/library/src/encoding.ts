/**
 * Определение кодировки FB2.
 *
 * ─── Почему это отдельная задача ──────────────────────────────────────────────
 *
 * FB2 вышел в 2004 году как XML для русскоязычных изданий, и значительная часть
 * книг в сети хранится в однобайтовых кодировках: `windows-1251` у большинства,
 * `koi8-r` у части. При этом UTF-8 там встречается всё чаще, иногда с BOM, иногда
 * с честным `encoding="utf-8"` в объявлении, а иногда вообще без объявления.
 *
 * Наивное `new TextDecoder('utf-8')` даёт на такой файл «Ð¿Ñ€Ð¸Ð²ÐµÑ‚» или
 * крякозябры с U+FFFD — и выглядит это не как «книга на чужом языке», а как
 * битый файл. Пользователь решит, что ему прислали мусор.
 *
 * ─── Стратегия ────────────────────────────────────────────────────────────────
 *
 * Порядок источников, от более надёжного к менее:
 *
 *   1. **BOM** — единственный однозначный признак. Побеждает всегда.
 *   2. **Объявление `<?xml encoding="..."?>`** — автор файла назвал сам.
 *   3. **Строгая проверка UTF-8** — если байты образуют корректный UTF-8, это
 *      UTF-8. Проверка строгая (через `fatal`), а не «заменить битые на �»:
 *      именно отказ разбирать невалидную последовательность и отличает UTF-8 от
 *      однобайтовой кодировки, где почти любой байт «валиден».
 *   4. **Распределение байтов** — когда файл не UTF-8, остаётся выбрать между
 *      однобайтовыми. Это делается не по догадкам о правдоподобии текста, а по
 *      устройству самих кодировок:
 *
 *        - в `windows-1251` строчные русские буквы лежат в `0xE0..0xFF`, а
 *          заглавные — в `0xC0..0xDF`;
 *        - в `koi8-r` наоборот: строчные в `0xC0..0xDF`, заглавные в
 *          `0xE0..0xFF`.
 *
 *      В русском прозе строчных букв подавляющее большинство (заглавные —
 *      начала предложений и имена собственные, единицы процентов). Значит у
 *      настоящей windows-1251 почти все не-ASCII байты лежат выше `0xE0`, а у
 *      настоящей koi8-r — ниже. На реальных фикстурах разделение абсолютное:
 *      0.95 против 0.04, то есть误 перепутать практически невозможно.
 *
 *      Первая версия этой схемы считала «правдоподобие» готового текста
 *      (кириллица, пробелы) — и это не работало: количество кириллицы и пробелов
 *      у обеих расшифровок ОДИНАКОВОЕ, потому что обе кодировки отображают
 *      ASCII-пробел в `0x20` и кириллицу в тот же диапазон. Оценка всегда
 *      выходила равной, и выбор шёл по порядку, то есть по подбрасыванию.
 *
 * Шаг 4 остаётся эвристикой в одном честном смысле: без BOM и без объявления
 * однобайтовые кодировки различаются только таким способом, и для книги, где
 * русского текста почти нет, разницы не будет — там все кандидаты дают
 * практически одинаковый результат.
 */

/** Кодировки, которые имеет смысл пробов��ть. */
export const LEGACY_ENCODINGS = ['windows-1251', 'koi8-r'] as const;

export type LegacyEncoding = (typeof LEGACY_ENCODINGS)[number];

/**
 * Полоса, где в однобайтовой кодировке лежат строчные кириллические буквы.
 *
 * Это единственное знание о кодировке, на котором держится выбор: всё остальное
 * (кириллица, пробелы, пунктуация) у них совпадает по построению.
 */
const LOWERCASE_BAND: Record<LegacyEncoding, [number, number]> = {
  'windows-1251': [0xe0, 0xff],
  'koi8-r': [0xc0, 0xdf],
};

export interface DecodedText {
  text: string;
  /** Какая кодировка сработала: `utf-8`, `windows-1251`, … */
  encoding: string;
  /** Чем решили: для диагностики и журнала, не для логики. */
  source: 'bom' | 'declared' | 'utf-8-valid' | 'legacy-score' | 'fallback';
}

const XML_DECLARATION = /^\s*<\?xml\s[^>]*?encoding\s*=\s*["']([A-Za-z0-9_.:+-]+)["']/i;

/** Кодировка из BOM, либо null. BOM читаем по байтам, а не через TextDecoder. */
function fromBom(bytes: Uint8Array): { encoding: string; length: number } | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', length: 3 };
  }
  // UTF-16: в FB2 не встречается, но раз файл начат с такого маркера, читать
  // его как utf-8 бессмысленно — иначе получится мусор вместо книги.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { encoding: 'utf-16le', length: 2 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { encoding: 'utf-16be', length: 2 };
  }
  return null;
}

/** Есть ли у bytes кодировка без потери байтов. */
function decodeStrict(encoding: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeLoose(encoding: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Доля не-ASCII байтов, попавших в полосу строчных кириллических букв.
 *
 * Возвращает 0..1. Для настоящей однобайтовой кодировки с русским текстом
 * значение близко к 1, для перепутанной — близко к нулю.
 *
 * Для кодировок, полосу которых мы не знаем (latin1, ibm866), полоса
 * неизвестна, и функция возвращает долю байтов в общей «верхней» половине —
 * то есть в том, что вообще похоже на старшие байты кириллицы.
 */
export function legacyByteScore(bytes: Uint8Array, encoding: LegacyEncoding | string): number {
  const band = LOWERCASE_BAND[encoding as LegacyEncoding];
  let nonAscii = 0;
  let inBand = 0;
  for (const byte of bytes) {
    if (byte < 0x80) continue;
    nonAscii++;
    if (band === undefined) {
      // Полоса неизвестна: считаем «похожими на строчные» байты 0xE0..0xFF,
      // это верно для большинства однобайтовых кириллических кодировок.
      if (byte >= 0xe0) inBand++;
      continue;
    }
    if (byte >= band[0] && byte <= band[1]) inBand++;
  }
  // Не-ASCII байтов нет — сравнивать нечего, и «идеального» кандидата быть не
  // может: вернём 0, чтобы выбор ушёл по порядку, а не по случайному нулю.
  return nonAscii === 0 ? 0 : inBand / nonAscii;
}

/**
 * Разбирает байты FB2 в строку вместе с указанием кодировки.
 *
 * Никогда не бросает исключение из-за кодировки: худший случай — текст с
 * мусорными символами, и это честнее, чем отказ показывать книгу вовсе.
 */
export function decodeFb2(bytes: Uint8Array): DecodedText {
  if (bytes.length === 0) return { text: '', encoding: 'utf-8', source: 'fallback' };

  const bom = fromBom(bytes);
  if (bom !== null) {
    const body = bom.length === 2 ? swapIfUtf16Be(bytes, bom.encoding) : bytes.subarray(bom.length);
    return { text: decodeLoose(bom.encoding, body), encoding: bom.encoding, source: 'bom' };
  }

  // Строгая проверка UTF-8 — главный сигнал после BOM. Настоящий однобайтовый
  // русский текст почти никогда не проходит её: в windows-1251 и koi8-r все
  // байты 0xC0..0xFF, а в UTF-8 0xC0/0xC1 запрещены, а 0xC2..0xDF обязаны
  // сопровождаться байтом продолжения из 0x80..0xBF, которого в этих
  // кодировках практически нет.
  const utf8 = decodeStrict('utf-8', bytes);
  const hasNonAscii = bytes.some((b) => b >= 0x80);

  // Объявление смотрим в latin1: оно читается одинаково в любой однобайтовой
  // кодировке, потому что там ASCII-совместимая начальная часть.
  const declaredRaw = XML_DECLARATION.exec(decodeLatin1(bytes.subarray(0, 200)))?.[1];
  const declared = declaredRaw === undefined ? null : normalizeEncodingName(declaredRaw);

  if (declared !== null && declared !== 'utf-8') {
    // Объявление может врать, а в однобайтовой кодировке проверка строгости
    // бесполезна: там «валидно» абсолютно всё. Поэтому верю объявлению только
    // если байты при этом НЕ являются корректным UTF-8 — тогда альтернативы
    // просто нет, и мы не отбрасываем единственное верное объяснение.
    if (utf8 === null || !hasNonAscii) {
      const text = decodeLoose(declared, bytes);
      if (text !== '') return { text, encoding: declared, source: 'declared' };
    }
  }

  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', source: 'utf-8-valid' };

  if (declared !== null) {
    const text = decodeLoose(declared, bytes);
    if (text !== '') return { text, encoding: declared, source: 'declared' };
  }

  // Однобайтовые кандидаты: решает распределение байтов, а не правдоподобие
  // текста (см. комментарий в начале модуля).
  let best: { text: string; encoding: LegacyEncoding; score: number } | null = null;
  for (const encoding of LEGACY_ENCODINGS) {
    const score = legacyByteScore(bytes, encoding);
    // Первый кандидат при равенстве: порядок в LEGACY_ENCODINGS отражает
    // распространённость (windows-1251 встречается заметно чаще).
    if (best === null || score > best.score) {
      best = { text: decodeLoose(encoding, bytes), encoding, score };
    }
  }
  if (best !== null && best.score > 0) {
    return { text: best.text, encoding: best.encoding, source: 'legacy-score' };
  }

  return { text: decodeLoose('utf-8', bytes), encoding: 'utf-8', source: 'fallback' };
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** UTF-16BE в TextDecoder не поддерживается штатно — переворачиваем байты. */
function swapIfUtf16Be(bytes: Uint8Array, encoding: string): Uint8Array {
  if (encoding !== 'utf-16be') return bytes;
  const body = bytes.subarray(2);
  const out = new Uint8Array(body.length);
  for (let i = 0; i + 1 < body.length; i += 2) {
    out[i] = body[i + 1] as number;
    out[i + 1] = body[i] as number;
  }
  return out;
}

/**
 * Приводит имя кодировки к тому, что понимает `TextDecoder`.
 *
 * В FB2 встречаются синонимы: `cp1251`, `Win-1251`, `KOI8-R`, `windows-1251`.
 * `TextDecoder` понимает только канонические имена из стандарта WHATWG.
 */
export function normalizeEncodingName(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/[_\s]/g, '-');
  if (name === 'utf8') return 'utf-8';
  if (name === 'utf-8' || name === 'unicode-1-1-utf-8') return 'utf-8';
  if (name === 'ascii' || name === 'us-ascii') return 'windows-1252';
  if (name === 'cp1251' || name === 'win-1251' || name === 'win1251' || name === 'ms1251') return 'windows-1251';
  if (name === 'cp1252' || name === 'win-1252') return 'windows-1252';
  if (name === 'koi8r' || name === 'koi8-r') return 'koi8-r';
  if (name === 'ibm866' || name === 'cp866' || name === 'ibm-866') return 'ibm866';
  return name;
}
