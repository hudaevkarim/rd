/**
 * ICE-конфигурация в настоящем браузере.
 *
 * ─── Зачем это, если есть юнит-тесты ──────────────────────────────────────────
 *
 * Юнит-тесты подменяют `fetch` и доказывают, что клиент правильно разбирает
 * ответ. Они не могут доказать две вещи, из-за которых вся схема ломалась:
 *
 *   1. **CORS.** `GET /config` идёт с другого порта, то есть с другого источника.
 *      Без заголовка `Access-Control-Allow-Origin` браузер отбрасывает ответ, и
 *      клиент молча уходит на fallback. Раньше CORS на signaling был выключен по
 *      умолчанию, и эта поломка была невозможна только потому, что клиент
 *      `/config` вообще не запрашивал. Проверяется это из Node, а не из страницы:
 *      headless Chromium для такого запроса не шлёт `Origin`, и в браузере
 *      заголовка просто не видно — проверка была бы vacuous.
 *   2. **Что запрос вообще происходит.** Конфигурация может быть получена,
 *      проигнорирована и применена где угодно — вплоть до того, что её выкинут
 *      по дороге. Здесь проверяется сам факт обращения со стороны приложения.
 *
 * Внешние STUN в тестах выключены намеренно (см. playwright.config.ts), поэтому
 * ответ содержит пустой список и срабатывает ветка «сервер ответил, но ICE не
 * дал» — самая частая в жизни.
 */

import { expect, test } from '@playwright/test';

import { joinRoom, roomId } from './fixtures/app.js';
import { configUrl, WEB_URL } from '../ports.js';

test.describe('ICE-конфигурация в браузере', () => {
  test('клиент запрашивает конфигурацию у signaling-сервера при входе в комнату', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/config')) requested.push(request.url());
    });

    await joinRoom(page, { mode: 'create', roomId: roomId(), name: 'Аня' });

    // Ждать придётся не мгновенно: конфигурация запрашивается при создании
    // сессии, а до неё ещё выводится ключ комнаты (PBKDF2).
    await expect
      .poll(() => requested.length, { timeout: 20_000, message: 'клиент не запросил /config' })
      .toBeGreaterThan(0);
    expect(requested[0]).toBe(configUrl());
  });

  test('конфигурация доступна и разбирается клиентом', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url);
        const body: unknown = await response.json();
        return {
          ok: response.ok,
          status: response.status,
          iceServers: (body as { iceServers?: unknown } | null)?.iceServers,
        };
      } catch (error) {
        return { failed: (error as Error).message };
      }
    }, configUrl());

    expect(result.failed).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    // Форма ответа совпадает с тем, что ждёт клиент.
    expect(Array.isArray(result.iceServers)).toBe(true);
    // В тестах внешние серверы выключены, поэтому список пуст.
    expect(result.iceServers).toEqual([]);
  });

  test('заголовок CORS есть, когда клиент шлёт Origin', async ({ request }) => {
    // Проверяется из Node, а не из страницы: Chromium в headless не шлёт `Origin`
    // для этого запроса, поэтому в браузере заголовка не видно, и проверка была бы
    // vacuous. Именно наличие заголовка при запрошенном Origin — то, что нужно
    // кросс-доменному клиенту.
    const response = await request.get(configUrl(), { headers: { origin: WEB_URL } });
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBeTruthy();
  });

  test('при недоступной конфигурации вход в комнату всё равно удаётся', async ({ page }) => {
    // Клиент получит сетевую ошибку и обязан войти на локальных кандидатах.
    // Отказ здесь означал бы «не могу войти» — худший возможный исход.
    await page.route('**/config', (route) => route.abort('failed'));
    await joinRoom(page, { mode: 'create', roomId: roomId(), name: 'Аня' });
    await expect(page.getByTestId('library-panel')).toBeVisible();
    await expect(page.getByTestId('room-status')).toContainText('на связи', { timeout: 30_000 });
  });
});