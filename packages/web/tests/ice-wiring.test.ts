/**
 * ICE-конфигурация доходит до `RoomMesh` и до `RTCPeerConnection`.
 *
 * ─── Почему нужен отдельный тест, раз есть тест на загрузчик ───────────────────
 *
 * Загрузчик можно написать верно и не подключить. Проверки на `loadIceServers`
 * ничего не говорят о том, что его результат применяется, а поломка была
 * именно такого рода: конфигурация доезжала до переменной и там умирала.
 * Поэтому здесь настоящая `RoomSession` — с тем же `create`, который зовут живые
 * клиенты, — и утверждение на самой границе: что у `RoomMesh` непустой
 * `rtcConfig.iceServers`, и что фабрика `RTCPeerConnection` получила то же самое.
 *
 * Соединение создаётся между ДВУМЯ сессиями: с одним участником пиров нет, и
 * фабрика `RTCPeerConnection` не вызывается ни разу — проверять тогда нечего,
 * а тест на «передали конфигурацию» прошёл бы вхолостую.
 *
 * WebRTC и signaling подменены (в Node их нет), всё остальное — боевой код.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@rd/protocol';
import { MockRtcNetwork } from '../../p2p/tests/mock-webrtc.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { createLibraryStore } from '@rd/library';
import type { IceServerConfig } from '@rd/p2p';
import { RoomSession } from '../src/room-session.js';

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

interface Built {
  anna: RoomSession;
  /** Все конфигурации, с которыми создавались соединения. */
  rtcConfigs: Array<{ iceServers?: unknown }>;
}

/** Две сессии в одной комнате; `iceServers` — если задано, подставляется обеим. */
async function createPair(iceServers?: IceServerConfig[]): Promise<Built> {
  const roomId = newId();
  const network = new MockRtcNetwork({ mode: 'instant' });
  const signalRoom = new MemorySignalRoom();
  const rtcConfigs: Array<{ iceServers?: unknown }> = [];
  const factory = network.factory;

  const make = async (name: string, color: string): Promise<RoomSession> => {
    const store = createLibraryStore(`ice-${name}-${Math.random().toString(36).slice(2)}`);
    const session = await RoomSession.create(
      {
        roomId,
        passphrase: 'север-берег-звезда-улица',
        name,
        color,
        signalingUrl: 'ws://localhost:1/не-используется',
      },
      () => {},
      {
        store,
        transport: (descriptor) => new MemorySignalTransport(descriptor, signalRoom),
        // Оборачиваем фабрику, чтобы увидеть, что реально уходит в браузер.
        rtc: (config) => {
          rtcConfigs.push(config as { iceServers?: unknown });
          return factory(config);
        },
        kdfIterations: 1_000,
        ...(iceServers === undefined ? {} : { iceServers }),
      },
    );
    cleanup.push(async () => {
      await session.stop();
      await store.clearRoom(roomId).catch(() => {});
      await store.db.delete().catch(() => {});
    });
    return session;
  };

  const anna = await make('Аня', '#3b82f6');
  const boris = await make('Борис', '#f59e0b');
  await waitFor(
    () => anna.state.peers.some((p) => p.state === 'ready') && boris.state.peers.some((p) => p.state === 'ready'),
    'пиры не соединились',
  );
  return { anna, rtcConfigs };
}

describe('ICE-конфигурация в сессии', () => {
  it('доходит до RoomMesh', async () => {
    const { anna } = await createPair([{ urls: 'stun:stun.example:3478' }]);
    expect(anna.mesh.rtcConfig.iceServers).toEqual([{ urls: 'stun:stun.example:3478' }]);
  });

  it('доходит до RTCPeerConnection', async () => {
    const { rtcConfigs } = await createPair([{ urls: 'turn:turn.example', username: 'u', credential: 'p' }]);
    expect(rtcConfigs.length).toBeGreaterThan(0);
    for (const config of rtcConfigs) {
      expect(config.iceServers).toEqual([{ urls: 'turn:turn.example', username: 'u', credential: 'p' }]);
    }
  });

  it('пустой список доезжает как пустой, а не превращается в мусор', async () => {
    // Различие важно: пустой список — это осознанное «только локальные
    // кандидаты». Если бы он молча заменялся на что-то другое, работа в сети без
    // доступа в интернет (а это и есть LAN) ломалась бы.
    const { anna, rtcConfigs } = await createPair([]);
    expect(anna.mesh.rtcConfig.iceServers).toEqual([]);
    for (const config of rtcConfigs) expect(config.iceServers).toEqual([]);
  });

  it('при недоступном signaling вход всё равно удаётся', async () => {
    // Конфигурация здесь не задана, поэтому сессия сама идёт в `/config` по
    // заведомо недоступному адресу. Правильное поведение — взять резервный
    // публичный STUN и войти, а не выбросить исключение на входе.
    const { anna, rtcConfigs } = await createPair(undefined);
    expect(anna.state.status).not.toBe('failed');
    expect(anna.mesh.rtcConfig.iceServers?.length ?? 0).toBeGreaterThan(0);
    // И у фабрики соединений список непустой, а не выброшен по дороге.
    for (const config of rtcConfigs) expect(config.iceServers).toBeDefined();
  });
});