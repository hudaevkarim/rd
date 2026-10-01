/**
 * Учёт книг, чей файл лежит на этом устройстве.
 *
 * Вынесен отдельным классом не ради архитектуры, а ради проверяемости. Регрессия,
 * которую здесь ловим, была настоящей и стоила пользователю нерабочей отправки:
 * наличие файла определялось по кэшу разбора EPUB, а аудиокнигу разбирать нечем.
 * Получалось, что загруженный mp3 всегда считался «не полученным» — интерфейс
 * прятал кнопку «передать участникам» и требовал получить файл от соседа.
 *
 * Правило простое и потому легко нарушаемое: файл либо лежит в хранилище, либо
 * нет. Никакой связи с форматом и разбором.
 */

export class LocalFiles {
  readonly #ids = new Set<string>();

  /**
   * Отмечает книгу как лежащую на диске.
   * @returns true, если состояние изменилось. Нужен вызывающему, чтобы не
   *   пересоздавать снимок состояния на каждый вызов подряд.
   */
  add(bookId: string): boolean {
    if (this.#ids.has(bookId)) return false;
    this.#ids.add(bookId);
    return true;
  }

  /** Книга удалена, или её больше нет в каталоге комнаты. */
  remove(bookId: string): void {
    this.#ids.delete(bookId);
  }

  has(bookId: string): boolean {
    return this.#ids.has(bookId);
  }

  /** Все известные идентификаторы — для сверки с каталогом при входе. */
  get ids(): string[] {
    return [...this.#ids];
  }

  /**
   * Сверяет каталог комнаты с хранилищем.
   *
   * Записи каталога, для которых в хранилище файла нет, убираются: они либо
   * достались в другой сессии, либо файл был удалён вручную. Оставленная в
   * «локальных» запись показывала бы кнопку передачи для файла, которого уже
   * нет, и передача падала бы с «файл не найден локально».
   *
   * @param hasFile проверка по хранилищу для конкретной книги
   * @param catalogIds все идентификаторы в каталоге комнаты
   */
  async reconcile(hasFile: (bookId: string) => Promise<boolean>, catalogIds: string[]): Promise<boolean> {
    let changed = false;
    const known = new Set(catalogIds);
    // Записи вне каталога — книга убрана из комнаты.
    for (const id of this.ids) {
      if (!known.has(id)) {
        this.remove(id);
        changed = true;
      }
    }
    // Проверяем только отсутствующие: лишние обращения к IndexedDB на каждый
    // перерисовываемый список книг заметны.
    const missing = catalogIds.filter((id) => !this.#ids.has(id));
    if (missing.length === 0) return changed;
    const results = await Promise.all(missing.map((id) => hasFile(id).catch(() => false)));
    for (let i = 0; i < missing.length; i++) {
      if (results[i] === true) changed = this.add(missing[i] as string) || changed;
    }
    return changed;
  }

  /** Забыть всё — например, при выходе из комнаты. */
  clear(): void {
    this.#ids.clear();
  }
}

/**
 * Имя файла для передачи.
 *
 * Раньше здесь жёстко подставлялось `.epub`, и получатель сохранял mp3 под
 * именем «Книга.epub». Само по себе безобидно, но приводит к путанице в
 * списке передач и к неверной иконке в каталоге.
 */
export function transferFileName(title: string, format: 'epub' | 'fb2' | 'audio', mime = ''): string {
  const ext = extensionFor(format, mime);
  const trimmed = title.trim();
  const clean = trimmed === '' ? 'книга' : trimmed;
  if (ext === '') return clean;
  // Название с диска часто уже с расширением («Лекции.m4b»). Без проверки
  // получатель сохранял файл как «Лекции.m4b.m4b».
  const lower = clean.toLowerCase();
  if (lower.endsWith(`.${ext}`)) return clean;
  return `${clean}.${ext}`;
}

function extensionFor(format: 'epub' | 'fb2' | 'audio', mime: string): string {
  if (format === 'fb2') return 'fb2';
  if (format === 'epub') return 'epub';
  const m = mime.toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4b')) return 'm4b';
  if (m.includes('aac')) return 'aac';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('opus')) return 'opus';
  if (m.includes('flac')) return 'flac';
  if (m.includes('wav')) return 'wav';
  // Неизвестный тип: пусть получатель сам разберётся по содержимому.
  return 'audio';
}