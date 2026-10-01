/**
 * Схема CRDT-документа комнаты.
 *
 * Что синхронизируется между участниками (и только это):
 *   meta      — название комнаты, время создания;
 *   library   — каталог книг, доступных в комнате (НЕ сами файлы);
 *   comments  — комментарии и треды;
 *   presence  — кто где находится (через awareness, вне документа).
 *
 * Чего здесь нет и не должно быть: содержимого книг, ключей шифрования,
 * парольных фраз. Файл книги — это Blob в IndexedDB конкретного устройства;
 * комната хранит только ссылку на него (id, размер, контрольную сумму).
 *
 * Почему тело комментария — Y.Text, а не строка:
 *   Два человека одновременно правят один комментарий. При хранении строки в
 *   Y.Map получится LWW: чья-то правка пропадёт молча. Y.Text даёт посимвольное
 *   слияние — результат может выглядеть нелепо, но ничьи изменения не теряются.
 *   Вся остальная «мелочь» (флаг спойлера, resolved) лежит обычными полями: там
 *   LWW — правильное поведение, конфликт невозможен в принципе.
 */

import * as Y from 'yjs';
import type { CommentAnchor, TextAnchor, AudioAnchor } from './anchors.js';
import { newId } from '@rd/protocol';

export const ROOM_SCHEMA_VERSION = 1;

export type BookFormat = 'epub' | 'fb2' | 'audio';

export interface BookEntry {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  /** Размер исходного файла в байтах. */
  size: number;
  mime: string;
  /** Контрольная сумма содержимого — по ней проверяется целостность передачи. */
  root: string;
  addedBy: string;
  addedAt: number;
  /** Длительность аудиокниги в секундах; null для текстовых книг. */
  durationSec: number | null;
  /** Заметка «прочитано до» в глобальной доле 0..1, рассчитывается по месту чтения. */
  note: string;
}

export interface RoomMeta {
  title: string;
  createdAt: number;
  createdBy: string;
  schema: number;
}

export interface CommentReaction {
  emoji: string;
  userIds: string[];
}

export interface CommentSnapshot {
  id: string;
  bookId: string;
  anchor: CommentAnchor;
  /** null для корневого комментария, иначе id родителя в треде. */
  parentId: string | null;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: number;
  editedAt: number | null;
  /** Комментарий скрыт, пока читатель не дойдёт до этого места. */
  spoiler: boolean;
  resolved: boolean;
  reactions: CommentReaction[];
}

export type CommentMap = Y.Map<unknown>;

export class RoomDoc {
  readonly doc: Y.Doc;
  /**
   * Метаданные комнаты храним «поле на поле», а не одним объектом: Y.Map<obj>
   * сменял бы весь объект целиком, и правка заголовка затирала бы createdAt.
   */
  readonly meta: Y.Map<unknown>;
  readonly library: Y.Map<BookEntry>;
  readonly comments: Y.Map<CommentMap>;

  constructor(doc?: Y.Doc) {
    this.doc = doc ?? new Y.Doc();
    this.meta = this.doc.getMap('meta');
    this.library = this.doc.getMap<BookEntry>('library');
    this.comments = this.doc.getMap<CommentMap>('comments');
  }

  static create(params: { title: string; authorId: string; now?: number }): RoomDoc {
    const room = new RoomDoc();
    const now = params.now ?? Date.now();
    room.doc.transact(() => {
      room.meta.set('title', params.title);
      room.meta.set('createdAt', now);
      room.meta.set('createdBy', params.authorId);
      room.meta.set('schema', ROOM_SCHEMA_VERSION);
    }, 'local');
    return room;
  }

  get title(): string {
    const value = this.meta.get('title');
    return typeof value === 'string' ? value : 'Без названия';
  }

  get info(): RoomMeta {
    const num = (key: string): number => {
      const v = this.meta.get(key);
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    return {
      title: this.title,
      createdAt: num('createdAt'),
      createdBy: typeof this.meta.get('createdBy') === 'string' ? (this.meta.get('createdBy') as string) : '',
      schema: num('schema'),
    };
  }

  setTitle(title: string): void {
    this.doc.transact(() => this.meta.set('title', title.slice(0, 200)), 'local');
  }

  // ─── Библиотека ──────────────────────────────────────────────────────────────

  addBook(entry: Omit<BookEntry, 'id' | 'addedAt' | 'addedBy'> & { id?: string; addedBy: string; addedAt?: number }): string {
    const id = entry.id ?? newId();
    const book: BookEntry = {
      id,
      title: entry.title,
      author: entry.author,
      format: entry.format,
      size: entry.size,
      mime: entry.mime,
      root: entry.root,
      durationSec: entry.durationSec,
      note: entry.note,
      addedBy: entry.addedBy,
      addedAt: entry.addedAt ?? Date.now(),
    };
    this.doc.transact(() => {
      this.library.set(id, book);
    }, 'local');
    return id;
  }

  patchBook(id: string, patch: Partial<Omit<BookEntry, 'id'>>): void {
    const existing = this.library.get(id);
    if (existing === undefined) return;
    this.doc.transact(() => {
      this.library.set(id, { ...existing, ...patch });
    }, 'local');
  }

  removeBook(id: string): void {
    this.doc.transact(() => {
      this.library.delete(id);
      for (const [commentId, node] of [...this.comments.entries()]) {
        if (node.get('bookId') === id) this.comments.delete(commentId);
      }
    }, 'local');
  }

  /** Метод, а не геттер: TypeScript не разрешает геттеры с аргументами. */
  bookEntry(id: string): BookEntry | undefined {
    return this.library.get(id);
  }

  listBooks(): BookEntry[] {
    return [...this.library.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  // ─── Комментарии ─────────────────────────────────────────────────────────────

  addComment(params: {
    bookId: string;
    anchor: CommentAnchor;
    body: string;
    authorId: string;
    authorName: string;
    parentId?: string | null;
    spoiler?: boolean;
  }): string {
    const id = newId();
    const now = Date.now();
    this.doc.transact(() => {
      const node = new Y.Map<unknown>();
      node.set('id', id);
      node.set('bookId', params.bookId);
      node.set('anchor', params.anchor);
      node.set('parentId', params.parentId ?? null);
      node.set('authorId', params.authorId);
      node.set('authorName', params.authorName);
      node.set('createdAt', now);
      node.set('editedAt', null);
      node.set('spoiler', params.spoiler ?? false);
      node.set('resolved', false);
      node.set('reactions', new Y.Map<Y.Array<string>>());
      const text = new Y.Text();
      text.insert(0, params.body);
      node.set('body', text);
      this.comments.set(id, node);
    }, 'local');
    return id;
  }

  editCommentBody(id: string, body: string): void {
    const node = this.comments.get(id);
    if (node === undefined) return;
    const text = node.get('body');
    if (!(text instanceof Y.Text)) return;
    this.doc.transact(() => {
      // Полная замена: Y.Text.delete + insert в одной транзакции.
      // Так сохранется посимвольное слияние, если правки шли параллельно.
      text.delete(0, text.length);
      text.insert(0, body);
      node.set('editedAt', Date.now());
    }, 'local');
  }

  setFlag(id: string, field: 'spoiler' | 'resolved', value: boolean): void {
    const node = this.comments.get(id);
    if (node === undefined) return;
    this.doc.transact(() => node.set(field, value), 'local');
  }

  removeComment(id: string): void {
    this.doc.transact(() => {
      // Вместе с корнем удаляем весь тред: осиротевшие ответы бессмысленны.
      for (const [commentId, node] of [...this.comments.entries()]) {
        if (commentId === id || node.get('parentId') === id) this.comments.delete(commentId);
      }
    }, 'local');
  }

  toggleReaction(id: string, emoji: string, userId: string): void {
    const node = this.comments.get(id);
    if (node === undefined) return;
    const reactions = node.get('reactions');
    if (!(reactions instanceof Y.Map)) return;
    this.doc.transact(() => {
      let list = reactions.get(emoji);
      if (!(list instanceof Y.Array)) {
        list = new Y.Array<string>();
        reactions.set(emoji, list);
      }
      const current = list.toArray();
      const at = current.indexOf(userId);
      if (at >= 0) list.delete(at, 1);
      else list.push([userId]);
    }, 'local');
  }

  comment(id: string): CommentSnapshot | null {
    const node = this.comments.get(id);
    return node === undefined ? null : readComment(node);
  }

  /** Все комментарии книги, отсортированные по времени создания. */
  commentsForBook(bookId: string): CommentSnapshot[] {
    const out: CommentSnapshot[] = [];
    for (const node of this.comments.values()) {
      if (node.get('bookId') === bookId) out.push(readComment(node));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Группировка в треды: корневые комментарии с вложенными ответами. */
  threadsForBook(bookId: string): Array<{ root: CommentSnapshot; replies: CommentSnapshot[] }> {
    const all = this.commentsForBook(bookId);
    const byId = new Map(all.map((c) => [c.id, c]));
    const replies = new Map<string, CommentSnapshot[]>();
    const roots: CommentSnapshot[] = [];
    for (const comment of all) {
      if (comment.parentId !== null && byId.has(comment.parentId)) {
        const list = replies.get(comment.parentId) ?? [];
        list.push(comment);
        replies.set(comment.parentId, list);
      } else {
        // Ответ на удалённый комментарий показываем как корневой, а не прячем:
        // терять чужую реплику молча неправильно.
        roots.push(comment);
      }
    }
    for (const list of replies.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    return roots
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
  }

  // ─── Сериализация ────────────────────────────────────────────────────────────

  /** Байты для офлайн-сохранения. Yjs сам разберётся при обратном применении. */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * Применяет обновление из сети или с диска.
   * Origin помечается REMOTE, поэтому изменения не пересылаются обратно и не
   * помечаются как локальные для UndoManager.
   */
  applyUpdate(update: Uint8Array, origin: unknown = REMOTE_ORIGIN): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  destroy(): void {
    this.doc.destroy();
  }
}

/** Origin для правок, пришедших не от локального пользователя. */
export const REMOTE_ORIGIN = Symbol('rd-remote');

function readComment(node: CommentMap): CommentSnapshot {
  const body = node.get('body');
  const rawReactions = node.get('reactions');
  const reactions: CommentReaction[] = [];
  if (rawReactions instanceof Y.Map) {
    for (const [emoji, list] of rawReactions.entries()) {
      if (list instanceof Y.Array) reactions.push({ emoji, userIds: list.toArray() });
    }
  }
  reactions.sort((a, b) => (a.emoji < b.emoji ? -1 : 1));

  const anchor = node.get('anchor') as CommentAnchor;
  return {
    id: String(node.get('id')),
    bookId: String(node.get('bookId')),
    anchor: normalizeAnchor(anchor),
    parentId: (node.get('parentId') as string | null) ?? null,
    body: body instanceof Y.Text ? body.toString() : '',
    authorId: String(node.get('authorId')),
    authorName: String(node.get('authorName')),
    createdAt: Number(node.get('createdAt')),
    editedAt: node.get('editedAt') === null ? null : Number(node.get('editedAt')),
    spoiler: node.get('spoiler') === true,
    resolved: node.get('resolved') === true,
    reactions,
  };
}

/**
 * Данные из сети считаем недоверенными даже после расшифровки: пир может
 * держать ключ и подсунуть что угодно. Битый якорь превращаем в безопасный
 * «неизвестно», а не роняем интерфейс.
 */
function normalizeAnchor(value: unknown): CommentAnchor {
  if (typeof value !== 'object' || value === null) {
    return { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 0, quote: '', prefix: '', suffix: '' };
  }
  const a = value as Record<string, unknown>;
  if (a['kind'] === 'audio') {
    const timeSec = Number(a['timeSec']);
    return {
      kind: 'audio',
      timeSec: Number.isFinite(timeSec) ? Math.max(0, timeSec) : 0,
      ...(typeof a['quote'] === 'string' ? { quote: a['quote'].slice(0, 300) } : {}),
    } satisfies AudioAnchor;
  }
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    kind: 'text',
    chapterIndex: Math.max(0, Math.trunc(num(a['chapterIndex']))),
    blockIndex: Math.max(0, Math.trunc(num(a['blockIndex']))),
    start: Math.max(0, Math.trunc(num(a['start']))),
    end: Math.max(0, Math.trunc(num(a['end']))),
    quote: str(a['quote']).slice(0, 2_000),
    prefix: str(a['prefix']).slice(0, 200),
    suffix: str(a['suffix']).slice(0, 200),
  } satisfies TextAnchor;
}

export { Y };
