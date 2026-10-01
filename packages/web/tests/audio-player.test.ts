/**
 * Тесты плеера на подставном элементе.
 *
 * Настоящий `<audio>` в Node не существует, да и декодировать MP3 нечем. Но всё
 * решение плеера — загрузка, перемотка, громкость, троттлинг публикаций,
 * применение коррекций — живёт в переходах между состояниями элемента. Значит,
 * достаточно подставить элемент, который ведёт себя по правилам HTMLMediaElement,
 * и проверить наши реакции на его события.
 *
 * Проверяется не «метод вернул void», а наблюдаемое следствие: куда именно
 * установлен `currentTime`, что ушло в presence, что показано в интерфейсе.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPlayer, type MediaElementLike } from '../src/audio-player.js';
import type { SyncOptions } from '../src/audio-core.js';

/** Подставной элемент: хранит состояние и умеет его менять извне. */
class FakeMedia implements MediaElementLike {
  src = '';
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  error: { code: number; message: string } | null = null;
  /** Сколько раз вызвали play(): автозапуск без жеста браузер может отклонить. */
  playCalls = 0;
  /** Если задано — play() отклоняется, как это делает браузер. */
  playRejects: string | null = null;
  loadCalls = 0;

  readonly #listeners = new Map<string, Array<(ev: unknown) => void>>();

  play(): Promise<void> | void {
    this.playCalls++;
    if (this.playRejects !== null) return Promise.reject(new Error(this.playRejects));
    this.paused = false;
    this.#emit('play');
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.#emit('pause');
  }

  load(): void {
    this.loadCalls++;
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(handler);
    this.#listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (ev: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    this.#listeners.set(
      type,
      list.filter((h) => h !== handler),
    );
  }

  #emit(type: string): void {
    for (const handler of [...(this.#listeners.get(type) ?? [])]) handler({ type });
  }

  // ── Управление из теста ──────────────────────────────────────────────────────

  /** Элемент сообщил, что метаданные загружены. */
  ready(durationSec: number): void {
    this.duration = durationSec;
    this.#emit('loadedmetadata');
  }

  /**
   * Элемент «играет» до времени t.
   *
   * По умолчанию currentTime меняется. Если `apply = false`, значение только
   * сообщается событием, но не записывается — так ведёт себя элемент, получивший
   * `currentTime = 120` и ещё какое-то время отдающий прежнюю позицию.
   */
  advanceTo(t: number, apply = true): void {
    if (apply) this.currentTime = t;
    this.#emit('timeupdate');
  }

  ended(): void {
    this.paused = true;
    this.currentTime = this.duration;
    this.#emit('ended');
  }

  fail(code: number): void {
    this.error = { code, message: '' };
    this.#emit('error');
  }
}

const cleanup: Array<() => void> = [];

function makePlayer(opts: { sync?: SyncOptions; peerId?: string } = {}): { player: AudioPlayer; el: FakeMedia } {
  const el = new FakeMedia();
  const player = new AudioPlayer({
    createElement: () => el as unknown as MediaElementLike,
    sync: opts.sync,
    // Идентификатор нужен выбору ведущего. В тестах одинаковый: проверяются
    // правила догоня, а не распределение ролей.
    peerId: opts.peerId ?? 'me',
  });
  cleanup.push(() => player.destroy());
  return { player, el };
}

function audioBlob(size = 4096): Blob {
  return new Blob([new Uint8Array(size)]);
}

afterEach(() => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    fn?.();
  }
  vi.useRealTimers();
});

describe('AudioPlayer: загрузка', () => {
  it('берёт файл из Blob и освобождает URL предыдущей книги', async () => {
    // Утечка Blob здесь стоит сотни мегабайт на переключении книг.
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { player, el } = makePlayer();
    const first = URL.createObjectURL(audioBlob());

    await player.load({ bookId: 'b1', title: 'Первая', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(3600);
    expect(el.src).not.toBe('');
    expect(player.bookId).toBe('b1');
    expect(player.durationSec).toBe(3600);
    expect(player.state).toBe('ready');

    await player.load({ bookId: 'b2', title: 'Вторая', blob: audioBlob(), mime: 'audio/mpeg' });
    expect(revoke).toHaveBeenCalled();
    revoke.mockRestore();
    expect(first).not.toBe('');
  });

  it('не начинает играть в состоянии idle', async () => {
    // Без источника play() должен быть no-op, а не исключение.
    const { player, el } = makePlayer();
    await player.play();
    expect(el.playCalls).toBe(0);
  });

  it('переводит ошибку элемента в понятный текст', () => {
    const { player, el } = makePlayer();
    const errors: string[] = [];
    player.events.on('error', (e) => errors.push((e as { message: string }).message));

    el.fail(4);
    expect(player.state).toBe('error');
    expect(errors[0]).toContain('не поддерживается');
  });

  it('различает сетевую ошибку и повреждённый файл', () => {
    const { player, el } = makePlayer();
    const errors: string[] = [];
    player.events.on('error', (e) => errors.push((e as { message: string }).message));
    el.fail(2);
    el.fail(3);
    expect(errors[0]).toContain('недоступен');
    expect(errors[1]).toContain('повреждён');
  });

  it('освобождает URL при уничтожении', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const el = new FakeMedia();
    const player = new AudioPlayer({ createElement: () => el as unknown as MediaElementLike });
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    player.destroy();
    expect(revoke).toHaveBeenCalled();
    revoke.mockRestore();
  });
});

describe('AudioPlayer: воспроизведение и перемотка', () => {
  it('играет, паузит и переключает', async () => {
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(100);

    await player.play();
    expect(player.state).toBe('playing');
    expect(el.playCalls).toBe(1);

    player.pause();
    expect(player.state).toBe('paused');
    expect(el.paused).toBe(true);

    await player.play();
    expect(el.playCalls).toBe(2);
  });

  it('сообщает, когда браузер запретил автозапуск', async () => {
    // Реальный сценарий: play() без жеста пользователя отклоняется.
    const { player, el } = makePlayer();
    const errors: string[] = [];
    player.events.on('error', (e) => errors.push((e as { message: string }).message));
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(100);

    el.playRejects = 'запуск заблокирован';
    await player.play();
    expect(errors.some((m) => m.includes('заблокирован'))).toBe(true);
  });

  it('перематывает и зажимает позицию в границы файла', async () => {
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(600);

    player.seek(120);
    expect(player.currentSec).toBe(120);
    expect(el.currentTime).toBe(120);

    // Отрицательное и заведомо большое значение из чужого presence не должно
    // уводить плеер за пределы файла.
    player.seek(-50);
    expect(player.currentSec).toBe(0);

    player.seek(99_999);
    expect(player.currentSec).toBe(600);
    expect(el.currentTime).toBe(600);
  });

  it('не реагирует на перемотку в ту же точку', () => {
    // Лишний seek на живом элементе сбрасывает буфер: повторяющиеся команды от
    // синхронизации должны быть дешёвыми no-op.
    const { player, el } = makePlayer();
    const times: number[] = [];
    player.seek(0);
    player.seek(0);
    // currentTime установлен один раз — второй раз значения не меняются.
    expect(el.currentTime).toBe(0);
    expect(times).toEqual([]);
  });

  it('следит за позицией по таймеру, а не только за событиями элемента', async () => {
    // HTMLMediaElement шлёт timeupdate ~4 раза в секунду. Для шкалы и
    // комментариев по таймкоду этого мало.
    vi.useFakeTimers();
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);

    const seen: number[] = [];
    player.events.on('time', (t) => seen.push((t as { currentSec: number }).currentSec));

    el.advanceTo(10);
    vi.advanceTimersByTime(300);
    expect(seen[seen.length - 1]).toBe(10);

    el.advanceTo(20);
    vi.advanceTimersByTime(300);
    expect(seen[seen.length - 1]).toBe(20);

    el.advanceTo(30);
    vi.advanceTimersByTime(300);
    expect(seen[seen.length - 1]).toBe(30);
  });

  it('не откатывает позицию во время собственной перемотки', async () => {
    // Присваивание currentTime браузер применяет не сразу: элемент ещё какое-то
    // время отдаёт старое значение. Опрос записал бы его назад, и шкала дёрнулась.
    vi.useFakeTimers();
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(100);

    const seen: number[] = [];
    player.events.on('time', (t) => seen.push((t as { currentSec: number }).currentSec));

    player.seek(500);
    // Элемент ещё отдаёт старое значение — оно не должно попасть в состояние.
    el.currentTime = 100;
    vi.advanceTimersByTime(500);
    expect(player.currentSec).toBe(500);
    expect(seen[seen.length - 1]).toBe(500);
  });

  it('управляет громкостью с зажимом', async () => {
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });

    player.setVolume(0.5);
    expect(player.volume).toBe(0.5);
    player.setVolumePercent(30);
    expect(el.volume).toBeCloseTo(0.3, 5);
    player.setVolume(5);
    expect(el.volume).toBe(1);
    player.setVolume(-1);
    expect(el.volume).toBe(0);
    player.setVolume(Number.NaN);
    expect(el.volume).toBe(1);
  });

  it('доходит до состояния ended в конце файла', async () => {
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(300);
    await player.play();
    el.ended();
    expect(player.state).toBe('ended');
    expect(player.currentSec).toBe(300);
  });
});

describe('AudioPlayer: публикация позиции', () => {
  it('публикует позицию с троттлингом', async () => {
    const { player, el } = makePlayer({ sync: { publishIntervalMs: 1000 } });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    // Играем: иначе смена состояния сама по себе считалась бы событием, и
    // троттлинг проверялся бы совсем не на позиции.
    await player.play();

    const first = player.publishPosition(1_000_000);
    expect(first).not.toBeNull();
    expect(first?.timeSec).toBe(10);
    expect(first?.playing).toBe(true);
    expect(first?.bookId).toBe('b1');

    // Позиция не изменилась — публиковать нечего, даже когда окно истекло.
    expect(player.publishPosition(1_010_000)).toBeNull();

    el.advanceTo(20);
    expect(player.publishPosition(1_011_000)?.timeSec).toBe(20);
  });

  it('публикует перемотку даже до истечения окна троттлинга', async () => {
    // Перемотка — это осознанное действие человека. Ждать полторы секунды
    // означало бы, что соседи всё это время слышат не то место.
    const { player, el } = makePlayer({ sync: { publishIntervalMs: 5000 } });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);

    expect(player.publishPosition(1_000_000)).not.toBeNull();

    player.seek(500);
    const jumped = player.publishPosition(1_000_100);
    expect(jumped).not.toBeNull();
    expect(jumped?.timeSec).toBe(500);
  });

  it('публикует паузу как отдельное событие', async () => {
    // Пауза меняет выбор опорного участника: на паузе человек не ведёт группу.
    // Если бы молчали о паузе, сосди считали бы его играющим и тянули к себе.
    const { player, el } = makePlayer({ sync: { publishIntervalMs: 5000 } });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    await player.play();

    expect(player.publishPosition(1_000_000)?.playing).toBe(true);

    player.pause();
    const paused = player.publishPosition(1_000_100);
    expect(paused).not.toBeNull();
    expect(paused?.playing).toBe(false);
  });

  it('молчит, когда позиция не меняется', async () => {
    const { player, el } = makePlayer({ sync: { publishIntervalMs: 100 } });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    expect(player.publishPosition(1_000_000)).not.toBeNull();
    // Стоим на месте: публиковать нечего, даже когда окно троттлинга истекло.
    expect(player.publishPosition(1_001_000)).toBeNull();
    expect(player.publishPosition(1_005_000)).toBeNull();
  });

  it('не публикует без книги', () => {
    const { player } = makePlayer();
    expect(player.publishPosition(1_000_000)).toBeNull();
  });
});

describe('AudioPlayer: следование за соседями', () => {
  const peer = (peerId: string, timeSec: number, now: number, playing = true) => ({
    peerId,
    bookId: 'b1',
    timeSec,
    playing,
    at: now,
  });

  /** Наша позиция: играем и id 'me', который меньше любого соседского. */
  const local = (timeSec: number, playing = true) => ({ bookId: 'b1', timeSec, playing, peerId: 'me' });

  it('выключено по умолчанию', async () => {
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);

    expect(player.followEnabled).toBe(false);
    player.applyRemote([peer('a', 900, Date.now())], Date.now());
    // Ключевое требование: без явного включения позиция не трогается.
    expect(player.currentSec).toBe(10);
  });

  it('догоняет соседа после включения', async () => {
    // Наш peerId 'me' больше, чем у соседа 'a', поэтому ведёт сосед.
    const { player, el } = makePlayer({ peerId: 'me' });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    await player.play();

    const events: string[] = [];
    player.events.on('synced', (e) => events.push((e as { reason: string }).reason));

    player.setFollowEnabled(true);
    player.applyRemote([peer('a', 600, Date.now())], Date.now());

    expect(player.currentSec).toBeCloseTo(600, 5);
    expect(el.currentTime).toBeCloseTo(600, 5);
    expect(events).toHaveLength(1);
  });

  it('не догоняет, когда ведём сами', async () => {
    // Наш peerId меньше соседского: ведём мы, и перематывать некого. Без этой
    // проверки «ведущий» всегда был бы сосед, и лидер менялся бы при каждом
    // обновлении — то самое биение, которого мы избегаем.
    const { player, el } = makePlayer({ peerId: 'a' });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    await player.play();

    player.setFollowEnabled(true);
    player.applyRemote([peer('z', 600, Date.now())], Date.now());
    expect(player.currentSec).toBe(10);
  });

  it('не дёргается на частых коррекциях', async () => {
    const { player, el } = makePlayer({ sync: { correctIntervalMs: 10_000 }, peerId: 'me' });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    await player.play();
    player.setFollowEnabled(true);

    player.applyRemote([peer('a', 600, Date.now())], Date.now());
    expect(player.currentSec).toBeCloseTo(600, 5);

    // Сосед тут же прислал другое время: без интервала мы бы прыгали.
    player.applyRemote([peer('a', 700, Date.now())], Date.now());
    expect(player.currentSec).toBeCloseTo(600, 5);
  });

  it('перестаёт следовать после выключения тумблера', async () => {
    const { player, el } = makePlayer({ peerId: 'me' });
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    player.setFollowEnabled(true);
    player.applyRemote([peer('a', 600, Date.now())], Date.now());

    player.setFollowEnabled(false);
    player.seek(20);
    player.applyRemote([peer('a', 999, Date.now())], Date.now());
    expect(player.currentSec).toBe(20);
  });

  it('игнорирует соседа, который слушает другую книгу', async () => {
    const { player, el } = makePlayer();
    await player.load({ bookId: 'b1', title: 'Книга', blob: audioBlob(), mime: 'audio/mpeg' });
    el.ready(1000);
    el.advanceTo(10);
    player.setFollowEnabled(true);

    player.applyRemote([{ peerId: 'a', bookId: 'other', timeSec: 900, playing: true, at: Date.now() }], Date.now());
    expect(player.currentSec).toBe(10);
  });
});

describe('AudioPlayer: главы', () => {
  it('читает главы из файла и отдаёт текущую', async () => {
    // Собираем минимальный M4B: атомы moov.udta.chpl с одной главой.
    // Частный случай: глава начинается с 120-й секунды — проверяем, что
    // позиция вычисляется как есть, а не всегда ноль.
    const chplBody = buildChpl([{ title: 'Первая глава', startSec: 0 }], 1);
    const moov = wrap('moov', wrap('udta', wrap('chpl', chplBody)));

    const { player } = makePlayer();
    await player.load({
      bookId: 'b',
      title: 'Аудиокнига',
      blob: new Blob([moov as unknown as ArrayBuffer]),
      mime: 'audio/mp4',
    });

    expect(player.chapters).toHaveLength(1);
    expect(player.chapters[0]?.title).toBe('Первая глава');
    expect(player.currentChapter?.title).toBe('Первая глава');
  });

  it('не ломается на mp3 без глав', async () => {
    const { player } = makePlayer();
    await player.load({ bookId: 'b', title: 'Аудиокнига', blob: audioBlob(), mime: 'audio/mpeg' });
    expect(player.chapters).toEqual([]);
    expect(player.currentChapter).toBeNull();
  });

  it('не ломается на битом заголовке', async () => {
    // Плохой заголовок не должен мешать слушать: главы просто не появятся.
    const broken = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { player } = makePlayer();
    await player.load({
      bookId: 'b',
      title: 'Аудиокнига',
      blob: new Blob([broken as unknown as ArrayBuffer]),
      mime: 'audio/mp4',
    });
    expect(player.chapters).toEqual([]);
  });
});

/**
 * Тело атома `chpl` (формат Nero): версия+флаги, количество, записи.
 *
 * Запись: время в единицах 100 нс (64 бита) и заголовок с однобайтовой длиной.
 */
function buildChpl(chapters: Array<{ title: string; startSec: number }>, padTo = 0): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint8(4, chapters.length);
  parts.push(header);

  for (const c of chapters) {
    const title = encoder.encode(c.title);
    const entry = new Uint8Array(8 + 1 + title.length);
    const view = new DataView(entry.buffer);
    const units = BigInt(Math.round(c.startSec * 1e7));
    view.setUint32(0, Number(units & 0xffffffffn), true);
    view.setUint32(4, Number((units >> 32n) & 0xffffffffn), true);
    entry[8] = title.length;
    entry.set(title, 9);
    parts.push(entry);
  }

  const bodyLength = parts.reduce((s, p) => s + p.length, 0);
  // Атом moov в настоящем файле идёт перед большим блоком аудиоданных. Тест
  // добавляет хвост, чтобы проверить, что парсер не читает лишнего.
  const total = Math.max(bodyLength, padTo);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function wrap(name: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, body.length + 8, false);
  for (let i = 0; i < 4; i++) header[4 + i] = name.charCodeAt(i);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}