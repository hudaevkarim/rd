/**
 * Панель комментариев: треды, привязка к тексту и таймкодам, режим спойлера.
 *
 * Режим защиты от спойлеров: комментарий, привязанный к месту дальше текущей
 * позиции читателя, показывается замазанным. Само содержимое при этом не
 * исчезает — иначе пользователь не поймёт, что комментарий вообще есть.
 * Раскрыть можно вручную.
 */

import { useMemo, useState } from 'react';
import { createTextAnchor, isSpoilerHidden, type CommentAnchor, type CommentSnapshot, type ParsedEpub } from '@rd/library';
import type { RoomSession } from './room-session.js';
import { useSession } from './use-session.js';
import type { Selection } from './reader.js';

const REACTIONS = ['👍', '❤️', '😂', '❓'];

export interface CommentsPanelProps {
  session: RoomSession;
  bookId: string | null;
  selection: Selection | null;
  onClearSelection: () => void;
  /**
   * Якорь из аудиоплеера: секунда в записи.
   *
   * Отдельное поле, а не общий `selection`: координаты у них разные
   * (смещение в тексте против секунды), и общий тип заставил бы проверять вид
   * якоря в каждом месте, где он используется.
   */
  audioAnchor?: { timeSec: number; quote?: string } | null;
  onClearAudioAnchor?: () => void;
}

export function CommentsPanel({
  session,
  bookId,
  selection,
  onClearSelection,
  audioAnchor = null,
  onClearAudioAnchor,
}: CommentsPanelProps) {
  const state = useSession(session);
  const [draft, setDraft] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [book, setBook] = useState<ParsedEpub | null>(null);

  const index = bookId === null ? null : session.bookIndex(bookId);
  useMemo(() => {
    if (bookId === null) {
      setBook(null);
      return;
    }
    let cancelled = false;
    void session.openBook(bookId).then((b) => !cancelled && setBook(b));
    return () => {
      cancelled = true;
    };
  }, [bookId, session]);

  const comments = state?.comments ?? [];
  const threads = useMemo(() => groupThreads(comments), [comments]);
  const progress = state?.position.progress ?? 0;
  const selfId = session.selfId;

  const submit = (parentId: string | null): void => {
    const text = draft.trim();
    if (text === '' || bookId === null) return;
    // Якорь строится из того, что выделили: в тексте — фрагмент, в аудио —
    // секунда. Без выделения комментарий идёт от текущей позиции: так удобно
    // «начать с этого места».
    let anchor: CommentAnchor;
    if (parentId === null && audioAnchor !== null) {
      anchor = { kind: 'audio', timeSec: audioAnchor.timeSec, ...(audioAnchor.quote ? { quote: audioAnchor.quote } : {}) };
    } else if (parentId === null && selection !== null && book !== null) {
      anchor =
        createTextAnchor(book, selection.chapterIndex, selection.blockIndex, selection.start, selection.end) ?? {
          kind: 'text',
          chapterIndex: selection.chapterIndex,
          blockIndex: selection.blockIndex,
          start: selection.start,
          end: selection.end,
          quote: selection.quote,
          prefix: '',
          suffix: '',
        };
    } else {
      anchor = {
        kind: 'text',
        chapterIndex: state?.position.chapterIndex ?? 0,
        blockIndex: state?.position.blockIndex ?? 0,
        start: 0,
        end: 0,
        quote: '',
        prefix: '',
        suffix: '',
      };
    }

    session.addComment({ bookId, anchor, body: text, spoiler, parentId });
    setDraft('');
    setSpoiler(false);
    setReplyTo(null);
    onClearSelection();
    onClearAudioAnchor?.();
  };

  return (
    <div className="flex h-full flex-col">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
        Комментарии · {comments.length}
      </h2>

      {bookId === null ? (
        <p className="text-xs text-ink-600">Откройте книгу, чтобы обсуждать её.</p>
      ) : (
        <>
          <div className="mb-3 rounded-md border border-ink-800 bg-ink-950/60 p-2">
            {audioAnchor !== null ? (
              <p className="px-1 pb-1 text-[11px] text-warn-500">
                на {formatTimecode(audioAnchor.timeSec)}
                {audioAnchor.quote !== undefined && audioAnchor.quote !== '' ? ` — «${audioAnchor.quote.slice(0, 60)}»` : ''}
              </p>
            ) : selection === null ? (
              <p className="px-1 text-[11px] text-ink-600">
                Выделите фрагмент в тексте — комментарий привяжется к нему. Без выделения — к текущему месту.
              </p>
            ) : (
              <p className="px-1 pb-1 text-[11px] text-warn-500">
                К «{selection.quote.slice(0, 60)}
                {selection.quote.length > 60 ? '…' : ''}»
              </p>
            )}
            {replyTo !== null && (
              <p className="px-1 pb-1 text-[11px] text-ink-500">
                отвечаем{' '}
                <button type="button" className="underline" onClick={() => setReplyTo(null)}>
                  отменить
                </button>
              </p>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              placeholder="Что вы об этом думаете?"
              className="w-full resize-y rounded-md border border-ink-800 bg-ink-950 px-2 py-1.5 text-sm text-ink-100"
            />
            <div className="mt-2 flex items-center gap-2">
              <label className="flex flex-1 items-center gap-1.5 text-[11px] text-ink-500">
                <input type="checkbox" checked={spoiler} onChange={(e) => setSpoiler(e.target.checked)} />
                спойлер
              </label>
              <button
                type="button"
                onClick={() => submit(replyTo)}
                disabled={draft.trim() === ''}
                className="rounded-md bg-accent-600 px-3 py-1 text-xs text-white hover:bg-accent-400 disabled:bg-ink-800 disabled:text-ink-600"
              >
                Отправить
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {threads.length === 0 && <p className="text-xs text-ink-600">Комментариев пока нет.</p>}
            {threads.map(({ root, replies }) => {
              const hidden =
                (index !== null && isSpoilerHidden(root.anchor, progress, index, session.audioDuration(root.bookId))) ||
                (root.spoiler && (index === null || isSpoilerHidden(root.anchor, progress, index, session.audioDuration(root.bookId))));
              const open = revealed.has(root.id);
              return (
                <article key={root.id} className="rounded-md border border-ink-800 bg-ink-950/40 p-2.5">
                  <Comment
                    comment={root}
                    hidden={hidden && !open}
                    onReveal={() => setRevealed((prev) => new Set(prev).add(root.id))}
                    selfId={selfId}
                    onReact={(emoji) => session.toggleReaction(root.id, emoji)}
                    onReply={() => setReplyTo(root.id)}
                    onSpoiler={() => session.setFlag(root.id, 'spoiler', !root.spoiler)}
                    onDelete={() => session.removeComment(root.id)}
                  />
                  {replies.length > 0 && (
                    <ul className="mt-2 space-y-2 border-l border-ink-800 pl-2.5">
                      {replies.map((r) => (
                        <li key={r.id}>
                          <Comment
                            comment={r}
                            selfId={selfId}
                            onReact={(emoji) => session.toggleReaction(r.id, emoji)}
                            onDelete={() => session.removeComment(r.id)}
                            compact
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Comment(props: {
  comment: CommentSnapshot;
  selfId: string;
  hidden?: boolean;
  compact?: boolean;
  onReveal?: () => void;
  onReact: (emoji: string) => void;
  onReply?: () => void;
  onSpoiler?: () => void;
  onDelete: () => void;
}) {
  const { comment, hidden = false, compact = false } = props;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-ink-100">{comment.authorName}</span>
        <span className="text-ink-600">{formatTime(comment.createdAt)}</span>
        {comment.editedAt !== null && <span className="text-ink-600">изм.</span>}
        {comment.spoiler && <span className="rounded bg-warn-500/20 px-1 text-[10px] text-warn-500">спойлер</span>}
      </div>

      {comment.anchor.kind === 'text' && comment.anchor.quote !== '' && (
        <p className="border-l-2 border-ink-700 pl-2 text-[11px] italic text-ink-500">«{comment.anchor.quote}»</p>
      )}
      {comment.anchor.kind === 'audio' && (
        <p className="font-mono text-[11px] text-ink-500">на {formatTimecode(comment.anchor.timeSec)}</p>
      )}

      {hidden ? (
        <button
          type="button"
          onClick={props.onReveal}
          className="rd-spoiler-mask block w-full rounded bg-ink-800/60 px-2 py-1 text-left text-sm text-ink-400"
        >
          {comment.body}
          <span className="mt-1 block text-[10px] text-warn-500">нажмите, чтобы раскрыть</span>
        </button>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-ink-200">{comment.body}</p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {REACTIONS.map((emoji) => {
          const count = comment.reactions.find((r) => r.emoji === emoji)?.userIds.length ?? 0;
          return (
            <button
              key={emoji}
              type="button"
              onClick={() => props.onReact(emoji)}
              className={`rounded px-1.5 py-0.5 transition ${
                count > 0 ? 'bg-ink-700 text-ink-100' : 'bg-ink-800 text-ink-500 hover:bg-ink-700'
              }`}
            >
              {emoji}
              {count > 0 ? ` ${count}` : ''}
            </button>
          );
        })}
        {props.onReply !== undefined && !compact && (
          <button type="button" onClick={props.onReply} className="ml-auto text-ink-500 hover:text-ink-200">
            ответить
          </button>
        )}
        {props.onSpoiler !== undefined && (
          <button type="button" onClick={props.onSpoiler} className="text-ink-500 hover:text-ink-200">
            спойлер
          </button>
        )}
        {comment.authorId === props.selfId && (
          <button type="button" onClick={props.onDelete} className="text-danger-500/70 hover:text-danger-500">
            удалить
          </button>
        )}
      </div>
    </div>
  );
}

function groupThreads(comments: CommentSnapshot[]): Array<{ root: CommentSnapshot; replies: CommentSnapshot[] }> {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const replies = new Map<string, CommentSnapshot[]>();
  const roots: CommentSnapshot[] = [];
  for (const c of comments) {
    if (c.parentId !== null && byId.has(c.parentId)) {
      const list = replies.get(c.parentId) ?? [];
      list.push(c);
      replies.set(c.parentId, list);
    } else {
      roots.push(c);
    }
  }
  return roots
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((root) => ({ root, replies: (replies.get(root.id) ?? []).sort((a, b) => a.createdAt - b.createdAt) }));
}

function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Таймкод в формате ч:мм:сс / мм:сс.
 *
 * Переопределение из audio-core: там эта функция живёт вместе с остальной
 * логикой времени и покрыта тестами. Здесь она нужна только для показа в
 * комментариях, поэтому дублировать поведение (и риск разойтись с ним) смысла
 * нет. Реэкспорт, а не обёртка: так поиск по таймкоду находит одно определение.
 */
import { formatTimecode } from './audio-core.js';
export { formatTimecode };
