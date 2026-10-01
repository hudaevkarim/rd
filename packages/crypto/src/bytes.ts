/** Мелкие утилиты для байтов. Без зависимостей, работают в Node и браузере. */

const HEX_RE = /^[0-9a-f]*$/;

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) throw new Error('некорректная hex-строка');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Сравнение за постоянное время. Не используем `===` для секретов. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // Копия нужна, потому что digest() требует ArrayBuffer-совместимый буфер,
  // а subarray() может смотреть на общий ArrayBuffer с ненулевым смещением
  // (в некоторых сборках TS это не проходит типизацию).
  const buf = data.slice().buffer as ArrayBuffer;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

/** HMAC-SHA256, поверх которого сделан HKDF. */
export async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    key.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data.slice().buffer as ArrayBuffer));
}

/**
 * HKDF-SHA256 (RFC 5869): extract → expand.
 *
 * Используется вместо «просто SHA(ikm || info)», потому что extract-шаг с HMAC
 * реально разводит ключи по разным salt/info, а наивная конкатенация оставляет
 * структуру, которую проще коллизировать.
 */
export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (length < 1 || length > 255 * 32) throw new Error('hkdf: некорректная длина');
  const prk = await hmac(salt.length === 0 ? new Uint8Array(32) : salt, ikm);
  const out = new Uint8Array(length);
  let t: Uint8Array = new Uint8Array(0);
  let done = 0;
  for (let counter = 1; done < length; counter++) {
    t = await hmac(prk, concat(t, info, Uint8Array.of(counter)));
    const take = Math.min(32, length - done);
    out.set(t.subarray(0, take), done);
    done += take;
  }
  return out;
}
