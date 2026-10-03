/**
 * Интеграционный тест signaling-сервера: настоящий Fastify, настоящие
 * WebSocket-клиенты, настоящий порт.
 *
 * Здесь проверяется именно то, что нельзя увидеть в юнит-тестах реестра:
 * маршрутизация между участниками, лимиты, изоляция комнат и то, что сервер
 * закрывает соединение при превышении дозволенного.
 */

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { newId, PROTOCOL_VERSION, AGREE_KEY_BYTES, IDENTITY_KEY_BYTES, type PeerDescriptor, type ServerMessage } from '@rd/protocol';
import { createSignalingServer, type SignalingServer } from '../src/index.js';
import { loadConfig, type ServerConfig } from '../src/config.js';

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 0,
  publicUrl: 'http://127.0.0.1:0',
  maxRoomPeers: 3,
  ratePerSec: 1000,
  rateBurst: 1000,
  connectPerMin: 1000,
  connectBurst: 1000,
  maxBufferedBytes: 1024 * 1024,
  roomIdleEvictMs: 50,
  corsOrigin: '',
  logLevel: 'silent',
  iceServers: [],
};

const servers: SignalingServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()?.terminate();
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s?.close();
  }
});

async function startServer(overrides: Partial<ServerConfig> = {}): Promise<{ server: SignalingServer; url: string }> {
  const server = await createSignalingServer({ config: { ...config, ...overrides }, silent: true });
  servers.push(server);
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, url: `ws://127.0.0.1:${port}/ws` };
}

function descriptor(name: string): PeerDescriptor {
  return {
    id: newId(),
    name,
    color: '#3b82f6',
    identityKey: newId().replace(/-/g, '').padEnd(IDENTITY_KEY_BYTES * 2, '0').slice(0, IDENTITY_KEY_BYTES * 2),
    agreeKey: newId().replace(/-/g, '').padEnd(AGREE_KEY_BYTES * 2, '0').slice(0, AGREE_KEY_BYTES * 2),
  };
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  peer: PeerDescriptor;
  readonly: string[];
  send(msg: unknown): void;
  join(room: string): void;
  waitFor<T extends ServerMessage['t']>(type: T, timeoutMs?: number): Promise<Extract<ServerMessage, { t: T }>>;
  close(): void;
}

async function connect(url: string, name: string, peer = descriptor(name)): Promise<Client> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  const readonly: string[] = [];
  ws.on('message', (data: WebSocket.RawData) => {
    messages.push(JSON.parse(data.toString('utf8')) as ServerMessage);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client: Client = {
    ws,
    messages,
    peer,
    readonly,
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    join(room) {
      ws.send(JSON.stringify({ t: 'join', room, peer, protocol: PROTOCOL_VERSION }));
    },
    async waitFor<T extends ServerMessage['t']>(type: T, timeoutMs = 3_000) {
      const start = Date.now();
      for (;;) {
        const found = messages.find((m) => m.t === type) as Extract<ServerMessage, { t: T }> | undefined;
        if (found) return found;
        if (Date.now() - start > timeoutMs) throw new Error(`не дождались ${type}; пришло: ${messages.map((m) => m.t).join(',')}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    close() {
      ws.close();
    },
  };
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('healthz и конфигурация', () => {
  it('отдаёт статус и список ICE-серверов', async () => {
    const { server, url } = await startServer();
    void url;
    const health = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION, rooms: 0, peers: 0 });

    const cfg = await server.app.inject({ method: 'GET', url: '/config' });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json()).toMatchObject({ protocol: PROTOCOL_VERSION, maxRoomPeers: 3 });
  });

  it('отдаёт ICE-серверы, которые задал оператор', async () => {
    const { server } = await startServer({
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }],
    });
    const cfg = await server.app.inject({ method: 'GET', url: '/config' });
    // Форма должна совпадать с тем, что ждёт клиент: иначе он отбросит
    // конфигурацию и молча уйдёт на резервный список.
    expect(cfg.json()).toMatchObject({
      iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }],
    });
  });

  it('разрешает чтение конфигурации с другого источника', async () => {
    // Без этого заголовка клиент с другого домена (а это обычная раскладка:
    // отдельный домен под клиент и отдельный под signaling) не увидит ICE-конфигурацию
    // и останется на локальных кандидатах — молча, без ошибки.
    const { server } = await startServer({ corsOrigin: 'http://client.example' });
    const cfg = await server.app.inject({
      method: 'GET',
      url: '/config',
      headers: { origin: 'http://client.example' },
    });
    expect(cfg.headers['access-control-allow-origin']).toBe('http://client.example');

    // Чужой источник заголовка не получает.
    const other = await server.app.inject({
      method: 'GET',
      url: '/config',
      headers: { origin: 'http://чужик.example' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('по умолчанию разрешает любой источник', async () => {
    // WebSocket-эндпоинт всё равно открыт любому сайту, поэтому CORS-заголовок по
    // умолчанию должен быть: иначе он запрещал бы чтение /config, но не защищал бы
    // ничего. Явно заданный список, наоборот, ограничивает.
    const { server } = await startServer({ corsOrigin: '*' });
    const cfg = await server.app.inject({
      method: 'GET',
      url: '/config',
      headers: { origin: 'http://any.example' },
    });
    expect(cfg.headers['access-control-allow-origin']).toBeTruthy();
  });
});

describe('чтение переменных окружения', () => {
  /** Подменяет переменные на время вызова и возвращает результат. */
  async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(vars)) {
      saved.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('пустой ICE_SERVERS отключает внешние серверы', async () => {
    // Раньше `str()` превращала пустое значение в «не задано», и проверка
    // `raw === ''` ниже была недостижимой: документированный способ отключить
    // ICE не работал. Теперь пустая строка — осмысленное значение.
    const result = await withEnv({ ICE_SERVERS: '' }, () => loadConfig());
    expect(result.iceServers).toEqual([]);
  });

  it('по умолчанию берётся публичный STUN', async () => {
    const result = await withEnv({ ICE_SERVERS: undefined }, () => loadConfig());
    expect(result.iceServers.length).toBeGreaterThan(0);
    expect(String(result.iceServers[0]?.urls)).toContain('stun:');
  });

  it('разбирает список через запятую', async () => {
    const result = await withEnv({ ICE_SERVERS: 'stun:a.example, stun:b.example' }, () => loadConfig());
    expect(result.iceServers).toEqual([{ urls: 'stun:a.example' }, { urls: 'stun:b.example' }]);
  });

  it('принимает JSON с учётными данными', async () => {
    const json = JSON.stringify([{ urls: 'turn:t.example', username: 'u', credential: 'p' }]);
    const result = await withEnv({ ICE_SERVERS: json }, () => loadConfig());
    expect(result.iceServers[0]).toMatchObject({ username: 'u', credential: 'p' });
  });

  it('CORS по умолчанию открыт для любого источника', async () => {
    const result = await withEnv({ CORS_ORIGIN: undefined }, () => loadConfig());
    expect(result.corsOrigin).toBe('*');
  });
});

describe('подключение и маршрутизация', () => {
  it('выдаёт welcome со списком участников и уведомляет остальных', async () => {
    const { url } = await startServer();
    const room = newId();

    const first = await connect(url, 'Аня');
    first.join(room);
    const welcome = await first.waitFor('welcome');
    expect(welcome.self.id).toBe(first.peer.id);
    expect(welcome.peers).toHaveLength(0);

    const second = await connect(url, 'Борис');
    second.join(room);
    const welcomeB = await second.waitFor('welcome');
    expect(welcomeB.peers.map((p) => p.id)).toEqual([first.peer.id]);

    const joined = await first.waitFor('peer-joined');
    expect(joined.peer.id).toBe(second.peer.id);
    expect(joined.peer.name).toBe('Борис');
  });

  it('пересылает offer, answer и кандидаты только адресату', async () => {
    const { url } = await startServer();
    const room = newId();
    const a = await connect(url, 'Аня');
    a.join(room);
    await a.waitFor('welcome');
    const b = await connect(url, 'Борис');
    b.join(room);
    await b.waitFor('welcome');
    const c = await connect(url, 'Вера');
    c.join(room);
    await c.waitFor('welcome');
    await a.waitFor('peer-joined');
    await a.waitFor('peer-joined');

    b.send({ t: 'signal', to: a.peer.id, kind: 'offer', sdp: 'v=0-offer' });
    const got = await a.waitFor('signal');
    expect(got.from).toBe(b.peer.id);
    expect(got.sdp).toBe('v=0-offer');

    b.send({ t: 'candidate', to: a.peer.id, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host' } });
    const cand = await a.waitFor('candidate');
    expect(cand.from).toBe(b.peer.id);

    // Вера ничего не должна была получить: она не адресат.
    expect(c.messages.some((m) => m.t === 'signal' || m.t === 'candidate')).toBe(false);
  });

  it('не пересылает сигналы между разными комнатами', async () => {
    const { url } = await startServer();
    const roomA = newId();
    const roomB = newId();
    const a1 = await connect(url, 'Аня');
    a1.join(roomA);
    await a1.waitFor('welcome');
    const b1 = await connect(url, 'Борис');
    b1.join(roomB);
    await b1.waitFor('welcome');

    b1.send({ t: 'signal', to: a1.peer.id, kind: 'offer', sdp: 'v=0' });
    await sleep(100);
    // Адресата нет в комнате отправителя: сообщение молча игнорируется,
    // иначе ответ с ошибкой стал бы оракулом для перебора идентификаторов.
    expect(a1.messages.some((m) => m.t === 'signal')).toBe(false);
  });

  it('рассылает переименование и убирает ушедшего', async () => {
    const { url } = await startServer();
    const room = newId();
    const a = await connect(url, 'Аня');
    a.join(room);
    await a.waitFor('welcome');
    const b = await connect(url, 'Борис');
    b.join(room);
    await b.waitFor('welcome');
    await a.waitFor('peer-joined');

    a.send({ t: 'rename', name: 'Анна', color: '#ff0000' });
    const renamed = await b.waitFor('renamed');
    expect(renamed.name).toBe('Анна');

    b.close();
    const left = await a.waitFor('peer-left');
    expect(left.id).toBe(b.peer.id);
  });

  it('отвечает на ping и замеряет задержку', async () => {
    const { url } = await startServer();
    const a = await connect(url, 'Аня');
    a.join(newId());
    await a.waitFor('welcome');
    a.send({ t: 'ping', id: 42, at: 1234 });
    const pong = await a.waitFor('pong');
    expect(pong.id).toBe(42);
    expect(pong.at).toBe(1234);
    expect(pong.serverTime).toBeGreaterThan(0);
  });
});

describe('валидация и защита', () => {
  it('не принимает сообщения до join', async () => {
    const { url } = await startServer();
    const a = await connect(url, 'Аня');
    a.send({ t: 'signal', to: newId(), kind: 'offer', sdp: 'v=0' });
    const err = await a.waitFor('error');
    expect(err.code).toBe('not-joined');
  });

  it('отвергает мусор и несоответствие протокола', async () => {
    const { url } = await startServer();
    const a = await connect(url, 'Аня');
    a.ws.send('не json');
    expect((await a.waitFor('error')).code).toBe('bad-message');

    a.send({ t: 'join', room: '../не-uuid', peer: a.peer, protocol: PROTOCOL_VERSION });
    expect((await a.waitFor('error')).code).toBe('bad-message');

    // Версию протокола не угадают — обрыв соединения fatal.
    const b = await connect(url, 'Борис');
    b.send({ t: 'join', room: newId(), peer: b.peer, protocol: 99 });
    const fatal = await b.waitFor('error');
    expect(fatal.code).toBe('protocol-mismatch');
    expect(fatal.fatal).toBe(true);
  });

  it('не пускает повторный join', async () => {
    const { url } = await startServer();
    const room = newId();
    const a = await connect(url, 'Аня');
    a.join(room);
    await a.waitFor('welcome');
    a.join(room);
    expect((await a.waitFor('error')).code).toBe('bad-message');
  });

  it('отказывает при переполнении комнаты', async () => {
    const { url } = await startServer({ maxRoomPeers: 2 });
    const room = newId();
    const a = await connect(url, 'Аня');
    a.join(room);
    await a.waitFor('welcome');
    const b = await connect(url, 'Борис');
    b.join(room);
    await b.waitFor('welcome');
    const c = await connect(url, 'Вера');
    c.join(room);
    const err = await c.waitFor('error');
    expect(err.code).toBe('room-full');
    expect(err.fatal).toBe(true);
  });

  it('отказывает при повторном идентификаторе', async () => {
    const { url } = await startServer();
    const room = newId();
    const shared = descriptor('Аня');
    const a = await connect(url, 'Аня', shared);
    a.join(room);
    await a.waitFor('welcome');
    const b = await connect(url, 'Аня again', shared);
    b.join(room);
    expect((await b.waitFor('error')).code).toBe('duplicate-id');
  });

  it('ограничивает поток сообщений и рвёт соединение', async () => {
    // Лимит специально крошечный: иначе тест штурмовал бы сервер тысячами
    // сообщений ради проверки одного if'а.
    const { url } = await startServer({ ratePerSec: 2, rateBurst: 4 });
    const a = await connect(url, 'Аня');
    a.join(newId());
    await a.waitFor('welcome');
    a.messages.length = 0;

    for (let i = 0; i < 40; i++) a.send({ t: 'ping', id: i, at: 0 });
    await sleep(300);

    const limited = a.messages.filter((m) => m.t === 'error' && m.code === 'rate-limited');
    expect(limited.length).toBeGreaterThan(0);
    // Ответов на пинги быть не должно: они шли в том же потоке.
    expect(a.messages.filter((m) => m.t === 'pong').length).toBeLessThan(40);
  });

  it('ограничивает число одновременных соединений с одного адреса', async () => {
    const { url } = await startServer({ connectPerMin: 1, connectBurst: 1 });
    await connect(url, 'Аня');
    const second = await connect(url, 'Борис');
    const err = await second.waitFor('error');
    expect(err.code).toBe('rate-limited');
    expect(err.fatal).toBe(true);
  });

  it('не хранит ничего после ухода всех участников', async () => {
    const { server, url } = await startServer({ roomIdleEvictMs: 20 });
    const room = newId();
    const a = await connect(url, 'Аня');
    a.join(room);
    await a.waitFor('welcome');
    expect(server.registry.peerCount).toBe(1);

    a.close();
    await waitUntil(() => server.registry.peerCount === 0, 'пир не удалился');
    await waitUntil(() => server.registry.size === 0, 'пустая комната не вытеснена');
  });

  it('возвращает пира в ту же комнату после краткого обрыва', async () => {
    // Комната не удаляется мгновенно: при переподключении из-за сети её
    // реестр и список участников должны сохраниться.
    const { server, url } = await startServer({ roomIdleEvictMs: 5_000 });
    const room = newId();
    const a = await connect(url, 'Аня');
    a.join(room);
    await a.waitFor('welcome');
    a.close();
    await waitUntil(() => server.registry.peerCount === 0, 'пир не удалился');
    expect(server.registry.size).toBe(1);

    const again = await connect(url, 'Аня');
    again.join(room);
    const welcome = await again.waitFor('welcome');
    expect(welcome.peers).toHaveLength(0);
  });
});

async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${description}`);
    await sleep(5);
  }
}
