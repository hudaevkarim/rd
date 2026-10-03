/**
 * Тесты разбора FB2 и определения кодировки.
 *
 * ─── О фикстурах ──────────────────────────────────────────────────────────────
 *
 * Настоящие FB2-файлы здесь не используются: окружение без сети, скачать их
 * негде. Фикстуры собраны вручную и воспроизводят те особенности реальных файлов,
 * из-за которых FB2 и приходится разбирать отдельно:
 *
 *   - однобайтовые кодировки `windows-1251` и `koi8-r` без BOM (типично для
 *     книг с librus.ru и similar);
 *   - UTF-8 с BOM и без, с честным `encoding` в объявлении и вр��д;
 *   - незакрытые `<p>` и «голые» ампersandы — в FB2 это норма, а не исключение;
 *   - `<binary>` с Base64 внутри того же файла;
 *   - `<empty-line/>` между абзацами;
 *   - `<script>`, `<iframe>`, `onload` и `javascript:`-ссылки — то, что FB2
 *     позволяет авторам, а мы не обязаны выполнять.
 *
 * Каждая фикстура проверяется на то же, что делал бы настоящий файл: главы,
 * заголовки, абзацы, оглавление и — главное — инвариант рендерера
 * `text(дерево) === block.text`.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeFb2,
  legacyByteScore,
  looksLikeFb2,
  normalizeEncodingName,
  parseFb2,
  parseFb2Detailed,
  textOf,
  Fb2Error,
} from '@rd/library';

// ─── Фикстуры ──────────────────────────────────────────────────────────────────

/** Минимальный, но структурно честный FB2 в UTF-8. */
const FB2_UTF8 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>prose_contemporary</genre>
      <author><first-name>Анна</first-name><last-name>Иванова</last-name></author>
      <book-title>Тихая улица</book-title>
      <lang>ru</lang>
    </title-info>
    <document-info>
      <author><nickname>oculus</nickname></author>
      <program-used>fb2edit</program-used>
      <date-created>2024-01-02</date-created>
    </document-info>
    <coverpage><image l:href="#cover.jpg"/></coverpage>
  </description>
  <body>
    <section>
      <title><p>Глава первая</p></title>
      <subtitle><p>Утро</p></subtitle>
      <p>Ветер гулял по пустым улицам и не хотел останавливаться.</p>
      <empty-line/>
      <p>Он умел ждать.</p>
      <section>
        <title><p>Подраздел</p></title>
        <p>Внутри главы тоже есть текст.</p>
      </section>
    </section>
    <section>
      <title><p>Глава вторая</p></title>
      <p>Дом на краю был тёмным.</p>
    </section>
  </body>
</FictionBook>`;

/**
 * То же самое, но в windows-1251 и БЕЗ объявления кодировки.
 *
 * Именно так выглядят файлы, из-за которых парсер FB2 нужен отдельный: без
 * BOM и без `encoding=` догадаться о кодировке можно только по содержимому.
 */
const FB2_CP1251 = FB2_UTF8.replace(/<\?xml[^?]*\?>\s*/, '');

/** KOI8-R, тоже без BOM: главная отличие — русские буквы лежат по другим адресам. */
const FB2_KOI8R = FB2_CP1251;

/** UTF-8 с BOM. */
const FB2_UTF8_BOM = `﻿${FB2_UTF8}`;

/** UTF-8, но в объявлении windows-1251 — в объявлении врут часто. */
const FB2_LYING_DECLARATION = FB2_UTF8.replace('encoding="utf-8"', 'encoding="windows-1251"');

/** Объявление называет кодировку, которой нет: разбор обязан разобраться сам. */
const FB2_UNKNOWN_DECLARATION = FB2_UTF8.replace('encoding="utf-8"', 'encoding="x-made-up-866"');

/** С Base64-иллюстрацией внутри файла — как у настоящих книг с картинками. */
const FB2_WITH_BINARY = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info><book-title>Книга с картинками</book-title><lang>ru</lang></title-info>
    <coverpage><image l:href="#cover.jpg"/></coverpage>
  </description>
  <body>
    <section>
      <title><p>Картинки</p></title>
      <p>Перед картинкой.</p>
      <p><image l:href="#pic1.png" alt="Луна над крышами"/></p>
      <binary id="cover.jpg" content-type="image/jpeg">${'A'.repeat(2000)}</binary>
      <binary id="pic1.png" content-type="image/png">${'B'.repeat(4000)}</binary>
      <p>После картинки.</p>
    </section>
  </body>
</FictionBook>`;

/**
 * Невалидная разметка — всё, что реально встречается и ломает строгий XML.
 *
 * Здесь нет ни одной фатальной ошибки: непарных `<p>`, «голый» ампersand,
 * `<!DOCTYPE>` с внутренним подмножеством, комментарий без закрытия,
 * `<?xml-stylesheet?>` и `<binary>` с неэкранированным Base64.
 */
const FB2_INVALID = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE FictionBook SYSTEM "fb2.dtd" [<!ENTITY xx "ыыы">]>
<?xml-stylesheet type="text/xsl" href="fb2.xsl"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info><book-title>Битая разметка</book-title><lang>ru</lang></title-info>
    <!-- комментарий, который никто не закрыл
  </description>
  <body>
    <section>
      <title><p>Глава</p></title>
      <p>Первый абзац, он нормально закрыт.</p>
      <p>Второй абзац не закрыт вообще
      <p>Третий абзац содержит «голый» ампersand: AT&T и ещё &amp; сущность.</p>
      <binary id="x.png" content-type="image/png">QUJDREVGRw==</binary>
      <p>Последний абзац.</p>
    </section>
  </body>
</FictionBook>`;

/** Всё, чего FB2 по спецификации не запрещает, а мы выполнять не будем. */
const FB2_DANGEROUS = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info><book-title>Опасная</book-title><lang>ru</lang></title-info>
  </description>
  <body>
    <section>
      <title><p>Глава</p></title>
      <script>alert('должен не выполниться')</script>
      <style>body { display: none }</style>
      <iframe src="https://example.invalid/evil"></iframe>
      <p onclick="alert('onclick')" onload="alert('onload')" style="color: red">Текст с обработчиками.</p>
      <p><a href="javascript:alert('ссылка')">Опасная ссылка</a></p>
      <p><a l:href="#note1">Обычная внутренняя ссылка</a></p>
      <svg><script>alert('в svg')</script></svg>
      <p>Обычный абзац для проверки, что разбор не сломался.</p>
    </section>
  </body>
</FictionBook>`;

// ─── Кодировки ─────────────────────────────────────────────────────────────────

/** Кодирует строку в однобайтовую кодировку без BOM. */
function encodeLegacy(text: string, encoding: string): Uint8Array {
  // Энкодера однобайтовых кодировок в Node нет, поэтому идём по таблице,
  // собранной перебором байтов.
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const mapped = TABLE[encoding]?.[ch];
    if (mapped === undefined) throw new Error(`нет таблицы для ${encoding}: ${ch}`);
    bytes.push(mapped);
  }
  return new Uint8Array(bytes);
}

/**
 * Полный русский алфавит вместе с «ё».
 *
 * «ё» обязан быть в таблице: в строках выше он встречается («тёмным»), и без
 * него кодирование фикстуры падало бы на середине.
 */
const ALPHABET =
  'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя';

/** Обратные таблицы: символ → байт. Собираются перебором всех 256 значений. */
const TABLE: Record<string, Record<string, number>> = buildTables();

function buildTables(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const encoding of ['windows-1251', 'koi8-r']) {
    const map: Record<string, number> = {};
    for (const ch of ALPHABET) {
      // Кодировщика в Node нет, поэтому идём обратным путём: перебираем все
      // старшие байты и находим тот, который декодируется в нужный символ.
      for (let b = 0x80; b < 0x100; b++) {
        if (new TextDecoder(encoding).decode(new Uint8Array([b])) === ch) {
          map[ch] = b;
          break;
        }
      }
      if (map[ch] === undefined) throw new Error(`${encoding}: не найден байт для ${ch}`);
    }
    out[encoding] = map;
  }
  return out;
}

const utf8Of = (text: string): Uint8Array => new TextEncoder().encode(text);

// ─── Содержимое книги ──────────────────────────────────────────────────────────

const TEXT = (book: ReturnType<typeof parseFb2>, chapter: number): string =>
  (book.chapters[chapter]?.blocks ?? []).map((b) => b.text).join('\n');

describe('определение кодировки FB2', () => {
  it('читает UTF-8 с BOM', () => {
    const decoded = decodeFb2(utf8Of(FB2_UTF8_BOM));
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.source).toBe('bom');
    expect(decoded.text).toContain('Тихая улица');
  });

  it('читает UTF-8 без BOM по объявлению', () => {
    const decoded = decodeFb2(utf8Of(FB2_UTF8));
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.text).toContain('Тихая улица');
  });

  it('читает windows-1251 без BOM и без объявления', () => {
    // Ключевой случай: наивный UTF-8 дал бы здесь «Ð¿Ñ€Ð¸Ð²ÐµÑ‚».
    const decoded = decodeFb2(encodeLegacy(FB2_CP1251, 'windows-1251'));
    expect(decoded.encoding).toBe('windows-1251');
    expect(decoded.text).toContain('Тихая улица');
    expect(decoded.text).toContain('Ветер гулял');
    // И никакого мусора: значит, выбрана правильная однобайтовая кодировка.
    expect(decoded.text).not.toContain('�');
  });

  it('читает koi8-r без BOM и без объявления', () => {
    const decoded = decodeFb2(encodeLegacy(FB2_KOI8R, 'koi8-r'));
    expect(decoded.encoding).toBe('koi8-r');
    expect(decoded.text).toContain('Тихая улица');
    expect(decoded.text).not.toContain('�');
  });

  it('различает кодировки по одной и той же битовой последовательности', () => {
    // Одна и та же фраза в двух кодировках даёт разные байты и разный текст.
    // Берём фразу с пробелами: для строки без пробелов однобайтовые кодировки
    // неразличимы в принципе (об этом честно сказано в README модуля), и тест
    // проверял бы не определение, а совпадение при равных оценках.
    const phrase = 'Ветер гулял по пустым улицам';
    const cp = decodeFb2(encodeLegacy(phrase, 'windows-1251'));
    const koi = decodeFb2(encodeLegacy(phrase, 'koi8-r'));
    expect(cp.text).toBe(phrase);
    expect(koi.text).toBe(phrase);
    expect(cp.encoding).not.toBe(koi.encoding);
  });

  it('не верит объявлению, когда байты ему противоречат', () => {
    // В объявлении windows-1251, а на самом деле UTF-8. Строгая проверка
    // отвергает враньё и разбирает файл правильно.
    const decoded = decodeFb2(utf8Of(FB2_LYING_DECLARATION));
    expect(decoded.text).toContain('Тихая улица');
    expect(decoded.text).not.toContain('Ð');
  });

  it('игнорирует несуществующую кодировку в объявлении', () => {
    const decoded = decodeFb2(utf8Of(FB2_UNKNOWN_DECLARATION));
    expect(decoded.text).toContain('Тихая улица');
  });

  it('пустой файл не роняет разбор', () => {
    expect(decodeFb2(new Uint8Array(0)).text).toBe('');
  });

  it('приводит синонимы имён кодировок к каноническим', () => {
    expect(normalizeEncodingName('UTF8')).toBe('utf-8');
    expect(normalizeEncodingName('Win-1251')).toBe('windows-1251');
    expect(normalizeEncodingName('cp1251')).toBe('windows-1251');
    expect(normalizeEncodingName('KOI8-R')).toBe('koi8-r');
    expect(normalizeEncodingName('ibm866')).toBe('ibm866');
  });

  it('выбирает однобайтовую кодировку по распределению байтов', () => {
    // Прямая проверка признака, на котором держится выбор между однобайтовыми
    // кодировками: у настоящей windows-1251 почти все не-ASCII байты лежат
    // выше 0xE0, у настоящей koi8-r — ниже.
    const phrase = 'Ветер гулял по пустым улицам, и он умел ждать.';
    const cpBytes = encodeLegacy(phrase, 'windows-1251');
    const koiBytes = encodeLegacy(phrase, 'koi8-r');

    expect(legacyByteScore(cpBytes, 'windows-1251')).toBeGreaterThan(0.9);
    expect(legacyByteScore(cpBytes, 'koi8-r')).toBeLessThan(0.1);
    expect(legacyByteScore(koiBytes, 'koi8-r')).toBeGreaterThan(0.9);
    expect(legacyByteScore(koiBytes, 'windows-1251')).toBeLessThan(0.1);

    // И на тех же байтах выбор должен упасть в ту же сторону.
    expect(decodeFb2(cpBytes).encoding).toBe('windows-1251');
    expect(decodeFb2(koiBytes).encoding).toBe('koi8-r');
  });

  it('не путает однобайтовые кодировки на тексте без заглавных букв', () => {
    // Отдельный неприятный случай: в книге без заглавных признак «строчных
    // больше» выражен слабее всего. Проверяем, что и на таком тексте выбор
    // остаётся верным.
    const lowerOnly = 'ветер гулял по пустым улицам и не хотел останавливаться';
    const cpBytes = encodeLegacy(lowerOnly, 'windows-1251');
    const koiBytes = encodeLegacy(lowerOnly, 'koi8-r');
    expect(decodeFb2(cpBytes).text).toBe(lowerOnly);
    expect(decodeFb2(koiBytes).text).toBe(lowerOnly);
  });
});

// ─── Разбор ────────────────────────────────────────────────────────────────────

describe('разбор FB2', () => {
  it('находит главы и заголовки', () => {
    const book = parseFb2(utf8Of(FB2_UTF8));
    expect(book.title).toBe('Тихая улица');
    expect(book.author).toBe('Иванова Анна');
    expect(book.language).toBe('ru');
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0]?.blocks[0]?.text).toBe('Глава первая');
    expect(book.chapters[1]?.blocks[0]?.text).toBe('Глава вторая');
  });

  it('подзаголовок отличается от заголовка главы', () => {
    // Иначе в потоке текста два подряд идущих заголовка выглядели бы как
    // опечатка, а якорь на подзаголовок вёл бы в никуда.
    const book = parseFb2(utf8Of(FB2_UTF8));
    const kinds = (book.chapters[0]?.blocks ?? []).map((b) => b.kind);
    expect(kinds.slice(0, 2)).toEqual(['h2', 'h3']);
  });

  it('не теряет вложенные разделы', () => {
    // Вложенный `<section>` — часть той же главы. Если бы мы дробили книгу на
    // каждый раздел, в главе первой оказалось бы четыре «главы» по одному
    // абзацу, и оглавление стало бы бессмысленным.
    const book = parseFb2(utf8Of(FB2_UTF8));
    const text = TEXT(book, 0);
    expect(text).toContain('Подраздел');
    expect(text).toContain('Внутри главы тоже есть текст.');
    expect(book.chapters).toHaveLength(2);
  });

  it('собирает текст всех абзацев главы', () => {
    const book = parseFb2(utf8Of(FB2_UTF8));
    expect(TEXT(book, 0)).toContain('Ветер гулял по пустым улицам и не хотел останавливаться.');
    expect(TEXT(book, 0)).toContain('Он умел ждать.');
    expect(TEXT(book, 1)).toContain('Дом на краю был тёмным.');
  });

  it('держит инвариант рендерера: текст дерева равен block.text', () => {
    // На этом держится вся система якорей: смещение в DOM должно совпадать со
    // смещением в block.text. Проверяем на всех фикстурах сразу.
    const fixtures: Array<[string, Uint8Array]> = [
      ['utf-8', utf8Of(FB2_UTF8)],
      ['cp1251', encodeLegacy(FB2_CP1251, 'windows-1251')],
      ['koi8-r', encodeLegacy(FB2_KOI8R, 'koi8-r')],
      ['картинки', utf8Of(FB2_WITH_BINARY)],
      ['битая разметка', utf8Of(FB2_INVALID)],
      ['опасные теги', utf8Of(FB2_DANGEROUS)],
    ];
    for (const [name, bytes] of fixtures) {
      const book = parseFb2(bytes);
      expect(book.chapters.length, `${name}: главы`).toBeGreaterThan(0);
      for (const chapter of book.chapters) {
        for (const block of chapter.blocks) {
          expect(textOf(block.node), `${name}: блок ${block.index}`).toBe(block.text);
        }
      }
    }
  });

  it('нумерует блоки подряд с нуля', () => {
    // От номера блока зависит якорь комментария: разрыв в нумерации сделал бы
    // «блок 5» несуществующим.
    const book = parseFb2(utf8Of(FB2_UTF8));
    for (const chapter of book.chapters) {
      chapter.blocks.forEach((block, i) => {
        expect(block.index).toBe(i);
      });
    }
  });

  it('одинаково разбирает файл в трёх кодировках', () => {
    // Самая важная проверка для кодировок: содержимое книги не должно зависеть
    // от того, чем она закодирована.
    const utf8 = parseFb2(utf8Of(FB2_UTF8));
    const cp = parseFb2(encodeLegacy(FB2_CP1251, 'windows-1251'));
    const koi = parseFb2(encodeLegacy(FB2_KOI8R, 'koi8-r'));
    expect(cp.title).toBe(utf8.title);
    expect(koi.title).toBe(utf8.title);
    for (let c = 0; c < utf8.chapters.length; c++) {
      expect(cp.chapters[c]?.blocks.map((b) => b.text)).toEqual(utf8.chapters[c]?.blocks.map((b) => b.text));
      expect(koi.chapters[c]?.blocks.map((b) => b.text)).toEqual(utf8.chapters[c]?.blocks.map((b) => b.text));
    }
  });

  it('не тащит Base64 иллюстраций в текст книги', () => {
    // Base64 на 4000 символов в тексте книги — это и мусор на экране, и мусор
    // в поиске цитат для якорей.
    const book = parseFb2(utf8Of(FB2_WITH_BINARY));
    const text = book.chapters.map((c) => c.blocks.map((b) => b.text).join('\n')).join('\n');
    expect(text).not.toContain('BBBB');
    expect(text).not.toContain('AAAA');
    expect(text).toContain('Перед картинкой.');
    expect(text).toContain('После картинки.');
  });

  it('находит ссылку на обложку', () => {
    const book = parseFb2(utf8Of(FB2_WITH_BINARY));
    expect(book.coverHref).toBe('#cover.jpg');
  });

  it('строит оглавление из заголовков глав', () => {
    const book = parseFb2(utf8Of(FB2_UTF8));
    expect(book.toc.map((t) => t.label)).toEqual(['Глава первая', 'Глава вторая']);
    expect(book.toc[0]?.chapterIndex).toBe(0);
    expect(book.toc[1]?.chapterIndex).toBe(1);
  });

  it('переживает невалидную разметку', () => {
    const book = parseFb2(utf8Of(FB2_INVALID));
    expect(book.title).toBe('Битая разметка');
    expect(book.chapters).toHaveLength(1);
    const text = TEXT(book, 0);
    expect(text).toContain('Первый абзац, он нормально закрыт.');
    expect(text).toContain('Последний абзац.');
    // «Голый» ампersand не должен ломать разбор.
    expect(text).toContain('AT&T');
  });

  it('не считает текст DOCTYPE и комментария книжным', () => {
    // Незакрытый комментарий в разметке схлопывает огромный кусок файла, если
    // его не вырезать: в текст книги попали бы и DOCTYPE, и весь хвост файла.
    const book = parseFb2(utf8Of(FB2_INVALID));
    const text = TEXT(book, 0);
    expect(text).not.toContain('DOCTYPE');
    expect(text).not.toContain('dtd');
    expect(text).not.toContain('комментарий');
  });

  it('сообщает об ошибке для чужого формата', () => {
    expect(() => parseFb2(utf8Of('<html><body>не FB2</body></html>'))).toThrow(Fb2Error);
  });

  it('узнаёт FB2 по содержимому, а не по расширению', () => {
    // У книги, скачанной от соседа, тип файла часто пустой, а `.fb2` в имени
    // может отсутствовать.
    expect(looksLikeFb2(utf8Of(FB2_UTF8))).toBe(true);
    expect(looksLikeFb2(utf8Of('<html><body>нет</body></html>'))).toBe(false);
    expect(looksLikeFb2(new Uint8Array(0))).toBe(false);
  });

  it('возвращает сведения о кодировке для диагностики', () => {
    const { book, decoded } = parseFb2Detailed(encodeLegacy(FB2_CP1251, 'windows-1251'));
    expect(book.title).toBe('Тихая улица');
    expect(decoded.encoding).toBe('windows-1251');
  });

  it('читает книгу без разделов как одну главу', () => {
    const flat = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info><book-title>Плоская</book-title></title-info></description>
  <body><p>Текст без единого раздела.</p><p>И ещё абзац.</p></body>
</FictionBook>`;
    const book = parseFb2(utf8Of(flat));
    expect(book.chapters).toHaveLength(1);
    expect(TEXT(book, 0)).toContain('Текст без единого раздела.');
  });
});

// ─── Безопасность ──────────────────────────────────────────────────────────────

describe('безопасность FB2', () => {
  it('не вытаскивает содержимое script в блоки', () => {
    // `extractBlocks` пропускает script/style целиком, поэтому в текст книги
    // код не попадает. Это проверка ДО рендеринга: дальше этих строк он идти
    // не может, но и лишнего в книге быть не должно.
    const book = parseFb2(utf8Of(FB2_DANGEROUS));
    const text = book.chapters.map((c) => c.blocks.map((b) => b.text).join('\n')).join('\n');
    expect(text).not.toContain('должен не выполниться');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('display: none');
    // Обычный текст рядом с опасным — разобран и остался.
    expect(text).toContain('Текст с обработчиками.');
    expect(text).toContain('Обычный абзац для проверки, что разбор не сломался.');
  });

  it('не копирует обработчики и стили в блоки', () => {
    const book = parseFb2(utf8Of(FB2_DANGEROUS));
    // Атрибуты из книги не доходят до DOM: `normalizeInline` собирает узел с
    // пустыми attrs. Проверяем это напрямую — это и есть тот барьер, который
    // не даёт обработчикам выполниться.
    for (const chapter of book.chapters) {
      for (const block of chapter.blocks) {
        expect(JSON.stringify(block.node), `блок ${block.index}`).not.toContain('onclick');
        expect(JSON.stringify(block.node)).not.toContain('onload');
        expect(JSON.stringify(block.node)).not.toContain('style');
      }
    }
  });

  it('сохраняет ссылку в дереве как есть, а безопасность отдаёт рендереру', () => {
    // Разбор ничего не «чинит» и не вырезает: `href` доезжает до дерева дословно.
    // Проверять схему здесь нельзя — этим занимается рендерер (`safeHref`),
    // и именно он отказывается превращать `javascript:` в кликабельную ссылку
    // (см. fb2-render.test.tsx).
    //
    // Так надёжнее, чем вырезать опасную схему регуляркой на разборе: схем URL
    // много и новые появляются, а у рендерера один разрешённый список.
    const book = parseFb2(utf8Of(FB2_DANGEROUS));
    const serialized = JSON.stringify(book.chapters);
    expect(serialized).toContain('javascript:');

    // А вот обработчики и стили не доезжают даже до дерева: их нет в белом
    // списке атрибутов, поэтому исполнять их нечем.
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('onload');
    expect(serialized).not.toContain('style');
  });

  it('не разбирает iframe и svg как содержимое главы', () => {
    const book = parseFb2(utf8Of(FB2_DANGEROUS));
    const text = book.chapters.map((c) => c.blocks.map((b) => b.text).join('\n')).join('\n');
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('alert');
  });
});
