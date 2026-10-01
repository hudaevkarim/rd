/**
 * Плеер аудиокниг поверх HTMLMediaElement.
 *
 * ─── Почему нативный <audio>, а не Howler.js ──────────────────────────────────
 *
 * Howler — удобная обёртка, но здесь она проигрывает по трём пунктам:
 *
 *   1. Форматы. Howler понимает mp3/ogg/wav. M4B (а это контейнер MP4 с AAC
 *      внутри) ему незнаком, и его пришлось бы всё равно разбирать самостоятельно.
 *      Нативный элемент берёт mp3, m4a, m4b и AAC без всякой обвязки.
 *   2. Память. Howler декодирует файл целиком через decodeAudioData, то есть
 *      аудиокнига на 800 МБ целиком окажется в RAM. `<audio>` играет потоком,
 *      через MediaSource, и держит в памяти только текущий буфер.
 *   3. Глобальное состояние. Howler пишет в глобальный синглтон `Howler`, из-за
 *      чего две книги в разных вкладках начинают мешать друг другу, а состояние
 *      плеера нельзя отдать в `useSyncExternalStore`.
 *
 * Решения (следование за соседями, что показывать) живут в `audio-core.ts` и
 * тестируются без браузера. Здесь только перенос решений на элемент.
 *
 * ─── Почему нет отдельного элемента в разметке ─────────────────────────────────
 *
 * `<audio>` всё равно нужен: без него браузер не декодирует. Но он создаётся
 * программно и не виден — вся разметка плеера (кнопки, шкала) рисуется нами, и
 * состояние живёт здесь. Так плеер можно полностью покрыть тестами с подставным
 * элементом, не поднимая браузер.
 */

import { Emitter } from '@rd/p2p';
import { chapterAt, decideSync, parseM4bChapters, type AudioChapter, type RemotePosition, type SyncOptions } from './audio-core.js';

export type PlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

/** Минимальный интерфейс, который нам нужен от элемента. */
export interface MediaElementLike {
  src: string;
  preload: string;
  volume: number;
  currentTime: number;
  duration: number;
  paused: boolean;
  error: { code: number; message: string } | null;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, handler: (ev: unknown) => void): void;
  removeEventListener(type: string, handler: (ev: unknown) => void): void;
  load?(): void;
}

export interface AudioPlayerEvents extends Record<string, unknown> {
  state: PlaybackState;
  /** Позиция изменилась. Часто — по таймеру опроса, не по событию элемента. */
  time: { currentSec: number; durationSec: number };
  /** Список глав перечитан (после загрузки или смены источника). */
  chapters: AudioChapter[];
  error: { message: string };
  /** Принято решение следовать за соседом — для журнала и подсказки в UI. */
  synced: { leaderId: string | null; reason: string; seekToSec: number };
}

export interface AudioPlayerOptions {
  /** Фабрика элемента. В тестах подменяется заглушкой. */
  createElement?: () => MediaElementLike;
  /** Период опроса позиции, мс. */
  pollIntervalMs?: number;
  /** Настройки мягкой синхронизации. */
  sync?: SyncOptions;
  /** Наш peerId. Участвует в выборе ведущего среди слушающих. */
  peerId?: string;
}

export interface AudioBookSource {
  bookId: string;
  title: string;
  /** Blob из IndexedDB: так файл не копируется в память целиком. */
  blob: Blob;
  mime: string;
}

const DEFAULT_POLL_MS = 250;

/**
 * Сколько ждать, пока элемент применит присвоенный `currentTime`.
 *
 * На нормальной машине это единицы миллисекунд. Значение нужно как «страховка»:
 * если элемент так и не дошёл до цели (бывает на некоторых сборках при seek за
 * пределы уже буферизованного), показания нельзя игнорировать вечно — иначе
 * стрелка шкалы навсегда замрёт.
 */
const SEEK_SETTLE_MS = 600;

export class AudioPlayer {
  readonly events = new Emitter<AudioPlayerEvents>();

  readonly #el: MediaElementLike;
  readonly #pollIntervalMs: number;
  readonly #sync: SyncOptions;
  /** Наш peerId для выбора ведущего. Может стать известен позже сессии. */
  #selfPeerId: string;
  readonly #listeners: Array<[string, (ev: unknown) => void]> = [];

  #state: PlaybackState = 'idle';
  #bookId: string | null = null;
  #title = '';
  #chapters: AudioChapter[] = [];
  #durationSec = 0;
  #currentSec = 0;
  #objectUrl: string | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #lastCorrectAt: number | null = null;
  #followEnabled = false;
  #lastPublishAt = 0;
  #publishedTime = -1;
  /** Состояние playing на момент последней публикации: пауза тоже событие. */
  #publishedPlaying = false;
  #destroyed = false;
  /** Куда перемотали: до тех пор показания элемента игнорируются. */
  #seekTarget: number | null = null;
  #seekDeadline = 0;

  constructor(opts: AudioPlayerOptions = {}) {
    const create = opts.createElement ?? (() => createNativeAudio());
    this.#el = create();
    this.#pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.#sync = opts.sync ?? {};
    this.#selfPeerId = opts.peerId ?? '';

    this.#bind('loadedmetadata', () => {
      this.#durationSec = finiteOr(this.#el.duration, 0);
      this.#currentSec = finiteOr(this.#el.currentTime, 0);
      this.#setState(this.#el.paused ? 'ready' : 'playing');
      this.events.emit('time', { currentSec: this.#currentSec, durationSec: this.#durationSec });
    });
    this.#bind('play', () => this.#setState('playing'));
    this.#bind('pause', () => this.#setState(this.#currentSec >= this.#durationSec && this.#durationSec > 0 ? 'ended' : 'paused'));
    this.#bind('ended', () => {
      this.#currentSec = this.#durationSec;
      this.#setState('ended');
      this.events.emit('time', { currentSec: this.#currentSec, durationSec: this.#durationSec });
    });
    this.#bind('error', () => {
      this.#setState('error');
      this.events.emit('error', { message: describeMediaError(this.#el.error) });
    });
    // Позиция обновляется и по событию элемента, и по таймеру. Одного таймера
    // мало: в фоновой вкладке браузер душит setInterval до раза в минуту, и
    // шкала замирала бы, хотя аудио играет. Событие timeupdate в фоне приходит
    // нормально.
    this.#bind('timeupdate', () => this.#poll());

    // Таймер добавляет плавность между событиями: элемент шлёт timeupdate около
    // четырёх раз в секунду, а комментарии по таймкоду и шкала хотелось бы
    // обновлять чаще.
    this.#pollTimer = setInterval(() => this.#poll(), this.#pollIntervalMs);
    this.#pollTimer.unref?.();
  }

  // ─── Состояние ───────────────────────────────────────────────────────────────

  get state(): PlaybackState {
    return this.#state;
  }

  get currentSec(): number {
    return this.#currentSec;
  }

  get durationSec(): number {
    return this.#durationSec;
  }

  get volume(): number {
    return this.#el.volume;
  }

  get bookId(): string | null {
    return this.#bookId;
  }

  get chapters(): AudioChapter[] {
    return this.#chapters;
  }

  /** Текущая глава — для подписи над плеером. */
  get currentChapter(): AudioChapter | null {
    return chapterAt(this.#chapters, this.#currentSec);
  }

  get followEnabled(): boolean {
    return this.#followEnabled;
  }

  // ─── Команды ─────────────────────────────────────────────────────────────────

  /** Загружает аудиокнигу. Прежняя освобождается, чтобы не течь Blob'ами. */
  async load(source: AudioBookSource): Promise<void> {
    this.#releaseObjectUrl();
    this.#bookId = source.bookId;
    this.#title = source.title;
    this.#currentSec = 0;
    this.#durationSec = 0;
    this.#chapters = [];
    this.#lastCorrectAt = null;
    this.#publishedTime = -1;
    this.#publishedPlaying = false;
    this.#seekTarget = null;
    this.#lastPublishAt = 0;
    this.#setState('loading');

    this.#el.src = URL.createObjectURL(source.blob);
    this.#el.preload = 'metadata';
    this.#objectUrl = this.#el.src;
    this.#el.load?.();

    // Главы лежат в начале файла, поэтому читаем только их: тянуть 800 МБ ради
    // списка глав незачем.
    //
    // Тип берём из `source.mime`, а НЕ из `blob.type`: Blob, собранный из
    // частей в IndexedDB, теряет тип при разбиении на куски, и проверка по
    // нему молча отключала бы список глав у книг, полученных от соседа.
    this.#chapters = await readChapters(source.blob, source.mime);
    this.events.emit('chapters', this.#chapters);
  }

  /** Разбор глав: не ошибка, а «глав нет». */
  async play(): Promise<void> {
    if (this.#state === 'idle' || this.#state === 'error') return;
    try {
      await this.#el.play();
      this.#setState('playing');
    } catch (err) {
      // Браузер блокирует автозапуск без жеста пользователя — это ожидаемо,
      // но пользователь должен понимать, что произошло.
      this.events.emit('error', { message: `не удалось запустить воспроизведение: ${describe(err)}` });
    }
  }

  pause(): void {
    if (this.#el.paused) return;
    this.#el.pause();
  }

  toggle(): void {
    if (this.#el.paused) void this.play();
    else this.pause();
  }

  /**
   * Перемотка. Значение зажимается в [0, duration]: браузер на `currentTime`
   * больше длительности ведёт себя по-разному, а нам нужен предсказуемый
   * переход, в том числе при поиске по мусорному значению из чужого presence.
   */
  seek(sec: number): void {
    const clamped = this.#clampTime(sec);
    if (clamped === this.#currentSec && this.#seekTarget === null) return;
    this.#currentSec = clamped;
    this.#el.currentTime = clamped;
    // Браузер применяет присвоение currentTime не мгновенно: какое-то время
    // элемент продолжает отдавать прежнее значение. Если записать его в
    // состояние, шкала дёрнется назад и обратно. Поэтому запоминаем цель и
    // игнорируем показания, пока элемент к ней не придёт.
    this.#seekTarget = clamped;
    this.#seekDeadline = Date.now() + SEEK_SETTLE_MS;
    this.events.emit('time', { currentSec: this.#currentSec, durationSec: this.#durationSec });
  }

  setVolume(volume: number): void {
    const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    this.#el.volume = v;
  }

  /** Громкость как процент — так её хранит интерфейс. */
  setVolumePercent(percent: number): void {
    this.setVolume(percent / 100);
  }

  /**
   * Позиция, которую видит интерфейс и которая уходит соседям.
   *
   * Отдельный метод не из приличия, а из-за фоновых вкладок: там браузер душит
   * таймеры, и кэшированное значение успевает устареть на минуты. Перед выдачей
   * раз в событие спрашиваем сам элемент — это дёшево и всегда актуально.
   */
  get positionSec(): number {
    if (this.#seekTarget === null) {
      const raw = finiteOr(this.#el.currentTime, this.#currentSec);
      if (raw !== this.#currentSec && raw >= 0) {
        if (this.#durationSec > 0) this.#durationSec = finiteOr(this.#el.duration, this.#durationSec);
        this.#currentSec = raw;
      }
    }
    return this.#currentSec;
  }

  setFollowEnabled(enabled: boolean): void {
    this.#followEnabled = enabled;
    if (!enabled) this.#lastCorrectAt = null;
  }

  /**
   * Наш peerId. Сессия узнаёт его только после подключения к signaling, а
   * плеер создаётся раньше, поэтому значение задаётся отдельно.
   */
  setPeerId(peerId: string): void {
    this.#selfPeerId = peerId;
  }

  get peerId(): string {
    return this.#selfPeerId;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    for (const [type, handler] of this.#listeners) this.#el.removeEventListener(type, handler);
    this.#listeners.length = 0;
    this.#releaseObjectUrl();
    this.#el.pause();
    this.events.clear();
  }

  // ─── Синхронизация ───────────────────────────────────────────────────────────

  /**
   * Позиция, которую стоит отправить остальным.
   *
   * Публикуется по троттлингу и только при заметном изменении: осведомление о
   * каждом перемещении на секунду забило бы awareness-канал, а для следования
   * достаточно обновления раз в полторы секунды.
   *
   * @returns объект для presence либо null, если публиковать нечего.
   */
  publishPosition(now = Date.now()): RemotePosition | null {
    if (this.#bookId === null || this.#destroyed) return null;
    const current = this.positionSec;
    const playing = this.#state === 'playing';

    // Ни позиция, ни состояние не изменились — соседям нечего сообщать.
    // Проверяем ОБА признака: человек нажал паузу на месте, и это тоже событие
    // (оно влияет на выбор опорного участника).
    if (Math.abs(current - this.#publishedTime) < 0.5 && playing === this.#publishedPlaying) return null;

    // Троттлинг НЕ применяется к перемотке и к смене состояния игры: это
    // осознанные действия человека, о которых соседям нужно узнать сразу.
    const deliberate = Math.abs(current - this.#publishedTime) >= 0.5 || playing !== this.#publishedPlaying;
    if (!deliberate && now - this.#lastPublishAt < (this.#sync.publishIntervalMs ?? 1500)) return null;

    this.#lastPublishAt = now;
    this.#publishedTime = current;
    this.#publishedPlaying = playing;
    return { peerId: '', bookId: this.#bookId, timeSec: current, playing, at: now };
  }

  /**
   * Обрабатывает позиции остальных и, если правила требуют, перематывает нас.
   *
   * Здесь же снимается главный недостаток «мягкого» следования: пока пир сам
   * перематывается, чужие коррекции не применяются — иначе он улетел бы на
   * середине своего seek'а.
   */
  applyRemote(remotes: RemotePosition[], now = Date.now()): void {
    if (this.#destroyed) return;
    const decision = decideSync({
      enabled: this.#followEnabled,
      bookId: this.#bookId,
      local: {
        bookId: this.#bookId,
        timeSec: this.positionSec,
        playing: this.#state === 'playing',
        // Наш peerId обязателен: без него выбора ведущего не происходит и пиры
        // начинают тянуть друг друга навстречу.
        peerId: this.#selfPeerId,
      },
      remotes,
      lastCorrectAt: this.#lastCorrectAt,
      now,
      options: this.#sync,
    });
    if (decision.action !== 'seek') return;
    this.#lastCorrectAt = now;
    this.seek(decision.seekToSec);
    this.events.emit('synced', {
      leaderId: decision.leaderId,
      reason: decision.reason,
      seekToSec: decision.seekToSec,
    });
  }

  /**
   * Ждёт, пока элемент применит перемотку.
   *
   * Нужен для тестов и для сценария «перемотал и сразу попросил комментарий
   * по таймкоду»: без него позиция на кнопке комментария может оказаться
   * старой.
   */
  async settled(): Promise<void> {
    while (this.#seekTarget !== null && Date.now() <= this.#seekDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // ─── Внутреннее ──────────────────────────────────────────────────────────────

  #poll(): void {
    if (this.#destroyed) return;
    const raw = finiteOr(this.#el.currentTime, this.#currentSec);

    // Перемотка ещё не «осела» в элементе: его показания игнорируем, иначе
    // стрелка шкалы отскочит назад. Снимаем ожидание, когда элемент дошёл до
    // цели либо прошло достаточно времени (элемент мог её и не принять).
    if (this.#seekTarget !== null) {
      const settled = Math.abs(raw - this.#seekTarget) < 0.25;
      if (settled || Date.now() > this.#seekDeadline) this.#seekTarget = null;
      else return;
    }

    if (raw === this.#currentSec) return;
    this.#currentSec = raw;
    if (this.#durationSec === 0) this.#durationSec = finiteOr(this.#el.duration, 0);
    this.events.emit('time', { currentSec: this.#currentSec, durationSec: this.#durationSec });
  }

  #clampTime(sec: number): number {
    if (!Number.isFinite(sec) || sec < 0) return 0;
    if (this.#durationSec > 0) return Math.min(sec, this.#durationSec);
    return sec;
  }

  #setState(state: PlaybackState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.events.emit('state', state);
  }

  #bind(type: string, handler: (ev: unknown) => void): void {
    this.#el.addEventListener(type, handler);
    this.#listeners.push([type, handler]);
  }

  #releaseObjectUrl(): void {
    if (this.#objectUrl === null) return;
    // Освобождение обязательно: иначе Blob держится в памяти до перезагрузки
    // вкладки, а аудиокнига — это сотни мегабайт.
    URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = null;
  }

  /** Заголовок книги для подписи. */
  get bookTitle(): string {
    return this.#title;
  }
}

/**
 * Читает главы из файла: MP4-контейнер ищется в первом мегабайте.
 *
 * Ограничение 1 МиБ — осознанное: атом `moov` в нормальных файлах стоит в начале
 * или в конце, и второй случай требует читать файл с конца. Для аудиокниг в
 * контейнере Nero/M4B метаданные в начале, поэтому этого достаточно.
 */
const M4B_PROBE_BYTES = 1024 * 1024;

async function readChapters(blob: Blob, mime: string): Promise<AudioChapter[]> {
  if (!looksLikeMp4(mime)) return [];
  try {
    const slice = blob.slice(0, Math.min(blob.size, M4B_PROBE_BYTES));
    return parseM4bChapters(new Uint8Array(await slice.arrayBuffer()));
  } catch {
    // Не разобрался — просто не будет глав. Плохой заголовок не должен
    // мешать слушать аудиокнигу.
    return [];
  }
}

function looksLikeMp4(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.includes('mp4') || m.includes('m4b') || m.includes('aac') || m.includes('mpeg');
}

function createNativeAudio(): MediaElementLike {
  if (typeof document === 'undefined') {
    throw new Error('AudioPlayer требует браузера: нет document');
  }
  return document.createElement('audio') as unknown as MediaElementLike;
}

function finiteOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeMediaError(err: { code: number; message: string } | null): string {
  if (err === null) return 'неизвестная ошибка воспроизведения';
  // Коды MediaError: 2 — сеть, 3 — разбор, 4 — формат не поддерживается.
  switch (err.code) {
    case 2:
      return 'аудиофайл недоступен';
    case 3:
      return 'аудиофайл повреждён';
    case 4:
      return 'формат аудио не поддерживается этим браузером';
    default:
      return err.message === '' ? `ошибка воспроизведения (${err.code})` : err.message;
  }
}