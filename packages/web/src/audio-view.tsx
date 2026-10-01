/**
 * Экран аудиокниги: плеер, комментарии по таймкоду, присутствие.
 *
 * Разметка нарисована нами, а `<audio>` живёт внутри плеера и не виден. Причина
 * та же, по которой блоки книги рендерятся императивно: состояние плеера должно
 * быть обычным объектом, который можно отдать в `useSyncExternalStore` и который
 * можно проверить тестами без браузера.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { isSpoilerHidden, type AudioAnchor, type CommentSnapshot } from '@rd/library';
import { formatDuration, progressPercent, type RemotePosition } from './audio-core.js';
import type { AudioPlayer } from './audio-player.js';
import { formatTimecode } from './comments.js';
import type { RoomSession } from './room-session.js';
import { useSession } from './use-session.js';

export interface AudioViewProps {
  session: RoomSession;
  bookId: string | null;
  /** Плеер создаётся сессией; сюда приходит уже готовый или null. */
  player: AudioPlayer | null;
  /** Что сейчас в панели комментариев — см. AudioCommentAnchor. */
  onAddComment: (anchor: { timeSec: number; quote?: string }) => void;
}

interface Snapshot {
  currentSec: number;
  durationSec: number;
  playing: boolean;
  volumePercent: number;
}

/**
 * Читает состояние плеера в снимок для React.
 *
 * `useSyncExternalStore` сравнивает снимки по ссылке, поэтому объект должен быть
 * НОВЫМ при каждом изменении — иначе интерфейс замрёт, как уже было с сессией.
 */
function usePlayerSnapshot(player: AudioPlayer | null): Snapshot {
  const [snap, setSnap] = useState<Snapshot>({
    currentSec: 0,
    durationSec: 0,
    playing: false,
    volumePercent: 100,
  });

  useEffect(() => {
    if (player === null) return;
    const read = (): void => {
      setSnap({
        currentSec: player.positionSec,
        durationSec: player.durationSec,
        playing: player.state === 'playing',
        volumePercent: Math.round(player.volume * 100),
      });
    };
    read();
    const offTime = player.events.on('time', read);
    const offState = player.events.on('state', read);
    return () => {
      offTime();
      offState();
    };
  }, [player]);

  return snap;
}

export function AudioView({ session, bookId, player, onAddComment }: AudioViewProps) {
  const state = useSession(session);
  const snap = usePlayerSnapshot(player);
  const [status, setStatus] = useState<string | null>(null);
  const [followHint, setFollowHint] = useState<string | null>(null);
  const openedRef = useRef<string | null>(null);

  const follow = state?.audioFollow ?? false;
  // Тип сужается через filter, но TypeScript не умеет выводить предикат по полю
  // объединения — приходится проверять дважды. Это же и защита от вызова
  // .timeSec у якоря вида 'text'.
  const comments = useMemo(
    () =>
      (state?.comments ?? [])
        .filter((c): c is CommentSnapshot & { anchor: AudioAnchor } => c.anchor.kind === 'audio')
        .sort((a, b) => a.anchor.timeSec - b.anchor.timeSec),
    [state?.comments],
  );
  const duration = player?.durationSec ?? session.audioDuration(bookId ?? '');

  // Открываем книгу один раз на bookId.
  useEffect(() => {
    if (bookId === null || player === null) return;
    if (openedRef.current === bookId) return;
    openedRef.current = bookId;
    let cancelled = false;
    void session
      .openAudio(bookId)
      .then((ok) => !cancelled && setStatus(ok ? null : 'Файл аудиокниги ещё не получен. Попросите участника передать его.'))
      .catch((err: unknown) => !cancelled && setStatus((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bookId, player, session]);

  // Восстанавливаем сохранённую позицию книги.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored || player === null || bookId === null) return;
    if (player.state === 'idle') return;
    const note = state?.books.find((b) => b.id === bookId)?.note ?? '';
    const seconds = parseProgressNote(note);
    if (seconds !== null && seconds > 0) player.seek(seconds);
    setRestored(true);
  }, [bookId, player, restored, state?.books]);

  // Слежение за соседями и публикация своей позиции.
  useEffect(() => {
    if (player === null || bookId === null) return;
    const offSynced = player.events.on('synced', (e) => {
      const info = e as { reason: string; leaderId: string | null };
      setFollowHint(info.leaderId === null ? null : `${info.reason} (участник ${info.leaderId.slice(0, 4)})`);
    });
    const timer = setInterval(() => {
      session.syncAudioPositions();
      session.setPosition(bookId, 0, 0, duration > 0 ? snap.currentSec / duration : 0);
    }, 1500);
    return () => {
      offSynced();
      clearInterval(timer);
    };
  }, [bookId, duration, player, session, snap.currentSec]);

  if (bookId === null) {
    return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-600">Выберите аудиокнигу в списке слева.</p>;
  }
  if (player === null || !session.hasAudio) {
    return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-500">Готовим плеер…</p>;
  }

  const pct = progressPercent(snap.currentSec, snap.durationSec);
  const book = state?.books.find((b) => b.id === bookId);
  const others = state?.others ?? {};

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {/* Плеер */}
      <section className="rounded-lg border border-ink-800 bg-ink-950/60 p-4">
        <h2 className="text-sm font-semibold text-ink-100">{book?.title ?? 'Аудиокнига'}</h2>
        {player.currentChapter !== null && (
          <p className="mt-0.5 text-xs text-ink-500">{player.currentChapter.title}</p>
        )}

        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(snap.durationSec))}
          value={Math.floor(snap.currentSec)}
          onChange={(e) => player.seek(Number(e.target.value))}
          className="mt-3 w-full accent-accent-500"
          aria-label="Позиция воспроизведения"
        />

        <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
          <span className="font-mono">{formatTimecode(snap.currentSec, true)}</span>
          <span className="font-mono">{formatDuration(snap.durationSec)}</span>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => player.toggle()}
            className="rounded-md bg-accent-600 px-4 py-1.5 text-sm text-white hover:bg-accent-400"
          >
            {snap.playing ? 'Пауза' : 'Слушать'}
          </button>
          <button
            type="button"
            onClick={() => player.seek(Math.max(0, snap.currentSec - 30))}
            className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:bg-ink-800"
          >
            −30 c
          </button>
          <button
            type="button"
            onClick={() => player.seek(Math.min(snap.durationSec, snap.currentSec + 30))}
            className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:bg-ink-800"
          >
            +30 c
          </button>

          <label className="ml-auto flex items-center gap-2 text-xs text-ink-500">
            <span className="sr-only">Громкость</span>
            <input
              type="range"
              min={0}
              max={100}
              value={snap.volumePercent}
              onChange={(e) => player.setVolumePercent(Number(e.target.value))}
              className="w-20 accent-accent-500"
            />
          </label>
        </div>

        {/* Следующий участник */}
        <button
          type="button"
          onClick={() => onAddComment({ timeSec: snap.currentSec })}
          className="mt-3 w-full rounded-md border border-ink-800 bg-ink-900/60 px-3 py-2 text-xs text-ink-300 hover:border-accent-600"
        >
          Комментарий на {formatTimecode(snap.currentSec, true)} ({pct}%)
        </button>

        {status !== null && <p className="mt-2 text-xs text-warn-500">{status}</p>}
      </section>

      {/* Следование за соседями */}
      <section className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => session.setAudioFollow(e.target.checked)}
          />
          <span className="text-ink-300">
            Следовать за позицией других
            <span className="mt-0.5 block text-[11px] text-ink-600">
              Когда вы отстали больше чем на {5} секунд, плеер сам перемотает туда, где слушают остальные.
              Выключено по умолчанию.
            </span>
          </span>
        </label>
        {followHint !== null && follow && (
          <p className="mt-2 rounded bg-ink-800/60 px-2 py-1 text-[11px] text-ink-400">{followHint}</p>
        )}
      </section>

      {/* Присутствие */}
      {Object.keys(others).length > 0 && (
        <section className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
          <h3 className="mb-2 text-[11px] uppercase tracking-wide text-ink-500">Сейчас слушают</h3>
          <ul className="space-y-1.5">
            {Object.entries(others).map(([peerId, peer]) => (
              <li key={peerId} className="flex items-center gap-2 text-xs">
                <span className="h-2 w-2 rounded-full" style={{ background: peer.color }} />
                <span className="text-ink-200">{peer.name}</span>
                {peer.audioTimeSec !== null && (
                  <button
                    type="button"
                    onClick={() => player.seek(peer.audioTimeSec as number)}
                    className="font-mono text-ink-400 hover:text-accent-400"
                    title="Перемотать к этому участнику"
                  >
                    {formatTimecode(peer.audioTimeSec)}
                    {peer.audioPlaying === false && ' (пауза)'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Комментарии по таймкоду */}
      <section className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
        <h3 className="mb-2 text-[11px] uppercase tracking-wide text-ink-500">
          Комментарии по времени · {comments.length}
        </h3>
        {comments.length === 0 && <p className="text-xs text-ink-600">Пока нет замечаний к этой записи.</p>}
        <ul className="space-y-1.5">
          {comments.map((c) => {
            const hidden =
              c.spoiler && duration > 0
                ? isSpoilerHidden(c.anchor, snap.currentSec / duration, session.bookIndex(bookId)!, duration)
                : false;
            return (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => player.seek(c.anchor.timeSec)}
                  className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-ink-300 hover:bg-accent-600 hover:text-white"
                  title="Перемотать к комментарию"
                >
                  {formatTimecode(c.anchor.timeSec)}
                </button>
                <div className="min-w-0">
                  <span className="text-ink-400">{c.authorName}: </span>
                  {hidden ? (
                    <span className="rd-spoiler-mask text-ink-500">нажмите, чтобы раскрыть</span>
                  ) : (
                    <span className="text-ink-200">{c.body}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/**
 * Сохранённая позиция хранится как доля 0..1.
 *
 * Не в секундах: у разных участников одна и та же книга может быть отдана в
 * разной битности, и时长 может отличаться на доли секунды. Доля переживает это.
 */
function parseProgressNote(note: string): number | null {
  if (note === '') return null;
  const ratio = Number(note);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) return null;
  return ratio;
}

export type { RemotePosition };