/**
 * Регрессия: аудиокнига не отправлялась соседям.
 *
 * Пользователь загружал mp3, и интерфейс писал «файла нет — получите от
 * участника». Кнопки «передать участникам» не было вовсе.
 *
 * Причина: наличие файла определялось через кэш разбора EPUB (`#parsed`).
 * Аудиокнигу разбирать нечем, она хранится в IndexedDB как есть, поэтому
 * `hasLocalFile` для неё всегда возвращал false — независимо от того, что файл
 * только что лежал на диске.
 *
 * Здесь проверяется именно то правило, которое было нарушено: наличие файла
 * не зависит от формата и от того, разбиралась ли книга.
 */

import { describe, expect, it } from 'vitest';
import { LocalFiles, transferFileName } from '../src/local-files.js';

describe('LocalFiles: наличие файла на устройстве', () => {
  it('считает файл полученным сразу после добавления, без разбора', () => {
    // Именно этот случай и ломался: у EPUB есть разбор, у аудио его нет.
    const files = new LocalFiles();
    expect(files.has('audio-1')).toBe(false);
    files.add('audio-1');
    expect(files.has('audio-1')).toBe(true);
  });

  it('сообщает, изменилось ли состояние', () => {
    // Вызывающий пересоздаёт снимок состояния по этому признаку. Если всегда
    // возвращать true, панель книг перерисовывалась бы на каждый вызов.
    const files = new LocalFiles();
    expect(files.add('a')).toBe(true);
    expect(files.add('a')).toBe(false);
    expect(files.add('b')).toBe(true);
  });

  it('забывает книгу по remove', () => {
    const files = new LocalFiles();
    files.add('a');
    files.remove('a');
    expect(files.has('a')).toBe(false);
  });

  it('находит файлы при сверке с каталогом комнаты', async () => {
    // Сценарий входа в комнату: каталог приехал по CRDT, файлы лежат на диске.
    const files = new LocalFiles();
    const onDisk = new Set(['epub-1', 'audio-1']);
    const changed = await files.reconcile(async (id) => onDisk.has(id), ['epub-1', 'audio-1', 'epub-2']);

    expect(changed).toBe(true);
    expect(files.has('epub-1')).toBe(true);
    expect(files.has('audio-1')).toBe(true);
    // Файла нет — книга в каталоге есть, но остаётся «получите от участника».
    expect(files.has('epub-2')).toBe(false);
  });

  it('не спрашивает хранилище повторно для уже известных книг', async () => {
    // Каталог перерисовывается часто; лишние обращения к IndexedDB на каждый
    // кадр заметны на слабых машинах.
    const files = new LocalFiles();
    files.add('a');
    let asked = 0;
    await files.reconcile(async () => {
      asked++;
      return true;
    }, ['a', 'b']);

    // Только для 'b': 'a' уже известен.
    expect(asked).toBe(1);
  });

  it('убирает книги, которых больше нет в каталоге', async () => {
    // Участник вышел и удалил книгу: показывать кнопку передачи для неё
    // нельзя, передача упала бы с «файл не найден локально».
    const files = new LocalFiles();
    files.add('a');
    files.add('b');
    const changed = await files.reconcile(async () => false, ['a']);

    expect(changed).toBe(true);
    expect(files.has('a')).toBe(true);
    expect(files.has('b')).toBe(false);
  });

  it('переживает ошибку хранилища при сверке', async () => {
    // IndexedDB бывает недоступен в приватном режиме. Сверка не должна
    // ни падать, ни считать отсутствующий файл имеющимся.
    const files = new LocalFiles();
    const changed = await files.reconcile(async () => {
      throw new Error('IndexedDB недоступна');
    }, ['a']);

    expect(changed).toBe(false);
    expect(files.has('a')).toBe(false);
  });

  it('не считает файл имеющимся, если проверка вернула мусор', async () => {
    const files = new LocalFiles();
    await files.reconcile(async () => undefined as unknown as boolean, ['a']);
    expect(files.has('a')).toBe(false);
  });

  it('очищает всё разом', () => {
    const files = new LocalFiles();
    files.add('a');
    files.add('b');
    files.clear();
    expect(files.ids).toEqual([]);
  });

  it('перечисляет идентификаторы', () => {
    const files = new LocalFiles();
    files.add('a');
    files.add('b');
    expect(new Set(files.ids)).toEqual(new Set(['a', 'b']));
  });
});

describe('имя файла при передаче', () => {
  it('подставляет расширение по формату, а не всегда .epub', () => {
    // Раньше здесь жёстко стояло `.epub`, и mp3 сохранялся как «Книга.epub».
    expect(transferFileName('Мастер и Маргарита', 'epub')).toBe('Мастер и Маргарита.epub');
    expect(transferFileName('Анна Каренина', 'fb2')).toBe('Анна Каренина.fb2');
    expect(transferFileName('Записки', 'audio', 'audio/mpeg')).toBe('Записки.mp3');
    expect(transferFileName('Дюна', 'audio', 'audio/mp4')).toBe('Дюна.m4b');
  });

  it('угадывает расширение по типу файла при неизвестном формате', () => {
    expect(transferFileName('X', 'audio', 'audio/aac')).toBe('X.aac');
    expect(transferFileName('X', 'audio', 'audio/ogg; codecs=opus')).toBe('X.ogg');
    expect(transferFileName('X', 'audio', 'audio/flac')).toBe('X.flac');
    // Неизвестный тип: даём нейтральное имя, разберётся получатель.
    expect(transferFileName('X', 'audio', '')).toBe('X.audio');
    expect(transferFileName('X', 'audio', 'application/octet-stream')).toBe('X.audio');
  });

  it('не оставляет пустое имя', () => {
    expect(transferFileName('', 'epub')).toBe('книга.epub');
    expect(transferFileName('   ', 'audio', 'audio/mpeg')).toBe('книга.mp3');
  });

  it('не размножает расширение, если оно уже в названии', () => {
    // Типичное имя файла с диска: «Лекции.m4b». Без проверки получатель
    // сохранял бы файл как «Лекции.m4b.m4b».
    expect(transferFileName('Лекции.m4b', 'audio', 'audio/mp4')).toBe('Лекции.m4b');
    // Регистр не должен мешать: имя с диска может быть «ЛЕКЦИИ.M4B».
    expect(transferFileName('ЛЕКЦИИ.M4B', 'audio', 'audio/mp4')).toBe('ЛЕКЦИИ.M4B');
    // А вот чужое расширение подменяем: mp3 не должен уехать под именем .m4b.
    expect(transferFileName('Лекции.epub', 'audio', 'audio/mpeg')).toBe('Лекции.epub.mp3');
  });
});