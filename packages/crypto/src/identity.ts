/**
 * Идентичность пира: Ed25519 (подпись транскрипта) + ECDH P-256 (согласование).
 *
 * Приватные ключи создаются НЕИЗВЛЕКАЕМЫМИ (`extractable: false`): даже
 * скомпрометированная вкладка с XSS не сможет вытащить ключ в JavaScript.
 * Публичные ключи WebCrypto всегда экспортируемы независимо от флага.
 *
 * Почему Ed25519 + P-256, а не Ed25519 + X25519: WebCrypto в Node не знает
 * curves `X25519` (проверено: «Unrecognized namedCurve» на Node 22.23), а без
 * него нельзя прогнать тесты криптографии, не поднимая браузер. Оба выбранных
 * алгоритма поддерживаются и Node, и всеми актуальными браузерами. Формат
 * провода хранит байты ключей, поэтому переход на X25519 — смена константы.
 *
 * ECDH P-256 добавляет поверх парольной фразы второй, независимый материал
 * для вывода ключа пары: посредник без приватного ключа пира не сможет
 * установить рабочий канал, даже если узнает парольную фразу.
 */

import { fromHex, toHex, randomBytes } from './bytes.js';

export interface PeerIdentity {
  identityPriv: CryptoKey;
  identityPub: CryptoKey;
  identityPubRaw: Uint8Array;
  agreePriv: CryptoKey;
  agreePub: CryptoKey;
  agreePubRaw: Uint8Array;
}

export class UnsupportedCryptoError extends Error {
  constructor(what: string) {
    super(
      `Браузер не поддерживает ${what}. Требуется Ed25519 и ECDH P-256 (Chrome 137+, Firefox 130+, Safari 17+).`,
    );
    this.name = 'UnsupportedCryptoError';
  }
}

/** Проверка поддержки. Вызывается один раз при старте, чтобы не падать в середине рукопожатия. */
export async function assertCryptoSupport(): Promise<void> {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  } catch {
    throw new UnsupportedCryptoError('Ed25519');
  }
  try {
    await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } catch {
    throw new UnsupportedCryptoError('ECDH P-256');
  }
}

export async function createPeerIdentity(): Promise<PeerIdentity> {
  let identityPair: CryptoKeyPair;
  try {
    identityPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
  } catch {
    throw new UnsupportedCryptoError('Ed25519');
  }

  let agreePair: CryptoKeyPair;
  try {
    agreePair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
  } catch {
    throw new UnsupportedCryptoError('ECDH P-256');
  }

  return {
    identityPriv: identityPair.privateKey,
    identityPub: identityPair.publicKey,
    identityPubRaw: await exportRawPublic(identityPair.publicKey),
    agreePriv: agreePair.privateKey,
    agreePub: agreePair.publicKey,
    agreePubRaw: await exportRawPublic(agreePair.publicKey),
  };
}

/** Импорт публичного Ed25519-ключа по hex — делается по данным из signaling-сервера. */
export async function importIdentityPub(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromHex(hex).slice().buffer as ArrayBuffer,
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
}

/** Импорт публичного ECDH-ключа по hex (несжатая точка P-256, 65 байт). */
export async function importAgreePub(hex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    fromHex(hex).slice().buffer as ArrayBuffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

export async function exportRawPublic(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function signTranscript(priv: CryptoKey, transcript: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', priv, transcript.slice().buffer as ArrayBuffer);
  return toHex(new Uint8Array(sig));
}

export async function verifyTranscript(
  pub: CryptoKey,
  transcript: Uint8Array,
  signatureHex: string,
): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      'Ed25519',
      pub,
      fromHex(signatureHex).slice().buffer as ArrayBuffer,
      transcript.slice().buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
}

/** Симметричный ECDH: подпись ставится на общий секрет (32 байта для X25519). */
export async function ecdhShared(priv: CryptoKey, peerPub: CryptoKey): Promise<Uint8Array> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, priv, 256);
  return new Uint8Array(bits);
}

export const nonceHex = (): string => toHex(randomBytes(16));
