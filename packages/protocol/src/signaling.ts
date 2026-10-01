/**
 * Сообщения signaling-сервера: строго типизированные и строго валидируемые.
 *
 * Сервер НИЧЕГО не хранит, кроме реестра участников комнаты, который нужен
 * только для маршрутизации. Никакие SDP/ICE-данные, тем более содержимое
 * книг или комментариев, на диск не попадают и не логируются.
 *
 * Все сообщения — компактные строковые ключи (`t`), потому что это хот-путь:
 * при сотнях соединений JSON.parse на длинных ключах экономнее по памяти.
 */

import { PROTOCOL_VERSION } from './limits.js';
import { AGREE_KEY_BYTES, IDENTITY_KEY_BYTES } from './hello.js';
import type { PeerId, RoomId } from './ids.js';
import {
  isHex,
  isHexColor,
  isIceCandidate,
  isPeerId,
  isPeerName,
  isRoomId,
  isSdp,
  type IceCandidatePayload,
  type PeerDescriptor,
} from './validate.js';

export type ErrorCode =
  | 'bad-message'
  | 'room-full'
  | 'room-not-found'
  | 'protocol-mismatch'
  | 'rate-limited'
  | 'too-large'
  | 'duplicate-id'
  | 'not-joined'
  | 'internal';

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  'bad-message': 'Некорректное сообщение',
  'room-full': 'Комната заполнена',
  'room-not-found': 'Комната не найдена',
  'protocol-mismatch': 'Неподдерживаемая версия протокола',
  'rate-limited': 'Слишком много запросов',
  'too-large': 'Сообщение слишком велико',
  'duplicate-id': 'Идентификатор уже используется',
  'not-joined': 'Сначала нужно присоединиться к комнате',
  internal: 'Внутренняя ошибка сервера',
};

// ─── Клиент → сервер ───────────────────────────────────────────────────────────

export type ClientMessage =
  | {
      t: 'join';
      room: RoomId;
      peer: PeerDescriptor;
      protocol: number;
    }
  | { t: 'signal'; to: PeerId; kind: 'offer' | 'answer'; sdp: string }
  | { t: 'candidate'; to: PeerId; candidate: IceCandidatePayload }
  | { t: 'rename'; name: string; color: string }
  | { t: 'ping'; id: number; at: number }
  | { t: 'leave' };

// ─── Сервер → клиент ───────────────────────────────────────────────────────────

export type ServerMessage =
  | {
      t: 'welcome';
      self: PeerDescriptor;
      peers: PeerDescriptor[];
      protocol: number;
      serverTime: number;
    }
  | { t: 'peer-joined'; peer: PeerDescriptor }
  | { t: 'peer-left'; id: PeerId; reason: 'left' | 'timeout' | 'duplicate' }
  | { t: 'renamed'; id: PeerId; name: string; color: string }
  | { t: 'signal'; from: PeerId; kind: 'offer' | 'answer'; sdp: string }
  | { t: 'candidate'; from: PeerId; candidate: IceCandidatePayload }
  | { t: 'pong'; id: number; at: number; serverTime: number }
  | { t: 'ping'; id: number; at: number }
  | { t: 'error'; code: ErrorCode; message: string; fatal: boolean };

// ─── Валидация ─────────────────────────────────────────────────────────────────

function fail(code: ErrorCode, message: string): never {
  const err = new Error(message) as Error & { code?: ErrorCode };
  err.code = code;
  throw err;
}

/**
 * Проверяет входящее сообщение клиента. Бросает исключение с `.code`,
 * чтобы вызывающая сторона могла превратить его в `error`-сообщение.
 *
 * Мы НЕ используем здесь `any` и не «доверяем» полям: каждое поле проверяется
 * по отдельности, потому что это единственная точка, где в сервер попадают
 * данные из сети.
 */
export function parseClientMessage(raw: unknown): ClientMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('bad-message', 'сообщение должно быть объектом');
  }
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'join': {
      if (!isRoomId(m.room)) fail('bad-message', 'room: некорректный идентификатор');
      if (!isPeerDescriptor(m.peer)) fail('bad-message', 'peer: некорректное описание');
      if (m.protocol !== PROTOCOL_VERSION) fail('protocol-mismatch', 'версия протокола не совпадает');
      return { t: 'join', room: m.room, peer: m.peer, protocol: PROTOCOL_VERSION };
    }
    case 'signal': {
      if (!isPeerId(m.to)) fail('bad-message', 'to: некорректный идентификатор');
      if (m.kind !== 'offer' && m.kind !== 'answer') fail('bad-message', 'kind: ожидается offer|answer');
      if (!isSdp(m.sdp)) fail('bad-message', 'sdp: пусто или слишком велико');
      return { t: 'signal', to: m.to, kind: m.kind, sdp: m.sdp };
    }
    case 'candidate': {
      if (!isPeerId(m.to)) fail('bad-message', 'to: некорректный идентификатор');
      if (!isIceCandidate(m.candidate)) fail('bad-message', 'candidate: некорректный');
      return { t: 'candidate', to: m.to, candidate: m.candidate };
    }
    case 'rename': {
      if (!isPeerName(m.name)) fail('bad-message', 'name: некорректное');
      if (!isHexColor(m.color)) fail('bad-message', 'color: ожидается #RRGGBB');
      return { t: 'rename', name: m.name, color: m.color };
    }
    case 'ping': {
      if (typeof m.id !== 'number' || !Number.isInteger(m.id) || m.id < 0) {
        fail('bad-message', 'id: некорректный');
      }
      if (typeof m.at !== 'number' || !Number.isFinite(m.at)) fail('bad-message', 'at: некорректно');
      return { t: 'ping', id: m.id, at: m.at };
    }
    case 'leave':
      return { t: 'leave' };
    default:
      fail('bad-message', `неизвестный тип: ${String(m.t)}`);
  }
}

export function isPeerDescriptor(v: unknown): v is PeerDescriptor {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    isPeerId(p.id) &&
    isPeerName(p.name) &&
    isHexColor(p.color) &&
    isHex(p.identityKey, IDENTITY_KEY_BYTES) &&
    isHex(p.agreeKey, AGREE_KEY_BYTES)
  );
}

/** Компактный сериализатор: меньше байт, чем JSON.stringify с длинными именами полей. */
export function encode(msg: ServerMessage | ClientMessage): string {
  return JSON.stringify(msg);
}
