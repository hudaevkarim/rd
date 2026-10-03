/**
 * ICE-конфигурация: получение у signaling-сервера с безопасным откатом.
 *
 * ─── Зачем это нужно ──────────────────────────────────────────────────────────
 *
 * `RoomMesh` создаёт `RTCPeerConnection` с пустым `rtcConfig`. Без STUN браузер
 * знает только локальные адреса, поэтому соединение устанавливается лишь внутри
 * одной сети: два человека в одном Wi-Fi соединятся, а из разных городов — нет,
 * и выглядит это как «приложение не работает» без всякой диагностики.
 *
 * Источник конфигурации — сам signaling-сервер: он уже читает `ICE_SERVERS` из
 * окружения и отдаёт его в `/config`. До этого клиент этот эндпоинт просто не
 * запрашивал, поэтому настройка оператора молча ничего не делала.
 *
 * ─── Откуда берётся fallback ──────────────────────────────────────────────────
 *
 * Если сервер недоступен, ответил ошибкой или вернул пустой список, клиент
 * берёт `VITE_ICE_FALLBACK`. По умолчанию это публичный STUN Google.
 *
 * Это сделано осознанно и требует проговаривания: приложение не заявляет телеметрии,
 * а STUN-сервер по определению видит ваш внешний адрес. Он не получает ни
 * содержимого комнаты, ни ключей (трафик идёт по E2EE), но факт соединения с ним
 * виден ему. Тому, кому это не подходит, достаточно положить
 * `VITE_ICE_FALLBACK=` пустым — приложение продолжит работать на локальных
 * кандидатах, то есть в пределах одной сети.
 *
 * ─── Почему ответ сервера проверяется ─────────────────────────────────────────
 *
 * Ответ приходит из сети и в него можно поверить только после проверки:
 * `new RTCPeerConnection({ iceServers: [...] })` БРОСАЕТ исключение на
 * некорректной конфигурации. То есть один мусорный элемент в ответе не «ухудшает
 * соединение», а роняет вход в комнату целиком. Поэтому элементы без строкового
 * `urls` отбрасываются поштучно, а не отвергается весь ответ.
 */

import type { IceServerConfig } from '@rd/p2p';

/** Откуда взят список ICE-серверов. Для журнала и диагностики. */
export type IceSource = 'server' | 'fallback' | 'deps' | 'none';

export interface IceServersResult {
  iceServers: IceServerConfig[];
  source: IceSource;
  /** Почему ответ сервера не подошёл. Человекочитаемо, для журнала. */
  reason?: string;
}

/**
 * Публичный STUN по умолчанию.
 *
 * Пустая строка означает «не использовать»: приложение останется на локальных
 * кандидатах и не будет обращаться ни к одному внешнему сервису.
 */
const DEFAULT_FALLBACK = 'stun:stun.l.google.com:19302';

/** Сколько ждём `/config`. Вход в комнату не должен зависеть от сервера. */
const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * Адрес конфигурации из адреса signaling.
 *
 * `/config` берётся рядом с `/ws`, а не «корень сайта»: сервер не обязательно
 * стоит в корне домена, и при развёртывании под префиксом (`wss://example.com/rd/ws`)
 * запрос ушёл бы не туда. Именно поэтому здесь не `new URL('/config', base)`:
 * такой вызов всегда сбрасывает путь до корня.
 */
export function configUrlFromSignaling(signalingUrl: string): string {
  const ws = /^(wss?):\/\//.exec(signalingUrl);
  if (ws === null) return '';
  // ws → http, wss → https: это тот же сервер, только другой протокол.
  const scheme = ws[1] === 'wss' ? 'https' : 'http';
  const rest = signalingUrl.slice(ws[0].length);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);
  const withoutWs = path.replace(/\/ws\/?$/, '');
  return `${scheme}://${host}${withoutWs}/config`;
}

/**
 * Отбор корректных элементов `iceServers`.
 *
 * Возвращает только то, что `RTCPeerConnection` примет: у каждого элемента
 * обязательно есть непустой `urls` — строка или массив строк. Остальное
 * отбрасывается: сервер может вернуть что угодно, а падать здесь нельзя.
 */
export function sanitizeIceServers(raw: unknown): IceServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: IceServerConfig[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = normalizeUrls(entry.urls);
    if (urls === null) continue;
    const server: IceServerConfig = { urls };
    // Креды есть только у TURN. Строковые значения обязательны: числовое
    // `credential` браузер примет, а наш доступ к нему — нет.
    if (typeof entry.username === 'string' && entry.username !== '') server.username = entry.username;
    if (typeof entry.credential === 'string' && entry.credential !== '') server.credential = entry.credential;
    out.push(server);
  }
  return out;
}

function normalizeUrls(raw: unknown): string | string[] | null {
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw;
  if (Array.isArray(raw)) {
    const urls = raw.filter((u): u is string => typeof u === 'string' && u.trim() !== '');
    return urls.length === 0 ? null : urls;
  }
  return null;
}

/** Список из `VITE_ICE_FALLBACK`: либо список URL, либо `''`. */
export function parseFallback(raw: string | undefined): IceServerConfig[] {
  const value = (raw ?? DEFAULT_FALLBACK).trim();
  if (value === '') return [];
  // Несколько серверов через запятую — тот же формат, что у ICE_SERVERS на
  // сервере, чтобы правило не приходилось запоминать дважды.
  const urls = value
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u !== '');
  return urls.length === 0 ? [] : [{ urls }];
}

export interface LoadIceOptions {
  signalingUrl: string;
  /** Подменяется в тестах: по умолчанию `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Куда брать fallback. `undefined` — из `VITE_ICE_FALLBACK`. */
  fallback?: IceServerConfig[];
  timeoutMs?: number;
}

/**
 * Достаёт ICE-конфигурацию. НИКОГДА не бросает исключение.
 *
 * Вход в комнату не должен зависеть от доступности сервера конфигурации: без
 * STUN приложение всё равно соединится внутри одной сети. Поэтому любая
 * неудача — это fallback и запись причины, а не ошибка входа.
 */
export async function loadIceServers(opts: LoadIceOptions): Promise<IceServersResult> {
  const fallback = opts.fallback ?? parseFallback(import.meta.env['VITE_ICE_FALLBACK'] as string | undefined);
  const fallbackResult: IceServersResult = { iceServers: fallback, source: 'fallback' };
  if (fallback.length === 0) fallbackResult.source = 'none';

  const url = configUrlFromSignaling(opts.signalingUrl);
  if (url === '') return { ...fallbackResult, reason: ' signaling-URL не распознан' };

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ...fallbackResult, reason: 'в этой среде нет fetch' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) return { ...fallbackResult, reason: `сервер ответил ${response.status}` };
    const body: unknown = await response.json();
    const servers = sanitizeIceServers((body as { iceServers?: unknown } | null)?.iceServers);
    // Пустой ответ — тоже ответ: оператор мог решить, что ICE не нужен.
    if (servers.length === 0) return { ...fallbackResult, reason: 'сервер не вернул ICE-серверов' };
    return { iceServers: servers, source: 'server' };
  } catch (error) {
    return { ...fallbackResult, reason: `запрос не удался: ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}