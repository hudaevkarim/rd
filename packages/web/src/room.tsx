/**
 * Экран комнаты: слева участники и библиотека, в центре текст, справа комментарии.
 *
 * Раскладка на CSS-grid, а не на библиотеку компонентов: приложению не нужны
 * вложенные тени, анимации и темы — нужен быстрый рендер длинного текста,
 * который не перерисовывается целиком при каждом движении мыши.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ParsedEpub } from '@rd/library';
import type { RoomSession, TransferView } from './room-session.js';
import { useSession } from './use-session.js';
import { Reader } from './reader.js';
import { CommentsPanel } from './comments.js';
import { SafetyCodes } from './safety-codes.js';
import { AudioView } from './audio-view.js';
import { formatTimecode } from './audio-core.js';

export interface RoomProps {
  session: RoomSession;
  onLeave: () => void;
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'ожидание',
  deriving: 'вывод ключа',
  connecting: 'соединение',
  connected: 'на связи',
  reconnecting: 'переподключение',
  failed: 'нет связи',
};

export function Room({ session, onLeave }: RoomProps) {
  const state = useSession(session);
  const [activeBook, setActiveBook] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [goto, setGoto] = useState<{ chapterIndex: number; blockIndex: number } | null>(null);
  const [selection, setSelection] = useState<{ chapterIndex: number; blockIndex: number; start: number; end: number; quote: string } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Книга выбирается автоматически, если в комнате она одна: чаще всего
  // пользователь заходит именно за ней.
  useEffect(() => {
    if (activeBook === null && state !== null && state.books.length === 1) {
      setActiveBook(state.books[0]?.id ?? null);
    }
  }, [activeBook, state]);

  const index = activeBook === null ? null : session.bookIndex(activeBook);
  const progress = state?.position.progress ?? 0;

  // Аудиокнига и текст — разные читалки: их нельзя смешивать в одном потоке,
  // иначе комментарии по таймкоду оказывались бы в текстовой книге.
  const books = state?.books ?? [];
  const activeEntry = books.find((b) => b.id === activeBook);
  const isAudio = activeEntry?.format === 'audio';
  /** Якорь комментария из плеера: секунда, а не смещение в тексте. */
  const [audioAnchor, setAudioAnchor] = useState<{ timeSec: number; quote?: string } | null>(null);

  // Закрываем книгу, если её убрали из каталога (участник вышел).
  useEffect(() => {
    if (activeBook !== null && books.length > 0 && !books.some((b) => b.id === activeBook)) setActiveBook(null);
  }, [activeBook, books]);

  // Переключение формата сбрасывает и выделение, и якорь аудио: они из разных
  // систем координат и вместе не имеют смысла.
  useEffect(() => {
    setSelection(null);
    setAudioAnchor(null);
  }, [activeBook]);

  const submitAudioComment = useCallback(
    (anchor: { timeSec: number; quote?: string }) => {
      if (activeBook === null) return;
      const text = window.prompt('Комментарий на ' + formatTimecode(anchor.timeSec));
      if (text === null || text.trim() === '') return;
      session.addComment({ bookId: activeBook, anchor: { kind: 'audio', ...anchor }, body: text.trim(), spoiler: false });
    },
    [activeBook, session],
  );

  const onLeaveRoom = useCallback(() => {
    void session.stop().then(onLeave);
  }, [onLeave, session]);

  const share = useCallback(
    async (bookId: string) => {
      try {
        await session.shareBook(bookId);
      } catch (err) {
        window.alert((err as Error).message);
      }
    },
    [session],
  );

  if (state === null) return <div className="p-8 text-ink-400">Загрузка…</div>;

  return (
    <div className="grid h-full grid-cols-[minmax(16rem,20rem)_1fr_minmax(20rem,26rem)]">
      {/* ─── Боковая панель: участники и библиотека ─── */}
      <aside className="flex flex-col gap-4 overflow-y-auto border-r border-ink-800 bg-ink-900/40 p-4">
        <header className="space-y-2">
          <div className="flex items-center justify-between">
            <h1 className="font-serif text-lg text-ink-50">{session.doc.title}</h1>
            <button
              type="button"
              onClick={onLeaveRoom}
              className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-400 hover:bg-ink-800"
            >
              Выйти
            </button>
          </div>
          <p className="flex items-center gap-2 text-xs text-ink-400">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                state.status === 'connected' ? 'bg-emerald-500' : state.status === 'failed' ? 'bg-danger-500' : 'bg-warn-500'
              }`}
            />
            {STATUS_LABEL[state.status] ?? state.status} · вы: {session.selfId === '' ? '—' : session.selfId.slice(0, 8)}
          </p>
          <p className="break-all font-mono text-[11px] text-ink-600">комната {session.roomId}</p>
        </header>

        <PeersPanel state={state} />
        <LibraryPanel session={session} activeBook={activeBook} onSelect={setActiveBook} onShare={(id) => void share(id)} />
        <TransfersPanel transfers={state.transfers} />
        <SafetyCodes safety={state.safety} />
      </aside>

      {/* ─── Текст ─── */}
      <section className="flex min-w-0 flex-col">
        <div className="flex items-center gap-3 border-b border-ink-800 px-6 py-3 text-sm">
          <button
            type="button"
            onClick={() => setTocOpen((v) => !v)}
            className="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-ink-300 hover:bg-ink-800"
          >
            {tocOpen ? 'Скрыть оглавление' : 'Оглавление'}
          </button>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-accent-600 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="font-mono text-xs text-ink-400">{Math.round(progress * 100)}%</span>
        </div>

        <div className="flex min-h-0 flex-1">
          {tocOpen && (
            <nav className="w-64 shrink-0 overflow-y-auto border-r border-ink-800 p-4">
              <Toc
                session={session}
                bookId={activeBook}
                onPick={(chapterIndex, blockIndex) => setGoto({ chapterIndex, blockIndex })}
              />
            </nav>
          )}
          <div ref={containerRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-10">
            {isAudio ? (
              <AudioView
                session={session}
                bookId={activeBook}
                player={session.hasAudio ? session.audio : null}
                onAddComment={submitAudioComment}
              />
            ) : (
              <Reader
                session={session}
                bookId={activeBook}
                index={index}
                selection={selection}
                goto={goto}
                onSelection={setSelection}
                onClearSelection={() => setSelection(null)}
              />
            )}
          </div>
        </div>
      </section>

      {/* ─── Комментарии ─── */}
      <aside className="overflow-y-auto border-l border-ink-800 bg-ink-900/40 p-4">
        <CommentsPanel
          session={session}
          bookId={activeBook}
          selection={isAudio ? null : selection}
          audioAnchor={isAudio ? audioAnchor : null}
          onClearSelection={() => setSelection(null)}
          onClearAudioAnchor={() => setAudioAnchor(null)}
        />
        {state.warnings.length > 0 && (
          <ul className="mt-4 space-y-1 border-t border-ink-800 pt-3 text-xs text-warn-500">
            {state.warnings.map((w, i) => (
              <li key={`${w}-${i}`}>
                <button type="button" onClick={() => session.dismissWarning(i)} className="text-left hover:underline">
                  {w} ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function PeersPanel({ state }: { state: NonNullable<ReturnType<typeof useSession>> }) {
  const self = { id: 'self', name: 'вы', color: '#8d8579', progress: state.position.progress, chapterIndex: state.position.chapterIndex, blockIndex: state.position.blockIndex };
  const others = Object.entries(state.others).map(([id, v]) => ({ id, ...v }));
  const byId = new Map(others.map((o) => [o.id, o]));
  const links = state.peers.map((p) => ({
    ...p,
    reading: byId.get(p.id) ?? { name: p.name, color: p.color, progress: 0, chapterIndex: 0, blockIndex: 0 },
  }));

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Участники · {links.length + 1}</h2>
      <ul className="space-y-2">
        <li className="flex items-center gap-2 text-sm text-ink-100">
          <Dot color="#8d8579" />
          <span className="flex-1">{self.name}</span>
          <span className="font-mono text-xs text-ink-500">{Math.round(self.progress * 100)}%</span>
        </li>
        {links.map((p) => (
          <li key={p.id} className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-ink-100">
              <Dot color={p.color} />
              <span className="flex-1 truncate">{p.reading.name}</span>
              {p.state === 'ready' ? (
                <span className="font-mono text-xs text-ink-500">{p.rttMs === null ? '' : `${p.rttMs} мс`}</span>
              ) : (
                <span className="text-[11px] text-warn-500" title={`ICE: ${p.iceState}, соединение: ${p.connectionState}`}>
                  {p.state} · {p.iceState}
                </span>
              )}
            </div>
            <div className="ml-4 h-1 overflow-hidden rounded-full bg-ink-800">
              <div className="h-full rounded-full" style={{ width: `${Math.round(p.reading.progress * 100)}%`, background: p.color }} />
            </div>
            {p.warn !== null && <p className="ml-4 text-[11px] text-warn-500">{p.warn}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />;
}

function LibraryPanel(props: {
  session: RoomSession;
  activeBook: string | null;
  onSelect: (id: string) => void;
  onShare: (id: string) => void;
}) {
  const state = useSession(props.session);
  const [busy, setBusy] = useState(false);
  const books = state?.books ?? [];

  const onFile = async (file: File | null): Promise<void> => {
    if (file === null) return;
    setBusy(true);
    try {
      const id = await props.session.importBook(file);
      props.onSelect(id);
    } catch (err) {
      window.alert(`Не удалось открыть файл: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Книги</h2>
      <label
        className={`block cursor-pointer rounded-md border border-dashed border-ink-700 px-3 py-2 text-center text-xs text-ink-400 hover:border-accent-600 hover:text-ink-200 ${
          busy ? 'opacity-50' : ''
        }`}
      >
        {busy ? 'Читаем файл…' : '+ добавить EPUB или аудиокнигу'}
        <input
          type="file"
          // Аудио в списке: без него диалог выбора на некоторых системах
          // показывает только папку с изображениями.
          accept=".epub,.fb2,application/epub+zip,.mp3,.m4a,.m4b,.aac,.ogg,.opus,.flac,audio/*"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
        />
      </label>

      {books.length === 0 && <p className="text-xs text-ink-600">Пока пусто. Добавьте книгу — она уедет к участникам по P2P.</p>}

      <ul className="space-y-1.5">
        {books.map((b) => {
          const local = props.session.hasLocalFile(b.id);
          return (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => props.onSelect(b.id)}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm transition ${
                  props.activeBook === b.id ? 'border-accent-600 bg-ink-800' : 'border-ink-800 hover:border-ink-600'
                }`}
              >
                <span className="block truncate text-ink-100">{b.title}</span>
                <span className="block truncate text-xs text-ink-500">
                  {b.author} · {(b.size / 1024).toFixed(0)} КБ
                </span>
              </button>
              <div className="mt-1 flex gap-1">
                {!local && (
                  <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-warn-500">
                    файла нет — получите от участника
                  </span>
                )}
                {local && (
                  <button
                    type="button"
                    onClick={() => props.onShare(b.id)}
                    className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 hover:bg-ink-700"
                  >
                    передать участникам
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TransfersPanel({ transfers }: { transfers: TransferView[] }) {
  const active = transfers.filter((t) => t.state === 'active' || t.state === 'error');
  if (active.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Передача</h2>
      {active.map((t) => {
        const pct = t.total === 0 ? 0 : Math.round((t.done / t.total) * 100);
        return (
          <div key={t.key} className="space-y-1 rounded-md border border-ink-800 px-3 py-2 text-xs">
            <div className="flex justify-between gap-2 text-ink-200">
              <span className="truncate">
                {t.direction === 'in' ? '← ' : '→ '}
                {t.name}
              </span>
              <span className="font-mono text-ink-500">{pct}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-ink-800">
              <div
                className={`h-full rounded-full ${t.state === 'error' ? 'bg-danger-500' : 'bg-accent-600'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {t.message !== undefined && <p className="text-danger-500">{t.message}</p>}
          </div>
        );
      })}
    </section>
  );
}

function Toc(props: {
  session: RoomSession;
  bookId: string | null;
  onPick: (chapterIndex: number, blockIndex: number) => void;
}) {
  const [entries, setEntries] = useState<Array<{ label: string; chapterIndex: number; blockIndex: number }>>([]);
  const { session, bookId, onPick } = props;
  useEffect(() => {
    let cancelled = false;
    if (bookId === null) {
      setEntries([]);
      return;
    }
    void session.openBook(bookId).then((book: ParsedEpub | null) => {
      if (cancelled || book === null) return;
      setEntries(book.toc);
    });
    return () => {
      cancelled = true;
    };
  }, [bookId, session]);

  if (bookId === null) return <p className="text-xs text-ink-600">Книга не выбрана</p>;
  if (entries.length === 0) return <p className="text-xs text-ink-600">Оглавление недоступно</p>;

  return (
    <ul className="space-y-1">
      {entries.map((e, i) => (
        <li key={`${e.chapterIndex}-${e.blockIndex}-${i}`}>
          <button
            type="button"
            onClick={() => onPick(e.chapterIndex, e.blockIndex)}
            className="w-full rounded px-2 py-1 text-left text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
          >
            {e.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
