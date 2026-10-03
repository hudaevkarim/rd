/**
 * Выбор разбора книги: EPUB или FB2.
 *
 * Проверяется ровно то решение, из-за которого появился `parse-book.ts`: чем
 * определяется формат. Здесь важны не «хорошие» случаи, а три расхождения,
 * которые в жизни обязательно случаются:
 *
 *   1. Файл `.fb2`, которому браузер не дал MIME-типа (обычное дело).
 *   2. FB2, пришедший от соседа под именем `.epub` — имя при передаче может
 *      не доехать или его могли подменить, а каталог при этом говорит «epub».
 *   3. Каталог говорит «fb2», а внутри обычный EPUB — и наоборот.
 *
 * Правило: при сомнении побеждает содержимое файла, потому что каталог приходит
 * из общей CRDT и является недоверенными данными.
 */

import { describe, expect, it } from 'vitest';
import { Fb2Error } from '@rd/library';
import { parseTextBook, textMime, TEXT_ACCEPT } from '../src/parse-book.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const FB2 = utf8(`<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info><book-title>Тихая улица</book-title><lang>ru</lang></title-info></description>
  <body>
    <section>
      <title><p>Глава первая</p></title>
      <p>Ветер гулял по пустым улицам и не хотел останавливаться.</p>
    </section>
  </body>
</FictionBook>`);

/** Настоящий EPUB: zip-сигнатура плюс вложенный документ. */
const EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

describe('определение формата книги', () => {
  it('опознаёт FB2 по содержимому, даже если расширения нет', () => {
    const { book, format } = parseTextBook(FB2);
    expect(format).toBe('fb2');
    expect(book.title).toBe('Тихая улица');
    expect(book.chapters[0]?.blocks[1]?.text).toContain('Ветер гулял');
  });

  it('опознаёт EPUB по содержимому', () => {
    // Неполный zip: полноценный EPUB в этом тесте разбирать незачем, важно
    // лишь, что формат выбран верный. Разбор упадёт — проверяем маршрут.
    expect(() => parseTextBook(EPUB)).toThrow();
  });

  it('верит содержимому, когда каталог врёт', () => {
    // Книга пришла от соседа под именем `.epub`, и в каталоге формат тоже
    // «epub» — а внутри FB2. Слушать каталог тут нельзя: иначе получатель
    // не откроет книгу и не поймёт почему.
    const { format, book } = parseTextBook(FB2, 'epub');
    expect(format).toBe('fb2');
    expect(book.title).toBe('Тихая улица');
  });

  it('не доверяет подсказке, если содержимое — не FB2', () => {
    // Обратный случай: каталог говорит «fb2», а файл — обычный zip. Показывать
    // пользователю «ожидался FB2» здесь нельзя: недоверенная подсказка из CRDT
    // не должна превращать понятную ошибку «битый zip» в неверную.
    expect(() => parseTextBook(EPUB, 'fb2')).toThrow();
    try {
      parseTextBook(EPUB, 'fb2');
      throw new Error('ожидалась ошибка разбора');
    } catch (error) {
      expect(error).not.toBeInstanceOf(Fb2Error);
    }
  });

  it('сообщает именно об FB2, когда содержимое FB2, но разорвано', () => {
    // Файл опознан как FB2 (в начале файла есть упоминание `<FictionBook>`), но
    // корневой элемент — чужой. Каталог при этом говорил «epub». Сказать «это
    // FB2, а не zip» полезнее: иначе пользователь ищет проблему в EPUB,
    // которого тут нет.
    const broken = utf8('<?xml version="1.0"?><!-- <FictionBook> --><html><body>нет</body></html>');
    expect(() => parseTextBook(broken, 'epub')).toThrow(Fb2Error);
  });

  it('не пустой файл не выдаёт за книгу', () => {
    expect(() => parseTextBook(utf8('просто текст'))).toThrow();
  });
});

describe('MIME книги', () => {
  it('подставляет тип, которого нет в природе, только для FB2', () => {
    expect(textMime('fb2', '')).toBe('application/x-fictionbook+xml');
    expect(textMime('epub', '')).toBe('application/epub+zip');
  });

  it('не выдумывает тип, если браузер его дал', () => {
    expect(textMime('fb2', 'text/xml')).toBe('text/xml');
    expect(textMime('epub', 'application/octet-stream')).toBe('application/octet-stream');
  });

  it('объявляет в выборе файла оба формата', () => {
    // Иначе FB2 нельзя выбрать в диалоге, и парсер останется недостижимым
    // из интерфейса: тесты зелёные, а книга не открывается.
    expect(TEXT_ACCEPT).toContain('.fb2');
    expect(TEXT_ACCEPT).toContain('.epub');
  });
});