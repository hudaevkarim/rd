/**
 * Управляющие сообщения внутри зашифрованного P2P-канала.
 *
 * Всё, что здесь описано, уже прошло через AEAD, но это НЕ значит, что можно
 * расслабиться: пир, у которого есть ключ, может прислать любой байт. Поэтому
 * каждое сообщение парсится с проверкой полей и границ.
 *
 * Yjs-данные сюда НЕ попадают — они идут отдельными фреймами (YjsSync /
 * YjsAwareness), потому что это горячий путь и там JSON только мешал бы.
 */

import { isPlainObject, isShortString, isString } from './validate.js';
import { isUuidV4 } from './ids.js';
import { CHUNK_SIZE, MAX_FILE_NAME_LEN, MAX_CHAT_LEN } from './limits.js';
import type { BookId, TransferId } from './ids.js';

const MAX_ROOT_HEX = 64;
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4 ГиБ — потолок для MVP

/** Описание файла, который отправитель предлагает скачать. */
export interface FileOffer {
  transferId: TransferId;
  bookId: BookId;
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunkCount: number;
  /**
   * Контрольная сумма файла: SHA-256 от конкатенации SHA-256 всех чанков.
   * Не «хеш всего файла» сознательно — так проверка идёт потоково, без
   * необходимости держать гигабайт в памяти.
   */
  root: string;
}

export type CtrlMessage =
  | { k: 'ping'; id: number; at: number }
  | { k: 'pong'; id: number; at: number }
  | { k: 'chat'; id: string; text: string; at: number }
  /**
   * Запрос книги: «у меня её нет, пришлите».
   *
   * ─── Почему это отдельное сообщение, а не `file-offer` наоборот ──────────────
   *
   * Передача по требованию, а не всем подряд. Владелец файла решает, кому
   * отправить, а получатель решает, просить ли вообще. Без отдельного запроса
   * пришлось бы либо раздавать файл всем сразу (и он молча уезжал каждому, что
   * пользователя и возмущало), либо вводить обратный `file-offer`, который
   * неотличим от настоящего объявления.
   *
   * Запрос адресован по `bookId`, а не по `transferId`: transferId ещё
   * неизвестен — он рождается в момент, когда владелец согласится передать.
   */
  | { k: 'book-request'; bookId: string }
  /** Владелец отказал в передаче. Запрос снимается, книга не придёт. */
  | { k: 'book-decline'; bookId: string; reason: string }
  | { k: 'file-offer'; offer: FileOffer }
  | { k: 'file-accept'; transferId: TransferId }
  | { k: 'file-decline'; transferId: TransferId; reason: string }
  /** Запрос докачки: отправитель начинает с `offset`. */
  | { k: 'file-resume'; transferId: TransferId; offset: number }
  /**
   * Кумулятивное подтверждение приёма: «всё до `offset` принято и записано».
   *
   * Отправитель держит скользящее окно по неподтверждённым данным, а не только
   * по локальному буферу SCTP. Локальный буфер не знает, дошёл ли кадр до
   * получателя: SCTP освобождает место, как только данные доставлены в сокет
   * получателя, а не когда тот их записал в хранилище. Окно по ACK ограничивает
   * память получателя и одновременно служит детектором зависания: если
   * подтверждений нет дольше таймаута, передача считается вставшей и
   * перезапускается с подтверждённого смещения.
   */
  | { k: 'file-ack'; transferId: TransferId; offset: number }
  | { k: 'file-finish'; transferId: TransferId; root: string }
  | { k: 'file-cancel'; transferId: TransferId; reason: string }
  /** Пир подтвердил, что сверил код безопасности с пользователем. */
  | { k: 'trust-ack'; code: string };

export class CtrlError extends Error {}

const DECODER = new TextDecoder('utf-8', { fatal: true });
const ENCODER = new TextEncoder();

export function encodeCtrl(msg: CtrlMessage): Uint8Array {
  return ENCODER.encode(JSON.stringify(msg));
}

function fail(why: string): never {
  throw new CtrlError(why);
}

function isFileOffer(v: unknown): v is FileOffer {
  if (!isPlainObject(v)) return false;
  const o = v as Record<string, unknown>;
  if (!isUuidV4(o.transferId) || !isUuidV4(o.bookId)) return false;
  if (!isShortString(o.name, MAX_FILE_NAME_LEN)) return false;
  if (typeof o.size !== 'number' || !Number.isInteger(o.size) || o.size < 0 || o.size > MAX_FILE_SIZE) {
    return false;
  }
  if (!isShortString(o.mime, 128)) return false;
  if (o.chunkSize !== CHUNK_SIZE) return false;
  if (typeof o.chunkCount !== 'number' || !Number.isInteger(o.chunkCount) || o.chunkCount < 0) {
    return false;
  }
  // chunkCount обязан соответствовать size при фиксированном размере чанка —
  // иначе получатель не сможет заранее выделить/проверить целостность.
  if (o.chunkCount !== Math.ceil((o.size as number) / CHUNK_SIZE)) return false;
  if (typeof o.root !== 'string' || !/^[0-9a-f]{64}$/.test(o.root)) return false;
  return true;
}

export function parseCtrl(bytes: Uint8Array): CtrlMessage {
  let text: string;
  try {
    text = DECODER.decode(bytes);
  } catch {
    return fail('сообщение не является UTF-8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('сообщение не является JSON');
  }
  if (!isPlainObject(raw)) return fail('сообщение должно быть объектом');
  const m = raw as Record<string, unknown>;

  switch (m.k) {
    case 'ping':
    case 'pong': {
      if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id < 0) return fail('id: некорректно');
      if (typeof m.at !== 'number' || !Number.isFinite(m.at)) return fail('at: некорректно');
      return { k: m.k, id: m.id, at: m.at };
    }
    case 'chat': {
      if (!isUuidV4(m.id)) return fail('id: некорректно');
      if (typeof m.text !== 'string' || m.text.length === 0 || m.text.length > MAX_CHAT_LEN) {
        return fail('text: некорректно');
      }
      if (typeof m.at !== 'number' || !Number.isFinite(m.at)) return fail('at: некорректно');
      return { k: 'chat', id: m.id, text: m.text, at: m.at };
    }
    case 'book-request': {
      if (!isUuidV4(m.bookId)) return fail('bookId: некорректно');
      return { k: 'book-request', bookId: m.bookId };
    }
    case 'book-decline': {
      if (!isUuidV4(m.bookId)) return fail('bookId: некорректно');
      if (!isString(m.reason) || m.reason.length > 200) return fail('reason: некорректно');
      return { k: 'book-decline', bookId: m.bookId, reason: m.reason };
    }
    case 'file-offer':
      if (!isFileOffer(m.offer)) return fail('offer: некорректно');
      return { k: 'file-offer', offer: m.offer };
    case 'file-accept':
    case 'file-decline':
    case 'file-cancel': {
      if (!isUuidV4(m.transferId)) return fail('transferId: некорректно');
      if (m.k === 'file-decline' || m.k === 'file-cancel') {
        if (!isString(m.reason) || m.reason.length > 200) return fail('reason: некорректно');
        return { k: m.k, transferId: m.transferId, reason: m.reason };
      }
      return { k: 'file-accept', transferId: m.transferId };
    }
    case 'file-resume':
    case 'file-ack': {
      if (!isUuidV4(m.transferId)) return fail('transferId: некорректно');
      if (typeof m.offset !== 'number' || !Number.isInteger(m.offset) || m.offset < 0) {
        return fail('offset: некорректно');
      }
      if (m.offset > MAX_FILE_SIZE) return fail('offset: вне диапазона');
      return { k: m.k, transferId: m.transferId, offset: m.offset };
    }
    case 'file-finish': {
      if (!isUuidV4(m.transferId)) return fail('transferId: некорректно');
      if (typeof m.root !== 'string' || m.root.length !== MAX_ROOT_HEX || !/^[0-9a-f]+$/.test(m.root)) {
        return fail('root: некорректно');
      }
      return { k: 'file-finish', transferId: m.transferId, root: m.root };
    }
    case 'trust-ack': {
      if (typeof m.code !== 'string' || m.code.length > 32) return fail('code: некорректно');
      return { k: 'trust-ack', code: m.code };
    }
    default:
      return fail(`неизвестный тип: ${String(m.k)}`);
  }
}
