/**
 * Ручные валидаторы входных данных.
 *
 * Почему не zod/valibot: эти функции попадают в бандл браузера, работают на
 * signaling-сервере и должны одинаково вести себя в Node и в браузере. Набор
 * проверок маленький и стабильный, поэтому самописные guard-функции дешевле и
 * предсказуемее по аллокациям (сервер держит сотни соединений на 1 vCPU).
 *
 * Принцип: любое поле, пришедшее от другого узла, считается враждебным.
 */

import { MAX_PEER_NAME_LEN, MAX_SDP_LEN, MAX_CANDIDATE_LEN } from './limits.js';
import { isUuidV4 } from './ids.js';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/** Строка без управляющих символов и без вложенного JSON-мусора. */
export function isShortString(v: unknown, max: number): v is string {
  if (typeof v !== 'string') return false;
  if (v.length === 0 || v.length > max) return false;
  // C0-контролы (кроме обычных букв) и удаляющие символы — признак попытки
  // «спрятать» мусор в UI другого пользователя.
  return !/[\u0000-\u001f\u007f]/.test(v);
}

export function isHex(v: unknown, byteLen: number): v is string {
  if (typeof v !== 'string' || v.length !== byteLen * 2) return false;
  return /^[0-9a-f]+$/.test(v);
}

export function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
}

/** Строка вида "#RRGGBB". Цвет participant'а — из фиксированного палитры, но приходит из сети. */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

/** Базовый валидатор WebRTC-сериализованного кандидата. */
export function isIceCandidate(v: unknown): v is IceCandidatePayload {
  if (!isPlainObject(v)) return false;
  if (!isString(v.candidate) || v.candidate.length === 0 || v.candidate.length > MAX_CANDIDATE_LEN) {
    return false;
  }
  if (v.sdpMid !== undefined && v.sdpMid !== null && !isShortString(v.sdpMid, 64)) return false;
  if (v.sdpMLineIndex !== undefined && v.sdpMLineIndex !== null) {
    if (typeof v.sdpMLineIndex !== 'number' || !Number.isInteger(v.sdpMLineIndex) || v.sdpMLineIndex < 0) {
      return false;
    }
  }
  if (v.usernameFragment !== undefined && v.usernameFragment !== null) {
    if (!isShortString(v.usernameFragment, 128)) return false;
  }
  return true;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export function isPeerId(v: unknown): v is string {
  return isUuidV4(v);
}

export function isRoomId(v: unknown): v is string {
  return isUuidV4(v);
}

export function isSdp(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SDP_LEN;
}

export function isPeerName(v: unknown): v is string {
  return isShortString(v, MAX_PEER_NAME_LEN);
}

/** Публичное описание пира, которым обмениваются через signaling. */
export interface PeerDescriptor {
  id: string;
  name: string;
  color: string;
  /** Ed25519 публичный ключ (hex, 32 байта) — идентичность для код�� безопасности. */
  identityKey: string;
  /** X25519 публичный ключ (hex, 32 байта) — ECDH для согласования ключа. */
  agreeKey: string;
}
