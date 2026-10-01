/**
 * Сквозной тест синхронизации воспроизведения между двумя участниками.
 *
 * Что проверяем (и почему это не проверяется в юнит-тестах ядра):
 *
 *   1. Позиция одного пира доходит до другого через awareness и превращается в
 *      перемотку — то есть работает связка player → presence → player.
 *   2. Решение о перемотке принимает ИМЕННО тот, кто отстал, а не оба сразу.
 *   3. Выключенный тумблер не даёт перемотать даже при большом расхождении, и
 *      при этом чужая позиция всё равно видна в списке участников.
 *   4. Перемотка на комментарий по таймкоду работает и не путается с
 *      текстовыми комментариями.
 *
 * Awareness здесь настоящий (y-protocols), но вместо сети он снимается
 * напрямую: проверяется логика раскладки по двум документам, а не транспорт,
 * который уже покрыт в packages/p2p/tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { RoomDoc } from '@rd/library';
import { AudioPlayer, type MediaElementLike } from '../src/audio-player.js';
import type { RemotePosition } from '../src/audio-core.js';

/**
 * Элемент с ручным управлением.
 *
 * События шлются по-настоящему: без них плеер не переходит в состояние
 * 'playing', и синхронизация молча перестаёт работать — а ведь именно это
 * поведение проверяет тест.
 */
class FakeMedia implements MediaElementLike {
  src = '';
  preload = '';
  volume = 1;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  error: { code: number; message: string } | null = null;

  readonly #listeners = new Map<string, Array<(ev: unknown) => void>>();

  play(): Promise<void> {
    this.paused = false;
    this.#emit('play');
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.#emit('pause');
  }

  load(): void {}

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

  ready(durationSec: number): void {
    this.duration = durationSec;
    this.#emit('loadedmetadata');
  }

  at(t: number): void {
    this.currentTime = t;
  }

  #emit(type: string): void {
    for (const handler of [...(this.#listeners.get(type) ?? [])]) handler({ type });
  }
}

interface Peer {
  name: string;
  doc: Y.Doc;
  awareness: Awareness;
  player: AudioPlayer;
  el: FakeMedia;
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

async function makePeer(name: string, color: string): Promise<Peer> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const el = new FakeMedia();
  const peerId = `peer-${name}`;
  // peerId обязателен: без него плеер не участвует в выборе ведущего, и в паре
  // оба считали бы лидером друг друга (см. decideSync).
  const player = new AudioPlayer({ createElement: () => el as unknown as MediaElementLike, peerId });
  awareness.setLocalStateField('user', { name, color, peerId });
  await player.load({ bookId: 'book', title: 'Аудиокнига', blob: new Blob([new Uint8Array(64)]), mime: 'audio/mpeg' });
  el.ready(7200);

  cleanup.push(() => {
    player.destroy();
    awareness.destroy();
    doc.destroy();
  });
  return { name, doc, awareness, player, el };
}

/** Прокидывает awareness от отправителя получателю. */
function pipeAwareness(from: Peer, to: Peer): void {
  applyAwarenessUpdate(to.awareness, encodeAwarenessUpdate(from.awareness, [from.doc.clientID]), 'remote');
}

/**
 * Собирает список позиций соседей — ровно так, как это делает RoomSession.
 * Вынесено отдельно, потому что RoomSession тянет за собой WebRTC.
 */
function readRemotes(peer: Peer, bookId: string): RemotePosition[] {
  const out: RemotePosition[] = [];
  for (const [clientId, raw] of peer.awareness.getStates()) {
    if (clientId === peer.doc.clientID) continue;
    const s = raw as { user?: { peerId?: string }; audio?: { bookId?: unknown; timeSec?: unknown; playing?: unknown; updatedAt?: unknown } };
    const peerId = s.user?.peerId;
    const audio = s.audio;
    if (peerId === undefined || peerId === '') continue;
    if (audio === undefined || typeof audio !== 'object') continue;
    if (typeof audio.bookId !== 'string' || audio.bookId === '') continue;
    const timeSec = Number(audio.timeSec);
    if (!Number.isFinite(timeSec) || timeSec < 0) continue;
    // Без метки времени позицию игнорируем: по ней считается компенсация
    // задержки, и без неё мы бы догоняли устаревшую позицию как свежую.
    const updatedAt = Number(audio.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    out.push({ peerId, bookId: audio.bookId, timeSec, playing: audio.playing === true, at: updatedAt });
  }
  return out;
}

/** Публикует позицию игрока в awareness — как это делает syncAudioPositions. */
function publish(peer: Peer, now: number): void {
  const p = peer.player.publishPosition(now);
  if (p === null) return;
  peer.awareness.setLocalStateField('audio', {
    bookId: p.bookId,
    timeSec: p.timeSec,
    playing: p.playing,
    follow: peer.player.followEnabled,
    updatedAt: now,
  });
}

describe('синхронизация позиции между участниками', () => {
  it('доставляет позицию и перематывает отставшего', async () => {
    const anna = await makePeer('Аня', '#3b82f6');
    const boris = await makePeer('Борис', '#f59e0b');

    // Борис ушёл далеко вперёд и играет.
    boris.el.at(3600);
    await boris.player.play();
    publish(boris, 1_000_000);

    // Аня отстаёт. Сначала объявляется своя позиция, потом принимается чужая —
    // ровно так, как это делает syncAudioPositions.
    anna.el.at(10);
    publish(anna, 1_000_100);
    pipeAwareness(boris, anna);

    // По умолчанию не трогаем — это требование продукта.
    anna.player.applyRemote(readRemotes(anna, 'book'), 1_000_200);
    expect(anna.player.positionSec).toBe(10);

    anna.player.setFollowEnabled(true);
    // Первая коррекция сразу после включения: последней ещё не было, а
    // ждать пять секунд ради первого же шага незачем.
    anna.player.applyRemote(readRemotes(anna, 'book'), 1_000_300);
    expect(anna.player.positionSec).toBeCloseTo(3600, 0);
  });

  it('перематывает только отставшего, а не обоих', async () => {
    // Имена подобраны так, чтобы peerId «peer-А» оказался меньше «peer-Б»:
    // именно тогда А становится опорным по правилу выбора лидера.
    const a = await makePeer('А', '#111');
    const b = await makePeer('Б', '#222');
    const now = 1_000_000;

    a.el.at(100);
    b.el.at(500);
    await a.player.play();
    await b.player.play();
    a.player.setFollowEnabled(true);
    b.player.setFollowEnabled(true);

    publish(a, now);
    publish(b, now);
    pipeAwareness(a, b);
    pipeAwareness(b, a);

    // Каждый смотрит на чужую позицию. Время застывает на `now`: иначе
    // компенсация задержки отсчитала бы лишние секунды.
    a.player.applyRemote(readRemotes(a, 'book'), now);
    b.player.applyRemote(readRemotes(b, 'book'), now);

    // Опорный выбирается по минимальному peerId, а не по позиции: иначе А
    // тянул бы Б назад, Б тянул бы А вперёд, и оба скакали бы навстречу друг
    // другу. А остался на месте, Б перемотался к нему.
    expect(a.player.positionSec).toBe(100);
    expect(b.player.positionSec).toBeCloseTo(100, 5);
  });

  it('показывает чужую позицию, даже когда не следует за ней', async () => {
    const anna = await makePeer('Аня', '#111');
    const boris = await makePeer('Борис', '#222');
    const now = 1_000_000;

    boris.el.at(1234);
    await boris.player.play();
    publish(boris, now);
    pipeAwareness(boris, anna);

    // Тумблер выключен: плеер не дёргается…
    anna.player.setFollowEnabled(false);
    anna.player.applyRemote(readRemotes(anna, 'book'), now + 30_000);
    expect(anna.player.positionSec).toBe(0);

    // …но позиция видна в списке участников: человек должен знать, где коллеги.
    const remotes = readRemotes(anna, 'book');
    expect(remotes).toHaveLength(1);
    expect(remotes[0]?.timeSec).toBe(1234);
    expect(remotes[0]?.peerId).toBe('peer-Борис');
  });

  it('различает паузу соседа как состояние, а не как позицию', async () => {
    const anna = await makePeer('Аня', '#111');
    const boris = await makePeer('Борис', '#222');
    const now = 1_000_000;

    boris.el.at(500);
    await boris.player.play();
    publish(boris, now);
    boris.player.pause();
    // Пауза публикуется сразу: на паузе человек не ведёт группу.
    publish(boris, now + 100);

    pipeAwareness(boris, anna);
    const remotes = readRemotes(anna, 'book');
    expect(remotes[0]?.playing).toBe(false);
  });

  it('игнорирует позицию соседа по другой книге', async () => {
    const anna = await makePeer('Аня', '#111');
    const boris = await makePeer('Борис', '#222');
    const now = 1_000_000;

    anna.player.setFollowEnabled(true);
    boris.el.at(500);
    await boris.player.play();
    const p = boris.player.publishPosition(now);
    expect(p).not.toBeNull();
    // Вручную ставим чужую книгу: так выглядит рассинхронизация каталога.
    boris.awareness.setLocalStateField('audio', {
      bookId: 'другая-книга',
      timeSec: 500,
      playing: true,
      follow: true,
      updatedAt: now,
    });
    pipeAwareness(boris, anna);

    anna.player.applyRemote(readRemotes(anna, 'book'), now + 30_000);
    expect(anna.player.positionSec).toBe(0);
  });

  it('не падает на мусорных данных из awareness', async () => {
    // Пир с ключом может прислать что угодно. Публикация правок не доверяет
    // значениям — иначе один сломанный клиент портит интерфейс всем.
    const anna = await makePeer('Аня', '#111');
    const evil = await makePeer('Сбой', '#f00');
    const now = 1_000_000;

    anna.player.setFollowEnabled(true);
    for (const junk of [
      { timeSec: Number.NaN, playing: true, updatedAt: now },
      { timeSec: -100, playing: true, updatedAt: now },
      { timeSec: 'много', playing: true, updatedAt: now },
      { timeSec: 500, playing: true },
      { timeSec: 500, playing: true, updatedAt: 'вчера' },
    ]) {
      evil.awareness.setLocalStateField('audio', { bookId: 'book', ...junk });
      pipeAwareness(evil, anna);
      expect(() => anna.player.applyRemote(readRemotes(anna, 'book'), now + 30_000)).not.toThrow();
      expect(anna.player.positionSec).toBe(0);
    }
  });
});

describe('комментарии по таймкоду', () => {
  it('привязывает комментарий к секунде и восстанавливает её', async () => {
    const doc = new Y.Doc();
    const room = new RoomDoc(doc);
    cleanup.push(() => room.destroy());

    const bookId = room.addBook({
      title: 'Аудиокнига',
      author: '',
      format: 'audio',
      size: 100,
      mime: 'audio/mpeg',
      root: 'a'.repeat(64),
      addedBy: 'me',
      durationSec: 7200,
      note: '',
    });

    const id = room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 3661.5, quote: '— Здравствуйте!' },
      body: 'Здесь смешно',
      authorId: 'me',
      authorName: 'Аня',
    });

    const got = room.comment(id);
    expect(got?.anchor.kind).toBe('audio');
    if (got?.anchor.kind !== 'audio') throw new Error('якорь не того вида');
    expect(got.anchor.timeSec).toBe(3661.5);
    expect(got.anchor.quote).toBe('— Здравствуйте!');
    expect(got.bookId).toBe(bookId);
  });

  it('учитывает таймкод при прогрессе и спойлерах', async () => {
    // Проверяем, что аудио-якорь честно живёт в общей шкале прогресса, а не в
    // отдельной: иначе спойлер в конце записи скрылся бы навсегда.
    const { BookIndex } = await import('@rd/library');
    const doc = new Y.Doc();
    const room = new RoomDoc(doc);
    const bookId = room.addBook({
      title: 'Аудиокнига',
      author: '',
      format: 'audio',
      size: 100,
      mime: 'audio/mpeg',
      root: 'b'.repeat(64),
      addedBy: 'me',
      durationSec: 3600,
      note: '',
    });
    room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 1800 },
      body: 'Спойлер',
      authorId: 'me',
      authorName: 'Аня',
      spoiler: true,
    });
    cleanup.push(() => room.destroy());

    // Пустой документ как «книга»: у аудио глав нет, но шкала времени есть.
    const index = new BookIndex({ title: '', author: '', language: '', coverHref: null, chapters: [], toc: [], totalBlocks: 0 });
    const [comment] = room.commentsForBook(bookId);
    expect(comment).toBeDefined();
    if (comment === undefined) throw new Error('нет комментария');

    // Пока не дослушали до середины — спойлер скрыт.
    expect(index.progressOfAnchor(comment.anchor, 3600)).toBeCloseTo(0.5, 5);
    expect(index.progressOfAnchor(comment.anchor, 3600)).toBeGreaterThan(0.4);
  });

  it('не путает аудио-комментарии с текстовыми при сортировке', async () => {
    const doc = new Y.Doc();
    const room = new RoomDoc(doc);
    cleanup.push(() => room.destroy());

    const bookId = room.addBook({
      title: 'Аудиокнига',
      author: '',
      format: 'audio',
      size: 100,
      mime: 'audio/mpeg',
      root: 'c'.repeat(64),
      addedBy: 'me',
      durationSec: 100,
      note: '',
    });
    room.addComment({ bookId, anchor: { kind: 'audio', timeSec: 90 }, body: 'в конце', authorId: 'a', authorName: 'А' });
    room.addComment({ bookId, anchor: { kind: 'audio', timeSec: 10 }, body: 'в начале', authorId: 'a', authorName: 'А' });
    room.addComment({
      bookId,
      anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 1, quote: 'x', prefix: '', suffix: '' },
      body: 'текстовый',
      authorId: 'a',
      authorName: 'А',
    });

    const all = room.commentsForBook(bookId);
    // Панель показывает все три. Порядок задаётся временем создания, а оно у
    // комментариев, добавленных подряд, совпадает — поэтому сравниваем множество,
    // а не последовательность.
    expect(all).toHaveLength(3);
    expect(new Set(all.map((c) => c.body))).toEqual(new Set(['в начале', 'в конце', 'текстовый']));

    // Плеер сортирует по таймкоду сам: список заметок по записи идёт по хронологии
    // звучания, а не по хронологии их написания.
    const audio = all.filter((c) => c.anchor.kind === 'audio');
    expect(audio).toHaveLength(2);
    const byTime = [...audio]
      .sort((x, y) => (x.anchor.kind === 'audio' ? x.anchor.timeSec : 0) - (y.anchor.kind === 'audio' ? y.anchor.timeSec : 0))
      .map((c) => c.body);
    expect(byTime).toEqual(['в начале', 'в конце']);
  });
});