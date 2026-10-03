/**
 * Фабрика WebRTC на произвольное число участников.
 *
 * Первый тест здесь — сам по себе проверка ткани: три настоящие `RoomSession`
 * в одной комнате должны соединиться mesh'ем (каждая с каждой). Без этого
 * все дальнейшие тесты про relay проверяли бы не то: при неработающей ткани
 * они падали бы на установлении соединений, а не на пересылке.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLibraryStore } from '@rd/library';
import { RoomSession } from '../src/room-session.js';
import { MockRtcFabric } from '../../p2p/tests/mock-fabric.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { newId } from '@rd/protocol';

const cleanup: Array<() => void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    try {
      await fn?.();
    } catch {
      // Уборка не должна маскировать результат теста.
    }
  }
});

async function waitFor(pred: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Комната из `count` сессий на общей ткани. */
async function makeRoom(count: number): Promise<{
  sessions: RoomSession[];
  fabric: MockRtcFabric;
}> {
  const roomId = newId();
  const passphrase = 'север-берег-звезда-улица';
  const fabric = new MockRtcFabric({ mode: 'instant' });
  const signalRoom = new MemorySignalRoom();
  const sessions: RoomSession[] = [];

  for (let i = 0; i < count; i++) {
    const store = createLibraryStore(`fabric-${i}-${Math.random().toString(36).slice(2)}`);
    const session = await RoomSession.create(
      {
        roomId,
        passphrase,
        name: `Участник ${i}`,
        color: '#3b82f6',
        signalingUrl: 'ws://localhost:1/не-используется',
      },
      () => {},
      {
        store,
        transport: (descriptor) => new MemorySignalTransport(descriptor, signalRoom),
        rtc: fabric.factory,
        kdfIterations: 1_000,
        iceServers: [],
      },
    );
    cleanup.push(async () => {
      await session.stop();
      await store.clearRoom(roomId).catch(() => {});
      await store.db.delete().catch(() => {});
    });
    sessions.push(session);
  }

  await waitFor(
    () => sessions.every((s) => s.state.peers.length === count - 1 && s.state.peers.every((p) => p.state === 'ready')),
    `все ${count} участников соединились`,
  );
  return { sessions, fabric };
}

describe('ткань WebRTC на N участников', () => {
  it('соединяет троих mesh-ом: у каждого по два готовых пира', async () => {
    const { sessions, fabric } = await makeRoom(3);
    for (const s of sessions) {
      expect(s.state.peers).toHaveLength(2);
      expect(s.state.peers.filter((p) => p.state === 'ready')).toHaveLength(2);
    }
    // Три пары: A–B, A–C, B–C.
    expect(fabric.pairCount).toBe(3);
  });

  it('соединяет четверых mesh-ом: шесть пар', async () => {
    const { sessions, fabric } = await makeRoom(4);
    for (const s of sessions) expect(s.state.peers.filter((p) => p.state === 'ready')).toHaveLength(3);
    expect(fabric.pairCount).toBe(6);
  });
});