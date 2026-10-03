/**
 * Ключ для отправки сообщения произвольному участнику комнаты.
 *
 * ─── Зачем нужен ──────────────────────────────────────────────────────────────
 *
 * Обычный канал пары (`PairHandshake`) выводит ключ из РУКОПОЖАТИЯ: там есть
 * agree-ключ пира и nonce, которые стороны обмениваются по живому соединению. В
 * mesh-топологии это и есть весь трафик. В star-топологии пиры не соединены между
 * собой, и пересылать сообщения «от А к В» через relay приходится по каналу
 * А–relay. Этот ключ нужен, чтобы relay стал прозрачной пересылкой, а не
 * посредником, который видит содержимое.
 *
 * ─── Что именно делается ──────────────────────────────────────────────────────
 *
 * Ключ выводится из трёх материалов:
 *   - passKey комнаты;
 *   - отсортированная пара identity-ключей (направление не зависит от того, кто
 *     подключился первым);
 *   - **ECDH agree-ключей пары** — `ECDH(self.agreePriv, peer.agreePub)`.
 *
 * Последнее нельзя убрать, и это главное в этом файле. Agree-ключи публикуются
 * в дескрипторах, поэтому ECDH считается без живого соединения: любой
 * участник может получить общий секрет с любым другим. Но общий секрет требует
 * ЧУЖОГО приватного ключа, а он есть только у владельца. Relay знает свои
 * ключи и публичные ключи всех, и этого недостаточно: вычислив ECDH со своим
 * приватным ключом, он получит пару «relay ↔ кто угодно», а не «Анна ↔ Борис».
 *
 * Именно поэтому схема не сводится к одному лишь passKey, как можно было бы
 * предположить по аналогии с парной ключевой парой. Наивный вариант
 * `HKDF(passKey, idLo, idHi)` дал бы ключ, который relay выводит тем же
 * кодом, что и отправитель, — и пересылка стала бы открытой передачей, при
 * этом выглядела бы как E2EE. Обойтись без agree-ключей и сохранить это
 * свойство нельзя: нужен секрет, которым владеет только пара.
 *
 * ─── Отдельный ключевой домен ────────────────────────────────────────────────
 *
 * Префикс `rd/relay/v1` и отдельный info не дают переиспользовать ключ канала
 * пары. Иначе расшифровка одного и того же кадра двумя разными ключами дала бы
 * пару «ключ + nonce» и раскрыла бы поток.
 */

import { sortPair } from '@rd/protocol';
import { hkdf, utf8, concat, toHex } from './bytes.js';
import { roomSalt, type PassKey } from './room-key.js';
import { ecdhShared, importAgreePub } from './identity.js';
import type { PeerIdentity } from './identity.js';

/** Ключи в обе стороны для пары «я ↔ участник». */
export interface MemberKeys {
  /** Ключ, которым запечатывают сообщения ДЛЯ партнёра. */
  send: CryptoKey;
  /** Ключ, которым расшифровывают сообщения ОТ партнёра. */
  recv: CryptoKey;
  /** Верно ли, что мы — сторона 'a' в отсортированной паре. */
  selfIsA: boolean;
}

export const RELAY_NONCE_BYTES = 12;

/**
 * Выводит ключи пары «я ↔ участник» без рукопожатия.
 *
 * @param self наша identity с приватным agree-ключом
 * @param peerIdentityHex публичный identity-ключ участника (из каталога комнаты)
 * @param peerAgreeHex публичный agree-ключ участника (из каталога комнаты)
 */
export async function deriveMemberKeys(args: {
  roomId: string;
  passKey: PassKey;
  self: PeerIdentity;
  peerIdentityHex: string;
  peerAgreeHex: string;
}): Promise<MemberKeys> {
  const selfIdentityHex = toHex(args.self.identityPubRaw);
  if (selfIdentityHex === args.peerIdentityHex) {
    throw new Error('участник комнаты не может быть самим собой');
  }
  const [idLo, idHi] = sortPair(selfIdentityHex, args.peerIdentityHex);
  const selfIsA = selfIdentityHex <= args.peerIdentityHex;
  const salt = await roomSalt(args.roomId);

  // Общий секрет пары: считается из agree-ключей, без установления соединения.
  // Fail-closed, как и в `PairHandshake`: если agree-ключ подменён, ключ
  // получится другим, канал просто не расшифруется.
  const shared = await ecdhShared(args.self.agreePriv, await importAgreePub(args.peerAgreeHex));
  const sharedHex = toHex(shared);

  const derive = async (role: 'a' | 'b'): Promise<CryptoKey> => {
    const info = concat(utf8(`rd/relay/v1|${role}|${idLo}|${idHi}|${sharedHex}`), new Uint8Array([0x52]));
    const raw = await hkdf(args.passKey, salt, info, 32);
    return crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  };

  return {
    send: await derive(selfIsA ? 'b' : 'a'),
    recv: await derive(selfIsA ? 'a' : 'b'),
    selfIsA,
  };
}

/**
 * Запечатывает сообщение для участника.
 *
 * Формат: 12 байт nonce, затем AEAD-GCM. Ничего больше в открытом виде нет —
 * в частности, длина известна только получателю, что не мешает, потому что
 * кадр идёт внутри канала, который и так огорожен лимитом размера.
 */
export async function sealForMember(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const nonce = new Uint8Array(RELAY_NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    key,
    plaintext.slice().buffer as ArrayBuffer,
  );
  const out = new Uint8Array(nonce.length + sealed.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(sealed), nonce.length);
  return out;
}

/** Расшифровывает сообщение от участника. Бросает исключение при подмене. */
export async function openFromMember(key: CryptoKey, frame: Uint8Array): Promise<Uint8Array> {
  if (frame.length <= RELAY_NONCE_BYTES) throw new Error('кадр от участника слишком короткий');
  const nonce = frame.subarray(0, RELAY_NONCE_BYTES);
  const body = frame.subarray(RELAY_NONCE_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    key,
    body.slice().buffer as ArrayBuffer,
  );
  return new Uint8Array(plain);
}