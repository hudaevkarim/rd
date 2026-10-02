import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Пакеты поставляются как исходники TypeScript, а не собранные артефакты.
// Причина: между пакетами нет публичного API, который менялся бы чаще, чем
// внутренние правки, а сборка каждого пакета отдельно потребовала бы порядка
// сборки и каталога dist в каждом. Vite и Vitest резолвят алиасы напрямую в src.
// Реально собирается только signaling-сервер (ему нужен Node-модуль), и он
// собирается esbuild'ом отдельной командой.
const pkg = (name: string): string => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@rd/protocol': pkg('protocol'),
      '@rd/crypto': pkg('crypto'),
      '@rd/p2p': pkg('p2p'),
      '@rd/library': pkg('library'),
    },
  },
  test: {
    // `.tsx` нужен для тестов компонентов: без DOM не проверить, что текст
    // главы действительно появился на странице.
    include: ['packages/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Один поток: тесты криптографии с PBKDF2 на 600k итераций идут по 0.3–0.6 с
    // каждый, а распараллеливание файлов между воркерами съело бы память на
    // стороне Node. Плюс детерминированный порядок упрощает разбор падений.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
  },
});
