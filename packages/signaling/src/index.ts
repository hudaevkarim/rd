/**
 * Signaling-сервер.
 *
 * Роль: помочь двум браузерам обменяться SDP и ICE-кандидатами, после чего
 * перестать участвовать. Никаких книг, комментариев, прогресса и ключей.
 *
 * Отсюда важные инженерные решения:
 *
 *  1. Кто инициирует соединение. Новый участник получает в `welcome` список
 *     существующих пиров и САМ отправляет им offer. Это полностью снимает
 *     «glare» (одновременный обмен предложениями) при первичном соединении.
 *     Дальше, при пересогласовании, клиенты используют perfect negotiation.
 *
 *  2. Backpressure. Если клиент не читает, у WebSocket растёт bufferedAmount.
 *     Копить его до гигабайта — верный способ уронить сервер, поэтому при
 *     превышении порога соединение рвётся.
 *
 *  3. Логи. Содержимое сообщений в лог не попадает никогда: даже SDP — это
 *     метаданные (IP-адреса, версии браузеров, пути в сети). Логируются только
 *     типы сообщений и коды ошибок.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { WebSocket } from 'ws';
import {
  ERROR_MESSAGES,
  MAX_SIGNAL_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  SERVER_PING_INTERVAL_MS,
  encode,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type PeerDescriptor,
  type PeerId,
  type ServerMessage,
} from '@rd/protocol';
import { RoomRegistry, type Peer, type Room } from './rooms.js';
import { KeyedWindowLimiter, TokenBucket, type Clock } from './rate-limit.js';
import type { ServerConfig } from './config.js';

const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_POLICY = 1008;
const WS_CLOSE_TRY_LATER = 1013;

/** Рвём соединение после N нарушений лимита, а не за один всплеск. */
const MAX_RATE_VIOLATIONS = 12;

export interface SignalingOptions {
  config: ServerConfig;
  clock?: Clock;
  /** Отключает логирование — удобно в тестах. */
  silent?: boolean;
}

export interface SignalingServer {
  app: FastifyInstance;
  registry: RoomRegistry;
  config: ServerConfig;
  close(): Promise<void>;
}

/**
 * Создаёт экземпляр signaling-сервера.
 *
 * Функция АСИНХРОННАЯ, и это не украшение: плагин @fastify/websocket обязан быть
 * зарегистрирован через `await` ДО добавления маршрута. При `void app.register`
 * обработчик маршрута получает первым аргументом Fastify Request вместо сокета
 * WebSocket и падает с «socket.on is not a function» уже на первом апгрейде.
 * Симптом при этом выглядит как «сервер отвечает 500 на /ws» и не имеет ничего
 * общего с настоящей причиной — на это ушло несколько часов отладки.
 */
export async function createSignalingServer(opts: SignalingOptions): Promise<SignalingServer> {
  const { config, clock } = opts;
  const registry = new RoomRegistry({ maxPeers: config.maxRoomPeers });
  const connectLimiter = new KeyedWindowLimiter({
    capacity: config.connectBurst,
    refillPerSec: config.connectPerMin / 60,
    clock,
  });

  const app = Fastify({
    logger: opts.silent === true ? false : { level: config.logLevel },
    // Сервер не принимает тела запросов — ограничиваем на всякий случай.
    bodyLimit: 16 * 1024,
    trustProxy: true,
  });

  const sockets = new Set<WebSocket>();
  const startedAt = Date.now();

  await app.register(helmet, { contentSecurityPolicy: false });
  /**
   * CORS по умолчанию разрешён для любого источника.
   *
   * Это не ослабление защиты, а её отсутствие: WebSocket-эндпоинт `/ws` и так
   * доступен с любого сайта — браузер не применяет CORS к WebSocket, и
   * ограничивать его origin'ом сервер не может. Значит, запрет CORS на `/config`
   * не закрывал ничего, а только ломал: клиент, загруженный не с того же
   * origin (а это обычная раскладка — отдельный домен под клиент и отдельный под
   * signaling), не мог спросить ICE-конфигурацию и молча работал без STUN.
   *
   * Тем не менее ограничение полезно: сервер перестаёт быть точкой притяжения
   * для чужих сайтов. Задайте `CORS_ORIGIN` — и он будет.
   */
  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') });
  await app.register(websocket, {
    options: {
      maxPayload: MAX_SIGNAL_MESSAGE_BYTES,
      // Компрессия signaling не нужна: SDP сжимается плохо, а CPU на 1 vCPU
      // лучше потратить на обслуживание соединений.
      perMessageDeflate: false,
    },
  });

  app.get('/healthz', async () => ({
    ok: true,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ...registry.stats(),
    connections: sockets.size,
    protocol: PROTOCOL_VERSION,
  }));

  app.get('/config', async () => ({
    protocol: PROTOCOL_VERSION,
    maxRoomPeers: config.maxRoomPeers,
    iceServers: config.iceServers,
  }));

  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    handleConnection({ socket, req, registry, config, connectLimiter, sockets, clock });
  });

  // ─── Периодика ──────────────────────────────────────────────────────────────

  const keepalive = setInterval(() => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      } else {
        sockets.delete(socket);
      }
    }
  }, SERVER_PING_INTERVAL_MS);
  keepalive.unref?.();

  const sweeper = setInterval(() => {
    registry.sweep(Date.now(), config.roomIdleEvictMs);
    connectLimiter.evictStale(10 * 60_000);
  }, 30_000);
  sweeper.unref?.();

  const close = async (): Promise<void> => {
    clearInterval(keepalive);
    clearInterval(sweeper);
    for (const socket of sockets) {
      try {
        socket.close(WS_CLOSE_NORMAL, 'server-shutdown');
      } catch {
        socket.terminate();
      }
    }
    sockets.clear();
    await app.close();
  };

  return { app, registry, config, close };
}

interface ConnectionCtx {
  socket: WebSocket;
  req: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } };
  registry: RoomRegistry;
  config: ServerConfig;
  connectLimiter: KeyedWindowLimiter;
  sockets: Set<WebSocket>;
  clock?: Clock;
}

function handleConnection(ctx: ConnectionCtx): void {
  const { socket, req, registry, config, connectLimiter, sockets, clock } = ctx;
  sockets.add(socket);

  const ip = clientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress ?? 'unknown');
  if (!connectLimiter.take(ip)) {
    trySend(socket, { t: 'error', code: 'rate-limited', message: ERROR_MESSAGES['rate-limited'], fatal: true });
    socket.close(WS_CLOSE_POLICY, 'rate-limited');
    return;
  }

  const limiter = new TokenBucket({ capacity: config.rateBurst, refillPerSec: config.ratePerSec, clock });

  let peer: Peer | null = null;
  let violations = 0;
  let closed = false;

  const send = (msg: ServerMessage): void => {
    if (closed || socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > config.maxBufferedBytes) {
      // Клиент не читает. Копить дальше — вред для общих ресурсов.
      closed = true;
      sockets.delete(socket);
      socket.close(WS_CLOSE_TRY_LATER, 'slow-consumer');
      return;
    }
    socket.send(encode(msg));
  };

  const fail = (code: ErrorCode, fatal: boolean): void => {
    send({ t: 'error', code, message: ERROR_MESSAGES[code], fatal });
    if (fatal) {
      closed = true;
      sockets.delete(socket);
      socket.close(WS_CLOSE_POLICY, code);
    }
  };

  const teardown = (): void => {
    if (closed && peer === null) return;
    if (peer !== null) {
      const room = peer.room;
      room.remove(peer.id);
      // Задержку вытеснения берём из конфига: со значением по умолчанию
      // пустая комната жила бы минуту и держала память на всех комнатах.
      registry.release(room, config.roomIdleEvictMs);
      broadcast(room, { t: 'peer-left', id: peer.id, reason: 'left' }, peer.id);
      peer = null;
    }
    sockets.delete(socket);
    closed = true;
  };

  const requirePeer = (): Peer => {
    if (peer === null) throw codeError('not-joined', 'сначала нужно присоединиться к комнате');
    return peer;
  };

  /** Адресата, которого нет, просто игнорируем: ответ с ошибкой стал бы оракулом
   *  для перебора идентификаторов пиров. */
  const relay = (room: Room, to: PeerId, msg: ServerMessage): void => {
    room.peers.get(to)?.send(msg);
  };

  const handle = (msg: ClientMessage): void => {
    switch (msg.t) {
      case 'join': {
        if (peer !== null) throw codeError('bad-message', 'уже присоединён к комнате');
        const room = registry.ensure(msg.room, Date.now());
        if (room.isFull) throw codeError('room-full', 'комната заполнена');
        if (room.peers.has(msg.peer.id)) throw codeError('duplicate-id', 'идентификатор уже используется');

        // Список существующих пиров отдаём ДО добавления нового в реестр,
        // чтобы новый участник не увидел сам себя.
        send({
          t: 'welcome',
          self: {
            id: msg.peer.id,
            name: msg.peer.name,
            color: msg.peer.color,
            identityKey: msg.peer.identityKey,
            agreeKey: msg.peer.agreeKey,
          },
          peers: room.others(msg.peer.id),
          protocol: PROTOCOL_VERSION,
          serverTime: Date.now(),
        });

        peer = { ...msg.peer, room, limiter, send, close: (c, r) => socket.close(c, r), joinedAt: Date.now(), sentOffers: 0 };
        room.add(peer);
        broadcast(room, { t: 'peer-joined', peer: toDescriptor(peer) }, peer.id);
        return;
      }

      case 'signal': {
        const from = requirePeer();
        if (msg.to === from.id) return; // защита от петель
        relay(from.room, msg.to, { t: 'signal', from: from.id, kind: msg.kind, sdp: msg.sdp });
        return;
      }

      case 'candidate': {
        const from = requirePeer();
        if (msg.to === from.id) return;
        relay(from.room, msg.to, { t: 'candidate', from: from.id, candidate: msg.candidate });
        return;
      }

      case 'rename': {
        const from = requirePeer();
        from.name = msg.name;
        from.color = msg.color;
        broadcast(from.room, { t: 'renamed', id: from.id, name: msg.name, color: msg.color }, from.id);
        return;
      }

      case 'ping':
        send({ t: 'pong', id: msg.id, at: msg.at, serverTime: Date.now() });
        return;

      case 'leave':
        teardown();
        socket.close(WS_CLOSE_NORMAL, 'left');
        return;
    }
  };

  socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      fail('bad-message', false);
      return;
    }
    if (!limiter.take()) {
      violations++;
      if (violations > MAX_RATE_VIOLATIONS) fail('rate-limited', true);
      else if (violations % 4 === 0) fail('rate-limited', false);
      return;
    }
    try {
      handle(parseClientMessage(textOf(raw)));
    } catch (err) {
      const code = (err as { code?: ErrorCode }).code ?? 'bad-message';
      // Несоответствие версий протокола лечится только переподключением.
      fail(code, code === 'protocol-mismatch' || code === 'room-full' || code === 'duplicate-id');
    }
  });

  socket.on('close', teardown);
  socket.on('error', teardown);
}

function textOf(raw: Buffer | ArrayBuffer | Buffer[]): unknown {
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
  return JSON.parse(text) as unknown;
}

function toDescriptor(peer: Peer): PeerDescriptor {
  return {
    id: peer.id,
    name: peer.name,
    color: peer.color,
    identityKey: peer.identityKey,
    agreeKey: peer.agreeKey,
  };
}

function broadcast(room: Room, msg: ServerMessage, except?: PeerId): void {
  for (const p of room.peers.values()) {
    if (except !== undefined && p.id === except) continue;
    p.send(msg);
  }
}

function trySend(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(encode(msg));
}

function codeError(code: ErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function clientIp(forwarded: string | string[] | undefined, remote: string): string {
  if (typeof forwarded === 'string' && forwarded !== '') {
    const first = forwarded.split(',')[0];
    if (first !== undefined && first.trim() !== '') return first.trim();
  }
  return remote;
}
