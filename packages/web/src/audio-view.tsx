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
  /** Что сейчас в панели комментариев. */
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

export function AudioView({ session, bookId, onAddComment }: AudioViewProps) {
  const state = useSession(session);
  // Плеер берём у сессии: он создаётся лениво, и получатель аудиофайла к этому
  // моменту его ещё не трогал. Раньше проверка `session.hasAudio` шла перед
  // обращением к `session.audio`, то есть к геттеру, который его создаёт, —
  // и у получателя экран навсегда застревал на «Готовим плеер…».
  const player = useMemo(() => session.audio, [session]);
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
        // Фильтр по книге обязателен: список в сессии содержит комментарии всей
        // комнаты, и без него в плеере собирались бы таймкоды чужой книги.
        .filter((c) => c.bookId === bookId)
        .filter((c): c is CommentSnapshot & { anchor: AudioAnchor } => c.anchor.kind === 'audio')
        .sort((a, b) => a.anchor.timeSec - b.anchor.timeSec),
    [bookId, state?.comments],
  );
  const duration = player.durationSec > 0 ? player.durationSec : session.audioDuration(bookId ?? '');
  const others = state?.others ?? {};

  /**
   * Кто слушает ОТКРЫТУЮ запись, а кто — другую.
   *
   * Позиция соседа показывается только в первой группе: его секунда из другой
   * книги в нашей шкале означала бы ничего. Во второй — просто имя и название
   * его записи, чтобы было видно, что человек в комнате и слушает, просто не
   * то же самое.
   */
  const sameBook = useMemo(
    () => Object.entries(others).filter(([, p]) => p.audioBookId !== null && p.audioBookId === bookId),
    [bookId, others],
  );
  const otherBooks = useMemo(
    () => Object.entries(others).filter(([, p]) => p.audioBookId !== null && p.audioBookId !== bookId),
    [bookId, others],
  );
  const titleOf = (id: string | null): string =>
    id === null ? '—' : state?.books.find((b) => b.id === id)?.title ?? 'другая запись';

  // Открываем книгу, когда она выбрана И файл до неё дошёл.
  useEffect(() => {
    if (bookId === null) return;
    /**
     * Ключ включает признак наличия файла, а не только bookId.
     *
     * Аудиофайл приходит отдельной передачей через несколько секунд после
     * появления записи в каталоге. Пока файла нет, `openAudio` возвращает false,
     * и в прошлом защита `openedRef` запрещала повторную попытку навсегда: файл
     * приходил, а на экране оставалось «Файл аудиокниги ещё не получен». Теперь
     * ключ меняется вместе с появлением файла, и запись открывается сама — ровно
     * то же, что пришлось чинить в читалке.
     */
    const key = `${bookId}:${state?.localFiles.includes(bookId) === true}`;
    if (openedRef.current === key) return;
    openedRef.current = key;
    let cancelled = false;
    void session
      .openAudio(bookId)
      .then((ok) => !cancelled && setStatus(ok ? null : 'Файл аудиокниги ещё не получен. Попросите участника передать его.'))
      .catch((err: unknown) => !cancelled && setStatus((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [bookId, session, state?.localFiles]);

  /**
   * Возврат на секунду, на которой остановились в ЭТОЙ аудиокниге.
   *
   * Раньше позиция бралась из заметки книги в каталоге комнаты — то есть из
   * значения, общего для всех участников. Своё место там не выжить: оно
   * обнулялось чужой перемоткой и не переживало перезагрузку страницы.
   * Теперь это личная запись в IndexedDB (см. `RoomSession.positionOf`).
   */
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  useEffect(() => {
    if (bookId === null || restoredFor === bookId) return;
    if (player.state === 'idle') return;
    setRestoredFor(bookId);
    const seconds = session.positionOf(bookId)?.audioSec ?? null;
    if (seconds !== null && seconds > 0) player.seek(seconds);
  }, [bookId, player, restoredFor, session]);

  // Слежение за соседями и публикация своей позиции.
  //
  // ─── Почему здесь НЕТ `snap.currentSec` в зависимостях ───────────────────────
  //
  // Было — и это ломало публикацию полностью. `snap.currentSec` меняется
  // несколько раз в секунду, поэтому React пересоздавал эффект на каждом кадре и
  // гасил недожданный `setInterval`. За 1500 мс таймер не успевал сработать ни
  // разу: пока шло воспроизведение, позиция соседям не уходила ВООБЩЕ. На паузе
  // (где снимок не меняется) таймер выстреливал — и поэтому синхронизация
  // «работала» только в покое, а в живом воспроизведении молчала.
  //
  // Вместо снимка читается `player.positionSec` прямо в тике: это живой геттер,
  // проблема устаревшего замыкания не возникает, а зависимости перестали
  // меняться на каждом кадре.
  useEffect(() => {
    if (bookId === null) return;
    const offSynced = player.events.on('synced', (e) => {
      const info = e as { reason: string; leaderId: string | null };
      setFollowHint(info.leaderId === null ? null : `${info.reason} (участник ${info.leaderId.slice(0, 4)})`);
    });
    const timer = setInterval(() => {
      session.syncAudioPositions();
      const current = player.positionSec;
      // Именно setAudioPosition, а не setPosition с нулями: у аудио нет ни глав,
      // ни блоков, и запись с нулями затирала бы место в главе текста.
      session.setAudioPosition(bookId, current, duration > 0 ? current / duration : 0);
    }, 1500);
    return () => {
      offSynced();
      clearInterval(timer);
    };
  }, [bookId, duration, player, session]);

  if (bookId === null) {
    return <p className="mx-auto max-w-md pt-24 text-center text-sm text-ink-600">Выберите аудиокнигу в списке слева.</p>;
  }

  const pct = progressPercent(snap.currentSec, snap.durationSec);
  const book = state?.books.find((b) => b.id === bookId);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {/* Плеер */}
      <section className="rounded-lg border border-ink-800 bg-ink-950/60 p-4" data-testid="audio-player">
        <h2 className="text-sm font-semibold text-ink-100" data-testid="audio-title">{book?.title ?? 'Аудиокнига'}</h2>
        {player.currentChapter !== null && (
          <p className="mt-0.5 text-xs text-ink-500">{player.currentChapter.title}</p>
        )}

        <input
          type="range"
          data-testid="audio-position"
          min={0}
          max={Math.max(1, Math.floor(snap.durationSec))}
          value={Math.floor(snap.currentSec)}
          onChange={(e) => player.seek(Number(e.target.value))}
          className="mt-3 w-full accent-accent-500"
          aria-label="Позиция воспроизведения"
        />

        <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
          <span className="font-mono" data-testid="audio-current">{formatTimecode(snap.currentSec, true)}</span>
          <span className="font-mono" data-testid="audio-duration">{formatDuration(snap.durationSec)}</span>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            data-testid="audio-toggle"
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
          data-testid="audio-add-comment"
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
            data-testid="audio-follow"
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

      {/*
        Присутствие.
        ─── Почему здесь фильтр по книге ──────────────────────────────────────────
        Список брал у соседей поле времени без оглядки на то, КАКУЮ книгу они
        слушают. Я слушаю первую, сосед — вторую, и в моём плеере у него
        отмечалась его секунда из его записи: цифра выглядела правдоподобно и
        была бессмысленной. Теперь позиция показывается только у того, кто
        слушает тот же файл, а остальные перечислены отдельно — с названием
        своей записи.
      */}
      {Object.keys(others).length > 0 && (
        <section className="rounded-lg border border-ink-800 bg-ink-950/40 p-3">
          <h3 className="mb-2 text-[11px] uppercase tracking-wide text-ink-500">
            Сейчас слушают {sameBook.length > 0 ? `· ${sameBook.length}` : ''}
          </h3>
          {sameBook.length === 0 && (
            <p className="text-[11px] text-ink-600">Эту запись сейчас никто не слушает.</p>
          )}
          <ul className="space-y-1.5">
            {sameBook.map(([peerId, peer]) => (
              <li key={peerId} className="flex items-center gap-2 text-xs" data-testid="audio-peer-same-book">
                <span className="h-2 w-2 rounded-full" style={{ background: peer.color }} />
                <span className="text-ink-200">{peer.name}</span>
                {peer.audioTimeSec !== null && (
                  <button
                    type="button"
                    data-testid="audio-peer-position"
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
          {otherBooks.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-ink-800 pt-2 text-[11px] text-ink-500">
              {otherBooks.map(([peerId, peer]) => (
                <li key={peerId} className="flex items-center gap-2" data-testid="audio-peer-other-book">
                  <span className="h-2 w-2 rounded-full" style={{ background: peer.color }} />
                  <span>{peer.name}</span>
                  <span className="truncate">— {titleOf(peer.audioBookId)}</span>
                </li>
              ))}
            </ul>
          )}
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
              <li key={c.id} className="flex items-start gap-2 text-xs" data-testid="audio-comment-item">
                <button
                  type="button"
                  data-testid="audio-comment-seek"
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

export type { RemotePosition };