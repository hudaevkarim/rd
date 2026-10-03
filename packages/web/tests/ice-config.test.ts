/**
 * Загрузка ICE-конфигурации у signaling-сервера.
 *
 * ─── Почему тут так много проверок отказа ─────────────────────────────────────
 *
 * Функция не имеет права бросить исключение: она вызывается на входе в комнату,
 * и падение означало бы «не могу войти». При этом отказов здесь четыре
 * принципиально разных, и каждый ведёт себя по-своему:
 *
 *   - сервер недоступен (сеть, сервер не запущен) → fallback;
 *   - сервер ответил ошибкой (404, 500) → fallback;
 *   - ответ не JSON или поле отсутствует → fallback;
 *   - ответ содержит мусор наряду с нормальными элементами → нормальные
 *     оставляем, мусор выбрасываем.
 *
 * Последний случай самый опасный, если его не предусмотреть: `new
 * RTCPeerConnection({ iceServers })` БРОСАЕТ исключение на некорректной
 * конфигурации, то есть один плохой элемент в ответе роняет вход в комнату
 * целиком.
 */

import { describe, expect, it, vi } from 'vitest';
import { configUrlFromSignaling, loadIceServers, parseFallback, sanitizeIceServers } from '../src/ice-config.js';

/** Ответ сервера с заданным `iceServers`. */
function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Ответ сервера с заданным HTTP-кодом. */
function status(code: number): Response {
  return { ok: false, status: code, json: async () => ({}) } as unknown as Response;
}

const FALLBACK = [{ urls: 'stun:fallback.example:3478' }];

describe('адрес конфигурации', () => {
  it('выводится из адреса signaling', () => {
    expect(configUrlFromSignaling('ws://localhost:8787/ws')).toBe('http://localhost:8787/config');
    expect(configUrlFromSignaling('wss://signaling.example/rd/ws')).toBe('https://signaling.example/rd/config');
  });

  it('сохраняет префикс пути, а не сбрасывает его в корень', () => {
    // Сервер не обязательно стоит в корне домена. `new URL('/config', base)`
    // здесь дал бы https://signaling.example/config — мимо сервера.
    expect(configUrlFromSignaling('wss://signaling.example/rd/ws')).toBe('https://signaling.example/rd/config');
    expect(configUrlFromSignaling('ws://localhost:8787/anything/ws')).toBe('http://localhost:8787/anything/config');
  });

  it('переживает отсутствие /ws и хвостовой слеш', () => {
    expect(configUrlFromSignaling('ws://localhost:8787')).toBe('http://localhost:8787/config');
    expect(configUrlFromSignaling('ws://localhost:8787/ws/')).toBe('http://localhost:8787/config');
  });

  it('не выдумывает адрес для не-ws URL', () => {
    // Признак того, что это не наш адрес. Молча превращать его в http значило бы
    // обратиться к произвольному узлу из пользовательской строки.
    expect(configUrlFromSignaling('https://localhost:8787')).toBe('');
    expect(configUrlFromSignaling('')).toBe('');
  });
});

describe('проверка ответа', () => {
  it('оставляет корректные элементы', () => {
    const servers = sanitizeIceServers([
      { urls: 'stun:stun.example:3478' },
      { urls: ['turn:turn.example', 'turns:turns.example'], username: 'u', credential: 'p' },
    ]);
    expect(servers).toHaveLength(2);
    expect(servers[1]).toEqual({
      urls: ['turn:turn.example', 'turns:turns.example'],
      username: 'u',
      credential: 'p',
    });
  });

  it('выбрасывает мусор, не отвергая весь ответ', () => {
    // Ключевое: полезные элементы сохраняются. Отвергнуть весь список из-за
    // одного плохого — значит потерять настройку оператора целиком.
    const servers = sanitizeIceServers([
      null,
      'стур',
      { urls: '' },
      { urls: [] },
      { urls: 42 },
      {},
      { urls: 'stun:ok.example' },
    ]);
    expect(servers).toEqual([{ urls: 'stun:ok.example' }]);
  });

  it('не принимает нестроковые креды', () => {
    // Числовые креды браузер в некоторых случаях примет, а тип у них не тот.
    const servers = sanitizeIceServers([{ urls: 'turn:t.example', username: 7, credential: 8 }]);
    expect(servers[0]).toEqual({ urls: 'turn:t.example' });
  });

  it('возвращает пустой список для не-массива', () => {
    expect(sanitizeIceServers(undefined)).toEqual([]);
    expect(sanitizeIceServers('stun:x')).toEqual([]);
    expect(sanitizeIceServers({ urls: 'stun:x' })).toEqual([]);
  });
});

describe('резервный список', () => {
  it('по умолчанию берётся из VITE_ICE_FALLBACK', () => {
    // В тестовой сборке переменная не задана, поэтому здесь именно умолчание
    // из модуля. Пустое значение означает «внешних серверов не использовать».
    expect(parseFallback(undefined).length).toBeGreaterThan(0);
    expect(parseFallback('stun:a.example,turn:b.example')).toEqual([
      { urls: ['stun:a.example', 'turn:b.example'] },
    ]);
    expect(parseFallback('')).toEqual([]);
    expect(parseFallback('  ')).toEqual([]);
  });
});

describe('загрузка у сервера', () => {
  it('применяет конфигурацию сервера', async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        protocol: 1,
        iceServers: [{ urls: 'stun:stun.example:3478' }],
      }),
    );
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: FALLBACK,
    });
    expect(result.source).toBe('server');
    expect(result.iceServers).toEqual([{ urls: 'stun:stun.example:3478' }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('проверяет конфигурацию, а не берёт её как есть', async () => {
    // Нефильтрованный список сломал бы RTCPeerConnection, а с ним и вход в комнату.
    const fetchImpl = vi.fn(async () => ok({ iceServers: [{ urls: 'stun:ok.example' }, { urls: '' }] }));
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: FALLBACK,
    });
    expect(result.source).toBe('server');
    expect(result.iceServers).toEqual([{ urls: 'stun:ok.example' }]);
  });

  it('при пустом ответе берёт резервный список', async () => {
    // Оператор мог решить, что ICE не нужен, — это законный ответ, а не ошибка.
    const fetchImpl = vi.fn(async () => ok({ protocol: 1, iceServers: [] }));
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: FALLBACK,
    });
    expect(result.source).toBe('fallback');
    expect(result.iceServers).toEqual(FALLBACK);
    expect(result.reason).toContain('не вернул');
  });

  it('при ошибке сети берёт резервный список', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: FALLBACK,
    });
    expect(result.source).toBe('fallback');
    expect(result.iceServers).toEqual(FALLBACK);
    expect(result.reason).toContain('не удался');
  });

  it('при коде ошибки берёт резервный список', async () => {
    const fetchImpl = vi.fn(async () => status(503));
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: FALLBACK,
    });
    expect(result.source).toBe('fallback');
    expect(result.reason).toContain('503');
  });

  it('при мусорном JSON берёт резервный список', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    })) as unknown as typeof fetch;
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl,
      fallback: FALLBACK,
    });
    expect(result.source).toBe('fallback');
    expect(result.iceServers).toEqual(FALLBACK);
  });

  it('при недоступном сервере не падает и не ждёт вечно', async () => {
    // Таймаут обязателен: иначе клиент, у которого signaling ещё поднимается,
    // завис бы на экране входа вместо того, чтобы войти позже.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('прервано по таймауту')));
        }),
    );
    const started = Date.now();
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: FALLBACK,
      timeoutMs: 120,
    });
    expect(result.source).toBe('fallback');
    expect(result.iceServers).toEqual(FALLBACK);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('при пустом резервном списке честно говорит, что серверов нет', async () => {
    // Вариант «ни сервера, ни резерва» обязан отличаться от «взяли fallback»:
    // иначе в журнале будет написано «резервная» при пустом списке.
    const fetchImpl = vi.fn(async () => {
      throw new Error('нет сети');
    });
    const result = await loadIceServers({
      signalingUrl: 'ws://localhost:8787/ws',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: [],
    });
    expect(result.source).toBe('none');
    expect(result.iceServers).toEqual([]);
  });

  it('не ходит в сеть, если адрес signaling нераспознан', async () => {
    const fetchImpl = vi.fn(async () => ok({ iceServers: [{ urls: 'stun:x' }] }));
    const result = await loadIceServers({
      signalingUrl: 'не-url',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fallback: FALLBACK,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback');
    expect(result.reason).toContain('не распознан');
  });
});