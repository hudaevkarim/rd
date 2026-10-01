/**
 * Регрессия: переданный аудиофайл не играл.
 *
 * Файл собирался в IndexedDB из кусков и сохранялся как Blob без типа. Браузер
 * для `<audio>` без распознаваемого типа просто не начинает воспроизведение:
 * файл лежит на диске, а звука нет, без ошибки в консоли. Для EPUB это
 * безразлично (его читает наш парсер, который тип не смотрит), для аудиокниги
 * — фатально.
 *
 * Проверяется чистая сборка Blob, а не весь приёмник: IndexedDB в Node
 * отсутствует, а терялся тип ровно на границе между кусками и готовым файлом.
 */

import { describe, expect, it } from 'vitest';
import { assembleBlob, blobSource, bytesSource } from '../src/storage.js';

describe('сборка файла из кусков: тип', () => {
  it('сохраняет MIME книги', () => {
    // Главная проверка: без неё `<audio>` молчит.
    expect(assembleBlob([new Blob([new Uint8Array(4)])], 'audio/mpeg').type).toBe('audio/mpeg');
    expect(assembleBlob([new Blob([new Uint8Array(4)])], 'audio/mp4').type).toBe('audio/mp4');
    expect(assembleBlob([new Blob([new Uint8Array(4)])], 'application/epub+zip').type).toBe(
      'application/epub+zip',
    );
  });

  it('не наследует пустой тип от кусков', () => {
    // Именно это и было дефектом: Blob из Blob'ов без type даёт ''.
    const chunk = new Blob([new Uint8Array(8)]);
    expect(chunk.type).toBe('');
    expect(assembleBlob([chunk, chunk], 'audio/mpeg').type).toBe('audio/mpeg');
  });

  it('не падает на неизвестном типе', () => {
    // Пустой MIME бывает у книг, пришедших от старой версии клиента. Файл
    // должен собраться; поймёт его получатель или нет.
    expect(() => assembleBlob([new Blob([new Uint8Array(4)])], '')).not.toThrow();
    expect(assembleBlob([new Blob([new Uint8Array(4)])], '').size).toBe(4);
    expect(assembleBlob([new Blob([new Uint8Array(4)])], '   ').size).toBe(4);
  });

  it('собирает байты в правильном порядке и размере', async () => {
    // Порядок кусков определяется сортировкой по part; собранный файл обязан
    // совпасть с исходным побайтово, иначе контрольная сумма разойдётся.
    const parts = [
      new Blob([new Uint8Array([1, 2, 3])]),
      new Blob([new Uint8Array([4, 5])]),
      new Blob([new Uint8Array([6])]),
    ];
    const blob = assembleBlob(parts, 'audio/mpeg');
    expect(blob.size).toBe(6);
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('работает с большим числом кусков без переполнения', async () => {
    // 800 МБ аудиокниги — это около 50 тысяч кусков по 16 КиБ.
    const parts: Blob[] = [];
    for (let i = 0; i < 500; i++) parts.push(new Blob([new Uint8Array(16 * 1024)]));
    const blob = assembleBlob(parts, 'audio/mpeg');
    expect(blob.size).toBe(500 * 16 * 1024);
    expect(blob.type).toBe('audio/mpeg');
  });

  it('не добавляет разделителей между кусками', () => {
    const blob = assembleBlob([new Blob([new Uint8Array(3)]), new Blob([new Uint8Array(3)])], 'audio/mpeg');
    // Ровно сумма размеров: лишний байт означал бы порчу потока.
    expect(blob.size).toBe(6);
  });
});

describe('источник файла для отправки', () => {
  it('читает файл по кускам, не копируя целиком', async () => {
    // Ключевое свойство для аудиокниги на 800 МБ: источник отдаёт срез.
    const size = 16 * 1024 * 2 + 17;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 256;
    const blob = new Blob([bytes as unknown as ArrayBuffer], { type: 'audio/mpeg' });
    const source = blobSource(blob);

    expect(source.size).toBe(size);
    const first = await source.slice(0, 16 * 1024);
    expect(first).toHaveLength(16 * 1024);
    expect(Array.from(first.subarray(0, 4))).toEqual([0, 1, 2, 3]);

    const last = await source.slice(16 * 1024 * 2, size);
    expect(last).toHaveLength(17);
  });

  it('не читает за пределами файла', async () => {
    // Ошибка границы в одном месте даёт усечённый файл: он пройдёт по размеру
    // и не пройдёт по контрольной сумме.
    const blob = new Blob([new Uint8Array(100)], { type: 'audio/mpeg' });
    const source = blobSource(blob);
    expect(await source.slice(90, 200)).toHaveLength(10);
    expect(await source.slice(150, 200)).toHaveLength(0);
  });

  it('раздаёт байты из памяти без изменений', async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const source = bytesSource(bytes);

    expect(source.size).toBe(1000);
    const part = await source.slice(100, 200);
    expect(Array.from(part)).toEqual(Array.from(bytes.subarray(100, 200)));
    // Отрезок за концом файла — пустой, а не undefined: иначе отправитель
    // отправил бы кадр нулевой длины.
    expect(await source.slice(1000, 1200)).toHaveLength(0);
  });
});