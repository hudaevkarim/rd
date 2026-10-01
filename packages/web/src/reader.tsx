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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTextAnchor, locateSelection, renderChapter, type BookIndex, type EpubChapter } from '@rd/library';
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  /** Главы, в которых уже есть комментарии — подсвечиваем их в потоке. */
  const commented = useMemo(() => new Set(session.state.comments.map((c) => c.anchor)), [session.state.comments]);

  // Открываем книгу и встаём на сохранённое место.
  useEffect(() => {
    let cancelled = false;
    if (bookId === null) {
      setChapter(null);
      return;
    }
    setLoading(true);
    void session
      .openBook(bookId)
      .then((book) => {
        if (cancelled || book === null) {
          if (!cancelled) setError('Файл книги ещё не получен. Попросите участника передать его.');
          return;
        }
        setError(null);
        const pos = session.state.position.bookId === bookId ? session.state.position.chapterIndex : 0;
        setChapter(book.chapters[pos] ?? book.chapters[0] ?? null);
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
  }, [chapter]);

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

  if (bookId === null) {
    return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-600">Выберите книгу в списке слева.</p>;
  }
  if (loading) return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-500">Разбираем книгу…</p>;
  if (error !== null) {
    return <p className="mx-auto max-w-md pt-24 text-center text-sm text-warn-500">{error}</p>;
  }
  if (chapter === null) return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-600">В книге нет читаемых глав.</p>;

  return (
    <div className="mx-auto max-w-2xl">
      <article ref={hostRef} className="rd-prose" onMouseUp={onMouseUp} />
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
      {selection !== null && (
        <p className="mx-auto mt-4 max-w-2xl rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-xs text-warn-500">
          Выделено: «{selection.quote.slice(0, 80)}
          {selection.quote.length > 80 ? '…' : ''}» — добавьте комментарий справа
        </p>
      )}
      <span className="hidden">{commented.size}</span>
    </div>
  );

  function setChapterByIndex(next: number): void {
    void (async () => {
      if (bookId === null) return;
      const book = await session.openBook(bookId);
      const target = book?.chapters[next];
      if (book !== null && book !== undefined && target !== undefined) {
        setChapter(target);
        onClearSelection();
        session.setPosition(bookId, target.index, 0, index?.progressOf(target.index, 0) ?? 0);
      }
    })();
  }
}

export { createTextAnchor };
