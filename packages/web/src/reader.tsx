/**
 * Читалка: рендер главы, отслеживание позиции, выделение текста → якорь.
 *
 * Ключевое решение по безопасности: текст книги попадает в DOM только через
 * `createElement`/`textContent` (см. renderBlock в @rd/library). Никакого
 * `innerHTML`, никакого `dangerouslySetInnerHTML`: недоверенный EPUB не может
 * выполнить код на вашем устройстве.
 *
 * Позиция отслеживается по IntersectionObserver, а не по событию scroll:
 * скролл срабатывает на каждый кадр и заставляет пересчитывать геометрию всех
 * абзацев. Наблюдатель сообщает только о пересечениях, которых на экране
 * единицы.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createTextAnchor,
  firstVisibleChapter,
  hasVisibleBlocks,
  locateSelection,
  renderChapter,
  type BookIndex,
  type EpubChapter,
} from '@rd/library';
import type { RoomSession } from './room-session.js';

export interface Selection {
  chapterIndex: number;
  blockIndex: number;
  start: number;
  end: number;
  quote: string;
}

export interface ReaderProps {
  session: RoomSession;
  bookId: string | null;
  index: BookIndex | null;
  selection: Selection | null;
  /** Переход по оглавлению: null — ничего не делать. */
  goto: { chapterIndex: number; blockIndex: number } | null;
  onSelection: (selection: Selection) => void;
  onClearSelection: () => void;
}

export function Reader({ session, bookId, index, selection, goto, onSelection, onClearSelection }: ReaderProps) {
  const [chapter, setChapter] = useState<EpubChapter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Абзац, к которому возвращаемся при открытии: сохранённое место в этой
   * главе. Ноль означает «в начало». Отдельное состояние, а не поле главы,
   * чтобы прокрутка не перезапускалась при каждом кадре наблюдателя.
   */
  const [restoreBlock, setRestoreBlock] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  /**
   * Абзацы этой главы, в которых есть комментарии.
   *
   * Фильтр по открытой книге обязателен: список в состоянии сессии теперь
   * содержит комментарии всей комнаты, и без фильтра «свой комментарий»
   * отмечал бы абзацы чужой книги.
   */
  const commented = useMemo(() => {
    const mine = session.state.comments.filter((c) => c.bookId === bookId && c.anchor.kind === 'text');
    return new Set(
      mine
        .filter((c) => c.anchor.kind === 'text' && c.anchor.chapterIndex === chapter?.index)
        .map((c) => (c.anchor.kind === 'text' ? c.anchor.blockIndex : -1)),
    );
  }, [bookId, chapter?.index, session.state.comments]);

  // Открываем книгу и встаём на сохранённое место.
  useEffect(() => {
    let cancelled = false;
    if (bookId === null) {
      setChapter(null);
      return;
    }
    setLoading(true);
    // Сброс главы обязателен: при переключении на аудиокнигу компонент
    // размонтируется, а при возврате обратно монтируется заново — и без сброса
    // остался бы текст ПРОШЛОЙ книги на экране.
    setChapter(null);
    setError(null);
    void session
      .openBook(bookId)
      .then((book) => {
        if (cancelled || book === null) {
          if (!cancelled) setError('Файл книги ещё не получен. Попросите участника передать его.');
          return;
        }
        setError(null);
        // Место, на котором я остановился в ЭТОЙ книге. Не в комнате: одна
        // общая позиция означала, что, открыв вторую книгу, при возврате в
        // первую пришлось бы снова листать с начала.
        const saved = session.positionOf(bookId);
        const wanted = saved?.chapterIndex ?? 0;
        // Главы без видимого текста (обложка, одни картинки) пропускаем:
        // иначе пользователь видит пустую страницу и думает, что книга не
        // открылась.
        const at = firstVisibleChapter(book, wanted);
        setChapter(book.chapters[at] ?? book.chapters[0] ?? null);
        // Возвращаемся и на нужный абзац, а не в начало главы: иначе в длинной
        // главе пришлось бы искать глазами, где вы остановились.
        setRestoreBlock(saved !== null && saved.chapterIndex === at ? saved.blockIndex : 0);
      })
      .catch((err: unknown) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bookId, session]);

  // Рендерим главу. React здесь не нужен: блоки — это данные, а DOM строится
  // императивно. Так мы избегаем тысячи нод в vdom на длинной главе.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || chapter === null) return;
    host.textContent = '';
    const fragment = renderChapter(chapter, { baseDir: '', blockAttr: 'data-block' });
    host.appendChild(fragment);
    // Прокрутка к сохранённому месту — только после отрисовки, когда блок
    // уже есть в DOM. На `[chapter]`, а не на позиции: иначе эффект
    // перезапускался бы на каждом кадре скролла и дёргал страницу.
    if (restoreBlock > 0) {
      host.querySelector<HTMLElement>(`[data-block="${restoreBlock}"]`)?.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }, [chapter, restoreBlock]);

  // Наблюдатель за прогрессом.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || chapter === null || index === null || bookId === null) return;

    const visible = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const block = Number(el.getAttribute('data-block'));
          if (Number.isInteger(block)) visible.set(block, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        // Текущим считаем самый верхний заметно видимый абзац: так позиция
        // совпадает с тем, что человек видит как «начало экрана».
        let best = -1;
        let bestTop = Number.POSITIVE_INFINITY;
        for (const [block] of visible) {
          const el = host.querySelector<HTMLElement>(`[data-block="${block}"]`);
          if (el === null) continue;
          const top = el.getBoundingClientRect().top;
          if (top < bestTop) {
            bestTop = top;
            best = block;
          }
        }
        if (best < 0) return;
        session.setPosition(bookId, chapter.index, best, index.progressOf(chapter.index, best));
        for (const el of host.querySelectorAll<HTMLElement>('.rd-block-active')) el.classList.remove('rd-block-active');
        host.querySelector<HTMLElement>(`[data-block="${best}"]`)?.classList.add('rd-block-active');
      },
      { root: host.parentElement, threshold: [0, 0.25, 0.75, 1] },
    );

    for (const el of host.querySelectorAll<HTMLElement>('[data-block]')) observer.observe(el);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
      visible.clear();
    };
  }, [bookId, chapter, index, session]);

  // Переход по оглавлению: открываем нужную главу и прокручиваем к блоку.
  useEffect(() => {
    if (goto === null || bookId === null) return;
    let cancelled = false;
    void (async () => {
      const book = await session.openBook(bookId);
      if (cancelled || book === null) return;
      const target = book.chapters[goto.chapterIndex];
      if (target === undefined) return;
      setChapter(target);
      onClearSelection();
      // Прокручиваем после отрисовки главы: на момент эффекта нужного блока
      // ещё нет в DOM.
      requestAnimationFrame(() => {
        const el = hostRef.current?.querySelector<HTMLElement>(`[data-block="${goto.blockIndex}"]`);
        el?.scrollIntoView({ block: 'start', behavior: 'auto' });
        el?.classList.add('rd-block-active');
      });
    })();
    return () => {
      cancelled = true;
    };
    // Повторять переход при смене цели нужно только при смене самой цели.
  }, [bookId, goto, onClearSelection, session]);

  // Выделение фрагмента → якорь для комментария.
  const onMouseUp = useCallback(() => {
    const host = hostRef.current;
    if (host === null || chapter === null || index === null) return;
    const sel = window.getSelection();
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
      onClearSelection();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!host.contains(range.commonAncestorContainer)) return;
    const found = locateSelection(host, range);
    if (found === null) return;
    const block = chapter.blocks[found.blockIndex];
    if (block === undefined) return;
    const quote = block.text.slice(found.start, found.end);
    if (quote.trim() === '') return;
    onSelection({ chapterIndex: chapter.index, ...found, quote });
  }, [chapter, index, onClearSelection, onSelection]);

  // ─── Хост главы монтируется ВСЕГДА ───────────────────────────────────────────
  //
  // Это не стилистика, а условие работоспособности. Эффект отрисовки главы
  // зависит от `[chapter]` и работает с `hostRef.current`. Если `<article>`
  // появляется только в «успешной» ветке рендера, то при открытии книги React
  // успевает закоммитить `chapter` раньше, чем снимется флаг `loading`, и в
  // момент срабатывания эффекта хоста ещё нет: эффект выходит по
  // `hostRef.current === null` и больше не повторяется, потому что `chapter` уже
  // не меняется. Итог — пустая страница, а текст появляется только после
  // нажатия «Следующая» (оно меняет `chapter`, и эффект срабатывает уже при
  // смонтированном хосте). Именно это и происходило при смене книги.
  //
  // Поэтому ниже `<article>` вне всех ранних `return`.
  const notice = ((): ReactNode => {
    if (bookId === null) {
      return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-600">Выберите книгу в списке слева.</p>;
    }
    if (error !== null) {
      return <p className="mx-auto max-w-md pt-24 text-center text-sm text-warn-500">{error}</p>;
    }
    if (loading) return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-500">Разбираем книгу…</p>;
    if (chapter === null) {
      return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-600">В книге нет читаемых глав.</p>;
    }
    // Явное сообщение вместо пустого экрана: иначе выглядит как зависшая
    // загрузка, и пользователь жмёт «Следующая», думая, что что-то сломалось.
    if (!hasVisibleBlocks(chapter)) {
      return (
        <div className="mx-auto max-w-md pt-24 text-center">
          <p className="text-sm text-ink-500">В этой главе нет текста — только иллюстрации.</p>
          <button
            type="button"
            onClick={() => setChapterByIndex(chapter.index + 1)}
            disabled={chapter.index >= (index?.chapterCount ?? 1) - 1}
            className="mt-4 rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:bg-ink-800 disabled:opacity-30"
          >
            К следующей главе →
          </button>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="mx-auto max-w-2xl">
      {notice}
      <article ref={hostRef} className="rd-prose" onMouseUp={onMouseUp} />
      {chapter !== null && hasVisibleBlocks(chapter) && (
        <nav className="mx-auto mt-12 flex max-w-2xl items-center justify-between border-t border-ink-800 pt-4 text-sm">
          <button
            type="button"
            disabled={chapter.index === 0}
            onClick={() => setChapterByIndex(chapter.index - 1)}
            className="rounded-md border border-ink-700 px-3 py-1.5 text-ink-300 hover:bg-ink-800 disabled:opacity-30"
          >
            ← Предыдущая
          </button>
          <span className="text-xs text-ink-600">Глава {chapter.index + 1}</span>
          <button
            type="button"
            onClick={() => setChapterByIndex(chapter.index + 1)}
            className="rounded-md border border-ink-700 px-3 py-1.5 text-ink-300 hover:bg-ink-800"
          >
            Следующая →
          </button>
        </nav>
      )}
      {selection !== null && (
        <p className="mx-auto mt-4 max-w-2xl rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
          Выделено: «{selection.quote.slice(0, 80)}
          {selection.quote.length > 80 ? '…' : ''}» — добавьте комментарий справа
        </p>
      )}
      <span className="hidden">{commented.size}</span>
    </div>
  );

  /**
   * Переход к главе `next` с пропуском пустых.
   *
   * Пустые главы не должны быть и тупиком: если по кнопке «Следующая» попали
   * на главу без текста, двигаемся дальше, а не показываем белую страницу.
   */
  function setChapterByIndex(next: number): void {
    void (async () => {
      if (bookId === null) return;
      const book = await session.openBook(bookId);
      if (book === null || book === undefined) return;
      const at = firstVisibleChapter(book, next);
      const target = book.chapters[at];
      if (target === undefined) return;
      setChapter(target);
      onClearSelection();
      session.setPosition(bookId, target.index, 0, index?.progressOf(target.index, 0) ?? 0);
    })();
  }
}

export { createTextAnchor };
