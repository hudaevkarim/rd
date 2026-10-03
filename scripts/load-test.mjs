/**
 * Обёртка нагрузочного теста signaling-сервера.
 *
 * ─── Что делает ────────────────────────────────────────────────────────────────
 *
 *   1. Поднимает signaling-сервер на свободном порту с ослабленными лимитами
 *      подключений (см. ниже — почему).
 *   2. Замеряет исходное состояние процесса: CPU и RSS в покое.
 *   3. Прогревает сервер коротким запросом `/healthz` и небольшим k6-прогоном,
 *      чтобы JIT и пулы соединений прогрелись. Без прогрева первые измерения
 *      показывают время компиляции, а не работу сервера.
 *   4. Запускает k6, параллельно снимая метрики процесса и `/healthz`.
 *   5. Для проверки на утечки повторяет цикл несколько раз и сравнивает RSS
 *      между циклами.
 *   6. Гасит сервер и пишет отчёт в JSON.
 *
 * ─── Почему лимиты подключений ослаблены ───────────────────────────────────────
 *
 * `CONNECT_PER_MIN` считается ПО IP, а генератор на localhost приходит с
 * 127.0.0.1 — то есть все соединения делят один адрес. При продуктовых 30
 * подключениях в минуту с одного адреса нагрузка упёрлась бы в лимит на
 * тридцатом соединении, и мы бы измеряли не сервер, а rate limiter.
 *
 * Это заодно означает, что продуктовый лимит нужно поднимать: за одним
 * публичным IP (офис, оператор, общежитие) сидят десятки участников. См. README.
 *
 * ─── Про измерения на одной машине ─────────────────────────────────────────────
 *
 * Сервер и генератор здесь делят ядра. Все числа локальные и это верхняя
 * граница нагрузки на процесс, а не «сколько выдержит VPS». Для честных цифр
 * нужен отдельный генератор (или хотя бы ограничение ядер) — команды в README.
 *
 * ─── Запуск ────────────────────────────────────────────────────────────────────
 *
 *   node scripts/load-test.mjs                     # ступенчатая нагрузка
 *   node scripts/load-test.mjs --stage ratelimit   # проверка лимитов
 *   node scripts/load-test.mjs --cycles 3          # три цикла для проверки утечек
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const STAGE = arg('stage', 'ramp');
const CYCLES = Number(arg('cycles', STAGE === 'leak' ? 3 : 1));
const OUT = resolve(arg('out', join(ROOT, 'reports', `load-${STAGE}.json`)));
/**
 * Ищет исполняемый файл k6.
 *
 * На Windows k6 ставится не в PATH, а в каталог пользователя, и запуск
 * `npm run test:load` падал бы с «k6 не найден» при полностью установленном
 * инструменте. Поэтому: сначала явный K6_BIN, потом PATH, потом стандартные
 * места установки.
 */
function findK6() {
  if (process.env.K6_BIN) return process.env.K6_BIN;
  const exe = process.platform === 'win32' ? 'k6.exe' : 'k6';
  const local = process.env.LOCALAPPDATA ?? join(os.homedir(), '.local', 'share');
  const candidates = [
    join(local, 'k6'),
    join(local, 'Microsoft', 'WinGet', 'Links', exe),
    '/usr/local/bin/k6',
    '/usr/bin/k6',
    join(os.homedir(), 'go', 'bin', exe),
  ];
  // Внутри каталога установки бинарник лежит в подкаталоге с версией.
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    if (existsSync(join(dir, exe))) return join(dir, exe);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const inner = join(dir, entry.name, exe);
      if (existsSync(inner)) return inner;
    }
  }
  return 'k6';
}

const K6 = findK6();

/**
 * План нагрузки. Тот же список уходит в k6 (см. STAGES в сценарии), поэтому
 * таблица в отчёте и фактический прогон не могут разойтись.
 *
 * Профиль `default` — ступени из задания. Профиль `deep` добавляет 1000 и 2000:
 * при 500 соединениях сервер не напрягался, и точка деградации находится дальше.
 */
const PROFILES = {
  default: '15:50,15:100,15:200,30:500,10:0',
  deep: '15:50,15:100,15:200,20:500,20:1000,30:2000,10:0',
};
const STAGES = arg('stages', PROFILES[arg('profile', 'default')] ?? PROFILES.default);

/**
 * Сколько живёт соединение, мс.
 *
 * Параметр важнее, чем кажется. Короткое удержание означает частые переподключения,
 * а они упираются в `CONNECT_PER_MIN` — лимит подключений ПО IP, который для
 * локального генератора равен 10 000 в минуту. При удержании 3 с на 2000 VU
 * получается около 100 000 попыток, и «деградация» оказывается работой этого
 * лимита: 374 тысячи отказов и никакого вывода о сервере.
 *
 * Поэтому для глубокого профиля соединение держится долго: попыток выходит
 * порядка двух тысяч в минуту, и лимит перестаёт быть ограничителем.
 */
const HOLD_MS = arg('hold', STAGES.includes(':2000') ? '25000' : '3000');

/** Границы ступеней в секундах от старта прогона k6. */
function stageWindows(spec) {
  const out = [];
  let at = 0;
  for (const part of spec.split(',')) {
    const [dur, target] = part.split(':');
    const seconds = Number(dur);
    out.push({ at, seconds, target: Number(target) });
    at += seconds;
  }
  return out;
}

// ─── Порт ──────────────────────────────────────────────────────────────────────

/** Свободный порт: фиксированный занимался бы прошлым прогоном или чужим процессом. */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// ─── Метрики процесса ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * CPU и RSS процесса signaling-сервера.
 *
 * Кроссплатформенно и без внешних утилит: на Linux читаем `/proc`, на Windows
 * WMI. Отдельно важно, что это CPU ИМЕННО ПРОЦЕССА, а не всей машины: под
 * нагрузкой генератор тоже грузит ядра, и «процент от всех ядер» показывал бы
 * в основном работу k6.
 */
class ProcessProbe {
  #pid;
  #lastCpu = { cpu: 0, at: 0 };

  constructor(pid) {
    this.#pid = pid;
  }

  async read() {
    const cpu = await this.#cpu();
    const rss = await this.#rss();
    return { at: Date.now(), cpuPercent: cpu, rssMb: rss };
  }

  async #cpu() {
    const now = Date.now();
    try {
      if (process.platform === 'linux') {
        // /proc даёт готовые тики ядра и процессора с момента старта.
        const stat = await readFile(`/proc/${this.#pid}/stat`);
        const parts = stat.split(' ');
        const ticks = Number(parts[13]) + Number(parts[14]);
        const hz = 100; // sysconf(_SC_CLK_TCK) на практике всегда 100
        const prev = this.#lastCpu;
        if (prev.cpu > 0 && now > prev.at) {
          const pct = ((ticks - prev.cpu) / hz / ((now - prev.at) / 1000)) * 100;
          this.#lastCpu = { cpu: ticks, at: now };
          return Math.max(0, Math.min(100 * os.cpus().length, pct));
        }
        this.#lastCpu = { cpu: ticks, at: now };
        return 0;
      }
      // Windows: `p.CPU` — суммарное время процесса по всем ядрам в секундах.
      // Прирост за интервал, делённый на время, даёт «процент от одного ядра»,
      // что сопоставимо с Linux-версией.
      const sample = await this.#windowsSample();
      const now2 = Date.now();
      const prev = this.#lastCpu;
      this.#lastCpu = { cpu: sample.cpuSeconds, at: now2 };
      if (!Number.isFinite(sample.cpuSeconds) || prev.cpu <= 0 || now2 <= prev.at) return 0;
      const pct = ((sample.cpuSeconds - prev.cpu) / ((now2 - prev.at) / 1000)) * 100;
      return Math.max(0, Math.min(100 * os.cpus().length, pct));
    } catch {
      return 0;
    }
  }

  async #rss() {
    try {
      if (process.platform === 'linux') {
        const status = await readFile(`/proc/${this.#pid}/status`);
        const m = /VmRSS:\s+(\d+) kB/.exec(status);
        return m ? Number(m[1]) / 1024 : 0;
      }
      const sample = await this.#windowsSample();
      return sample.workingSet / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  /**
   * Оба значения Windows за ОДИН вызов PowerShell.
   *
   * Раньше CPU и память брались двумя отдельными вызовами, то есть в разные
   * моменты и с удвоенным числом процессов PowerShell: при сэмплировании раз в
   * секунду это заметная нагрузка на саму измеряемую машину. Заодно значения
   * относятся к одному моменту, что делает их согласованными.
   */
  async #windowsSample() {
    const out = await ps(
      `$p=Get-Process -Id ${this.#pid} -ErrorAction SilentlyContinue;if($p){"$($p.CPU)|$($p.WorkingSet64)"}`,
    );
    const [cpu, ws] = out.split('|');
    return { cpuSeconds: Number(cpu), workingSet: Number(ws) };
  }
}

async function readFile(path) {
  const { readFile: rf } = await import('node:fs/promises');
  return rf(path, 'utf8');
}

const POWERSHELL = 'powershell.exe';

function ps(script) {
  return new Promise((res) => {
    const p = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => res(out.trim()));
    p.on('error', () => res(''));
  });
}

// ─── Сервер ────────────────────────────────────────────────────────────────────

/**
 * Запускает signaling-сервер и ждёт готовности.
 *
 * Готовность проверяется по `/healthz`, а не по «порт слушает»: иначе первый
 * запрос может уйти в ещё не поднявшийся Fastify и дать обрыв, который
 * выглядел бы как ошибка сервера.
 */
async function startServer(port) {
  const child = spawn('npm.cmd', ['run', 'dev:once', '--workspace', '@rd/signaling'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: process.env.RD_LOAD_LOG_LEVEL || 'warn',
      // Лимит подключений по IP поднят до потолка, который допускает сам сервер
      // (валидатор ограничивает CONNECT_PER_MIN сверху 10000): см. пояснение в
      // начале файла.
      CONNECT_PER_MIN: '10000',
      CONNECT_BURST: '10000',
      // Комнаты живут недолго, чтобы память возвращалась между циклами.
      ROOM_IDLE_EVICT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    // Своя группа процессов: на POSIX это позволяет снять потомка целиком.
    detached: process.platform !== 'win32',
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const pid = await findPidByPort(port);
        if (pid === null) throw new Error(`не нашёл процесс, слушающий порт ${port}`);
        return { child, base, logs, pid };
      }
    } catch (err) {
      // Ещё не поднялся либо порт ещё не виден в списке соединений.
      if (String(err).includes('не нашёл процесс')) throw err;
    }
  }
  await stopServer(child);
  throw new Error(`сервер не поднялся за 60 с:\n${logs.join('')}`);
}

/**
 * PID процесса, который СЛУШАЕТ наш порт.
 *
 * Сервер запускается через `shell: true`, поэтому `child.pid` — это cmd.exe, а
 * не сам сервер. Замер CPU и памяти cmd.exe даёт бесполезные ~5 МБ и ноль
 * процентов, и вывод выглядит правдоподобно: «память не растёт, значит утечек
 * нет». На самом деле просто измерялся не тот процесс.
 *
 * Владелец слушающего сокета — это и есть сервер, поэтому ищем его по порту.
 */
async function findPidByPort(port) {
  if (process.platform === 'win32') {
    const out = await ps(`netstat -ano | Select-String ':${port}\\s+.*LISTENING'`);
    const m = /(\d+)\s*$/.exec(out.trim());
    return m ? Number(m[1]) : null;
  }
  const out = await sh(`ss -lptnH "sport = :${port}" 2>/dev/null || true`);
  const m = /pid=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

function sh(cmd) {
  return new Promise((res) => {
    const p = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => res(out));
    p.on('error', () => res(''));
  });
}

/**
 * Останавливает сервер ВМЕСТЕ со всем его потомком.
 *
 * Сервер запускается через `shell: true` (npm.cmd — это пакетный файл), и
 * `child.kill()` на Windows убивает только cmd.exe. Потомок node продолжает
 * жить, держит открытыми пайпы stdout/stderr, из-за чего event loop Node не
 * завершается и скрипт «висит» уже после того, как всё отработало. Побочный
 * эффект тот же — осиротевшие серверы на случайных портах, которые следующий
 * прогон может принять за свои.
 *
 * Поэтому на Windows дерево процесса снимается через taskkill /T, а на POSIX
 * группа процессов убивается целиком.
 */
async function stopServer(child) {
  if (child === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((res) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      });
      killer.on('close', res);
      killer.on('error', res);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (child.exitCode !== null) return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Процесс уже исчез — это желаемый исход.
  }
}

// ─── Сэмплирование ─────────────────────────────────────────────────────────────

/**
 * Снимает метрики раз в `intervalMs` до остановки.
 *
 * `/healthz` идёт параллельно с замером процесса: сколько соединений сервер
 * держит — это единственный источник правды о том, что он действительно
 * обслуживает, а не что насчитал генератор.
 */
function startSampling(probe, base, intervalMs) {
  const samples = [];
  let stop = false;
  const loop = async () => {
    while (!stop) {
      const proc = await probe.read();
      let health = null;
      try {
        const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) health = await r.json();
      } catch {
        // Сервер может не отвечать в момент деградации — это само по себе
        // важный признак, поэтому молча фиксируем null и продолжаем.
      }
      samples.push({
        at: proc.at,
        cpuPercent: Number(proc.cpuPercent.toFixed(1)),
        rssMb: Number(proc.rssMb.toFixed(1)),
        connections: health === null ? null : health.connections,
        rooms: health === null ? null : health.rooms,
        peers: health === null ? null : health.peers,
      });
      await sleep(intervalMs);
    }
  };
  void loop();
  return {
    samples,
    /** Останавливает сэмплирование и дожидается, чтобы текущая итерация дошла. */
    async stop() {
      stop = true;
      await sleep(intervalMs * 2);
    },
  };
}

// ─── k6 ────────────────────────────────────────────────────────────────────────

function runK6(script, wsUrl, outFile, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const args = [
      'run',
      '--quiet',
      '--no-color',
      script,
      '--out',
      'json=' + outFile,
      '--env',
      `WS_URL=${wsUrl}`,
      '--env',
      `STAGE=${STAGE}`,
    ];
    for (const [k, v] of Object.entries(extraEnv)) args.push('--env', `${k}=${v}`);
    args.push('--env', `STAGES=${STAGES}`);
    const child = spawn(K6, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, K6_WS_CONNECTIONS: '1500' } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolvePromise({ code, out }));
    child.on('error', (e) => resolvePromise({ code: -1, out: String(e) }));
  });
}

/**
 * Сводка из JSON-выгрузки k6.
 *
 * Файл читается ПОТОКОМ построчно, а не целиком. На 2000 VU выгрузка занимает
 * сотни мегабайт, и `readFileSync` в строку падает по лимиту длины строки V8
 * (0x1fffffe8 символов) — то есть ровно на том прогоне, ради которого всё и
 * затевалось.
 *
 * Метрики в JSON — поток точек, а не готовые числа; распределения и процентили
 * считаются здесь. Это же единственный способ получить те же цифры, что в
 * HTML-отчёте, без его разбора.
 */
async function summarizeK6(path) {
  const interest = new Set([
    'ws_connecting',
    'ws_session_duration',
    'ws_sessions',
    'ws_msgs_sent',
    'ws_msgs_received',
    'rd_welcome_latency',
    'rd_pong_latency',
    'rd_welcomed',
    'rd_relayed',
    'rd_unexpected_error',
    'rd_room_full',
    'rd_duplicate_id',
    'rd_connect_failed',
    'rd_rate_limited',
    'rd_rate_limited_fatal',
    'rd_expect_fatal',
    'rd_expect_non_fatal',
  ]);
  const byMetric = new Map();
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.length === 0 || !interest.has(metricNameOf(line))) continue;
    let p = null;
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    // В JSON-выгрузке k6 встречаются точки без `data.value`: у Rate там
    // `data.passes`/`data.fails`, у части метрик значение просто отсутствует.
    // Такие точки не имеют смысла считать.
    const value = p?.data?.value;
    if (typeof value !== 'number') continue;
    if (!byMetric.has(p.metric)) byMetric.set(p.metric, { points: [] });
    byMetric.get(p.metric).points.push(value);
  }

  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  const pct = (s, q) => {
    if (s.length === 0) return null;
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((q / 100) * s.length) - 1));
    return Number(s[idx].toFixed(2));
  };

  const out = {};
  for (const m of interest) {
    const e = byMetric.get(m);
    if (e === undefined) continue;
    const s = sorted(e.points);
    const total = s.reduce((a, b) => a + b, 0);
    out[m] = {
      count: s.length,
      sum: Number(total.toFixed(2)),
      avg: Number((total / s.length).toFixed(2)),
      p50: pct(s, 50),
      p95: pct(s, 95),
      p99: pct(s, 99),
      max: Number(s[s.length - 1].toFixed(2)),
    };
  }
  return out;
}

/**
 * Имя метрики из строки JSON без разбора всей строки.
 *
 * Строчный поиск позволяет отбросить99 % строк выгрузки (те, что не нужны)
 * до `JSON.parse`: на большом прогоне это разница между секундой и минутами.
 */
function metricNameOf(line) {
  const key = '"metric":"';
  const at = line.indexOf(key);
  if (at < 0) return '';
  const end = line.indexOf('"', at + key.length);
  return end < 0 ? '' : line.slice(at + key.length, end);
}

// ─── Основной прогон ───────────────────────────────────────────────────────────

async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const port = await freePort();
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  console.log(`порт signaling: ${port}`);
  const server = await startServer(port);
  console.log(`процесс сервера: PID ${server.pid}`);
  const probe = new ProcessProbe(server.pid);
  // Первый замер нужен, чтобы вычислить прирост CPU (он считается по разнице).
  await probe.read();

  const restAfterCycles = [];
  const peakPerCycle = [];
  const cycles = [];

  try {
    // Прогрев: JIT, пулы, первые компиляции. Без него первые измерения — это
    // время компиляции, а не работа сервера.
    console.log('прогрев…');
    await runK6(join(ROOT, 'packages/signaling/load/k6-signaling.js'), wsUrl, join(ROOT, 'reports', 'warmup.json'), {
      STAGE: 'warmup',
      HOLD_MS: '400',
    });
    // Прогрев делает два десятка соединений и на лимит подключений по IP
    // практически не влияет (потолок 10 000 в минуту). Сбрасывать его нечем и
    // не нужно: счётчик живёт в памяти сервера, снаружи до него не добраться.
    await sleep(2000);

    const baseline = await probe.read();
    console.log(`исходное состояние: RSS ${baseline.rssMb} МБ`);

    for (let c = 1; c <= CYCLES; c++) {
      console.log(`цикл ${c}/${CYCLES}…`);
      const sampler = startSampling(probe, server.base, 1000);
      const k6Out = join(ROOT, 'reports', `k6-${STAGE}-${c}.json`);
      const started = Date.now();
      const result = await runK6(join(ROOT, 'packages/signaling/load/k6-signaling.js'), wsUrl, k6Out, {
      HOLD_MS,
      IDLE: process.env.RD_LOAD_IDLE === '1' ? '1' : '0',
    });
      const k6EndedAt = Date.now();
      await sleep(1500);
      await sampler.stop();

      // Даём комнатам выветриться и сборщику мусора поработать: иначе память
      // между циклами не сравнить.
      await sleep(Number(arg('cooldown', 12000)));
      const after = await probe.read();

      cycles.push({
        cycle: c,
        durationSec: Math.round((Date.now() - started) / 1000),
        k6ExitCode: result.code,
        k6: await summarizeK6(k6Out),
        stages: bucketByStage(sampler.samples, started, k6EndedAt, STAGES),
        process: {
          cpuAvg: avg(sampler.samples.map((s) => s.cpuPercent)),
          cpuMax: Math.max(0, ...sampler.samples.map((s) => s.cpuPercent)),
          rssStart: first(sampler.samples).rssMb,
          rssPeak: Math.max(0, ...sampler.samples.map((s) => s.rssMb)),
          rssAfter: after.rssMb,
          connectionsPeak: Math.max(0, ...sampler.samples.map((s) => s.connections ?? 0)),
          roomsPeak: Math.max(0, ...sampler.samples.map((s) => s.rooms ?? 0)),
          healthGaps: sampler.samples.filter((s) => s.connections === null).length,
        },
        // Объём журнала сервера: при большом числе подключений логирование
        // способно стать тем самым узким местом, поэтому считается явно, а не
        // «на глаз».
        serverLogLines: server.logs.join('').split('\n').filter((l) => l.trim().length > 0).length,
        samples: sampler.samples,
      });
      restAfterCycles.push(after.rssMb);
      peakPerCycle.push(cycles[c - 1].process.rssPeak);
      console.log(
        `  RSS: старт ${cycles[c - 1].process.rssStart} МБ → пик ${cycles[c - 1].process.rssPeak} МБ → после ${after.rssMb} МБ, пик соединений ${cycles[c - 1].process.connectionsPeak}`,
      );
    }

    const report = {
      generatedAt: new Date().toISOString(),
      stage: STAGE,
      cycles,
      leak: CYCLES > 1 ? assessLeak(peakPerCycle, restAfterCycles) : null,
      environment: {
        platform: `${process.platform} ${process.arch}`,
        node: process.version,
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? 'неизвестно',
        totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
        note:
          'Сервер и генератор на одной машине. Цифры локальные: они показывают нагрузку на процесс, а не пропускную способность VPS.',
      },
    };
    writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\nотчёт: ${OUT}`);

    const failed = cycles.some((c) => c.k6ExitCode !== 0);
    if (failed) console.log('\nВНИМАНИЕ: k6 завершился с ненулевым кодом — пороги не выполнены.');
    if (report.leak !== null) {
      console.log(
        `утечка памяти: ${report.leak.verdict} (рост между циклами ${report.leak.growthMb} МБ)`,
      );
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    await stopServer(server.child);
  }

  // Явный выход, а не ожидание опустошения event loop: после остановки сервера
  // остаются пайпы и таймеры сэмплирования, и процесс иначе продолжал бы жить
  // после успешного завершения работы.
  process.exit(process.exitCode ?? 0);
}

/**
 * Раскладывает сэмплеры по ступеням нагрузки.
 *
 * Без этого в отчёте есть только суммарные числа, а вопрос «где сервер
 * начинает деградировать» требует рядом «соединения → CPU → RAM». Ступени
 * берутся из того же плана, что уходит в k6, поэтому границы совпадают по
 * построению, а не по догадке.
 *
 * Сэмпл относится к ступени по времени от старта ПРОГОНА, а не от старта
 * сэмплирования: сэмплирование включается заранее, иначе первые секунды
 * ступени потерялись бы.
 */
function bucketByStage(samples, k6StartedAt, k6EndedAt, spec) {
  const windows = stageWindows(spec);
  return windows.map((w, i) => {
    const from = k6StartedAt + w.at * 1000;
    // Последняя ступень (сброс к нулю) включает в себя время, пока k6 ещё
    // закрывает соединения, иначе она почти пустая.
    const to = i + 1 < windows.length ? k6StartedAt + (w.at + w.seconds) * 1000 : k6EndedAt + 3000;
    const rows = samples.filter((s) => s.at >= from && s.at <= to);
    if (rows.length === 0) return { target: w.target, samples: 0 };
    // Соединения и CPU усредняем по хвосту ступени: первые секунды ступени —
    // это разгон, а не её поведение.
    const tail = rows.slice(Math.floor(rows.length / 3));
    const use = tail.length > 0 ? tail : rows;
    return {
      target: w.target,
      samples: rows.length,
      connections: avg(use.map((s) => s.connections ?? 0)),
      connectionsPeak: Math.max(...rows.map((s) => s.connections ?? 0)),
      cpuAvg: avg(use.map((s) => s.cpuPercent)),
      cpuMax: Math.max(0, ...rows.map((s) => s.cpuPercent)),
      rssMb: Number((avg(use.map((s) => s.rssMb))).toFixed(1)),
      healthGaps: rows.filter((s) => s.connections === null).length,
    };
  });
}

/**
 * Оценка утечки по динамике RSS между циклами.
 *
 * ─── Почему критерий — рост ПИКА, а не состояния покоя ──────────────────────────
 *
 * Наивная проверка «RSS после циклов равен исходному ±10%» даёт ложную
 * утечку на любом Node: V8 не отдаёт кучу операционной системе сразу, и после
 * цикла под нагрузкой RSS остаётся раздутым до следующего сбора мусора.
 *
 * Но и обратный критерий («RSS растёт от цикла к циклу») неверен: на первом
 * цикле куча вырастает до рабочего объёма и дальше может не уменьшаться, то
 * есть рост состояния покоя объясняется всего лишь временем сборки мусора.
 *
 * Различает их ПИК RSS. Утечка — это растущее рабочее множество, и она
 * проявится в пиках: каждый следующий цикл будет брать больше памяти. Если пики
 * стоят на месте, а растёт только состояние покоя, то память не забывается, а
 * просто не отдана ОС — и это не утечка.
 *
 * Порог 16 МБ на цикл: он заметно больше разброса между одинаковыми циклами
 * (на этой машине — единицы мегабайт) и меньше типичного шага кучи V8.
 */
function assessLeak(peaks, rests) {
  if (peaks.length < 2) return { verdict: 'недостаточно циклов', growthMb: null };
  const firstPeak = peaks[0];
  const lastPeak = peaks[peaks.length - 1];
  const peakGrowth = Number((lastPeak - firstPeak).toFixed(1));
  const restGrowth = Number((rests[rests.length - 1] - rests[0]).toFixed(1));
  return {
    verdict: peakGrowth > 16 ? 'возможна утечка' : 'утечки нет',
    growthMb: peakGrowth,
    peakGrowthMb: peakGrowth,
    restGrowthMb: restGrowth,
    peaksMb: peaks.map((p) => Number(p.toFixed(1))),
    restsMb: rests.map((r) => Number(r.toFixed(1))),
    note:
      'Вердикт по росту ПИКА RSS: утечка означает растущее рабочее множество. ' +
      'Рост состояния покоя при неизменных пиках — это невыполненный сбор мусора V8, а не утечка.',
  };
}

const avg = (a) => (a.length === 0 ? 0 : Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)));
const first = (a) => (a.length === 0 ? { rssMb: 0 } : a[0]);

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});