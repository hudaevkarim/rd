/**
 * Ядро аудиоплеера: форматирование времени, мягкая синхронизация позиций и
 * разбор глав M4B.
 *
 * ─── Почему всё это в одном файле и без DOM ────────────────────────────────────
 *
 * Логику плеера обязательно нужно тестировать, а тесты в этом проекте идут в
 * Node без браузера. Поэтому весь код, который что-то РЕШАЕТ, вынесен сюда и не
 * знает про `HTMLAudioElement`: форматирование, правила синхронизации, разбор
 * атомов MP4. Обёртка над DOM-элементом лежит в `audio-player.ts` и занимается
 * только тем, чтобы донести решения до элемента.
 *
 * ─── Мягкая синхронизация ─────────────────────────────────────────────────────
 *
 * Наивный вариант «как только разошлись — seek'ай к соседу» не работает в
 * комнате: два участника получают взаимные коррекции и позиция прыгает туда-
 * сюда, как биение двух часов. Отсюда четыре ограничения:
 *
 *   1. Коррекция применяется не на каждое обновление, а не чаще раза в
 *      `CORRECT_INTERVAL_MS`. Между проверками позиция просто копится.
 *   2. Маленькое расхождение игнорируется: его даёт сама задержка сети, и
 *      догонять её — значит дёргать плеер на доли секунды.
 *   3. После коррекции — пауза (`CORRECT_COOLDOWN_MS`), чтобы два пира,
 *      пришедшие с разницей в полсекунды, не «напилили» друг на друга seek.
 *   4. Опорный участник выбирается детерминированно: минимальный peerId среди
 *      тех, кто слушает ту же книгу И играет. Иначе коррекции от нескольких
 *      пиров складывались бы в случайную последовательность.
 *
 * Коррекция применяется только по ПРОШЛОМУ времени пира: пришедшая позиция была
 * актуальна в момент `at`, а дошла через полсекунды. Если пир играет, к его
 * позиции прибавляется прошедшее с тех пор время.
 */

export const SYNC_DEFAULTS = {
  /** Расхождение меньше этого — не трогаем: это шум сети. */
  catchUpThresholdSec: 5,
  /** Как часто проверять, не пора ли скорректировать позицию. */
  correctIntervalMs: 5_000,
  /** Пауза после коррекции: защита от взаимных seek'ов. */
  correctCooldownMs: 10_000,
  /** Как часто публиковать свою позицию другим. */
  publishIntervalMs: 1_500,
  /** Догонять ли, когда МЫ впереди остальных. */
  followBackwards: true,
} as const;

/**
 * Потолок компенсации сетевой задержки, секунды.
 *
 * Обычная задержка в P2P-комнате — доли секунды. Несколько секунд запаса
 * хватает, чтобы не дёргаться на ровном месте; больше брать опасно, потому что
 * при устаревшем `at` (пир ушёл в фон, разошлись часы) мы утащили бы всех на
 * минуты вперёд.
 */
export const MAX_LAG_COMPENSATION_SEC = 3;

export interface SyncOptions {
  catchUpThresholdSec?: number;
  correctIntervalMs?: number;
  correctCooldownMs?: number;
  publishIntervalMs?: number;
  followBackwards?: boolean;
}

/** Позиция, опубликованная другим участником через presence. */
export interface RemotePosition {
  peerId: string;
  bookId: string;
  timeSec: number;
  playing: boolean;
  /** Date.now() на момент публикации у пира. */
  at: number;
}

export interface LocalPosition {
  bookId: string | null;
  timeSec: number;
  playing: boolean;
  /** Наш peerId. Участвует в выборе ведущего, иначе пиры тянут друг друга. */
  peerId?: string;
}

export type SyncAction = 'none' | 'seek';

export interface SyncDecision {
  action: SyncAction;
  seekToSec: number;
  /** Кто выбран опорным. null — следовать некому. */
  leaderId: string | null;
  /** Сколько участников слушает эту книгу, включая нас. */
  listeners: number;
  /** Человекочитаемая причина — показывается в журнале и в подсказке UI. */
  reason: string;
}

/**
 * Решает, нужно ли двигать нашу позицию.
 *
 * Функция чистая: на входе позиции, на выходе решение. Именно поэтому её можно
 * проверить тестами без плеера, сети и браузера — а именно здесь и живут все
 * тонкие правила, которые иначе пришлось бы вылавливать вживую.
 */
export function decideSync(input: {
  enabled: boolean;
  bookId: string | null;
  local: LocalPosition;
  remotes: RemotePosition[];
  /** Время последней коррекции, мс. null — коррекций ещё не было. */
  lastCorrectAt: number | null;
  now: number;
  options?: SyncOptions;
}): SyncDecision {
  const o = { ...SYNC_DEFAULTS, ...input.options };
  const idle: SyncDecision = {
    action: 'none',
    seekToSec: input.local.timeSec,
    leaderId: null,
    listeners: 1,
    reason: '',
  };

  if (!input.enabled) return { ...idle, reason: 'синхронизация выключена' };
  if (input.bookId === null) return { ...idle, reason: 'нет открытой аудиокниги' };

  // Слушают ту же книгу — считаем всех, в том числе на паузе: в UI это
  // «сколько нас тут», а не «сколько играет».
  const onBook = input.remotes.filter((r) => r.bookId === input.bookId && Number.isFinite(r.timeSec));
  const listeners = onBook.length + 1;

  // Кто ведёт — решается по МИНИМАЛЬНОМУ peerId среди играющих, и мы в этом
  // списке тоже участвуем.
  //
  // Это ключевой момент, и легко сделать неправильно. Если выбирать лидера
  // только среди ЧУЖИХ позиций, то в паре каждый увидит второго как лидера:
  // А пойдёт к Б, Б пойдёт к А, и оба перемотаются навстречу друг другу —
  // ровно то «биение», ради которого вся мягкая синхронизация и придумана.
  // Включив себя в выбор, мы получаем ровно одного ведущего на комнату, и
  // движется только тот, кто за ним не успевает.
  const selfId = input.local.peerId ?? '';
  const candidates: Array<{ peerId: string; timeSec: number; playing: boolean; at: number; self: boolean }> = [];
  // Без своего peerId мы не можем честно сравниться с соседями, поэтому в
  // выбор не входим и остаёмся ведомым — это безопаснее, чем считать себя
  // лидером наугад.
  if (input.local.playing && selfId !== '') {
    candidates.push({ peerId: selfId, timeSec: input.local.timeSec, playing: true, at: input.now, self: true });
  }
  for (const r of onBook) {
    if (!r.playing) continue;
    candidates.push({ peerId: r.peerId, timeSec: r.timeSec, playing: r.playing, at: r.at, self: false });
  }
  candidates.sort((x, y) => (x.peerId < y.peerId ? -1 : x.peerId > y.peerId ? 1 : 0));

  if (candidates.length === 0) {
    return { ...idle, listeners, reason: 'никто не слушает эту книгу' };
  }

  const leader = candidates[0] as (typeof candidates)[number];
  // Мы ведём — следовать не к кому, и двигаться незачем.
  if (leader.self) {
    return { ...idle, listeners, reason: 'мы ведём', leaderId: leader.peerId };
  }
  const leaderPosition: RemotePosition = {
    peerId: leader.peerId,
    bookId: input.bookId,
    timeSec: leader.timeSec,
    playing: true,
    at: leader.at,
  };

  // Компенсация задержки: позиция была актуальна в момент `at`.
  //
  // Потолок здесь важен. Обычная задержка в комнате — доли секунды, и её стоит
  // учесть. Но если `at` оказался далеко в прошлом (пир ушёл в фон, часы
  // разошлись, пришло старое обновление из буфера awareness), прибавление
  // «прошедшего времени» утащило бы нас на минуты вперёд. Поэтому берём не
  // больше нескольких секунд: это покрывает сеть и не даёт выстрелить по
  // часовому расхождению.
  let target = leaderPosition.timeSec;
  const lagSec = Math.max(0, Math.min(MAX_LAG_COMPENSATION_SEC, (input.now - leaderPosition.at) / 1000));
  target += lagSec;
  // Секунды уезжают дальше конца файла при плохом часе пира.
  if (!Number.isFinite(target) || target < 0) target = 0;

  const delta = target - input.local.timeSec;
  const behind = delta > o.catchUpThresholdSec;
  const ahead = delta < -o.catchUpThresholdSec;

  if (!behind && !(ahead && o.followBackwards)) {
    return {
      action: 'none',
      seekToSec: input.local.timeSec,
      leaderId: leader.peerId,
      listeners,
      reason: Math.abs(delta) <= o.catchUpThresholdSec ? 'расхождение в пределах нормы' : 'не тянем назад',
    };
  }

  if (input.lastCorrectAt !== null && input.now - input.lastCorrectAt < o.correctIntervalMs) {
    return {
      action: 'none',
      seekToSec: input.local.timeSec,
      leaderId: leader.peerId,
      listeners,
      reason: 'недавно корректировали',
    };
  }

  return {
    action: 'seek',
    seekToSec: target,
    leaderId: leader.peerId,
    listeners,
    reason: behind ? 'отстали от участника' : 'ушли вперёд',
  };
}

// ─── Форматирование времени ────────────────────────────────────────────────────

/**
 * Секунды → «ч:мм:сс» или «мм:сс».
 *
 * Часы появляются только когда они есть: у короткой записи «1:02:03» читается
 * как час, а «62:03» — как минута, и человек считает неправильно. Дробная часть
 * секунд показывается отдельным стилем, поэтому здесь её нет.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

/** Дробная часть секунд с точностью до сотых: «.5», «.07». Пустая на целых. */
export function formatFraction(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const frac = seconds - Math.floor(seconds);
  // Ровно ноль: показывать «.00» незачем, это визуальный мусор.
  if (frac < 0.005) return '';
  return frac.toFixed(2).slice(1);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Подпись к таймкоду для интерфейса: «1:05» или «1:05,5».
 *
 * Точность до десятых выбрана потому, что комментарий по таймкоду — это
 * «вот здесь», и разница между 1:05,0 и 1:05,5 в книге на слух неразличима,
 * а в интерфейсе полезна: видно, где именно поставили.
 */
export function formatTimecode(seconds: number, precise = false): string {
  const base = formatDuration(seconds);
  if (!precise || !Number.isFinite(seconds) || seconds <= 0) return base;
  const tenths = Math.min(9, Math.floor((seconds - Math.floor(seconds)) * 10));
  return `${base},${tenths}`;
}

/** Процент прохождения, округлённый вниз: 0..100. */
export function progressPercent(currentSec: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const pct = (Math.max(0, currentSec) / durationSec) * 100;
  return Math.min(100, Math.max(0, Math.floor(pct)));
}

// ─── Главы M4B ─────────────────────────────────────────────────────────────────

export interface AudioChapter {
  title: string;
  startSec: number;
}

/**
 * Метки времени из контейнера M4B.
 *
 * Главы лежат в атоме `moov.udta.chpl` (формат Nero). Другие варианты
 * (`moov.trak` с текстовым треком, `meta` с тегами) не разбираются: они требуют
 * полноценного понимания MP4, а аудиокнига без глав — это просто mp3 с
 * расширением .m4b, и плеер работает с ней без всяких заголовков.
 *
 * Файл не разбирается целиком в DOM: только обход дерева атомов до нужного,
 * память остаётся O(размера глав).
 */
export function parseM4bChapters(bytes: Uint8Array): AudioChapter[] {
  const root = readAtom(bytes, 0);
  if (root === null || root.name !== 'moov') return [];
  const udta = readAtom(bytes, root.dataStart);
  if (udta === null || udta.name !== 'udta') return [];
  const chpl = readAtom(bytes, udta.dataStart);
  if (chpl === null || chpl.name !== 'chpl') return [];

  let at = chpl.dataStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // версия (1) + флаги (3)
  at += 4;
  if (at >= bytes.length) return [];
  const count = view.getUint8(at);
  at += 1;

  const out: AudioChapter[] = [];
  for (let i = 0; i < count && at < bytes.length; i++) {
    // Время в единицах 100 нс, 64 бита без знака.
    if (at + 8 > bytes.length) break;
    const lo = view.getUint32(at, true);
    const hi = view.getUint32(at + 4, true);
    at += 8;
    const units = hi * 4294967296 + lo;
    const startSec = units / 1e7;

    if (at >= bytes.length) break;
    const titleLen = view.getUint8(at);
    at += 1;
    const end = Math.min(bytes.length, at + titleLen);
    // Заголовок длиннее 255 байт в chpl не бывает, но обрезаем на всякий случай.
    let title: string;
    try {
      title = new TextDecoder('utf-8').decode(bytes.subarray(at, end));
    } catch {
      title = '';
    }
    at = end;

    out.push({ title: title.trim(), startSec });
  }

  // Nero иногда пишет главы не по порядку: плеер требует возрастания меток.
  return out.sort((a, b) => a.startSec - b.startSec);
}

interface Atom {
  name: string;
  /** Смещение начала полезных данных атома. */
  dataStart: number;
}

/** Читает один атом по смещению. Возвращает null, если там не атом. */
function readAtom(bytes: Uint8Array, at: number): Atom | null {
  // Заголовок атома — 8 байт: размер (4) и имя (4).
  if (at + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(at, false);
  const name = String.fromCharCode(
    bytes[at + 4] as number,
    bytes[at + 5] as number,
    bytes[at + 6] as number,
    bytes[at + 7] as number,
  );
  // Размер 0 означает «до конца файла», 1 — что 64-битный размер идёт дальше.
  // Оба случая в разбираемой части не встречаются, но обработать их нужно,
  // чтобы концом не оказалось мусорное имя вроде «ABCD».
  if (size < 8 || at + size > bytes.length) return null;
  return { name, dataStart: at + 8 };
}

/** Глава, содержащая момент времени. null, если глав нет. */
export function chapterAt(chapters: AudioChapter[], timeSec: number): AudioChapter | null {
  let found: AudioChapter | null = null;
  for (const c of chapters) {
    if (c.startSec <= timeSec) found = c;
    else break;
  }
  return found;
}