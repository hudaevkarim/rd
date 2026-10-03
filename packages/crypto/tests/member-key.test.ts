/**
 * Ключ для произвольного участника комнаты (используется relay).
 *
 * Главное, что здесь проверяется, — НЕ то, что схема работает, а то, что она
 * не выдаёт содержимое посреднику. Relay — обычный участник комнаты: у него
 * есть и парольная фраза, и agree-ключи, и список остальных. Если ключ
 * выводится из фразы и публичных ключей, relay расшифрует всё, и пересылка
 * станет открытой, хотя выглядеть будет как E2EE.
 */

import { describe, expect, it } from 'vitest';
import {
  concat,
  createPeerIdentity,
  deriveMemberKeys,
  derivePassKey,
  hkdf,
  openFromMember,
  PairHandshake,
  roomSalt,
  sealForMember,
  toHex,
  utf8,
  RELAY_NONCE_BYTES,
  type MemberKeys,
  type PeerIdentity,
} from '@rd/crypto';
import { sortPair } from '@rd/protocol';

const ROOM = 'комната-relay-тест';

const secret = new TextEncoder().encode('очень длинное тестовое сообщение для проверки пересылки');

async function passKeyFor(roomId = ROOM): Promise<Awaited<ReturnType<typeof derivePassKey>>> {
  return derivePassKey('север-берег-звезда-улица', roomId, 1_000);
}

/** Ключи «я ↔ участник» по публичным ключам из каталога комнаты. */
function keysFor(
  self: PeerIdentity,
  peer: PeerIdentity,
  key: Awaited<ReturnType<typeof derivePassKey>>,
): Promise<MemberKeys> {
  return deriveMemberKeys({
    roomId: ROOM,
    passKey: key,
    self,
    peerIdentityHex: toHex(peer.identityPubRaw),
    peerAgreeHex: toHex(peer.agreePubRaw),
  });
}

/**
 * Ключи канала пары — через настоящее рукопожатие.
 *
 * Нужны, чтобы доказать, что ключ участника не совпадает с ключом канала:
 * иначе один кадр расшифровывался бы двумя способами и пара «ключ + nonce»
 * могла бы повториться.
 */
async function pairKeys(
  key: Awaited<ReturnType<typeof derivePassKey>>,
  anna: PeerIdentity,
  boris: PeerIdentity,
): Promise<{ ctrlSend: CryptoKey; ctrlRecv: CryptoKey }> {
  const a = new PairHandshake({ roomId: ROOM, self: anna, passKey: key });
  const b = new PairHandshake({ roomId: ROOM, self: boris, passKey: key });
  const stage1A = a.stage1;
  const stage1B = b.stage1;
  await a.accept(stage1B);
  await b.accept(stage1A);
  const keysA = await a.accept(await b.stage2());
  const keysB = await b.accept(await a.stage2());
  if (keysA === null || keysB === null) throw new Error('рукопожатие не завершилось');
  return { ctrlSend: keysA.ctrlSend, ctrlRecv: keysB.ctrlRecv };
}

describe('ключ участника комнаты', () => {
  it('отправитель и получатель получают взаимные ключи', async () => {
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    const boris = await createPeerIdentity();

    const fromAnna = await keysFor(anna, boris, key);
    const fromBoris = await keysFor(boris, anna, key);

    // Ключ отправки у одного — ключ получения у другого, и наоборот.
    expect(fromAnna.selfIsA).not.toBe(fromBoris.selfIsA);
    const frame = await sealForMember(fromAnna.send, secret);
    expect(await openFromMember(fromBoris.recv, frame)).toEqual(secret);
    const back = await sealForMember(fromBoris.send, secret);
    expect(await openFromMember(fromAnna.recv, back)).toEqual(secret);
  });

  it('ключ из одной лишь фразы и публичных ключей пары не открывает кадр', async () => {
    // Ключевой тест всего файла — прямая проверка наивной схемы.
    //
    // Relay знает: парольную фразу комнаты, публичные identity-ключи Анны и
    // Бориса, публичные agree-ключи обоих. Всё это приходит ему в каталоге
    // комнаты. Если бы ключ выводился из фразы и публичных ключей ПАРЫ, relay
    // вывел бы его ровно тем же кодом, что и отправитель, — и пересылка была бы
    // прозрачной, хотя выглядела бы как E2EE.
    //
    // Проверка идёт не через наш API: API не даст подставить чужой identity, но
    // атакующий выведет ключ напрямую. Поэтому ключ «злоумышленника»
    // собирается вручную ровно так, как это сделала бы наивная схема.
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    const boris = await createPeerIdentity();
    const salt = await roomSalt(ROOM);
    const [idLo, idHi] = sortPair(toHex(anna.identityPubRaw), toHex(boris.identityPubRaw));

    const naiveFor = async (role: 'a' | 'b'): Promise<CryptoKey> => {
      const raw = await hkdf(
        key,
        salt,
        concat(utf8(`rd/relay/v1|${role}|${idLo}|${idHi}`), new Uint8Array([0x52])),
        32,
      );
      return crypto.subtle.importKey('raw', raw.slice().buffer as ArrayBuffer, 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    };

    const annaToBoris = await keysFor(anna, boris, key);
    const frame = await sealForMember(annaToBoris.send, secret);
    // Роль та же, что и у настоящего ключа отправки: «b» — если self первый в
    // отсортированной паре, «a» — иначе. С другой ролью проверка прошла бы в
    //холостую: ключи разных ролей и так несравнимы.
    const annaIsA = toHex(anna.identityPubRaw) <= toHex(boris.identityPubRaw);
    const asRelaySeesIt = await naiveFor(annaIsA ? 'b' : 'a');

    await expect(openFromMember(asRelaySeesIt, frame)).rejects.toBeTruthy();
  }, 30_000);

  it('третий участник не может расшифровать чужой трафик', async () => {
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    const boris = await createPeerIdentity();
    const vanya = await createPeerIdentity();

    const annaToBoris = await keysFor(anna, boris, key);
    const vanyaView = await keysFor(vanya, boris, key);

    const frame = await sealForMember(annaToBoris.send, secret);
    await expect(openFromMember(vanyaView.recv, frame)).rejects.toBeTruthy();
  });

  it('другая комната не подходит даже при той же фразе', async () => {
    // Фраза «север-берег» в другой комнате — другой ключ. Иначе перехват
    // сообщения из другой комнаты, где назвали ту же фразу, был бы возможен.
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    const boris = await createPeerIdentity();

    const annaToBoris = await keysFor(anna, boris, key);
    const otherRoom = await passKeyFor('другая-комната');
    const annaToBorisElsewhere = await deriveMemberKeys({
      roomId: 'другая-комната',
      passKey: otherRoom,
      self: anna,
      peerIdentityHex: toHex(boris.identityPubRaw),
      peerAgreeHex: toHex(boris.agreePubRaw),
    });

    const frame = await sealForMember(annaToBoris.send, secret);
    await expect(openFromMember(annaToBorisElsewhere.recv, frame)).rejects.toBeTruthy();
  });

  it('не совпадает с ключом канала пары', async () => {
    // Критично для потока: если бы ключи совпали, один и тот же кадр можно
    // было бы расшифровать двумя способами, и пара «ключ + nonce» повторилась бы.
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    const boris = await createPeerIdentity();
    const pair = await pairKeys(key, anna, boris);
    const member = await keysFor(anna, boris, key);

    // `await` должен быть ВНУТРИ expect: иначе промис разрешится до того, как
    // `rejects` его обернёт, и тест упадёт на самом шифровании.
    const byMember = await sealForMember(member.send, secret);
    const byPair = await sealForMember(pair.ctrlSend, secret);
    await expect(openFromMember(pair.ctrlRecv, byMember)).rejects.toBeTruthy();
    await expect(openFromMember(member.recv, byPair)).rejects.toBeTruthy();
  });

  it('отказывается выводить ключ с самим собой', async () => {
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    await expect(keysFor(anna, anna, key)).rejects.toBeTruthy();
  });

  it('подмена содержимого ломает расшифровку', async () => {
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    const boris = await createPeerIdentity();
    const fromAnna = await keysFor(anna, boris, key);
    const fromBoris = await keysFor(boris, anna, key);

    const frame = await sealForMember(fromAnna.send, secret);
    const tampered = frame.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
    await expect(openFromMember(fromBoris.recv, tampered)).rejects.toBeTruthy();
  });

  it('в кадре только nonce и шифротекст, открытого текста нет', async () => {
    const key = await passKeyFor();
    const anna = await createPeerIdentity();
    const boris = await createPeerIdentity();

    const frame = await sealForMember((await keysFor(anna, boris, key)).send, secret);
    expect(frame.length).toBe(RELAY_NONCE_BYTES + secret.length + 16);
    // Relay читает только заголовок кадра маршрутизации; содержимое закрыто.
    expect(new TextDecoder().decode(frame)).not.toContain('сообщение');
  });
});