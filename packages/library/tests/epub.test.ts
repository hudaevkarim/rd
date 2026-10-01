/**
 * Тесты разбора EPUB и разрешения путей внутри архива.
 *
 * EPUB собирается прямо в тесте: это важно, потому что тест не должен зависеть
 * от бинарного файла в репозитории, который нечем объяснить. Заодно видно,
 * что парсеру достаточно «обычной» книги, а не идеально сделанной.
 */

import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { dirname, EpubError, extractBlocks, normalizeText, parseEpub, resolveZipPath, textOf } from '@rd/library';

interface EpubOptions {
  /** Подключить nav-документ (EPUB 3) с оглавлением. */
  nav?: Array<{ href: string; label: string }>;
  /** Пометить обложку через свойство manifest. */
  cover?: boolean;
  /** Использовать устаревший NCX вместо nav. */
  ncx?: boolean;
  /** Файлы, помеченные в spine как linear="no". */
  skipLinear?: string[];
}

function buildEpub(chapters: Record<string, string>, opts: EpubOptions = {}): Uint8Array {
  const skip = new Set(opts.skipLinear ?? []);
  const spine = Object.keys(chapters);
  const items: string[] = [];
  const refs: string[] = [];

  spine.forEach((href, i) => {
    const id = `c${i + 1}`;
    items.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
    refs.push(`<itemref idref="${id}"${skip.has(href) ? ' linear="no"' : ''}/>`);
  });

  if (opts.cover) {
    items.push('<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
  }
  if (opts.nav) {
    items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  }
  if (opts.ncx) {
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  }

  const navBody = (opts.nav ?? [])
    .map((e) => `<li><a href="${e.href}">${e.label}</a></li>`)
    .join('');

  const ncxBody = (opts.nav ?? [])
    .map((e, i) => `<navPoint id="n${i}" playOrder="${i + 1}"><navLabel><text>${e.label}</text></navLabel><content src="${e.href}"/></navPoint>`)
    .join('');

  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:title>Заголовок книги</dc:title><dc:creator>Автор книги</dc:creator><dc:language>ru</dc:language>' +
        '<meta name="cover" content="cover-img"/>' +
        '</metadata>' +
        `<manifest>${items.join('')}</manifest>` +
        `<spine>${refs.join('')}</spine>` +
        '</package>',
    ),
  };

  if (opts.nav) {
    files['OEBPS/nav.xhtml'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
        '<body><nav epub:type="toc"><ol>' + navBody + '</ol></nav></body></html>',
    );
  }
  if (opts.ncx) {
    files['OEBPS/toc.ncx'] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
        '<navMap>' + ncxBody + '</navMap></ncx>',
    );
  }
  if (opts.cover) {
    files['OEBPS/images/cover.jpg'] = strToU8('fake-jpeg-bytes');
  }
  for (const [href, body] of Object.entries(chapters)) {
    files[`OEBPS/${href}`] = strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>глава</title></head><body>' +
        body +
        '</body></html>',
    );
  }

  return zipSync(files, { level: 0 });
}

describe('пути внутри архива', () => {
  it('разрешает относительные ссылки', () => {
    expect(resolveZipPath('OEBPS/text', 'ch1.xhtml')).toBe('OEBPS/text/ch1.xhtml');
    expect(resolveZipPath('OEBPS/text', '../images/a.png')).toBe('OEBPS/images/a.png');
    expect(resolveZipPath('OEBPS', './ch1.xhtml')).toBe('OEBPS/ch1.xhtml');
    expect(resolveZipPath('OEBPS/text', '../../top.xhtml')).toBe('top.xhtml');
  });

  it('не выходит за пределы архива', () => {
    // `../../..` не должен подниматься выше корня: иначе злоумышленник в
    // href вышел бы из книги в соседний файл внутри архива.
    expect(resolveZipPath('a', '../../../etc/passwd')).toBe('etc/passwd');
  });

  it('отбрасывает якорь и декодирует проценты', () => {
    expect(resolveZipPath('OEBPS', 'ch1.xhtml#section2')).toBe('OEBPS/ch1.xhtml');
    expect(resolveZipPath('OEBPS', '%D0%B3%D0%BB%D0%B0%D0%B2%D0%B0.xhtml')).toBe('OEBPS/глава.xhtml');
  });

  it('берёт каталог из пути', () => {
    expect(dirname('a/b/c.opf')).toBe('a/b');
    expect(dirname('c.opf')).toBe('');
  });
});

describe('разбор EPUB', () => {
  it('читает метаданные, главы и оглавление', () => {
    const epub = buildEpub(
      {
        'ch1.xhtml': '<h1>Первая глава</h1><p>Один текст.</p><p>Другой <em>курсивом</em> текст.</p>',
        'text/ch2.xhtml': '<h2>Вторая глава</h2><p>Продолжение.</p>',
      },
      { nav: [{ href: 'ch1.xhtml', label: 'Начало' }, { href: 'text/ch2.xhtml', label: 'Дальше' }], cover: true },
    );

    const book = parseEpub(epub);
    expect(book.title).toBe('Заголовок книги');
    expect(book.author).toBe('Автор книги');
    expect(book.language).toBe('ru');
    expect(book.coverHref).toBe('OEBPS/images/cover.jpg');
    expect(book.chapters).toHaveLength(2);
    expect(book.chapters[0]?.href).toBe('OEBPS/ch1.xhtml');
    // href второй главы указывает в подкаталог — проверяем разрешение пути.
    expect(book.chapters[1]?.href).toBe('OEBPS/text/ch2.xhtml');

    expect(book.toc.map((t) => t.label)).toEqual(['Начало', 'Дальше']);
    expect(book.toc[0]?.chapterIndex).toBe(0);
    expect(book.toc[1]?.chapterIndex).toBe(1);
    expect(book.totalBlocks).toBeGreaterThan(0);
  });

  it('понимает оглавление EPUB 2 через NCX', () => {
    const epub = buildEpub(
      { 'ch1.xhtml': '<h1>Раз</h1><p>Текст.</p>' },
      { ncx: true, nav: [{ href: 'ch1.xhtml', label: 'Единственная' }] },
    );
    const book = parseEpub(epub);
    expect(book.toc).toHaveLength(1);
    expect(book.toc[0]?.label).toBe('Единственная');
  });

  it('синтезирует оглавление из заголовков, если навигации нет', () => {
    const epub = buildEpub({
      'a.xhtml': '<h1>Альфа</h1><p>раз</p>',
      'b.xhtml': '<h1>Бета</h1><p>два</p>',
    });
    const book = parseEpub(epub);
    expect(book.toc.map((t) => t.label)).toEqual(['Альфа', 'Бета']);
  });

  it('извлекает блоки с сохранением инлайновой разметки', () => {
    const book = parseEpub(
      buildEpub({
        'ch1.xhtml':
          '<h1>Заголовок</h1><p>Первый абзац.</p>' +
          '<p>Второй <strong>жирный</strong> и <em>наклонный</em>.</p>' +
          '<ul><li>Пункт один</li><li>Пункт два</li></ul>' +
          '<blockquote><p>Цитата</p></blockquote>',
      }),
    );
    const blocks = book.chapters[0]?.blocks ?? [];
    expect(blocks.map((b) => b.kind)).toEqual(['h1', 'p', 'p', 'li', 'li', 'blockquote']);
    expect(blocks[2]?.text).toBe('Второй жирный и наклонный.');
    // Инлайновые узлы сохраняются: рендерер построит из них <strong>/<em>.
    const inline = blocks[2]?.node.children ?? [];
    expect(inline.map((n) => n.name)).toContain('strong');
  });
  it('не тащит в текст заголовок из <head>', () => {
    // Без явного пропуска каждая глава начиналась бы с блока «глава» — это
    // заголовок вкладки, а не книжный текст.
    const book = parseEpub(buildEpub({ 'ch1.xhtml': '<h1>Глава</h1><p>Текст.</p>' }));
    const texts = (book.chapters[0]?.blocks ?? []).map((b) => b.text);
    expect(texts).toEqual(['Глава', 'Текст.']);
  });

  it('не тащит скрипты и обработчики в дерево', () => {
    // Недоверенная разметка не должна влиять на структуру: атрибуты вообще
    // не копируются в нормализованное дерево.
    const book = parseEpub(
      buildEpub({
        'ch1.xhtml': '<p onclick="alert(1)">Текст<script>alert(2)</script></p><div style="color:red">Ещё</div>',
      }),
    );
    const blocks = book.chapters[0]?.blocks ?? [];
    expect(blocks[0]?.text).toBe('Текст');
    for (const block of blocks) expect(block.node.attrs).toEqual({});
  });

  it('сохраняет инвариант: текст дерева равен block.text', () => {
    // На этом держится привязка комментариев: смещения в DOM должны
    // совпадать с координатами якоря.
    const book = parseEpub(
      buildEpub({
        'ch1.xhtml': '<p>Строка\n   с   переносами</p><p>  <em>Курсив</em>  и  пробелы  </p>',
      }),
    );
    for (const block of book.chapters[0]?.blocks ?? []) {
      expect(textOf(block.node)).toBe(block.text);
    }
    expect(book.chapters[0]?.blocks[0]?.text).toBe('Строка с переносами');
    expect(book.chapters[0]?.blocks[1]?.text).toBe('Курсив и пробелы');
  });

  it('пропускает файлы с linear="no"', () => {
    // Сноски, колофон и прочая вспомогательная разметка не должны попадать
    // в основной поток чтения.
    const book = parseEpub(
      buildEpub(
        { 'ch1.xhtml': '<h1>Глава</h1><p>Текст.</p>', 'notes.xhtml': '<p>Сноска</p>' },
        { skipLinear: ['notes.xhtml'] },
      ),
    );
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]?.href).toBe('OEBPS/ch1.xhtml');
  });

  it('сообщает понятную ошибку для не-EPUB файла', () => {
    expect(() => parseEpub(strToU8('это не zip'))).toThrow(EpubError);
    const noContainer = zipSync({ 'OEBPS/content.opf': strToU8('<package/>') }, { level: 0 });
    expect(() => parseEpub(noContainer)).toThrow(/container\.xml/);
  });

  it('не падает на пустой главе', () => {
    const book = parseEpub(buildEpub({ 'empty.xhtml': '<body><div></div></body>' }));
    expect(book.chapters).toHaveLength(1);
    expect(book.chapters[0]?.blocks).toHaveLength(0);
    expect(book.totalBlocks).toBe(0);
  });
});

describe('нормализация текста', () => {
  it('схлопывает пробелы и невидимые символы', () => {
    expect(normalizeText('  много\t\tпробелов \n между ')).toBe('много пробелов между');
    expect(normalizeText('обычный')).toBe('обычный');
    expect(normalizeText(' раз с nbsp ')).toBe('раз с nbsp');
  });
});

describe('извлечение блоков', () => {
  it('превращает свободный текст в абзац', () => {
    const blocks = extractBlocks([{ name: 'body', attrs: {}, children: [{ name: '#text', text: ' просто текст ', attrs: {}, children: [] }] }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('p');
    expect(blocks[0]?.text).toBe('просто текст');
  });
});
