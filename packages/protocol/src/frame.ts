/**
 * Бинарный фрейм данных P2P-канала.
 *
 * Раскладка (little-endian не используем — выравнивание DataView-переносов
 * одинаково, зато байты заголовка удобно класть в AAD):
 *
 *   общая часть
 *   [0]      version = 0x01
 *   [1]      type
 *   [2..3]   flags   (бит 0 = sealed: тело зашифровано AES-GCM)
 *   [4..5]   headLen — длина заголовка, байт
 *   [6..]    head    — заголовок (JSON UTF-8 либо фиксированный бинарный)
 *   [..]     body    — полезная нагрузка (шифротекст, если sealed)
 *
 *   CHUNK-фрейм (headLen всегда 22, чтобы не гонять JSON на каждый 16 КиБ кусок)
 *   [0]      version
 *   [1]      type = 0x05
 *   [2..3]   flags
 *   [4..5]   headLen = 22
 *   [6..21]  transferId — 16 байт, сырой UUID
 *   [22..25] offset     — u32, смещение в файле
 *   [26..27] chunkLen   — u16, длина данных
 *   [28..]   data
 *
 * ВНИМАНИЕ: headLen — это длина ЧАСТИ ПОСЛЕ первых шести байт. Для CHUNK это
 * 16 + 4 + 2 = 22, а весь заголовок вместе с префиксом — 28 байт. Если указать
 * здесь 24, разборщик сдвинет начало тела на два байта и будет читать nonce как
 * данные: ошибка выглядит как «повреждённый файл» при perfectly корректной
 * передаче.
 *
 * Почему так, а не «просто JSON на каждое сообщение»: файл на 500 МБ при
 * CHUNK_SIZE=16 КиБ — это ~32 000 сообщений. Лишние 60 байт JSON на каждом дают
 * ~2 МБ мусора и лишние аллокации — на слабом ноутбуке это заметно.
 *
 * Флаг `sealed` вынесен в заголовок, а не в тело, чтобы шифратор мог
 * подставить его ДО вычисления AAD: тогда нельзя переставить тип фрейма или
 * подменить offset в чанке, не сломав аутентификационный тег.
 */

import { FRAME_VERSION, SEALED_OVERHEAD } from './limits.js';

export const FrameType = {
  /** Рукопожатие: публичные ключи, nonce, подпись. Идёт открытым — ключи ещё не согласованы. */
  Hello: 0x01,
  /** Бинарное сообщение y-protocols/sync (шаг 1, шаг 2, обновление). */
  YjsSync: 0x02,
  /** Бинарное сообщение y-protocols/awareness (presence). */
  YjsAwareness: 0x03,
  /** Управляющее сообщение: JSON-заголовок + необязательное бинарное тело. */
  Json: 0x04,
  /** Чанк файла. */
  Chunk: 0x05,
} as const;

export type FrameTypeName = keyof typeof FrameType;

export const FLAG_SEALED = 0x0001;

const FIXED_HEAD = 6;
/** Полный заголовок CHUNK-кадра: 6 байт префикса + 22 байта полезной части. */
const CHUNK_HEAD = 28;
/** Полезная часть заголовка CHUNK: transferId(16) + offset(4) + chunkLen(2). */
const CHUNK_HEAD_LEN = 22;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Собирает заголовок фрейма: 6 байт фиксированной части + полезная часть заголовка.
 * Возвращается Uint8Array, который одновременно является AAD для AEAD.
 */
export function buildHead(
  type: number,
  head: Uint8Array,
  sealed: boolean,
): Uint8Array {
  const out = new Uint8Array(FIXED_HEAD + head.length);
  const dv = new DataView(out.buffer);
  out[0] = FRAME_VERSION;
  out[1] = type;
  dv.setUint16(2, sealed ? FLAG_SEALED : 0, false);
  dv.setUint16(4, head.length, false);
  out.set(head, FIXED_HEAD);
  return out;
}

export function buildJsonHead(type: number, header: unknown, sealed: boolean): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(header);
  } catch (err) {
    throw new FrameError(`не удалось сериализовать заголовок: ${(err as Error).message}`);
  }
  const bytes = ENCODER.encode(json);
  if (bytes.length > 0xffff) throw new FrameError('заголовок кадра слишком велик');
  return buildHead(type, bytes, sealed);
}

export function buildChunkHead(
  transferIdBytes: Uint8Array,
  offset: number,
  chunkLen: number,
  sealed: boolean,
): Uint8Array {
  if (transferIdBytes.length !== 16) throw new FrameError('transferId должен быть 16 байт');
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) {
    throw new FrameError('offset вне диапазона u32');
  }
  if (!Number.isInteger(chunkLen) || chunkLen < 0 || chunkLen > 0xffff) {
    throw new FrameError('chunkLen вне диапазона u16');
  }
  const out = new Uint8Array(CHUNK_HEAD);
  const dv = new DataView(out.buffer);
  out[0] = FRAME_VERSION;
  out[1] = FrameType.Chunk;
  dv.setUint16(2, sealed ? FLAG_SEALED : 0, false);
  dv.setUint16(4, CHUNK_HEAD_LEN, false);
  out.set(transferIdBytes, 6);
  dv.setUint32(22, offset, false);
  dv.setUint16(26, chunkLen, false);
  return out;
}

export interface ParsedHead {
  type: number;
  sealed: boolean;
  /** Байты заголовка — они же AAD. */
  aad: Uint8Array;
  /** JSON-заголовок, если это JSON-фрейм. */
  json: unknown;
  /** Для CHUNK-фрейма. */
  chunk?: { transferId: Uint8Array; offset: number; length: number };
  /** Всё после заголовка. Если sealed — это nonce||ciphertext||tag. */
  payload: Uint8Array;
}

/**
 * Разбирает кадр. Бросает FrameError на любом нарушении структуры.
 * Никаких «мягких» разборов: кадр пришёл от другого узла, доверять нельзя.
 */
export function readFrame(buf: Uint8Array): ParsedHead {
  if (buf.length < FIXED_HEAD) throw new FrameError('кадр короче фиксированного заголовка');
  if (buf[0] !== FRAME_VERSION) {
    throw new FrameError(`неподдерживаемая версия кадра: ${String(buf[0])}`);
  }
  const type = buf[1] as number;
  const flags = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(2, false);
  if ((flags & ~FLAG_SEALED) !== 0) throw new FrameError('неизвестные флаги кадра');
  const sealed = (flags & FLAG_SEALED) !== 0;
  const headLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(4, false);
  const aad = buf.subarray(0, FIXED_HEAD + headLen);
  const payload = buf.subarray(FIXED_HEAD + headLen);

  if (type === FrameType.Chunk) {
    if (headLen !== CHUNK_HEAD_LEN) throw new FrameError('неверная длина заголовка CHUNK');
    const offset = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(22, false);
    const length = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(26, false);
    // В зашифрованном кадре тело длиннее данных чанка на nonce+тег: длина,
    // объявленная в заголовке, относится к ОТКРЫТЫМ данным, а в кадре лежит
    // шифротекст. Без этой поправки любой зашифрованный чанк отвергался бы как
    // «повреждённый».
    const expected = length + (sealed ? SEALED_OVERHEAD : 0);
    if (payload.length !== expected) {
      throw new FrameError(`заявленная длина чанка ${expected} != фактическая ${payload.length}`);
    }
    return {
      type,
      sealed,
      aad,
      json: undefined,
      chunk: { transferId: buf.slice(6, 22), offset, length },
      payload,
    };
  }

  if (type !== FrameType.Json && type !== FrameType.Hello && type !== FrameType.YjsSync && type !== FrameType.YjsAwareness) {
    throw new FrameError(`неизвестный тип кадра: ${type}`);
  }

  let json: unknown = undefined;
  if (headLen > 0) {
    if (type === FrameType.YjsSync || type === FrameType.YjsAwareness) {
      // Для Yjs-фреймов заголовок — это непрозрачный префикс (обычно пустой).
      // JSON там не допускаем: это бинарный канал.
      throw new FrameError('Yjs-фрейм не должен нести JSON-заголовок');
    }
    let text: string;
    try {
      text = DECODER.decode(aad.subarray(FIXED_HEAD));
    } catch {
      throw new FrameError('заголовок не является валидным UTF-8');
    }
    try {
      json = JSON.parse(text);
    } catch {
      throw new FrameError('заголовок не является валидным JSON');
    }
  }

  return { type, sealed, aad, json, payload };
}

/** Собирает готовый (незашифрованный) кадр. Используется в тестах и для отладочного дампа. */
export function encodePlainFrame(type: number, head: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}
