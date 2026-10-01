/**
 * Типы-новости: идентификаторы и брендированные строки.
 *
 * Идентификаторы — всегда UUIDv4 в каноническом нижнем регистре с дефисами.
 * Мы не полагаемся на Math.random(): при генерации ключей и nonce это недопустимо,
 * поэтому в crypto-пакете используется crypto.getRandomValues, а здесь — только
 * для несекретных ID (комната, книга, комментарий, передача).
 */

export type RoomId = string;
export type PeerId = string;
export type BookId = string;
export type CommentId = string;
export type TransferId = string;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_RE = /^[0-9a-f]+$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Генерирует криптографически стойкий UUIDv4. Работает и в Node, и в браузере. */
export function newId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Раскладка UUIDv4 по RFC 4122:
  //   bytes[6] — старший ниббл time_hi_and_version, там живёт версия 4;
  //   bytes[8] — старшие биты clock_seq_hi_and_reserved, там вариант 10xx.
  // Ошибка в любом из двух мест даёт «почти UUID», который не проходит нашу же
  // проверку isUuidV4 — поэтому заодно покрыто тестом.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

/** Короткий префикс для отображения в UI, чтобы не путать две книги с одинаковым названием. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ─── Преобразование UUID ↔ байты ───────────────────────────────────────────────

/**
 * UUID в 16 байт — для компактного заголовка кадра передачи файла.
 *
 * Почему это в протоколе, а не в p2p: обе стороны обязаны получить ОДИНАКОВУЮ
 * строку. Наивный `toHex(16 байт)` даёт 32 символа без дефисов, и идентификатор
 * перестаёт совпадать с тем, по которому запись лежит в принимающей таблице —
 * файл «скачивается», но не собирается.
 */
export function uuidToBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, '');
  if (hex.length !== 32 || !HEX_RE.test(hex)) throw new Error('ожидался UUIDv4');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Обратное преобразование: 16 байт → канонический UUID с дефисами. */
export function uuidFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('ожидалось 16 байт');
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
