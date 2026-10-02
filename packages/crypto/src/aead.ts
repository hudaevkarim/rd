/**
 * AEAD-канал поверх пары AES-GCM-ключей.
 *
 * Формат зашифрованного тела: `nonce (12 B) || ciphertext || tag (16 B)`.
 * Nonce = 4 случайных байта префикса сессии + 8 байт счётчика (big-endian).
 * Префикс фиксируется при создании канала, счётчик начинается с нуля, поэтому
 * пара «ключ + nonce» неповторима в пределах сессии. Отдельный ключ на каждое
 * направление и на каждый канал (ctrl/file) гарантирует, что даже после сброса
 * счётчика при переподключении nonce не повторится с тем же ключом.
 *
 * Заголовок кадра (версия, тип, флаги, длина, содержимое заголовка) передаётся
 * как AAD. Это значит, что переставить тип фрейма, изменить `k` в JSON или
 * подменить `offset` в чанке невозможно без слома аутентификационного тега.
 * Заодно это убирает целый класс «невалидный протокол по построению».
 *
 * Окно переигрывания нужно по конкретной причине: `crypto.subtle.encrypt`
 * асинхронен, поэтому два параллельных вызова seal() могут завершиться НЕ в том
 * же порядке, в котором им выдали счётчики. DataChannel доставит кадры в порядке
 * завершения, и счётчики окажутся «перепутаны». Поэтому принимаем любой счётчик
 * из окна в 64 позиции назад, а не строго «следующий ожидаемый».
 */

import {
  buildChunkHead,
  buildHead,
  buildJsonHead,
  encodePlainFrame,
  FrameType,
  readFrame,
  REPLAY_WINDOW,
  SEALED_OVERHEAD,
} from '@rd/protocol';
import { randomBytes } from './bytes.js';

const NONCE_LEN = 12;
const PREFIX_LEN = 4;
const TAG_LEN = 16;
const MASK64 = (1n << 64n) - 1n;

export class AeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AeadError';
  }
}

export interface OpenedFrame {
  type: number;
  json: unknown;
  body: Uint8Array;
  chunk?: { transferId: Uint8Array; offset: number; length: number };
}

export interface AeadStats {
  sealed: number;
  opened: number;
  rejected: number;
  /** Счётчик последнего принятого кадра — используется в тестах и диагностике. */
  lastCounter: bigint | null;
}

export class AeadChannel {
  readonly #sendKey: CryptoKey;
  readonly #recvKey: CryptoKey;
  readonly #sendPrefix: Uint8Array;
  #sendCounter = 0n;

  #recvPrefix: Uint8Array | null = null;
  #recvInitialised = false;
  /** Счётчик, который ждём следующим. */
  #recvNext = 0n;
  /** Бит i = «счётчик recvNext - 1 - i уже принят». */
  #recvSeen = 0n;

  readonly stats: AeadStats = { sealed: 0, opened: 0, rejected: 0, lastCounter: null };

  constructor(keys: { send: CryptoKey; recv: CryptoKey }) {
    this.#sendKey = keys.send;
    this.#recvKey = keys.recv;
    this.#sendPrefix = randomBytes(PREFIX_LEN);
  }

  /** Незашифрованный кадр с JSON-заголовком — только для рукопожатия. */
  static plainJson(type: number, json: unknown): Uint8Array {
    return encodePlainFrame(type, buildJsonHead(type, json, false), new Uint8Array(0));
  }

  /**
   * Зашифрованный кадр с ТИПОМ в заголовке и данными в теле.
   *
   * Отдельного метода «зашифровать JSON в заголовок» здесь нет намеренно.
   * Заголовок кадра передаётся открытым (он идёт как AAD, и шифровать его нельзя),
   * поэтому любая полезная нагрузка в заголовке — это утечка в открытом виде.
   * Тип кадра (1 байт) получателю и так нужен для разбора, а всё содержимое
   * обязано быть в зашифрованном теле.
   */
  async sealBody(type: number, body: Uint8Array): Promise<Uint8Array> {
    return this.#seal(buildHead(type, new Uint8Array(0), true), body);
  }

  async sealChunk(transferId: Uint8Array, offset: number, data: Uint8Array): Promise<Uint8Array> {
    const head = buildChunkHead(transferId, offset, data.length, true);
    return this.#seal(head, data);
  }

  async #seal(head: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
    // Счётчики выдаются в порядке вызовов, порядок фактической отправки может
    // отличаться (см. комментарий про асинхронность subtle.encrypt).
    const counter = this.#sendCounter++;
    const nonce = new Uint8Array(NONCE_LEN);
    nonce.set(this.#sendPrefix, 0);
    new DataView(nonce.buffer).setBigUint64(PREFIX_LEN, counter, false);

    const ct = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce.slice().buffer as ArrayBuffer,
        additionalData: head.slice().buffer as ArrayBuffer,
        tagLength: TAG_LEN * 8,
      },
      this.#sendKey,
      body.slice().buffer as ArrayBuffer,
    );

    // ВАЖНО: ct уже содержит в себе тег (tagLength байт). Прибавлять TAG_LEN к
    // размеру ещё раз нельзя — в хвосте кадра окажется 16 нулевых байт, которые
    // получатель посчитает частью шифротекста, и проверка тега провалится.
    const out = new Uint8Array(head.length + NONCE_LEN + ct.byteLength);
    out.set(head, 0);
    out.set(nonce, head.length);
    out.set(new Uint8Array(ct), head.length + NONCE_LEN);
    this.stats.sealed++;
    return out;
  }

  /**
   * Расшифровывает кадр. Бросает AeadError на любой подозрительный ввод —
   * вызывающая сторона решает, закрывать ли соединение.
   */
  async open(frame: Uint8Array): Promise<OpenedFrame> {
    let parsed: ReturnType<typeof readFrame>;
    try {
      parsed = readFrame(frame);
    } catch (err) {
      this.stats.rejected++;
      throw new AeadError(`структура кадра: ${(err as Error).message}`);
    }
    if (!parsed.sealed) {
      throw new AeadError('ожидался зашифрованный кадр');
    }
    if (parsed.payload.length < NONCE_LEN + TAG_LEN) {
      this.stats.rejected++;
      throw new AeadError('шифротекст слишком короткий');
    }
    const nonce = parsed.payload.subarray(0, NONCE_LEN);
    const prefix = nonce.subarray(0, PREFIX_LEN);
    const counter = new DataView(
      nonce.buffer,
      nonce.byteOffset + PREFIX_LEN,
      8,
    ).getBigUint64(0, false);

    if (this.#recvPrefix === null) {
      this.#recvPrefix = prefix.slice();
    } else if (!equalBytes(this.#recvPrefix, prefix)) {
      // Смена префикса посреди сессии невозможна для честного пира: значит,
      // кто-то перемешивает кадры из разных сессий.
      this.stats.rejected++;
      throw new AeadError('префикс nonce изменился в пределах сессии');
    }
    if (!this.#acceptCounter(counter)) {
      this.stats.rejected++;
      throw new AeadError(`повтор или слишком старый счётчик: ${counter}`);
    }

    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce.slice().buffer as ArrayBuffer,
          additionalData: parsed.aad.slice().buffer as ArrayBuffer,
          tagLength: 128,
        },
        this.#recvKey,
        parsed.payload.slice(NONCE_LEN).buffer as ArrayBuffer,
      );
    } catch {
      this.stats.rejected++;
      throw new AeadError('не удалось проверить аутентификационный тег');
    }

    this.stats.opened++;
    this.stats.lastCounter = counter;
    const body = new Uint8Array(plain);
    return {
      type: parsed.type,
      json: parsed.json,
      body,
      ...(parsed.chunk ? { chunk: parsed.chunk } : {}),
    };
  }

  /**
   * Скользящее окно принятых счётчиков.
   *
   * Инвариант: бит i равен единице, если счётчик `recvNext - 1 - i` уже принят.
   * Первое сообщение сессии задаёт начало отсчёта, но само себя «помечает»
   * только через общий путь — иначе его повтор прошёл бы как «новый».
   */
  #acceptCounter(counter: bigint): boolean {
    if (!this.#recvInitialised) {
      this.#recvInitialised = true;
      this.#recvNext = counter;
      this.#recvSeen = 0n;
    }
    if (counter < this.#recvNext) {
      const diff = this.#recvNext - counter;
      if (diff > BigInt(REPLAY_WINDOW)) return false;
      const bit = 1n << (diff - 1n);
      if ((this.#recvSeen & bit) !== 0n) return false; // уже принимали
      this.#recvSeen |= bit;
      return true;
    }
    const diff = counter - this.#recvNext;
    if (diff >= BigInt(REPLAY_WINDOW)) {
      // Разрыв больше окна: старые счётчики забываем, иначе счётчик-счётчик
      // «переедет» на миллиарды и перестанет помещаться в 64 бита.
      this.#recvNext = counter + 1n;
      this.#recvSeen = 0n;
      return true;
    }
    // Окно сдвигается вправо на diff + 1, а не на diff.
    //
    // ─── Почему именно +1 ──────────────────────────────────────────────────────
    //
    // Только что принятый счётчик занимает позицию 0 (он равен recvNext - 1
    // после приращения), поэтому прежние биты сдвигаются не на свой сдвиг, а на
    // свой сдвиг ПЛЮС один. Сдвиг на diff «съедал» одну позицию, и бит, который
    // должен был описывать счётчик `recvNext - 1 - diff`, оказывался на месте
    // счётчика `recvNext - 2 - diff` — то есть окно пометило как принятый
    // счётчик, который ещё не приходил.
    //
    // Последствие было не теоритическим. Порядок отправки кадров на ctrl-канале
    // НЕ совпадает с порядком выдачи счётчиков: `#sealAndSend` вызывается без
    // await, а `crypto.subtle.encrypt` асинхронен, поэтому кадры уходят в канал
    // в порядке завершения шифрования. Стоило кадру N-1 задержаться на один
    // такт, как окно принимало N, помечало N-1 как уже принятый, а настоящий
    // N-1 приходил следующим и отбрасывался как повтор:
    //
    //     ... 46, 47, 49, 48   ← 48 отброшен как «повтор», которого не было
    //
    // Дальше PeerLink считал это атакой и рвал соединение
    // (`кадр не прошёл проверку: повтор или слишком старый счётчик`), а вместе
    // с ним и идущую передачу файла («передача прервана: канал rd-file
    // закрыт»). Канал рвался сам у себя, без всякого вторжения.
    //
    // Разрыв на 1 — самый частый случай: он возникает всякий раз, когда два
    // управляющих кадра шифруются одновременно, то есть на любой активности
    // Yjs (sync + awareness + ctrl JSON). Поэтому баг был не редким, а
    // практически гарантированным при реальной работе в комнате.
    this.#recvSeen = ((this.#recvSeen << (diff + 1n)) | 1n) & MASK64;
    this.#recvNext = counter + 1n;
    return true;
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export { FrameType };
