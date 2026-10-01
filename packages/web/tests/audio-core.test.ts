/**
 * Тесты ядра аудиоплеера: форматирование, мягкая синхронизация, главы M4B.
 *
 * Ядро намеренно не знает про DOM — иначе его пришлось бы проверять браузером.
 * Здесь достаточно чистых данных на входе и выхода.
 */

import { describe, expect, it } from 'vitest';
import {
  chapterAt,
  decideSync,
  formatDuration,
  formatFraction,
  formatTimecode,
  parseM4bChapters,
  progressPercent,
  SYNC_DEFAULTS,
  type RemotePosition,
} from '../src/audio-core.js';

const NOW = 1_000_000;

function remote(peerId: string, timeSec: number, opts: { playing?: boolean; ageMs?: number; bookId?: string } = {}): RemotePosition {
  return {
    peerId,
    bookId: opts.bookId ?? 'book-1',
    timeSec,
    playing: opts.playing ?? true,
    at: NOW - (opts.ageMs ?? 0),
  };
}

describe('форматирование времени', () => {
  it('показывает часы только когда они есть', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(605)).toBe('10:05');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(36000)).toBe('10:00:00');
  });

  it('не падает на мусоре', () => {
    // Значения из чужого presence недоверенные: NaN и отрицательные реальны.
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatDuration(-10)).toBe('0:00');
  });

  it('отделяет дробную часть точкой, а не запятой', () => {
    // Запятая занята десятичным разделителем в счётчике, поэтому дробная часть
    // показывается точкой.
    expect(formatFraction(12.5)).toBe('.50');
    expect(formatFraction(12.07)).toBe('.07');
    expect(formatFraction(12)).toBe('');
    expect(formatFraction(12.001)).toBe('');
    expect(formatTimecode(65.5, true)).toBe('1:05,5');
    expect(formatTimecode(65)).toBe('1:05');
    expect(formatTimecode(3665.25, true)).toBe('1:01:05,2');
  });

  it('считает процент прохождения с зажимом', () => {
    expect(progressPercent(0, 100)).toBe(0);
    expect(progressPercent(50, 100)).toBe(50);
    expect(progressPercent(150, 100)).toBe(100);
    expect(progressPercent(-5, 100)).toBe(0);
    // Длительность ещё неизвестна: показываем ноль, а не деление на ноль.
    expect(progressPercent(10, 0)).toBe(0);
    expect(progressPercent(10, Number.NaN)).toBe(0);
  });
});

describe('мягкая синхронизация', () => {
  const base = { enabled: true, bookId: 'book-1', lastCorrectAt: null, now: NOW };

  it('выключена по умолчанию и не двигает позицию', () => {
    // Это требование продукта: включение только явным тумблером.
    const d = decideSync({
      ...base,
      enabled: false,
      local: { bookId: 'book-1', timeSec: 10, playing: true },
      remotes: [remote('a', 500)],
    });
    expect(d.action).toBe('none');
    expect(d.seekToSec).toBe(10);
  });

  it('догоняет, когда отстали', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 10, playing: true },
      remotes: [remote('a', 300)],
    });
    expect(d.action).toBe('seek');
    expect(d.seekToSec).toBeCloseTo(300, 5);
    expect(d.leaderId).toBe('a');
  });

  it('не дёргается на малом расхождении', () => {
    // Задержка сети даёт расхождение в доли секунды постоянно. Если на него
    // реагировать, плеер будет прыгать непрерывно.
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 100, playing: true },
      remotes: [remote('a', 102)],
    });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('нормы');
  });

  it('учитывает задержку сети при сравнении', () => {
    // Пир опубликовал позицию 2 секунды назад и всё это время играл.
    // Без компенсации мы бы увидели отставание и дёрнулись назад.
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 100, playing: true },
      remotes: [remote('a', 100, { ageMs: 2000 })],
    });
    expect(d.action).toBe('none');
  });

  it('не догоняет назад по умолчанию выключенной опцией', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 900, playing: true },
      remotes: [remote('a', 100)],
      options: { followBackwards: false },
    });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('назад');
  });

  it('тянет назад, если опция включена', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 900, playing: true },
      remotes: [remote('a', 100)],
      options: { followBackwards: true },
    });
    expect(d.action).toBe('seek');
    expect(d.seekToSec).toBeCloseTo(100, 5);
  });

  it('выбирает опорного детерминированно, а не случайно', () => {
    // Три пира с разными позициями. Если бы выбор зависел от порядка прихода
    // сообщений, позиция скакала бы. Минимальный peerId — стабильный выбор.
    const remotes = [remote('m', 500), remote('a', 100), remote('z', 900)];
    const local = { bookId: 'book-1', timeSec: 50, playing: true };
    const first = decideSync({ ...base, local, remotes });
    const second = decideSync({ ...base, local, remotes: [...remotes].reverse() });
    expect(first.leaderId).toBe('a');
    expect(second.leaderId).toBe('a');
    expect(first.seekToSec).toBe(second.seekToSec);
  });

  it('игнорирует пира на паузе как кандидата в лидеры', () => {
    // Человек, который остановился, не должен быть ориентиром: он слушает
    // не то, что играет.
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 10, playing: true },
      remotes: [remote('a', 5, { playing: false }), remote('b', 400)],
    });
    expect(d.leaderId).toBe('b');
  });

  it('игнорирует другую книгу', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 10, playing: true },
      remotes: [remote('a', 900, { bookId: 'other-book' })],
    });
    expect(d.action).toBe('none');
    expect(d.listeners).toBe(1);
  });

  it('не корректирует чаще заданного интервала', () => {
    // Защита от биения: два пира присылают позиции с разницей в полсекунды,
    // и без интервала они бы «напилили» друг на друга перемотку.
    const remotes = [remote('a', 500)];
    const local = { bookId: 'book-1', timeSec: 10, playing: true };
    const first = decideSync({ ...base, local, remotes });
    expect(first.action).toBe('seek');

    const soon = decideSync({
      ...base,
      local,
      remotes,
      lastCorrectAt: NOW - 1_000,
      options: { correctIntervalMs: SYNC_DEFAULTS.correctIntervalMs },
    });
    expect(soon.action).toBe('none');
    expect(soon.reason).toContain('корректировали');
  });

  it('не ограничен, когда прошло достаточно времени', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 10, playing: true },
      remotes: [remote('a', 500)],
      lastCorrectAt: NOW - SYNC_DEFAULTS.correctCooldownMs - 1_000,
    });
    expect(d.action).toBe('seek');
  });

  it('не двигается, когда играть некому', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 10, playing: false },
      remotes: [remote('a', 5, { playing: false })],
    });
    expect(d.action).toBe('none');
    expect(d.reason).toContain('никто не слушает');
  });

  it('не дёргает пустое или нечисловое смещение', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 10, playing: true },
      remotes: [remote('a', Number.NaN)],
    });
    expect(d.action).toBe('none');
  });

  it('считает слушателей, включая нас', () => {
    const d = decideSync({
      ...base,
      local: { bookId: 'book-1', timeSec: 10, playing: true },
      remotes: [remote('a', 11), remote('b', 12), remote('c', 13, { playing: false })],
    });
    // Четверо в комнате, но вести позицию готовы двое из них плюс мы.
    expect(d.listeners).toBe(4);
    expect(d.leaderId).toBe('a');
  });

  it('не работает без открытой книги', () => {
    const d = decideSync({
      ...base,
      bookId: null,
      local: { bookId: null, timeSec: 0, playing: false },
      remotes: [remote('a', 500)],
    });
    expect(d.action).toBe('none');
  });
});

describe('главы M4B', () => {
  /**
   * Собирает контейнер MP4 с атомом `moov.udta.chpl` вручную.
   *
   * Настоящий .m4b весит сотни мегабайт и в репозиторий не положишь, а формат
   * `chpl` достаточно мал, чтобы воспроизвести его побайтово.
   */
  function buildM4b(chapters: Array<{ title: string; startSec: number }>, name = 'chpl'): Uint8Array {
    const encoder = new TextEncoder();
    const entries: number[] = [];
    for (const c of chapters) {
      const titleBytes = encoder.encode(c.title);
      const units = BigInt(Math.round(c.startSec * 1e7));
      const buf = new ArrayBuffer(8 + 1 + titleBytes.length);
      const view = new DataView(buf);
      view.setUint32(0, Number(units & 0xffffffffn), true);
      view.setUint32(4, Number((units >> 32n) & 0xffffffffn), true);
      view.setUint8(8, titleBytes.length);
      new Uint8Array(buf, 9).set(titleBytes);
      entries.push(...new Uint8Array(buf));
    }

    // chpl: версия+флаги (4), количество (1), записи.
    const chplBody = new Uint8Array(5 + entries.length);
    const chplView = new DataView(chplBody.buffer);
    chplView.setUint8(0, 1); // версия
    chplView.setUint8(4, chapters.length);
    chplBody.set(entries, 5);

    return buildAtoms([
      { name: 'moov', children: [{ name: 'udta', children: [{ name, body: chplBody }] }] },
    ]);
  }

  /** Вложенные атомы MP4: каждый — 4 байта размера, 4 байта имени, данные. */
  function buildAtoms(list: Array<{ name: string; children?: Array<{ name: string; children?: unknown[] }>; body?: Uint8Array }>): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (const item of list) {
      let body: Uint8Array;
      if (item.body !== undefined) {
        body = item.body;
      } else {
        body = buildAtoms(item.children as Array<{ name: string; body?: Uint8Array }>);
      }
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint32(0, body.length + 8, false);
      for (let i = 0; i < 4; i++) header[4 + i] = item.name.charCodeAt(i);
      chunks.push(header, body);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  it('читает главы из chpl', () => {
    const bytes = buildM4b([
      { title: 'Глава 1', startSec: 0 },
      { title: 'Глава 2', startSec: 615 },
      { title: 'Глава 3', startSec: 1800.5 },
    ]);
    const chapters = parseM4bChapters(bytes);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]?.title).toBe('Глава 1');
    expect(chapters[1]?.title).toBe('Глава 2');
    expect(chapters[1]?.startSec).toBeCloseTo(615, 4);
    expect(chapters[2]?.startSec).toBeCloseTo(1800.5, 4);
  });

  it('возвращает пустой список, если глав нет', () => {
    // Обычный mp3 без заголовков — самый частый случай.
    expect(parseM4bChapters(new Uint8Array(1024))).toEqual([]);
  });

  it('не падает на мусоре вместо контейнера', () => {
    expect(parseM4bChapters(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x41, 0x42, 0x43, 0x44]))).toEqual([]);
    expect(parseM4bChapters(new Uint8Array(0))).toEqual([]);
  });

  it('не падает на обрезанном файле', () => {
    // Файл мог прийти битым или передача прервалась. Разбор не должен ронять
    // плеер — максимум не будет списка глав.
    const full = buildM4b([{ title: 'Очень длинное название главы', startSec: 10 }]);
    for (const cut of [9, 12, 20, full.length - 1]) {
      expect(Array.isArray(parseM4bChapters(full.subarray(0, cut)))).toBe(true);
    }
  });

  it('сортирует главы по времени', () => {
    // Nero иногда пишет не по порядку; плеер требует возрастания меток.
    const bytes = buildM4b([
      { title: 'Вторая', startSec: 500 },
      { title: 'Первая', startSec: 0 },
    ]);
    const chapters = parseM4bChapters(bytes);
    expect(chapters.map((c) => c.startSec)).toEqual([0, 500]);
  });

  it('находит главу по времени', () => {
    const chapters = [
      { title: '1', startSec: 0 },
      { title: '2', startSec: 100 },
      { title: '3', startSec: 200 },
    ];
    expect(chapterAt(chapters, 0)?.title).toBe('1');
    expect(chapterAt(chapters, 99)?.title).toBe('1');
    expect(chapterAt(chapters, 100)?.title).toBe('2');
    expect(chapterAt(chapters, 10_000)?.title).toBe('3');
    expect(chapterAt([], 5)).toBeNull();
  });
});