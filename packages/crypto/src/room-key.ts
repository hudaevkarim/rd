/**
 * Ключ комнаты из парольной фразы.
 *
 * Соль детерминирована от roomId: `salt = SHA-256("rd/room-salt/v1|" + roomId)`.
 * Случайная соль не дала бы дополнительной стойкости, потому что roomId — уже
 * 122 бита энтропии из UUIDv4, а вот детерминированная соль избавляет от
 * необходимости тащить соль в ссылке-приглашении. Разные комнаты при этом
 * получают независимые соли и, главное, независимые ключи.
 *
 * 600 000 итераций PBKDF2-SHA256 (рекомендация OWASP) дают порядка 0.3–0.6 с
 * на ноутбуке. Это ощутимая задержка, поэтому:
 *   - в UI показывается явный индикатор « deriving key…»;
 *   - функцию можно вынести в Web Worker (она не трогает DOM);
 *   - число итераций не «уменьшаем для удобства» — ослабление KDF обесценивает
 *     всю модель безопасности.
 */

import { PBKDF2_ITERATIONS, ROOM_SALT_LEN } from '@rd/protocol';
import { hkdf, sha256, utf8 } from './bytes.js';

export const MIN_PASSPHRASE_LEN = 6;

/**
 * Производный «мастер»-ключ комнаты. 32 байта. Никогда не покидает устройство
 * и никогда не отправляется по сети — даже в зашифрованном виде.
 */
export type PassKey = Uint8Array;

export async function derivePassKey(
  passphrase: string,
  roomId: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<PassKey> {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`парольная фраза должна быть не короче ${MIN_PASSPHRASE_LEN} символов`);
  }
  const salt = await roomSalt(roomId);
  const base = await crypto.subtle.importKey('raw', utf8(passphrase).slice().buffer as ArrayBuffer, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice().buffer as ArrayBuffer, iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function roomSalt(roomId: string): Promise<Uint8Array> {
  const digest = await sha256(utf8('rd/room-salt/v1|' + roomId));
  return digest.subarray(0, ROOM_SALT_LEN);
}

/**
 * Спутниковые ключи, которые не зависят от содержимого комнаты.
 * Нужны, чтобы один и тот же материал можно было расшифровать и в P2P-канале,
 * и в локально сохранённых данных (см. `sealLocal`).
 */
export async function deriveLocalKey(passKey: PassKey, roomId: string): Promise<Uint8Array> {
  return hkdf(passKey, await roomSalt(roomId), utf8('rd/local/v1'), 32);
}

// Алфавит без похожих символов (0/O, 1/I/L) — фразу часто диктуют вслух.
const WORDS = [
  'амбар', 'берег', 'ветер', 'гвоздь', 'дверь', 'ель', 'журнал', 'завод',
  'иней', 'камень', 'лимон', 'мост', 'невод', 'облако', 'плечо', 'радуга',
  'север', 'тишина', 'улица', 'фонарь', 'хвост', 'цветок', 'череп', 'шапка',
  'якорь', 'береста', 'весло', 'гайка', 'дождь', 'емель', 'журавль', 'звезда',
  'ива', 'кочерга', 'лужа', 'метель', 'невод', 'осень', 'погреб', 'роза',
] as const;

export const SUGGESTED_WORDS = 5;

/**
 * Генерирует читаемую парольную фразу вида `север-берег-звезда-улица-фонарь`.
 * 5 слов из списка дают ~21 бит на слово при номинале ~2^12 — суммарно
 * ~60 бит, что достаточно для KDF и, главное, позволяет людям сравнивать
 * фразу, а не запоминать 32 hex-символа.
 */
export function suggestPassphrase(): string {
  const idx = new Uint32Array(SUGGESTED_WORDS);
  crypto.getRandomValues(idx);
  const parts: string[] = [];
  for (let i = 0; i < SUGGESTED_WORDS; i++) {
    parts.push(WORDS[(idx[i] as number) % WORDS.length] as string);
  }
  return parts.join('-');
}

/** Грубая оценка стойкости фразы — только для подсказки в UI. */
export function passphraseStrength(passphrase: string): { score: 0 | 1 | 2 | 3; label: string } {
  const s = passphrase.trim();
  if (s.length < MIN_PASSPHRASE_LEN) return { score: 0, label: 'слишком короткая' };
  const words = s.split(/[\s\-_]+/).filter(Boolean);
  let bits = 0;
  if (words.length >= 3) {
    bits = words.length * Math.log2(WORDS.length);
  } else {
    const pool = 26 + 26 + 10 + 33;
    bits = s.length * Math.log2(pool);
  }
  if (bits < 30) return { score: 1, label: 'слабая' };
  if (bits < 45) return { score: 2, label: 'средняя' };
  return { score: 3, label: 'хорошая' };
}
