/**
 * Сборка сессии комнаты: крипто → signaling → mesh → Yjs → передача файлов.
 *
 * Это единственное место, где стыкуются пакеты. UI не знает ни про WebRTC, ни
 * про Yjs — он работает с плоским состоянием, которое здесь собирается. Такой
 * «слой сессии» полезен и тем, что весь конвейер одинаков в браузере и в тестах.
 *
 * Важные решения:
 *
 *  - Парольная фраза не попадает ни в URL, ни в localStorage, ни в лог. Ссылка
 *    содержит только идентификатор комнаты; фразу вводят отдельно. Если бы фраза
 *    была в ссылке, она утекла бы в историю браузера, в заголовок Referer и в
 *    мессенджер, где такую ссылку обычно и пересылают.
 *
 *  - Состояние CRDT сохраняется в IndexedDB с задержкой: пользователь может
 *    закрыть вкладку через секунду после комментария и не потерять его.
 *
 *  - Прогресс каждого участника лежит в awareness, а не в документе: это личное
 *    состояние, и в общий документ оно попадать не должно.
 */

import {
  assertCryptoSupport,
  createPeerIdentity,
  derivePassKey,
  type PassKey,
  type PeerIdentity,
} from '@rd/crypto';
import {
  CHUNK_SIZE,
  defaultRtcFactory,
  FileTransferManager,
  RoomMesh,
  WebSocketSignalTransport,
  YRoomProvider,
  type RoomPeerInfo,
  type TransferSource,
} from '@rd/p2p';
import { blobSource, BookIndex, createLibraryStore, parseEpub, RoomDoc, type BookEntry, type CommentAnchor, type CommentSnapshot, type ParsedEpub } from '@rd/library';
import { newId, type PeerDescriptor, type RoomId } from '@rd/protocol';

export type SessionStatus = 'idle' | 'deriving' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface TransferView {
  key: string;
  transferId: string;
  bookId: string;
  name: string;
  direction: 'in' | 'out';
  done: number;
  total: number;
  state: 'active' | 'done' | 'error';
  message?: string;
}

export interface ReadingPosition {
  bookId: string | null;
  chapterIndex: number;
  blockIndex: number;
  /** Глобальная доля 0..1: по ней считается прогресс и работают спойлеры. */
  progress: number;
}

export interface PeerReading {
  name: string;
  color: string;
  progress: number;
  chapterIndex: number;
  blockIndex: number;
}

export interface SessionState {
  status: SessionStatus;
  peers: RoomPeerInfo[];
  books: BookEntry[];
  comments: CommentSnapshot[];
  transfers: TransferView[];
  position: ReadingPosition;
  warnings: string[];
  safety: Record<string, string>;
  /** Кто и где читает: идентификатор участника → позиция. */
  others: Record<string, PeerReading>;
}

export interface SessionOptions {
  roomId: RoomId;
  passphrase: string;
  name: string;
  color: string;
  signalingUrl: string;
}

const SAVE_DEBOUNCE_MS = 1_500;
/** Не чаще: скролл вызывает событие десятки раз в секунду. */
const PRESENCE_THROTTLE_MS = 400;

interface Parts {
  identity: PeerIdentity;
  passKey: PassKey;
  transport: WebSocketSignalTransport;
  mesh: RoomMesh;
  provider: YRoomProvider;
  transfers: FileTransferManager;
}

export class RoomSession {
  readonly state: SessionState = {
    status: 'idle',
    peers: [],
    books: [],
    comments: [],
    transfers: [],
    position: { bookId: null, chapterIndex: 0, blockIndex: 0, progress: 0 },
    warnings: [],
    safety: {},
    others: {},
  };

  readonly #store = createLibraryStore();
  readonly #doc = new RoomDoc();
  readonly #listeners = new Set<() => void>();
  readonly #transfersByKey = new Map<string, TransferView>();
  /** Разобранные книги: разбор EPUB дорогой, поэтому кэшируем. */
  readonly #parsed = new Map<string, ParsedEpub>();
  readonly #indexes = new Map<string, BookIndex>();
  readonly #audioDuration: Record<string, number> = {};
  readonly #options: SessionOptions;

  #parts!: Parts;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #lastPresenceAt = 0;
  #stopped = false;
  /**
   * Счётчик изменений состояния.
   *
   * `state` мутируется на месте — так удобно писать код сессии, но
   * `useSyncExternalStore` сравнивает снимки по ссылке и при неизменном
   * объекте просто не вызывает перерисовку: UI замирал на «вывод ключа».
   * Поэтому наружу отдаётся версия, а по ней кэшируется новый снимок.
   */
  #version = 0;

  get version(): number {
    return this.#version;
  }

  private constructor(options: SessionOptions) {
    this.#options = options;
  }

  /**
   * Создаёт сессию. Асинхронная фаза (KDF, генерация ключей) вынесена в
   * отдельный метод, чтобы UI мог показать «выводим ключ…»: PBKDF2 на 600k
   * итераций занимает треть секунды даже на быстром ноутбуке, а на старом
   планшете — секунду.
   */
  static async create(options: SessionOptions, onChange: (state: SessionState) => void): Promise<RoomSession> {
    const session = new RoomSession(options);
    session.#listeners.add(() => onChange(session.state));
    session.#patch({ status: 'deriving' });

    await assertCryptoSupport();
    const identity = await createPeerIdentity();
    const passKey = await derivePassKey(options.passphrase, options.roomId);

    // Офлайн-правки из IndexedDB применяем ДО подключения: тогда первая же
    // синхронизация с соседями увидит полное состояние.
    const saved = await session.#store.loadYState(options.roomId);
    if (saved !== null) session.#doc.applyUpdate(saved);

    const descriptor: PeerDescriptor = {
      id: newId(),
      name: options.name,
      color: options.color,
      identityKey: toHex(identity.identityPubRaw),
      agreeKey: toHex(identity.agreePubRaw),
    };

    const transport = new WebSocketSignalTransport({
      url: options.signalingUrl,
      room: options.roomId,
      peer: descriptor,
      newPeerId: () => newId(),
    });

    const mesh = new RoomMesh({
      roomId: options.roomId,
      passKey,
      self: identity,
      transport,
      rtc: defaultRtcFactory,
      // Диагностика P2P-слоя: паузы передачи из-за backpressure, таймауты
      // подтверждений, состояние рукопожатия.
      onTrace: (message) => {
        console.debug('[rd/p2p]', message);
      },
    });
    const provider = new YRoomProvider({ mesh, doc: session.#doc.doc });

    const transfers = new FileTransferManager({
      mesh,
      createSink: async (offer) => {
        const book = session.#doc.bookEntry(offer.bookId);
        return session.#store.createSink({
          roomId: options.roomId,
          transferId: offer.transferId,
          bookId: offer.bookId,
          title: book?.title ?? offer.name,
          author: book?.author ?? '',
          format: book?.format ?? 'epub',
          mime: offer.mime,
          size: offer.size,
          root: offer.root,
          chunkSize: offer.chunkSize,
        });
      },
      findPartial: (offer) => session.#store.partialBytes(options.roomId, offer.transferId),
      resolveSource: async (transferId) => null,
      onLog: (message) => session.#warn(message),
      // Подробный журнал — только в консоль: пользователю сотни строк «чанк #47,
      // буфер 120 КБ» не нужны, а при разборе зависшей передачи без них не обойтись.
      onTrace: (message) => {
        console.debug('[rd/передача]', message);
      },
    });

    session.#parts = { identity, passKey, transport, mesh, provider, transfers };
    session.#wire();

    // Порядок важен: сначала mesh.start() — он подписывается на транспорт и
    // сам вызывает transport.start(). Если вызвать только transport.start(),
    // signaling-сервер ответит в пустоту: подписчиков на сообщения нет,
    // комната выглядит пустой, а UI молча стоит на «соединение».
    mesh.start();
    transfers.start();
    return session;
  }

  get roomId(): RoomId {
    return this.#options.roomId;
  }

  get doc(): RoomDoc {
    return this.#doc;
  }

  get mesh(): RoomMesh {
    return this.#parts.mesh;
  }

  get selfId(): string {
    try {
      return this.#parts.mesh.self;
    } catch {
      return '';
    }
  }

  get provider(): YRoomProvider {
    return this.#parts.provider;
  }

  get store() {
    return this.#store;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ─── Проводка событий ────────────────────────────────────────────────────────

  #wire(): void {
    const { transport, mesh, provider, transfers } = this.#parts;
    const options = this.#options;

    transport.on('message', (msg) => {
      if (msg.t === 'welcome') this.#patch({ status: 'connecting' });
    });
    transport.on('closed', (info) => {
      this.#patch({ status: info.willReconnect ? 'reconnecting' : 'failed' });
      if (!info.willReconnect) this.#warn('Соединение с signaling закрыто');
    });
    transport.on('warning', (w) => this.#warn(w.message));

    mesh.events.on('peers', (peers) => this.#patch({ peers }));
    mesh.events.on('open', () => {
      this.#patch({ status: 'connected' });
      this.#setUser();
    });
    mesh.events.on('closed', () => this.#patch({ status: 'reconnecting' }));
    mesh.events.on('safety', ({ peerId, code }) => {
      this.#patch({ safety: { ...this.state.safety, [peerId]: code } });
    });
    mesh.events.on('warning', (w) => this.#warn(w.message));

    this.#doc.library.observe(() => this.#patch({ books: this.#doc.listBooks() }));
    this.#doc.comments.observeDeep(() => this.#patch({ comments: this.#comments() }));
    // Любое изменение документа попадает на диск с задержкой.
    this.#doc.doc.on('update', () => this.#scheduleSave());

    provider.awareness.on('change', () => this.#rebuildPresence());
    this.#setUser();

    transfers.events.on('progress', (p) => {
      const view = this.#findTransfer(p.transferId) ?? this.#findTransfer(`${p.peerId}`);
      if (view === undefined) return;
      view.done = p.done;
      view.total = p.total;
      this.#patch({ transfers: [...this.#transfersByKey.values()] });
    });
    transfers.events.on('incoming', ({ offer }) => {
      // Принимаем только то, что уже объявлено в каталоге комнаты: иначе
      // любой участник мог бы завалить наш диск файлами без спроса.
      const known = this.#doc.bookEntry(offer.bookId) !== undefined;
      this.#upsertTransfer({
        key: offer.transferId,
        transferId: offer.transferId,
        bookId: offer.bookId,
        name: this.#doc.bookEntry(offer.bookId)?.title ?? offer.name,
        direction: 'in',
        done: 0,
        total: offer.size,
        state: known ? 'active' : 'error',
        message: known ? undefined : 'файл не объявлен в каталоге комнаты — отклонён',
      });
    });
    transfers.events.on('complete', ({ transferId, offer, direction }) => {
      const view = this.#findTransfer(transferId);
      if (view !== undefined) {
        view.state = 'done';
        view.done = view.total;
      }
      this.#patch({ transfers: [...this.#transfersByKey.values()] });
      if (direction === 'in') this.#scheduleSave();
      if (direction === 'out' && offer.root !== '') this.#doc.patchBook(offer.bookId, { root: offer.root });
    });
    transfers.events.on('error', ({ transferId, message }) => {
      const view = this.#findTransfer(transferId);
      if (view !== undefined) {
        view.state = 'error';
        view.message = message;
        this.#patch({ transfers: [...this.#transfersByKey.values()] });
      } else {
        this.#warn(message);
      }
    });

    void options;
  }

  #setUser(): void {
    const { provider, mesh } = this.#parts;
    let peerId = '';
    try {
      peerId = mesh.self;
    } catch {
      peerId = '';
    }
    provider.setLocalField('user', { name: this.#options.name, color: this.#options.color, peerId });
  }

  // ─── Позиция и присутствие ───────────────────────────────────────────────────

  setPosition(bookId: string | null, chapterIndex: number, blockIndex: number, progress: number): void {
    this.#patch({ position: { bookId, chapterIndex, blockIndex, progress } });
    const now = Date.now();
    if (now - this.#lastPresenceAt < PRESENCE_THROTTLE_MS) return;
    this.#lastPresenceAt = now;
    this.#parts.provider.setLocalField('reading', { bookId, chapterIndex, blockIndex, progress });
  }

  #rebuildPresence(): void {
    const next: Record<string, PeerReading> = {};
    const states = this.#parts.provider.awareness.getStates();
    const self = this.#parts.provider.doc.clientID;
    for (const [clientId, raw] of states) {
      if (clientId === self) continue;
      const s = raw as { user?: { name?: string; color?: string; peerId?: string }; reading?: ReadingPosition };
      const peerId = s.user?.peerId;
      if (peerId === undefined || peerId === '') continue;
      next[peerId] = {
        name: s.user?.name ?? 'Участник',
        color: s.user?.color ?? '#8d8579',
        progress: s.reading?.progress ?? 0,
        chapterIndex: s.reading?.chapterIndex ?? 0,
        blockIndex: s.reading?.blockIndex ?? 0,
      };
    }
    this.#patch({ others: next });
  }

  // ─── Библиотека ──────────────────────────────────────────────────────────────

  async importBook(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseEpub(bytes);
    const id = newId();

    await this.#store.putBook({
      id,
      roomId: this.roomId,
      title: parsed.title,
      author: parsed.author,
      format: 'epub',
      size: file.size,
      mime: file.type === '' ? 'application/epub+zip' : file.type,
      root: '',
      blob: new Blob([bytes.slice().buffer as ArrayBuffer]),
      received: file.size,
      complete: true,
      savedAt: Date.now(),
      lastOpenedAt: null,
    });

    this.#parsed.set(id, parsed);
    this.#indexes.set(id, new BookIndex(parsed));
    this.#doc.addBook({
      id,
      title: parsed.title,
      author: parsed.author,
      format: 'epub',
      size: file.size,
      mime: file.type === '' ? 'application/epub+zip' : file.type,
      root: '',
      addedBy: this.selfId === '' ? 'me' : this.selfId,
      durationSec: null,
      note: '',
    });
    this.#patch({ books: this.#doc.listBooks() });
    return id;
  }

  async shareBook(bookId: string): Promise<void> {
    const stored = await this.#store.getBook(this.roomId, bookId);
    const book = this.#doc.bookEntry(bookId);
    if (stored?.blob == null) throw new Error('файл книги не найден локально: его нужно получить от участника');
    if (book === undefined) throw new Error('книга не найдена в каталоге комнаты');
    if (this.#parts.mesh.readyPeerCount === 0) throw new Error('нет готовых соединений с участниками');

    const key = `out:${bookId}`;
    this.#upsertTransfer({
      key,
      transferId: '',
      bookId,
      name: book.title,
      direction: 'out',
      done: 0,
      total: stored.size,
      state: 'active',
    });

    const offer = await this.#parts.transfers.share({
      bookId,
      name: `${book.title}.epub`,
      mime: stored.mime,
      source: blobSource(stored.blob) as TransferSource,
    });
    const view = this.#transfersByKey.get(key);
    if (view !== undefined) view.transferId = offer.transferId;
    // Контрольная сумма известна только сейчас: записываем её в общий каталог,
    // чтобы получатели проверили файл, а повторно не качали.
    this.#doc.patchBook(bookId, { root: offer.root });
    this.#patch({ transfers: [...this.#transfersByKey.values()] });
  }

  async openBook(bookId: string): Promise<ParsedEpub | null> {
    const cached = this.#parsed.get(bookId);
    if (cached !== undefined) return cached;
    const stored = await this.#store.getBook(this.roomId, bookId);
    if (stored?.blob == null) return null;
    const parsed = parseEpub(new Uint8Array(await stored.blob.arrayBuffer()));
    this.#parsed.set(bookId, parsed);
    this.#indexes.set(bookId, new BookIndex(parsed));
    return parsed;
  }

  hasLocalFile(bookId: string): boolean {
    return this.#parsed.has(bookId);
  }

  bookIndex(bookId: string): BookIndex | null {
    return this.#indexes.get(bookId) ?? null;
  }

  setAudioDuration(bookId: string, seconds: number): void {
    this.#audioDuration[bookId] = seconds;
  }

  audioDuration(bookId: string): number {
    return this.#audioDuration[bookId] ?? 0;
  }

  // ─── Комментарии ─────────────────────────────────────────────────────────────

  addComment(params: { bookId: string; anchor: CommentAnchor; body: string; spoiler: boolean; parentId?: string | null }): string {
    return this.#doc.addComment({
      bookId: params.bookId,
      anchor: params.anchor,
      body: params.body,
      authorId: this.selfId === '' ? 'me' : this.selfId,
      authorName: this.#options.name,
      parentId: params.parentId ?? null,
      spoiler: params.spoiler,
    });
  }

  removeComment(id: string): void {
    this.#doc.removeComment(id);
  }

  toggleReaction(id: string, emoji: string): void {
    this.#doc.toggleReaction(id, emoji, this.selfId === '' ? 'me' : this.selfId);
  }

  setFlag(id: string, field: 'spoiler' | 'resolved', value: boolean): void {
    this.#doc.setFlag(id, field, value);
  }

  renameSelf(name: string): void {
    this.#options.name = name;
    this.#parts.transport.send({ t: 'rename', name, color: this.#options.color });
    this.#setUser();
  }

  dismissWarning(index: number): void {
    const warnings = this.state.warnings.filter((_w, i) => i !== index);
    this.#patch({ warnings });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    try {
      await this.#store.saveYState(this.roomId, this.#doc.encodeState());
    } catch {
      // Не смогли сохранить — не повод блокировать выход из комнаты.
    }
    this.#parts.provider.destroy();
    this.#parts.transfers.stop();
    this.#parts.mesh.stop();
    this.#listeners.clear();
  }

  // ─── Внутреннее ──────────────────────────────────────────────────────────────

  #comments(): CommentSnapshot[] {
    const { bookId } = this.state.position;
    return bookId === null ? [] : this.#doc.commentsForBook(bookId);
  }

  #findTransfer(key: string): TransferView | undefined {
    return this.#transfersByKey.get(key) ?? [...this.#transfersByKey.values()].find((t) => t.transferId === key);
  }

  #upsertTransfer(view: TransferView): void {
    this.#transfersByKey.set(view.key, view);
    this.#patch({ transfers: [...this.#transfersByKey.values()] });
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#store.saveYState(this.roomId, this.#doc.encodeState());
    }, SAVE_DEBOUNCE_MS);
  }

  #warn(message: string): void {
    this.#patch({ warnings: [...this.state.warnings.slice(-8), message] });
  }

  #patch(patch: Partial<SessionState>): void {
    Object.assign(this.state, patch);
    this.#version++;
    for (const listener of [...this.#listeners]) listener();
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export { CHUNK_SIZE };
