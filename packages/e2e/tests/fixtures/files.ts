/**
 * Файлы-книги для e2e: EPUB, FB2, аудиокнига.
 *
 * ─── Почему файлы собираются в коде, а не лежат в репозитории ─────────────────
 *
 * Двоичный файл в git нечитаем: непонятно, что именно проверяет тест, и любая
 * правка содержимого — это новая бинарная ревизия без читаемого описания. Здесь
 * видно, что именно подаётся приложению.
 *
 * ─── Почему не MP3, а WAV ────────────────────────────────────────────────────
 *
 * WAV пишется за тридцать строк, длительность известна до байта, и Chromium
 * декодирует его штатным кодеком без всяких проприетарных кусков. MP3 пришлось бы
 * либо тащить в репозиторий, либо кодировать — и падение теста «аудио»
 * становилось бы падением из-за чужой зависимости, а не из-за приложения.
 *
 * Звук в headless Chromium не слышен, но он декодируется и течёт по времени:
 * `currentTime` растёт, состояние меняется. Именно это и проверяют тесты.
 */

import { zipSync, strToU8 } from 'fflate';

// ─── EPUB ─────────────────────────────────────────────────────────────────────

const EPUB_TITLE = 'Тихая улица';
const EPUB_AUTHOR = 'Анна Иванова';
const EPUB_P1 = 'Ветер гулял по пустым улицам и не хотел останавливаться.';
const EPUB_P2 = 'Он умел ждать.';
const EPUB_CH2 = 'Дом на краю был тёмным.';

export interface TextFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Настоящий EPUB: zip с mimetype, OPF, nav и двумя главами XHTML.
 *
 * Собирается fflate — тем же пакетом, которым читается книга в приложении, так
 * что расхождение в формате невозможно по построению.
 */
export function makeEpub(): TextFile {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${EPUB_TITLE}</dc:title>
    <dc:creator>${EPUB_AUTHOR}</dc:creator>
    <dc:language>ru</dc:language>
    <dc:identifier id="id">rd-e2e-epub</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Оглавление</title></head><body>
<nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Глава первая</a></li>
  <li><a href="ch2.xhtml">Глава вторая</a></li>
</ol></nav>
</body></html>`;

  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава первая</title></head><body>
<h1>Глава первая</h1>
<p>${EPUB_P1}</p>
<p>${EPUB_P2}</p>
</body></html>`;

  const ch2 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава вторая</title></head><body>
<h1>Глава вторая</h1>
<p>${EPUB_CH2}</p>
</body></html>`;

  // mimetype обязан идти первым и без сжатия — этого требует спецификация EPUB.
  //
  // `mtime` фиксирован, а не «сейчас»: иначе каждый запуск давал бы другие
  // байты, и провал не удалось бы отличить от настоящей поломки — пришлось бы
  // пересобирать книгу, чтобы посмотреть, в чём дело. Формат zip хранит дату в
  // формате DOS, где год меньше 1980 недопустим, поэтому `0` здесь нельзя.
  const archive = zipSync(
    {
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8(containerXml()),
      'OEBPS/content.opf': strToU8(opf),
      'OEBPS/nav.xhtml': strToU8(nav),
      'OEBPS/ch1.xhtml': strToU8(ch1),
      'OEBPS/ch2.xhtml': strToU8(ch2),
    },
    { level: 0, mtime: new Date('2024-01-01T00:00:00Z') },
  );

  return { name: 'тихая-улица.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(archive) };
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
}

// ─── FB2 ─────────────────────────────────────────────────────────────────────

export const FB2_TITLE = 'Тихая бухта';
export const FB2_P1 = 'Ветер гулял по пустому берегу и не хотел утихать.';
export const FB2_CH2 = 'Дом на краю маяка был тёмным.';

/**
 * FB2 в windows-1251 и без BOM.
 *
 * Кодировка выбрана не случайно: это ровно тот случай, ради которого парсер FB2
 * и написан. В UTF-8 проверялся бы только путь «современный файл», а здесь
 * проходит определение кодировки по распределению байтов.
 */
export function makeFb2(): TextFile {
  const xml = `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>prose_contemporary</genre>
      <author><first-name>Пётр</first-name><last-name>Сидоров</last-name></author>
      <book-title>${FB2_TITLE}</book-title>
      <lang>ru</lang>
    </title-info>
    <coverpage><image l:href="#cover.jpg"/></coverpage>
  </description>
  <body>
    <section>
      <title><p>Глава первая</p></title>
      <p>${FB2_P1}</p>
      <empty-line/>
      <p>Он умел ждать.</p>
      <section>
        <title><p>Подраздел</p></title>
        <p>Внутри главы тоже есть текст.</p>
      </section>
    </section>
    <section>
      <title><p>Глава вторая</p></title>
      <p>${FB2_CH2}</p>
    </section>
  </body>
</FictionBook>`;

  return {
    name: 'тихая-бухта.fb2',
    mimeType: 'application/x-fictionbook+xml',
    buffer: Buffer.from(encodeWindows1251(xml)),
  };
}

/**
 * Кодирование в windows-1251.
 *
 * Собственной таблицы здесь нет: байты берутся у самого Node, который знает эту
 * кодировку. Так таблица не может разойтись с настоящей.
 */
function encodeWindows1251(text: string): Uint8Array {
  const decoder = new TextDecoder('windows-1251');
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    // Обратный поиск по одному байту: кириллица в windows-1251 однобайтовая,
    // поэтому это однозначно и работает без внешней таблицы.
    let found = -1;
    for (let b = 0x80; b < 0x100; b++) {
      if (decoder.decode(new Uint8Array([b])) === ch) {
        found = b;
        break;
      }
    }
    if (found < 0) throw new Error(`windows-1251 не знает символ ${JSON.stringify(ch)}`);
    bytes.push(found);
  }
  return new Uint8Array(bytes);
}

// ─── Аудиокнига ───────────────────────────────────────────────────────────────

/** Длительность фикстуры. С запасом: тестам нужно место для перемотки. */
export const AUDIO_DURATION_SEC = 90;

/**
 * Название, под которым аудиокнига появится в каталоге.
 *
 * Приложение берёт название из ИМЕНИ ФАЙЛА, отбрасывая расширение, поэтому
 * константа обязана совпадать с именем фикстуры. Раньше здесь было расхождение
 * («тихая-улица» против «тихая улица»), и тесты падали с «книга не появилась»,
 * хотя книга была на экране.
 */
export const AUDIO_TITLE = 'Тихая бухта (аудио)';

/**
 * @param title название записи. Разное имя нужно для сценария, где сосед
 *   слушает ДРУГУЮ книгу: при одинаковых именах отличить «слушает ту же» от
 *   «слушает другую» невозможно, и тест прошёл бы вхолостую.
 */
export function makeAudioBook(title: string = AUDIO_TITLE): TextFile {
  return {
    name: `${title}.mp3`,
    mimeType: 'audio/wav',
    buffer: Buffer.from(makeWav(AUDIO_DURATION_SEC)),
  };
}

/**
 * Моно WAV 8 кГц, 8 бит: тишина нужной длины.
 *
 * Частота дискретизации занижена намеренно. На 44,1 кГц минута весила бы около
 * 2,6 МБ, и этот файл каждый раз гонялся бы по DataChannel при передаче между
 * двумя участниками — то есть тест аудио платил бы за проверку сети. 8 кГц
 * достаточно, чтобы длительность и перемотка считались честно.
 */
function makeWav(seconds: number): Uint8Array {
  const rate = 8000;
  const samples = rate * seconds;
  const dataSize = samples;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // размер блока fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // моно
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true); // байт в секунду = rate × 1 × 1
  view.setUint16(32, 1, true); // выравнивание блока
  view.setUint16(34, 8, true); // бит на сэмпл
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  // Данные уже нулевые: 8-битная тишина PCM — это 0x80, а не 0.
  for (let i = 0; i < dataSize; i++) out[44 + i] = 0x80;
  return out;
}