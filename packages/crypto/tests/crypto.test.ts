import { describe, expect, it } from 'vitest';
import { newId, FrameType, CHUNK_SIZE } from '@rd/protocol';
import {
  AeadChannel,
  AeadError,
  PairHandshake,
  createPeerIdentity,
  derivePassKey,
  hkdf,
  sha256,
  toHex,
  safetyCode,
} from '@rd/crypto';

// PBKDF2 на 600k итераций — это ~0.3 с на машине разработчика. В тестах
// уменьшаем до 1k: проверяется логика KDF, а не стойкость к перебору.
const FAST_KDF = 1_000;

async function makePair(passphrase = 'север-берег-звезда', roomId = newId()): Promise<{
  roomId: string;
  a: { hs: PairHandshake; identity: Awaited<ReturnType<typeof createPeerIdentity>> };
  b: { hs: PairHandshake; identity: Awaited<ReturnType<typeof createPeerIdentity>> };
}> {
  const passKey = await derivePassKey(passphrase, roomId, FAST_KDF);
  const identityA = await createPeerIdentity();
  const identityB = await createPeerIdentity();
  return {
    roomId,
    a: { hs: new PairHandshake({ roomId, self: identityA, passKey }), identity: identityA },
    b: { hs: new PairHandshake({ roomId, self: identityB, passKey }), identity: identityB },
  };
}

/** Прогоняет обе стадии рукопожатия и возвращает ключи обеих сторон. */
async function handshakeBoth(p: Awaited<ReturnType<typeof makePair>>): Promise<{ a: Awaited<ReturnType<PairHandshake['accept']>>; b: Awaited<ReturnType<PairHandshake['accept']>> }> {
  const a1 = p.a.hs.stage1;
  const b1 = p.b.hs.stage1;
  expect(await p.a.hs.accept(b1)).toBeNull();
  expect(await p.b.hs.accept(a1)).toBeNull();
  const a2 = await p.a.hs.stage2();
  const b2 = await p.b.hs.stage2();
  return {
    a: await p.b.hs.accept(a2),
    b: await p.a.hs.accept(b2),
  };
}

describe('HKDF', () => {
  it('детерминирован и зависит от всех трёх входов', async () => {
    const ikm = new Uint8Array(32).fill(1);
    const salt = new Uint8Array(32).fill(2);
    const one = await hkdf(ikm, salt, new TextEncoder().encode('info'), 32);
    const two = await hkdf(ikm, salt, new TextEncoder().encode('info'), 32);
    expect(toHex(one)).toBe(toHex(two));

    const otherInfo = await hkdf(ikm, salt, new TextEncoder().encode('info2'), 32);
    const otherSalt = await hkdf(ikm, new Uint8Array(32).fill(3), new TextEncoder().encode('info'), 32);
    const otherIkm = await hkdf(new Uint8Array(32).fill(9), salt, new TextEncoder().encode('info'), 32);
    expect(toHex(one)).not.toBe(toHex(otherInfo));
    expect(toHex(one)).not.toBe(toHex(otherSalt));
    expect(toHex(one)).not.toBe(toHex(otherIkm));
  });

  it('даёт разные ключи на разные info в одном запуске', async () => {
    const ikm = new Uint8Array(32).fill(5);
    const salt = new Uint8Array(32);
    const a = await hkdf(ikm, salt, new TextEncoder().encode('ctrl|a'), 32);
    const b = await hkdf(ikm, salt, new TextEncoder().encode('ctrl|b'), 32);
    const c = await hkdf(ikm, salt, new TextEncoder().encode('file|a'), 32);
    expect(new Set([toHex(a), toHex(b), toHex(c)]).size).toBe(3);
  });

  it('поддерживает вывод длиннее 32 байт', async () => {
    const out = await hkdf(new Uint8Array(32).fill(1), new Uint8Array(32), new Uint8Array(0), 100);
    expect(out.length).toBe(100);
    // Первый блок T(1) должен совпасть с 32-байтным выводом.
    const short = await hkdf(new Uint8Array(32).fill(1), new Uint8Array(32), new Uint8Array(0), 32);
    expect(toHex(out.subarray(0, 32))).toBe(toHex(short));
  });

  it('не принимает некорректную длину', async () => {
    await expect(hkdf(new Uint8Array(32), new Uint8Array(32), new Uint8Array(0), 0)).rejects.toThrow();
  });
});

describe('ключ комнаты', () => {
  it('одинаков для одной фразы и комнаты, разный для разных комнат', async () => {
    const roomA = newId();
    const roomB = newId();
    const k1 = await derivePassKey('фраза-из-трёх-слов', roomA, FAST_KDF);
    const k2 = await derivePassKey('фраза-из-трёх-слов', roomA, FAST_KDF);
    const k3 = await derivePassKey('фраза-из-трёх-слов', roomB, FAST_KDF);
    const k4 = await derivePassKey('другая-фраза', roomA, FAST_KDF);
    expect(toHex(k1)).toBe(toHex(k2));
    expect(toHex(k1)).not.toBe(toHex(k3));
    expect(toHex(k1)).not.toBe(toHex(k4));
    expect(k1.length).toBe(32);
  });

  it('отказывается от слишком короткой фразы', async () => {
    await expect(derivePassKey('кор', newId(), FAST_KDF)).rejects.toThrow(/короче/);
  });
});

describe('рукопожатие пиров', () => {
  it('выдаёт одинаковые ключи и код безопасности обеим сторонам', async () => {
    const p = await makePair();
    const { a, b } = await handshakeBoth(p);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const ka = a!;
    const kb = b!;

    // Роли противоположны: один отправляет туда, куда другой принимает.
    expect(ka.role).not.toBe(kb.role);
    expect(ka.safetyCode).toBe(kb.safetyCode);
    expect(ka.safetyCode).toMatch(/^\d{5} \d{5}$/);

    // Ключи на РАЗНЫЕ направления: отправка A→B это приём B→A.
    const aToB = new AeadChannel({ send: ka.ctrlSend, recv: kb.ctrlSend });
    const bToA = new AeadChannel({ send: kb.ctrlSend, recv: ka.ctrlSend });
    const frame = await aToB.sealBody(FrameType.Json, new Uint8Array([1]));
    const opened = await bToA.open(frame);
    expect(opened.type).toBe(FrameType.Json);
  });

  it('не выдаёт ключи при неверной парольной фразе', async () => {
    const roomId = newId();
    const idA = await createPeerIdentity();
    const idB = await createPeerIdentity();
    const good = await derivePassKey('правильная-фраза', roomId, FAST_KDF);
    const bad = await derivePassKey('неправильная', roomId, FAST_KDF);

    const hsA = new PairHandshake({ roomId, self: idA, passKey: good });
    const hsB = new PairHandshake({ roomId, self: idB, passKey: bad });

    await hsA.accept(hsB.stage1);
    await hsB.accept(hsA.stage1);
    const a2 = await hsA.stage2();
    const b2 = await hsB.stage2();
    const keysB = await hsB.accept(a2);
    const keysA = await hsA.accept(b2);

    expect(keysB).not.toBeNull();
    expect(keysA).not.toBeNull();
    // Подпись честная, но ключи разные: канал просто не расшифруется.
    const aOut = new AeadChannel({ send: keysA!.ctrlSend, recv: keysA!.ctrlRecv });
    const bIn = new AeadChannel({ send: keysB!.ctrlRecv, recv: keysB!.ctrlSend });
    const frame = await aOut.sealBody(FrameType.Json, new Uint8Array([1]));
    await expect(bIn.open(frame)).rejects.toThrow(AeadError);
  });

  it('ловит подмену публичных ключей между стадиями', async () => {
    const p = await makePair();
    const impostor = await createPeerIdentity();
    expect(await p.a.hs.accept(p.b.hs.stage1)).toBeNull();
    // Пир прислал валидную stage 1, а в stage 2 подменил ключ.
    const forged = { ...p.b.hs.stage1, stage: 2 as const, e: toHex(impostor.identityPubRaw), s: 'f'.repeat(128) };
    await expect(p.a.hs.accept(forged)).rejects.toThrow(/изменились/);
  });

  it('ловит подпись, не соответствующую транскрипту', async () => {
    const p = await makePair();
    await p.a.hs.accept(p.b.hs.stage1);
    await p.b.hs.accept(p.a.hs.stage1);
    // Ключи пира настоящие, а подпись — мусор. Проверка обязана это отбить,
    // иначе код безопасности можно было бы навязать без участия пира.
    await expect(p.a.hs.accept({ ...p.b.hs.stage1, stage: 2, s: 'f'.repeat(128) })).rejects.toThrow(/подпись/);
  });

  it('привязывает подпись к комнате', async () => {
    // Один и тот же пир в другой комнате даёт другой транскрипт, поэтому
    // подпись из первой комнаты во второй не сойдётся.
    const roomOne = newId();
    const roomTwo = newId();
    const identity = await createPeerIdentity();
    const other = await createPeerIdentity();
    const keyOne = await derivePassKey('одна-и-та-же-фраза', roomOne, FAST_KDF);
    const keyTwo = await derivePassKey('одна-и-та-же-фраза', roomTwo, FAST_KDF);

    const hsOneA = new PairHandshake({ roomId: roomOne, self: identity, passKey: keyOne });
    const hsOneB = new PairHandshake({ roomId: roomOne, self: other, passKey: keyOne });
    await hsOneA.accept(hsOneB.stage1);
    await hsOneB.accept(hsOneA.stage1);
    const signatureFromRoomOne = (await hsOneA.stage2()).s;

    const hsTwoB = new PairHandshake({ roomId: roomTwo, self: other, passKey: keyTwo });
    await hsTwoB.accept(hsOneA.stage1);
    // Nonce совпали, ключи настоящие, но транскрипт другой комнаты —
    // подпись не подходит.
    await expect(hsTwoB.accept({ ...hsOneA.stage1, stage: 2, s: signatureFromRoomOne })).rejects.toThrow(/подпись/);
  });

  it('отвергает собственный публичный ключ', async () => {
    const p = await makePair();
    await expect(p.a.hs.accept(p.a.hs.stage1)).rejects.toThrow(/собственный/);
  });

  it('код безопасности зависит от комнаты', async () => {
    const idA = toHex((await createPeerIdentity()).identityPubRaw);
    const idB = toHex((await createPeerIdentity()).identityPubRaw);
    const one = await safetyCode('room-1', idA, idB);
    const two = await safetyCode('room-2', idA, idB);
    const three = await safetyCode('room-1', idB, idA);
    expect(one).toMatch(/^\d{5} \d{5}$/);
    expect(one).not.toBe(two);
    // Порядок аргументов не влияет: код симметричен.
    expect(one).toBe(three);
  });
});

describe('AEAD-канал', () => {
  async function channels(): Promise<{ a: AeadChannel; b: AeadChannel }> {
    const raw = new Uint8Array(32).fill(42);
    const key = await crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return {
      a: new AeadChannel({ send: key, recv: key }),
      b: new AeadChannel({ send: key, recv: key }),
    };
  }

  it('не оставляет полезной нагрузки в открытом заголовке', async () => {
    const { a, b } = await channels();
    const id = newId();
    const payload = enc('секретный чат');
    const body = new Uint8Array(4 + payload.length);
    new DataView(body.buffer).setUint32(0, 1, false);
    body.set(payload, 4);

    const frame = await a.sealBody(FrameType.Json, body);
    // Заголовок кадра (первые 6 байт) — единственное, что видно снаружи.
    // Полезной нагрузки в нём быть не должно, иначе чат утекает в открытом виде.
    const header = frame.subarray(0, 6);
    expect(header[1]).toBe(FrameType.Json);
    expect(Array.from(header).includes(payload[0] as number)).toBe(false);

    const opened = await b.open(frame);
    expect(opened.type).toBe(FrameType.Json);
    expect(new TextDecoder().decode(opened.body.subarray(4))).toBe('секретный чат');
  });

  it('читает тело JSON-кадра, отличное от заголовка', async () => {
    const { a, b } = await channels();
    const body = new Uint8Array([1, 2, 3, 4]);
    const opened = await b.open(await a.sealBody(FrameType.YjsSync, body));
    expect(opened.type).toBe(FrameType.YjsSync);
    expect(Array.from(opened.body)).toEqual([1, 2, 3, 4]);
  });

  it('не навешивает JSON-заголовок на Yjs-кадр', async () => {
    // Формат Yjs бинарный: заголовок с JSON здесь сделал бы кадр неразбираемым.
    const { a, b } = await channels();
    const opened = await b.open(await a.sealBody(FrameType.YjsAwareness, new Uint8Array([7])));
    expect(opened.json).toBeUndefined();
  });

  it('шифрует чанк файла и сохраняет заголовок', async () => {
    const { a, b } = await channels();
    const transferId = new Uint8Array(16).fill(3);
    const data = new Uint8Array(CHUNK_SIZE).fill(7);
    const frame = await a.sealChunk(transferId, 32_768, data);
    const opened = await b.open(frame);
    expect(opened.chunk?.offset).toBe(32_768);
    expect(Array.from(opened.chunk?.transferId ?? [])).toEqual(Array.from(transferId));
    expect(opened.body.length).toBe(data.length);
  });

  it('отбрасывает кадр с испорченным телом', async () => {
    const { a, b } = await channels();
    const frame = await a.sealBody(FrameType.Json, new Uint8Array([1, 2, 3]));
    frame[frame.length - 5] = (frame[frame.length - 5] as number) ^ 0xff;
    await expect(b.open(frame)).rejects.toThrow(/тег/);
  });

  it('отбрасывает кадр с подменённым offset в чанке', async () => {
    const { a, b } = await channels();
    const frame = await a.sealChunk(new Uint8Array(16), 0, new Uint8Array([1, 2, 3]));
    // offset лежит в AAD, поэтому правка ломает аутентификацию.
    frame[22] = 0x7f;
    await expect(b.open(frame)).rejects.toThrow();
  });

  it('отбрасывает повторно переданный кадр', async () => {
    const { a, b } = await channels();
    const frame = await a.sealBody(FrameType.Json, new Uint8Array([1]));
    await b.open(frame);
    await expect(b.open(frame)).rejects.toThrow(/повтор/);
  });

  it('терпит перестановку счётчиков из-за асинхронного шифрования', async () => {
    // crypto.subtle.encrypt асинхронен: два параллельных seal() могут завершиться
    // не в том порядке, в котором получили счётчики. Канал обязан это пережить.
    const { a, b } = await channels();
    const frames = await Promise.all([
      a.sealBody(FrameType.Json, new Uint8Array([1])),
      a.sealBody(FrameType.Json, new Uint8Array([2])),
      a.sealBody(FrameType.Json, new Uint8Array([3])),
    ]);
    for (const frame of frames) await b.open(frame);
    expect(b.stats.opened).toBe(3);
    expect(b.stats.rejected).toBe(0);
  });

  it('не пускает кадры из чужой сессии с тем же ключом', async () => {
    // Разные сессии имеют разные префиксы nonce; при одинаковом ключе (например,
    // после переподключения с тем же ключом комнаты) смешивать их нельзя.
    const raw = new Uint8Array(32).fill(11);
    const key = await crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const session1 = new AeadChannel({ send: key, recv: key });
    const receiver = new AeadChannel({ send: key, recv: key });
    await receiver.open(await session1.sealBody(FrameType.Json, new Uint8Array([1])));

    const session2 = new AeadChannel({ send: key, recv: key });
    await expect(receiver.open(await session2.sealBody(FrameType.Json, new Uint8Array([1])))).rejects.toThrow(/префикс/);
  });

  it('не принимает незашифрованный кадр в AEAD-канал', async () => {
    const { b } = await channels();
    const plain = AeadChannel.plainJson(FrameType.Hello, { v: 1 });
    await expect(b.open(plain)).rejects.toThrow(/зашифрованный/);
  });
});

describe('SHA-256', () => {
  it('совпадает с известным вектором', async () => {
    const digest = await sha256(new TextEncoder().encode('abc'));
    expect(toHex(digest)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
