import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

import { SIGNALING_HTTP, SIGNALING_WS, SIGNALING_PORT, WEB_PORT, WEB_URL } from './ports.js';

/**
 * Сквозные UI-тесты: signaling + клиент + два браузерных контекста.
 *
 * ─── Почему отдельный пакет ───────────────────────────────────────────────────
 *
 * Playwright нужен только здесь: vitest-модули и e2e используют разные
 * окружения (Node и браузер), разные таймауты и разные артефакты. Смешивать их в
 * одном пакете значит тащить браузерные зависимости туда, где их быть не надо.
 *
 * ─── Порты ────────────────────────────────────────────────────────────────────
 *
 * Свои порты (8790 / 5199), а не 8787 / 5173. Тесты не должны зависеть от того,
 * запустил ли разработчик что-то руками, и не должны ломать его работающий сервер
 * разработки. Переопределяются переменными окружения.
 */

/** Корень монорепо: команды npm workspaces запускаются только отсюда. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Флаги Chromium.
 *
 * `--disable-features=WebRtcHideLocalIpsWithMdns` — главный и неочевидный.
 * По умолчанию Chromium прячет локальные адреса за именами вида
 * `a1b2c3d4-….local` (mDNS). Внутри одной машины это работает, но mDNS-резолвинг
 * зависит от сетевого стека и в CI на разных образцах срабатывает по-разному.
 * С флагом кандидаты содержат настоящий адрес, и пересылка их через signaling
 * работает одинаково везде. Проверено на этой машине: без флага кандидат —
 * `….local`, с флагом — `192.168.0.106`.
 *
 * `--use-fake-device-for-media-stream` и `--use-fake-ui-for-media-stream` —
 * согласие на доступ к устройствам выдаётся сразу, без диалога. Приложению они
 * не нужны: ни камера, ни микрофон оно не запрашивает. Оставлены, потому что
 * без них первый запуск в новом окружении может упереться в системный запрос
 * разрешений, и тест упадёт не на своём.
 *
 * `--autoplay-policy=no-user-gesture-required` — для аудиотестов. Плеер вызывает
 * `play()` по нажатию кнопки, и настоящего жеста Chromium в headless не видит,
 * из-за чего воспроизведение не стартует и пауза не наступает.
 */
const CHROMIUM_ARGS = [
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];

export default defineConfig({
  testDir: './tests',
  /**
   * Один воркер.
   *
   * Каждый тест поднимает две сессии с полным E2EE-рукопожатием (PBKDF2 на
   * 600 000 итераций), и при 4 параллельных тестах Chromium начинает отдавать
   * нестабильные тайминги, а ICE-сбор тем временем упирается в лимиты. Кроме
   * того, все тесты ходят в один signaling-сервер, и параллельная работа с ним
   * добавляет ровно тот класс нестабильности, которого в e2e быть не должно.
   */
  workers: 1,
  fullyParallel: false,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },

  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: { args: CHROMIUM_ARGS },
      },
    },
  ],

  /**
   * Playwright сам поднимает оба сервера и гасит их после прогона.
   *
   * Массив вместо globalSetup/globalTeardown: серверы запускаются параллельно, а
   * teardown делает сам Playwright, включая остановку по Ctrl+C и при падении.
   * Отдельные globalSetup/globalTeardown пришлось бы гордочными крючками
   * закрывать, причём при аварии процесс не отпустил бы дочерние процессы.
   *
   * Готовность signaling проверяется по `/healthz`, а не по «порт от��крылся»:
   * иначе тест успевает подключиться к ещё не поднятому Fastify.
   */
  webServer: [
    {
      command: 'npm run dev:once --workspace @rd/signaling',
      cwd: REPO_ROOT,
      url: `${SIGNALING_HTTP}/healthz`,
      env: {
        PORT: String(SIGNALING_PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        /**
         * STUN выключен намеренно.
         *
         * Тесты не должны зависеть от внешней сети: иначе при её отсутствии они
         * падали бы по таймауту, и причина была бы неочевидна. Пустой список на
         * сервере выбран ещё и потому, что так проверяется ветка «сервер ответил,
         * но ICE не дал» — самая частая в жизни.
         */
        ICE_SERVERS: '',
        /**
         * CORS разрешён для клиента.
         *
         * Именно он нужен, чтобы `GET /config` вообще прошёл: клиент живёт на
         * другом порту, а это для браузера другой источник. Без этого тесты
         * проверяли бы не код, а отказ браузера.
         */
        CORS_ORIGIN: WEB_URL,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      /**
       * `--host 127.0.0.1` обязателен, а не косметика.
       *
       * Без него Vite печатает «Network: use --host to expose» и слушает только
       * `localhost`, который на Windows резолвится в `::1` (IPv6). Проверка
       * готовности ходит на `127.0.0.1` (IPv4) и получает отказ, хотя сервер
       * жив. Тесты падают с «Timed out waiting for webServer», и причина
       * выглядит совсем не так, как есть. На Linux это воспроизводится иначе, и
       * та же самая причина даёт плавающие падения — поэтому адрес указан явно.
       */
      command: `npm run dev --workspace @rd/web -- --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      cwd: REPO_ROOT,
      url: WEB_URL,
      env: {
        VITE_SIGNALING_URL: SIGNALING_WS,
        /**
         * Резервный ICE-сервер выключен: см. выше. Пустое значение означает
         * «не обращаться ни к одному внешнему сервису» — ровно то поведение,
         * которым обладало приложение до этой настройки, так что e2e проверяет
         * прежний, самый строгий режим.
         */
        VITE_ICE_FALLBACK: '',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});