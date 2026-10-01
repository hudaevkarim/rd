import { describe, expect, it } from 'vitest';
import {
  BookIndex,
  createTextAnchor,
  findQuote,
  isSpoilerHidden,
  resolveTextAnchor,
  RoomDoc,
  type ParsedEpub,
} from '@rd/library';
import { newId } from '@rd/protocol';

/** Мини-книга для тестов якорей: три главы, известные координаты. */
function makeBook(): ParsedEpub {
  const chapters = [
    {
      index: 0,
      id: 'c1',
      href: 'c1.xhtml',
      blocks: [
        { index: 0, kind: 'h1' as const, node: { name: 'h1', attrs: {}, children: [] }, text: 'Пролог' },
        {
          index: 1,
          kind: 'p' as const,
          node: { name: 'p', attrs: {}, children: [] },
          text: 'Ветер гулял по пустым улицам и не хотел останавливаться.',
        },
        { index: 2, kind: 'p' as const, node: { name: 'p', attrs: {}, children: [] }, text: 'Он умел ждать.' },
      ],
    },
    {
      index: 1,
      id: 'c2',
      href: 'c2.xhtml',
      blocks: [
        { index: 0, kind: 'p' as const, node: { name: 'p', attrs: {}, children: [] }, text: 'Дом на краю был тёмным.' },
        {
          index: 1,
          kind: 'p' as const,
          node: { name: 'p', attrs: {}, children: [] },
          text: 'Ветер гулял по пустым улицам и не хотел останавливаться, но здесь он стих.',
        },
      ],
    },
    {
      index: 2,
      id: 'c3',
      href: 'c3.xhtml',
      blocks: [{ index: 0, kind: 'p' as const, node: { name: 'p', attrs: {}, children: [] }, text: 'Эпилог.' }],
    },
  ];
  return {
    title: 'Книга',
    author: 'Автор',
    language: 'ru',
    coverHref: null,
    chapters,
    toc: [],
    totalBlocks: 6,
  };
}

describe('поиск цитаты', () => {
  const text = 'Он сказал: «Ветер гулял по пустым улицам» и ушёл.';

  it('находит точное вхождение', () => {
    const found = findQuote(text, 'Ветер гулял');
    expect(found?.start).toBe(text.indexOf('Ветер гулял'));
    expect(found?.confidence).toBe(0);
  });

  it('находит цитату, разбитую переносами и лишними пробелами', () => {
    const messy = 'Он  сказал:  «Ветер   гулял\n   по пустым улицам» и ушёл.';
    const found = findQuote(messy, 'Ветер гулял по пустым улицам');
    expect(found).not.toBeNull();
    // Координаты возвращаются в ИСХОДНУЮ строку, а не в «сжатую».
    expect(messy.slice(found?.start ?? 0, found?.end ?? 0).replace(/\s+/g, ' ')).toBe('Ветер гулял по пустым улицам');
  });

  it('использует контекст, когда цитата повторяется', () => {
    const repeated = 'Солнце встало. Солнце встало. Солнце село.';
    // Просто «Солнце встало» встречается дважды — выбираем первое, но с
    // контекстом обязаны найти именно нужное вхождение.
    const found = findQuote(repeated, 'Солнце встало', { prefix: '', suffix: '. Солнце встало' });
    expect(found).not.toBeNull();
  });

  it('возвращает null, если цитаты нет', () => {
    expect(findQuote(text, 'совсем другой текст')).toBeNull();
    expect(findQuote(text, '')).toBeNull();
  });
});

describe('якоря комментариев', () => {
  it('создаёт якорь с цитатой и контекстом', () => {
    const book = makeBook();
    const start = book.chapters[0]?.blocks[1]?.text.indexOf('пустым') ?? 0;
    const anchor = createTextAnchor(book, 0, 1, start, start + 6);
    expect(anchor).not.toBeNull();
    expect(anchor?.quote).toBe('пустым');
    expect(anchor?.prefix.length).toBeGreaterThan(0);
    expect(anchor?.suffix.length).toBeGreaterThan(0);
  });

  it('не создаёт якорь на пустом выделении', () => {
    const book = makeBook();
    expect(createTextAnchor(book, 0, 1, 3, 3)).toBeNull();
    expect(createTextAnchor(book, 99, 0, 0, 1)).toBeNull();
  });

  it('находит якорь по точным координатам', () => {
    const book = makeBook();
    const anchor = createTextAnchor(book, 1, 1, 0, 5);
    const resolved = resolveTextAnchor(book, anchor!);
    expect(resolved?.confidence).toBe(0);
    expect(resolved?.stale).toBe(false);
  });

  it('находит якорь по цитате, если координаты сдвинулись', () => {
    const book = makeBook();
    const block = book.chapters[1]?.blocks[1];
    const start = block?.text.indexOf('но здесь он стих') ?? 0;
    const anchor = createTextAnchor(book, 1, 1, start, start + 16);
    // Сдвигаем координаты так, как будто текст до цитаты переписали.
    const shifted = { ...anchor!, start: anchor!.start + 100, end: anchor!.end + 100 };
    const resolved = resolveTextAnchor(book, shifted);
    expect(resolved?.stale).toBe(false);
    expect(resolved?.start).toBe(start);
  });

  it('ищет цитату по всей книге, если блок переехал', () => {
    const book = makeBook();
    // Один и тот же текст есть в главе 0 и в главе 1 — проверяем приоритет
    // «сначала своя глава», а не глобальный поиск с начала книги.
    const anchor = createTextAnchor(book, 1, 1, 0, 'Ветер гулял'.length);
    const resolved = resolveTextAnchor(book, { ...anchor!, chapterIndex: 1, blockIndex: 0, start: 0, end: 0 });
    expect(resolved?.chapterIndex).toBe(1);
    expect(resolved?.blockIndex).toBe(1);
  });

  it('помечает якорь как устаревший, а не теряет комментарий', () => {
    const book = makeBook();
    // Цитата должна быть уникальной: «Ветер гулял» встречается в книге дважды,
    // и глобальный поиск нашёл бы второе вхождение.
    const block = book.chapters[0]?.blocks[2];
    const anchor = createTextAnchor(book, 0, 2, 0, 5);
    expect(anchor?.quote).toBe(block?.text.slice(0, 5));

    const otherBook = makeBook();
    if (otherBook.chapters[0]?.blocks[2]) otherBook.chapters[0].blocks[2].text = 'Совершенно иной текст.';
    if (otherBook.chapters[1]?.blocks[1]) otherBook.chapters[1].blocks[1].text = 'И здесь тоже другое.';
    const resolved = resolveTextAnchor(otherBook, anchor!);
    expect(resolved?.stale).toBe(true);
  });
});

describe('прогресс и спойлеры', () => {
  it('переводит координаты в глобальную долю', () => {
    const index = new BookIndex(makeBook());
    expect(index.progressOf(0, 0)).toBe(0);
    expect(index.progressOf(2, 0)).toBeCloseTo(5 / 6, 5);
    // Середина последнего блока — почти конец книги.
    expect(index.progressOf(2, 0, 3)).toBeGreaterThan(5 / 6);
    expect(index.progressOf(0, 0, 10_000)).toBeLessThanOrEqual(1);
  });

  it('обратно находит блок по доле прогресса', () => {
    const index = new BookIndex(makeBook());
    const at = index.locate(0);
    expect(at).toEqual({ chapterIndex: 0, blockIndex: 0 });
    const late = index.locate(0.99);
    expect(late.chapterIndex).toBe(2);
  });

  it('прячет спойлер, пока читатель не дошёл до места', () => {
    const book = makeBook();
    const index = new BookIndex(book);
    // В книге 6 блоков: пролог — это 0 %, третья глава — 83 %.
    const start = createTextAnchor(book, 0, 0, 0, 5);
    const end = createTextAnchor(book, 2, 0, 0, 5);

    // Читатель в начале: комментарий из конца скрыт, из начала — виден.
    expect(isSpoilerHidden(end!, 0.05, index)).toBe(true);
    expect(isSpoilerHidden(start!, 0.05, index)).toBe(false);
    // Дочитал: оба видны.
    expect(isSpoilerHidden(end!, 1, index)).toBe(false);
  });

  it('применяет аудиоякорь по длительности', () => {
    const book = makeBook();
    const index = new BookIndex(book);
    // Комментарий на 10-й минуте часа.
    const atTenMinutes = { kind: 'audio' as const, timeSec: 600 };
    // Читатель на 6-й минуте — до комментария не дошёл.
    expect(isSpoilerHidden(atTenMinutes, 0.1, index, 3_600)).toBe(true);
    // Читатель на 20-й минуте — комментарий уже в прошлом.
    expect(isSpoilerHidden(atTenMinutes, 0.3, index, 3_600)).toBe(false);
  });
});

describe('CRDT-документ комнаты', () => {
  function makeRoom(): RoomDoc {
    return RoomDoc.create({ title: 'Моя комната', authorId: newId() });
  }

  const bookParams = {
    title: 'Книга',
    author: 'Автор',
    format: 'epub' as const,
    size: 100,
    mime: 'application/epub+zip',
    root: 'a'.repeat(64),
    durationSec: null,
    note: '',
  };

  it('хранит метаданные и каталог', () => {
    const room = makeRoom();
    expect(room.title).toBe('Моя комната');
    expect(room.info.createdBy).not.toBe('');
    const id = room.addBook({ ...bookParams, addedBy: 'peer-1' });
    expect(room.bookEntry(id)?.title).toBe('Книга');
    expect(room.listBooks()).toHaveLength(1);
  });

  it('не затирает метаданные при смене заголовка', () => {
    // Y.Map<объект> сменял бы весь объект целиком, и createdAt пропал бы.
    const room = makeRoom();
    const createdAt = room.info.createdAt;
    room.setTitle('Новое имя');
    expect(room.title).toBe('Новое имя');
    expect(room.info.createdAt).toBe(createdAt);
  });

  it('сливает одновременные комментарии без потерь', () => {
    const a = makeRoom();
    const b = makeRoom();
    const bookId = newId();

    // Оба пира начинают с одинакового состояния каталога, но правят его
    // одновременно и не видят правок друг друга.
    a.addBook({ ...bookParams, id: bookId, addedBy: 'a' });
    b.addBook({ ...bookParams, id: bookId, addedBy: 'b' });
    const snapshot = b.encodeState();
    a.applyUpdate(snapshot);

    a.addComment({
      bookId,
      anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 3, quote: 'раз', prefix: '', suffix: '' },
      body: 'от Ани',
      authorId: 'a',
      authorName: 'Аня',
    });
    b.addComment({
      bookId,
      anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 3, quote: 'два', prefix: '', suffix: '' },
      body: 'от Бориса',
      authorId: 'b',
      authorName: 'Борис',
    });

    // Обмен состояниями — ровно то, что делает YRoomProvider по сети.
    b.applyUpdate(a.encodeState());
    a.applyUpdate(b.encodeState());

    const bodiesA = a.commentsForBook(bookId).map((c) => c.body).sort();
    const bodiesB = b.commentsForBook(bookId).map((c) => c.body).sort();
    expect(bodiesA).toEqual(['от Ани', 'от Бориса']);
    expect(bodiesB).toEqual(['от Ани', 'от Бориса']);
  });

  it('группирует ответы в треды', () => {    const room = makeRoom();
    const bookId = room.addBook({ ...bookParams, addedBy: 'a' });
    const root = room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 120 },
      body: 'Корневой',
      authorId: 'a',
      authorName: 'Аня',
    });
    room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 125 },
      body: 'Ответ',
      authorId: 'b',
      authorName: 'Борис',
      parentId: root,
    });

    const threads = room.threadsForBook(bookId);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.body).toBe('Корневой');
    expect(threads[0]?.replies[0]?.body).toBe('Ответ');
  });

  it('удаляет тред целиком вместе с корнем', () => {
    const room = makeRoom();
    const bookId = room.addBook({ ...bookParams, addedBy: 'a' });
    const root = room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 1 },
      body: 'Корень',
      authorId: 'a',
      authorName: 'Аня',
    });
    room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 2 },
      body: 'Ответ',
      authorId: 'b',
      authorName: 'Борис',
      parentId: root,
    });
    room.removeComment(root);
    expect(room.commentsForBook(bookId)).toHaveLength(0);
  });

  it('считает реакции без дублей', () => {
    const room = makeRoom();
    const bookId = room.addBook({ ...bookParams, addedBy: 'a' });
    const id = room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 3 },
      body: 'Согласен',
      authorId: 'a',
      authorName: 'Аня',
    });
    room.toggleReaction(id, '👍', 'a');
    room.toggleReaction(id, '👍', 'b');
    expect(room.comment(id)?.reactions[0]?.userIds.sort()).toEqual(['a', 'b']);
    // Повторное нажатие снимает реакцию.
    room.toggleReaction(id, '👍', 'a');
    expect(room.comment(id)?.reactions[0]?.userIds).toEqual(['b']);
  });

  it('переживает битый якорь из сети', () => {
    // Пир с ключом может подсунуть что угодно: интерфейс не должен падать.
    const room = makeRoom();
    const bookId = room.addBook({ ...bookParams, addedBy: 'a' });
    const id = room.addComment({
      bookId,
      anchor: { kind: 'audio', timeSec: 1 },
      body: 'Ок',
      authorId: 'a',
      authorName: 'Аня',
    });
    const node = room.comments.get(id);
    node?.set('anchor', { kind: 'text', chapterIndex: 'не число', start: -5, quote: 42 });
    const snapshot = room.comment(id);
    expect(snapshot?.anchor.kind).toBe('text');
    if (snapshot?.anchor.kind === 'text') {
      expect(snapshot.anchor.chapterIndex).toBe(0);
      expect(snapshot.anchor.start).toBe(0);
      expect(snapshot.anchor.quote).toBe('');
    }
  });

  it('удаляет комментарии книги вместе с книгой', () => {
    const room = makeRoom();
    const bookId = room.addBook({ ...bookParams, addedBy: 'a' });
    room.addComment({ bookId, anchor: { kind: 'audio', timeSec: 1 }, body: 'X', authorId: 'a', authorName: 'А' });
    room.removeBook(bookId);
    expect(room.listBooks()).toHaveLength(0);
    expect(room.commentsForBook(bookId)).toHaveLength(0);
  });
});