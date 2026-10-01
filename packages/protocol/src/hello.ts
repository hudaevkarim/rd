/**
 * Рукопожатие P2P-канала (первый кадр в канале управления).
 *
 * Идёт ОТКРЫТЫМ — ключи пары ещё не согласованы, шифровать нечем. Поэтому здесь
 * лежит только криптографический материал и ничего чувствительного: имя и цвет
 * пира сервер знает и так (они приходят в `join`).
 *
 * Рукопожатие двухстадийное:
 *   stage 1 — публикуем свои ключи и nonce, подписи ещё нет;
 *   stage 2 — тот же набор плюс подпись транскрипта, который обе стороны
 *             вычисляют из (roomId, два identity-ключа, два nonce).
 *
 * Ключи «закрепляются» (pin) на первой стадии: если во второй они изменились,
 * рукопожатие отвергается. Иначе посредник подменил бы ключ уже после того,
 * как мы его «запомнили», и подпись оказалась бы не по тому транскрипту.
 *
 * Что именно защищает подпись Ed25519:
 *
 *   WebRTC + DTLS защищают КАНАЛ, но не ИДЕНТИЧНОСТЬ. Активный посредник
 *   терминирует DTLS с обеих сторон. Парольная фраза закрывает половину
 *   проблемы: без её знания посредник не выведет ключ пары. Но если фраза
 *   скомпрометирована, подпись + «код безопасности» позволяют заметить подмену
 *   ключей: у честных сторон коды совпадут, у стороны за MITM — нет.
 */

import { isHex, isPlainObject } from './validate.js';
import { PROTOCOL_VERSION } from './limits.js';

export const NONCE_LEN = 16;
/** Длина подписи Ed25519 в байтах. */
export const SIG_LEN = 64;
/** Ed25519: публичный ключ в сыром виде. */
export const IDENTITY_KEY_BYTES = 32;
/**
 * Публичный ключ ECDH P-256 в сыром виде: 0x04 ‖ X(32) ‖ Y(32) = 65 байт.
 *
 * Почему P-256, а не X25519: X25519 не поддерживается WebCrypto в Node
 * (проверено на Node 22.23: «Unrecognized namedCurve»), а значит, всю
 * криптографию нельзя было бы покрыть тестами. P-256 одинаково работает и в
 * Node, и во всех браузерах, а для этой модели угроз (парольная фраза + код
 * безопасности) разница в стойкости несущественна. Формат провода хранит сами
 * байты ключа, поэтому переход на X25519 — это смена одной константы, когда
 * Node его поддержит.
 */
export const AGREE_KEY_BYTES = 65;

export interface HelloPayload {
  /** Версия протокола. */
  v: number;
  stage: 1 | 2;
  /** Ed25519 публичный ключ отправителя (hex, 32 байта). */
  e: string;
  /** X25519 публичный ключ отправителя (hex, 32 байта). */
  x: string;
  /** Случайный nonce сессии (hex, 16 байт) — защита от replay. */
  n: string;
  /** Подпись транскрипта (hex, 64 байта). */
  s: string;
}

export function parseHello(v: unknown): HelloPayload {
  if (!isPlainObject(v)) throw new Error('hello: ожидается объект');
  const h = v as Record<string, unknown>;
  if (h.v !== PROTOCOL_VERSION) throw new Error('hello: версия протокола не совпадает');
  if (h.stage !== 1 && h.stage !== 2) throw new Error('hello: некорректная стадия');
  if (!isHex(h.e, IDENTITY_KEY_BYTES)) throw new Error('hello: некорректный identity-ключ');
  if (!isHex(h.x, AGREE_KEY_BYTES)) throw new Error('hello: некорректный agree-ключ');
  if (!isHex(h.n, NONCE_LEN)) throw new Error('hello: некорректный nonce');
  if (!isHex(h.s, SIG_LEN)) throw new Error('hello: некорректная длина подписи');
  return { v: h.v, stage: h.stage, e: h.e, x: h.x, n: h.n, s: h.s };
}

/**
 * Каноническая строка, которую подписывают обе стороны.
 *
 * Порядок полей фиксирован, а identity-ключи и nonce сортируются лексикографически
 * по hex — благодаря этому обе стороны независимо получают побайтово одинаковый
 * транскрипт, хотя обмениваются они разными значениями полей.
 */
export function handshakeTranscript(params: {
  roomId: string;
  identityA: string;
  identityB: string;
  nonceA: string;
  nonceB: string;
}): Uint8Array {
  const [idLo, idHi] = sortPair(params.identityA, params.identityB);
  const [nLo, nHi] = sortPair(params.nonceA, params.nonceB);
  const line = ['rd/handshake/v1', params.roomId, idLo, idHi, nLo, nHi].join('|');
  return new TextEncoder().encode(line);
}

/** Каноническая сортировка пары hex-строк: (меньшая, большая). */
export function sortPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}
