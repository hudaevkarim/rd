/**
 * Порты и адреса, которыми пользуются и конфигурация, и тесты.
 *
 * Отдельный файл, а не константы в `playwright.config.ts`: тестам нужно знать
 * адрес signaling-сервера, чтобы проверить, что клиент к нему обращается, а
 * конфигурация — чтобы поднять сервер. Дублировать числа в двух местах означало
 * бы, что смена порта в одном месте тихо ломает проверку в другом.
 *
 * Файл лежит вне `testDir` намеренно: Playwright не должен считать его
 * тестовым файлом.
 */

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const SIGNALING_PORT = num('RD_E2E_SIGNALING_PORT', 8790);
export const WEB_PORT = num('RD_E2E_WEB_PORT', 5199);

export const SIGNALING_HTTP = `http://127.0.0.1:${SIGNALING_PORT}`;
export const SIGNALING_WS = `ws://127.0.0.1:${SIGNALING_PORT}/ws`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/** Тот же вывод адреса, что делает клиент: ws→http, хвост /ws→/config. */
export function configUrl(): string {
  return `${SIGNALING_HTTP}/config`;
}