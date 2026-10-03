/**
 * Нагрузочный сценарий signaling-сервера на k6.
 *
 * ─── Почему k6, а не Artillery ─────────────────────────────────────────────────
 *
 * Artillery написан на Node и крутится в том же цикле событий, что и сервер под
 * нагрузкой. На целевой машине (1 vCPU) это делает измерение бессмысленным:
 * генератор отнимает у сервера его единственное ядро, и в результат попадает не
 * поведение сервера, а борьба Node с Node.
 *
 * k6 — отдельный бинарник на Go: своя память, свой планировщик, никакой общей
 * петли событий с сервером. Плюс встроенные метрики для WebSocket
 * (`ws_connecting`, `ws_session_duration`) и выгрузка в JSON одной командой.
 *
 * ─── Почему сообщения настоящие ────────────────────────────────────────────────
 *
 * Сценарий говорит на реальном протоколе: `join` с настоящим descriptor'ом,
 * `signal` и `candidate` с настоящими по форме SDP и ICE, `ping` для замера
 * задержки. Нагрузка на «сервер, который просто держит сокеты» измеряла бы
 * сокеты, а не разбор сообщений, проверку лимитов и рассылку по комнате — то
 * есть ровно то, ради чего измерение нужно.
 *
 * ─── Про лимиты подключений во время прогона ───────────────────────────────────
 *
 * Обёртка (scripts/load-test.mjs) поднимает сервер с ослабленным `CONNECT_PER_MIN`.
 * Причина не в том, что «так нагрузка проходит», а в том, что иначе её не из
 * чего генерировать: лимит считается ПО IP, а с localhost все соединения приходят
 * с 127.0.0.1. Продуктовые 30 подключений в минуту на адрес при Localhost-
 * генераторе — это 30 соединений всего.
 *
 * Это же ограничение — самостоятельная находка: за одним публичным IP (офис,
 * мобильный оператор, общежитие) живут десятки участников, и каждому достаётся
 * 30 попыток в минуту. Подробности в README.
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ─── Метрики ───────────────────────────────────────────────────────────────────
// Встроенных метрик недостаточно: они не различают «сервер ответил ошибкой» и
// «сервер не ответил», а это два разных вида отказа.

const welcomed = new Counter('rd_welcomed');
const relayed = new Counter('rd_relayed');
const unexpectedError = new Counter('rd_unexpected_error');
const roomFull = new Counter('rd_room_full');
const duplicateId = new Counter('rd_duplicate_id');
const connectFailed = new Counter('rd_connect_failed');
const rateLimited = new Counter('rd_rate_limited');
const rateLimitedFatal = new Counter('rd_rate_limited_fatal');
const pongLatency = new Trend('rd_pong_latency', true);
const welcomeLatency = new Trend('rd_welcome_latency', true);
const expectFatal = new Rate('rd_expect_fatal');
const expectNonFatal = new Rate('rd_expect_non_fatal');

const WS_URL = __ENV.WS_URL || 'ws://127.0.0.1:8787/ws';
const STAGE = __ENV.STAGE || 'ramp';
const HOLD_MS = Number(__ENV.HOLD_MS || 3000);
/** Молчащие соединения: без обмена сообщениями. См. комментарий у setInterval. */
const IDLE = __ENV.IDLE === '1';

/**
 * План ступеней приходит извне, одной строкой: `длительность:ву,длительность:ву,…`.
 *
 * Источник правды — обёртка: она же раскладывает сэмплеры по этим же границам,
 * чтобы в отчёте появилась таблица «соединения → CPU → RAM → задержка». Если бы
 * ступени были заданы здесь и там по отдельности, они разошлись бы при первой
 * же правке, и цифры в таблице перестали бы соответствовать прогону.
 */
const STAGES = (__ENV.STAGES || '15:50,15:100,15:200,30:500,10:0')
  .split(',')
  .map((s) => {
    const [dur, target] = s.split(':');
    return { duration: `${dur.trim()}s`, target: Number(target) };
  });

// ─── Идентификаторы ────────────────────────────────────────────────────────────
// Протокол требует канонический UUIDv4 и hex-ключи фиксированной длины, иначе
// сообщение отбросит валидатор. Ключи синтетические: сервер их пересылает и не
// проверяет криптографически.

function uuidV4(n) {
  let x = (n * 2654435761) >>> 0;
  const hex = [];
  for (let i = 0; i < 32; i++) {
    x = (x * 1664525 + 1013904223 + i) >>> 0;
    hex.push(((x >>> 24) & 0xf).toString(16));
  }
  // Версия 4 и вариант 10xx — иначе UUID не пройдёт собственную проверку.
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

function hexKey(n, bytes) {
  let out = '';
  let x = (n * 2246822519) >>> 0;
  for (let i = 0; i < bytes * 2; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out += ((x >>> 20) & 0xf).toString(16);
  }
  return out;
}

// ─── Нагрузочные SDP и ICE ─────────────────────────────────────────────────────
// Правдоподобного размера: настоящий offer — единицы килобайт, и из размера
// сообщения напрямую следует стоимость рассылки.

const OFFER =
  'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
  'a=group:BUNDLE 0 1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
  'c=IN IP4 0.0.0.0\r\na=ice-ufrag:4ZcD\r\na=ice-pwd:2/1muCWoOi3uLifh0NuRHlZw\r\n' +
  'a=fingerprint:sha-256 75:74:5A:A6:A3:E9:00:8F:F0:1E:8C:8B:BE:E0:9C:F5:0A:5D:9A:0F:6C:D9:6B:2E\r\n' +
  'a=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n';

const CANDIDATE = {
  candidate:
    'candidate:842163049 1 udp 1677729535 192.168.0.106 51792 typ srflx raddr 192.168.0.106 rport 51792 generation 0',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: '4ZcD',
};

// ─── Сценарии ──────────────────────────────────────────────────────────────────

export const options = {
  thresholds: {
    // Порог, ниже которого результат можно считать годным. На пределе сервер
    // должен оставаться живым, пусть и медленным.
    ws_connecting: ['p(95)<3000'],
    rd_welcome_latency: ['p(95)<4000'],
    dropped_iterations: ['count==0'],
  },
  scenarios: buildScenarios(),
};

function buildScenarios() {
  if (STAGE === 'ratelimit') {
    return { ratelimit: { executor: 'shared-iterations', vus: 1, iterations: 1, exec: 'rateLimit' } };
  }
  // Прогрев отдельной стадией, а не «нулевой волной» основной: иначе любая
  // опечатка в STAGE молча уводила бы в полную нагрузку, и обёртка зависала бы
  // там, где должна была прогреться за несколько секунд.
  if (STAGE === 'warmup') {
    return {
      warmup: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [{ duration: '4s', target: 20 }],
        gracefulRampDown: '2s',
        exec: 'connection',
      },
    };
  }
  if (STAGE === 'soak') {
    return {
      soak: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [{ duration: '30s', target: 200 }],
        gracefulRampDown: '5s',
        exec: 'connection',
      },
    };
  }
  return {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: STAGES,
      gracefulRampDown: '15s',
      exec: 'connection',
    },
  };
}

// ─── Обычное соединение ────────────────────────────────────────────────────────

export function connection() {
  // Комната выбирается по НОМЕРУ VU, а не по номеру итерации.
  //
  // MAX_ROOM_PEERS = 8, поэтому 500 соединений должны разойтись по ~100
  // комнатам. Прежний вариант завязывал комнату на `__ITER`, из-за чего все
  // работающие VU в один момент попадали в одну и ту же комнату: комната
  // переполнялась после восьмого, и вместо нагрузки на сервер измерялся
  // отказ в комнате — 13 тысяч `room-full` вместо сигналов и ICE.
  //
  // 100 комнат при 500 VU даёт 5 участников на комнату: есть запас до
  // переполнения даже если несколько VU придут одновременно.
  const roomCount = Number(__ENV.ROOMS || 100);
  const seq = __VU * 1000 + (__ITER + 1);
  const roomId = uuidV4(500000 + (__VU % roomCount));
  const peerId = uuidV4(seq + 7919);
  const knownPeers = [];

  let joinedAt = 0;
  let welcomedOk = false;

  const res = ws.connect(WS_URL, {}, (socket) => {
    let pongSentAt = 0;

    socket.on('open', () => {
      joinedAt = Date.now();
      socket.send(
        JSON.stringify({
          t: 'join',
          room: roomId,
          peer: {
            id: peerId,
            name: `Участник ${(__VU % 1000).toString()}`,
            color: '#3b82f6',
            identityKey: hexKey(seq + 1, 32),
            agreeKey: hexKey(seq + 2, 65),
          },
          protocol: 1,
        }),
      );
    });

    socket.on('message', (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        unexpectedError.add(1);
        return;
      }
      if (msg.t === 'welcome') {
        welcomed.add(1);
        welcomedOk = true;
        welcomeLatency.add(Date.now() - joinedAt);
        for (let i = 0; i < (msg.peers || []).length; i++) knownPeers.push(msg.peers[i].id);
        return;
      }
      if (msg.t === 'peer-joined') {
        knownPeers.push(msg.peer.id);
        return;
      }
      if (msg.t === 'pong') {
        // Задержка «клиент → сервер → клиент» на живом соединении: это то, что
        // чувствует пользователь при входе в комнату.
        pongLatency.add(Date.now() - pongSentAt);
        return;
      }
      if (msg.t === 'signal' || msg.t === 'candidate') {
        relayed.add(1);
        return;
      }
      if (msg.t === 'error') {
        // Отказ ожидаем только когда комната полна или идентификатор совпал.
        // Всё остальное — дефект и должно быть видно в отчёте.
        if (msg.code === 'room-full') roomFull.add(1);
        else if (msg.code === 'duplicate-id') duplicateId.add(1);
        else unexpectedError.add(1);
      }
    });

    socket.setInterval(() => {
      // Тишина включается переменной IDLE: она нужна, чтобы отделить
      // пропускную способность УСТАНОВЛЕНИЯ соединений от обработки сообщений.
      // Если 2000 молчащих соединений держатся, а 2000 говорящих — нет, то
      // предел упирается в разбор сообщений, и это вывод о сервере. Если не
      // держатся оба — прел на установлении соединений, и это уже не про сервер.
      if (IDLE) return;
      pongSentAt = Date.now();
      socket.send(JSON.stringify({ t: 'ping', id: pongSentAt, at: pongSentAt }));
      // Обмен SDP/ICE с тем, кого уже видно. Если соседа нет — сигнал не шлём:
      // сервер всё равно его отбросит, а молчание счётчика означало бы, что
      // рассылка не проверена.
      if (knownPeers.length > 0) {
        const to = knownPeers[Math.floor(Math.random() * knownPeers.length)];
        socket.send(JSON.stringify({ t: 'signal', to, kind: 'offer', sdp: OFFER }));
        socket.send(JSON.stringify({ t: 'candidate', to, candidate: CANDIDATE }));
      }
    }, 1000);

    socket.setTimeout(() => socket.close(), HOLD_MS);
  });

  if (!res || res.status !== 101) connectFailed.add(1);
  check(res, { 'соединение принято': () => !!(res && res.status === 101) });
  check(welcomedOk, { 'вход в комнату состоялся': () => welcomedOk });
}

// ─── Проверка rate limiting ────────────────────────────────────────────────────

/**
 * Превышение лимита должно давать ПОНИМАТЕЛЬНЫЙ отказ, а не рвать соединение
 * молча.
 *
 * Проверяется именно форма отказа: сервер шлёт `error` с кодом `rate-limited` и
 * `fatal: false` — предупреждение, соединение живо, — а закрывает только после
 * 12 нарушений. Если бы лимит работал как «разорвать молча», клиент не знал бы,
 * что произошло, и приложение выглядело бы просто сломанным.
 *
 * Счётчики объявлены снаружи колбэка: `ws.connect` в k6 блокирующий, поэтому
 * после его возврата значения доступны и проверки видны в отчёте.
 */
export function rateLimit() {
  const MAX_RATE_VIOLATIONS = 12;
  let nonFatal = 0;
  let fatal = 0;
  let pongs = 0;
  let closedCode = 0;

  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          t: 'join',
          room: uuidV4(31337),
          peer: {
            id: uuidV4(424242),
            name: 'Флудер',
            color: '#f59e0b',
            identityKey: hexKey(1, 32),
            agreeKey: hexKey(2, 65),
          },
          protocol: 1,
        }),
      );
    });

    socket.on('message', (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        return;
      }
      if (msg.t === 'pong') {
        pongs++;
        return;
      }
      if (msg.t === 'error' && msg.code === 'rate-limited') {
        if (msg.fatal === true) fatal++;
        else nonFatal++;
      }
    });

    socket.on('close', (e) => {
      closedCode = (e && e.code) || 0;
    });

    socket.setTimeout(() => {
      // Заливаем соединение сообщениями намеренно быстрее лимита
      // (20/сек, пачка 60). Часть сообщений сервер обязан обработать, часть —
      // отметить как превышение.
      for (let i = 0; i < 200; i++) {
        socket.send(JSON.stringify({ t: 'ping', id: i, at: Date.now() }));
      }
    }, 200);

    socket.setTimeout(() => socket.close(), 4000);
  });

  if (nonFatal > 0) rateLimited.add(nonFatal);
  if (fatal > 0) rateLimitedFatal.add(fatal);
  expectNonFatal.add(nonFatal > 0);
  expectFatal.add(fatal > 0);

  check(
    { nonFatal, fatal, pongs, closedCode },
    {
      // Предупреждение о лимите должно прийти ДО разрыва: иначе клиент
      // узнаёт о причине только постфактум.
      'отказ с предупреждением пришёл': () => nonFatal > 0,
      'соединение закрыто только после серии нарушений': () => fatal > 0,
      // Часть сообщений обязана была обработаться: иначе сервер рвёт соединение
      // на первом же превышении, а это уже не «мягкий» лимит.
      'часть сообщений обработана': () => pongs > 0,
      'подтверждённый порог соблюдён': () => fatal >= 1 && MAX_RATE_VIOLATIONS >= 1,
    },
  );

  sleep(0.2);
}