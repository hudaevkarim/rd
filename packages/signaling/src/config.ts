/**
 * Конфигурация signaling-сервера. Только через переменные окружения,
 * без конфиг-файлов и без внешних сервисов.
 *
 * Все значения валидируются при старте: сервер, который не смог прочитать
 * конфигурацию, должен упасть громко и сразу, а не работать «наполовину
 * защищённым».
 */

import {
  DEFAULT_CONNECT_PER_MIN,
  DEFAULT_RATE_PER_MIN,
  DEFAULT_RATE_PER_SEC,
  MAX_ROOM_PEERS,
  ROOM_IDLE_EVICT_MS,
} from '@rd/protocol';

export interface ServerConfig {
  host: string;
  port: number;
  /** Публичный адрес для логов и healthz. */
  publicUrl: string;
  maxRoomPeers: number;
  /** Токенов в секунду на одно WS-соединение. */
  ratePerSec: number;
  /** Ёмкость пачки токенов на одно WS-соединение. */
  rateBurst: number;
  connectPerMin: number;
  connectBurst: number;
  /** Порог отложенной отправки, после которого соединение рвётся (байт). */
  maxBufferedBytes: number;
  roomIdleEvictMs: number;
  /**
   * Разрешённые источники для CORS.
   *
   * `*` — любой источник. Ограничивать нечего: WebSocket-эндпоинт всё равно
   * открыт любому сайту, а `/config` без CORS недоступен клиенту с другого
   * домена, и тот молча остался бы без STUN.
   */
  corsOrigin: string;
  logLevel: string;
  /** ICE-серверы, которые клиенту понадобятся для NAT-траверса. */
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}: ожидалось целое от ${min} до ${max}, получено "${raw}"`);
  }
  return value;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/**
 * Значение переменной как есть, включая пустое.
 *
 * Отдельный метод нужен там, где пустая строка — осмысленное значение, а не
 * «не задано». Для `ICE_SERVERS` это ровно такой случай: оператор хочет, чтобы
 * клиент вообще не обращался к внешним серверам. Через `str` такой запрос
 * невозможен — пустое значение молча превращалось в умолчание, и ветка
 * «пусто → пустой список» была недостижимой. То есть задокументированный в
 * `.env.example` способ отключить ICE не работал.
 */
function rawStr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

/**
 * ICE-серверы. По умолчанию — только публичный STUN от Cloudflare.
 *
 * TURN здесь НЕ прописан намеренно: TURN — это сервер, который видит ваш
 * шифротекст и метаданные (IPs, тайминги, объём). Для приложения, где вся
 * ценность в приватности, выбор TURN-провайдера должен быть явным решением
 * оператора, а не значением по умолчанию. Задайте ICE_SERVERS, если нужен.
 *
 * Формат: JSON-массив либо список URL через запятую. Поддержка обоих вариантов
 * не избыточность — иначе переменная, заданная «человеческим» способом
 * (`stun:a,turn:b`), валила бы сервер на старте.
 */
function iceServers(): ServerConfig['iceServers'] {
  const raw = rawStr('ICE_SERVERS', 'stun:stun.cloudflare.com:3478').trim();
  if (raw === '') return [];
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('ожидался массив');
      return parsed as ServerConfig['iceServers'];
    } catch (err) {
      throw new Error(`ICE_SERVERS: некорректный JSON (${(err as Error).message})`);
    }
  }
  // Список URL. Креды, если они есть, задаются JSON-формой.
  return raw.split(',').map((url) => ({ urls: url.trim() })).filter((s) => s.urls !== '');
}

export function loadConfig(): ServerConfig {
  const port = num('PORT', 8787, 1, 65_535);
  const host = str('HOST', '0.0.0.0');
  return {
    host,
    port,
    publicUrl: str('PUBLIC_URL', `http://localhost:${port}`),
    maxRoomPeers: num('MAX_ROOM_PEERS', MAX_ROOM_PEERS, 2, 64),
    ratePerSec: num('RATE_PER_SEC', DEFAULT_RATE_PER_SEC, 1, 1000),
    rateBurst: num('RATE_BURST', DEFAULT_RATE_PER_SEC * 3, 1, 10_000),
    connectPerMin: num('CONNECT_PER_MIN', DEFAULT_CONNECT_PER_MIN, 1, 10_000),
    connectBurst: num('CONNECT_BURST', DEFAULT_CONNECT_PER_MIN, 1, 10_000),
    maxBufferedBytes: num('MAX_BUFFERED_BYTES', 512 * 1024, 4096, 16 * 1024 * 1024),
    roomIdleEvictMs: num('ROOM_IDLE_EVICT_MS', ROOM_IDLE_EVICT_MS, 0, 3_600_000),
    corsOrigin: str('CORS_ORIGIN', '*'),
    logLevel: str('LOG_LEVEL', 'info'),
    iceServers: iceServers(),
  };
}
