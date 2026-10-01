/**
 * Согласование ключей пары пиров.
 *
 * Модель угроз и что на что именно отвечает:
 *
 *  1. Пассивный наблюдатель (сервер, провайдер) — не может прочитать данные.
 *     Ключ выводится из парольной фразы, которую сервер не знает.
 *
 *  2. Активный посредник, у которого НЕТ парольной фразы, — тоже не может:
 *     даже подменив публичные ключи, он не выведет passKey-производный секрет,
 *     и канал просто не расшифруется. «Отказ в молчание» здесь предпочтительнее
 *     явной ошибки: по симптому нельзя отличить MITM от неверной парольной фразы.
 *
 *  3. Активный посредник, у которого ЕСТЬ парольная фраза (значит, он и так
 *     имеет право входить в комнату), — единственная защита от незаметной
 *     подмены ключей это подпись Ed25519 в транскрипте и «код безопасности»,
 *     который пользователи сверяют вне приложения.
 *
 * Поэтому в KDF входят сразу ТРИ независимых материала:
 *   - passKey — что знает только участник комнаты (аутентификация комнаты);
 *   - ECDH P-256 — что знает только владелец приватного ключа (аутентификация
 *     пира, fail-closed при подмене ключа посредником);
 *   - отсортированные identity-ключи — чтобы направление ключей не зависело от
 *     того, кто подключился первым.
 *
 * Каналы `ctrl` и `file` разведены по разным info, а каждое направление — по
 * своей роли. Итого 4 независимых ключа AES на пару, поэтому счётчики nonce
 * можно начинать с нуля в каждом направлении и никогда не получить пару
 * «один ключ + один nonce» дважды.
 */

import { handshakeTranscript, sortPair, type HelloPayload } from '@rd/protocol';
import { hkdf, sha256, toHex, utf8, concat } from './bytes.js';
import {
  ecdhShared,
  importAgreePub,
  importIdentityPub,
  signTranscript,
  verifyTranscript,
  type PeerIdentity,
} from './identity.js';
import { roomSalt, type PassKey } from './room-key.js';

export type Role = 'a' | 'b';

export interface PairKeys {
  ctrlSend: CryptoKey;
  ctrlRecv: CryptoKey;
  fileSend: CryptoKey;
  fileRecv: CryptoKey;
  /** 10 цифр, которые пользователи сверяют голосом или в мессенджере. */
  safetyCode: string;
  role: Role;
}

/** Заглушка подписи в первой стадии рукопожатия. */
export const ZERO_SIG = '0'.repeat(128);

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeError';
  }
}

export class PairHandshake {
  readonly roomId: string;
  readonly self: PeerIdentity;
  readonly selfNonce: Uint8Array;

  /** Ключ комнаты. Задаётся сразу после создания хендшейка. */
  #passKey: PassKey | null = null;

  /** Пирские (e, x, n), зафиксированные на первой стадии. */
  #peerIdentityHex: string | null = null;
  #peerAgreeHex: string | null = null;
  #peerNonceHex: string | null = null;

  #transcript: Uint8Array | null = null;
  #signatureHex: string | null = null;
  #keys: PairKeys | null = null;

  constructor(args: { roomId: string; self: PeerIdentity; passKey: PassKey; selfNonce?: Uint8Array }) {
    this.roomId = args.roomId;
    this.self = args.self;
    this.#passKey = args.passKey;
    const nonce = args.selfNonce ?? new Uint8Array(16);
    if (args.selfNonce === undefined) crypto.getRandomValues(nonce);
    this.selfNonce = nonce;
  }

  get selfIdentityHex(): string {
    return toHex(this.self.identityPubRaw);
  }

  get selfAgreeHex(): string {
    return toHex(this.self.agreePubRaw);
  }

  get peerPinned(): boolean {
    return this.#peerIdentityHex !== null;
  }

  /** Кадр первой стадии: публикуем ключи и nonce, подписывать пока нечего. */
  get stage1(): HelloPayload {
    return {
      v: 1,
      stage: 1,
      e: this.selfIdentityHex,
      x: this.selfAgreeHex,
      n: toHex(this.selfNonce),
      s: ZERO_SIG,
    };
  }

  /**
   * Принимает сообщение пира.
   * Возвращает null, если это была первая стадия и надо дождаться второй.
   */
  async accept(peer: HelloPayload): Promise<PairKeys | null> {
    if (peer.e === this.selfIdentityHex) {
      throw new HandshakeError('пир прислал наш собственный публичный ключ');
    }

    if (this.#peerIdentityHex === null) {
      if (peer.stage !== 1) throw new HandshakeError('первым ожидается stage 1');
      this.#peerIdentityHex = peer.e;
      this.#peerAgreeHex = peer.x;
      this.#peerNonceHex = peer.n;
      return null;
    }

    if (peer.e !== this.#peerIdentityHex || peer.x !== this.#peerAgreeHex || peer.n !== this.#peerNonceHex) {
      throw new HandshakeError('ключи пира изменились между стадиями рукопожатия');
    }
    // Повторная stage 1 с теми же ключами — просто дубликат. DataChannel надёжен,
    // но рукопожатие не должно быть хрупким ни к какому повтору.
    if (peer.stage === 1) return null;
    if (peer.stage !== 2) throw new HandshakeError('неожиданная стадия рукопожатия');

    const transcript = this.#transcript ?? (this.#transcript = this.#buildTranscript());
    const pub = await importIdentityPub(peer.e);
    if (!(await verifyTranscript(pub, transcript, peer.s))) {
      throw new HandshakeError('подпись пира не прошла проверку');
    }
    if (this.#keys === null) {
      if (this.#passKey === null) throw new HandshakeError('не задан ключ комнаты');
      this.#keys = await this.#derive();
    }
    return this.#keys;
  }

  /** Кадр второй стадии: тот же набор данных плюс подпись транскрипта. */
  async stage2(): Promise<HelloPayload> {
    if (this.#transcript === null) {
      if (this.#peerIdentityHex === null) {
        throw new HandshakeError('нельзя подписать рукопожатие до получения stage 1 пира');
      }
      this.#transcript = this.#buildTranscript();
    }
    if (this.#signatureHex === null) {
      this.#signatureHex = await signTranscript(this.self.identityPriv, this.#transcript);
    }
    return { ...this.stage1, stage: 2, s: this.#signatureHex };
  }

  /**
   * Код безопасности. Считается из identity-ключей, поэтому одинаков у обеих сторон.
   * Доступен уже после первой стадии — он не зависит от подписей.
   */
  async safetyCode(): Promise<string> {
    if (this.#peerIdentityHex === null) {
      throw new HandshakeError('код безопасности доступен после stage 1');
    }
    return safetyCode(this.roomId, this.selfIdentityHex, this.#peerIdentityHex);
  }

  #buildTranscript(): Uint8Array {
    return handshakeTranscript({
      roomId: this.roomId,
      identityA: this.selfIdentityHex,
      identityB: this.#peerIdentityHex as string,
      nonceA: toHex(this.selfNonce),
      nonceB: this.#peerNonceHex as string,
    });
  }

  async #derive(): Promise<PairKeys> {
    const selfHex = this.selfIdentityHex;
    const peerHex = this.#peerIdentityHex as string;
    const [idLo, idHi] = sortPair(selfHex, peerHex);
    const role: Role = selfHex <= peerHex ? 'a' : 'b';
    const other: Role = role === 'a' ? 'b' : 'a';

    const shared = await ecdhShared(this.self.agreePriv, await importAgreePub(this.#peerAgreeHex as string));
    const salt = await roomSalt(this.roomId);

    const derive = async (channel: 'ctrl' | 'file', sender: Role): Promise<CryptoKey> => {
      // shared входит в info, а не в salt: соль общая для всей комнаты,
      // а секрет ECDH — уникален для пары.
      const info = concat(utf8(`rd/${channel}/v1|${sender}|${idLo}|${idHi}`), shared);
      const raw = await hkdf(this.#passKey as PassKey, salt, info, 32);
      return crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    };
    return {
      role,
      ctrlSend: await derive('ctrl', role),
      ctrlRecv: await derive('ctrl', other),
      fileSend: await derive('file', role),
      fileRecv: await derive('file', other),
      safetyCode: await safetyCode(this.roomId, selfHex, peerHex),
    };
  }
}

/**
 * 10 цифр из двух независимых блоков по 5 байт.
 *
 * Смещение по модулю 10^5 от 40 бит пренебрежимо мало (2^40 ≈ 1.1·10^12, то есть
 * 109 полных кругов), а вот короткий код реально диктуется по телефону — для
 * пользователя это важнее идеальной равномерности.
 */
export async function safetyCode(roomId: string, identityA: string, identityB: string): Promise<string> {
  const [lo, hi] = sortPair(identityA, identityB);
  const digest = await sha256(utf8(`rd/safety/v1|${roomId}|${lo}|${hi}`));
  const block = (start: number): string => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * 256 + (digest[start + i] as number);
    return String(v % 100_000).padStart(5, '0');
  };
  return `${block(0)} ${block(5)}`;
}
