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
  type RtcFactory,
  type RoomPeerInfo,
  type SignalTransport,
  type TransferSource,
} from '@rd/p2p';
import {
  blobSource,
  BookIndex,
  createLibraryStore,
  RoomDoc,
  type BookEntry,
  type CommentAnchor,
  type CommentSnapshot,
  type ParsedEpub,
  type StoredBook,
} from '@rd/library';
import { parseTextBook, textMime } from './parse-book.js';
import { newId, PBKDF2_ITERATIONS, type PeerDescriptor, type RoomId } from '@rd/protocol';
import { AudioPlayer } from './audio-player.js';
import type { RemotePosition } from './audio-core.js';
import { LocalFiles, transferFileName } from './local-files.js';



/**
 * Аудиокнига или книга.
 *
 * Решение принимается по типу файла И по расширению: браузер для .m4b не всегда
 * присылает осмысленный MIME, а для .epub, наоборот, иногда присылает
 * application/octet-stream. Проверка только по типу теряла бы такие книги.
 */
function looksLikeAudio(mime: string, name: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith('audio/')) return true;
  if (m.includes('mp4') || m.includes('m4b')) return true;
  return /\.(mp3|m4a|m4b|aac|ogg|opus|flac)$/i.test(name);
}

function guessAudioMime(name: string): string {
  if (/\.m4b$/i.test(name)) return 'audio/mp4';
  if (/\.m4a$/i.test(name)) return 'audio/mp4';
  if (/\.aac$/i.test(name)) return 'audio/aac';
  if (/\.ogg$/i.test(name)) return 'audio/ogg';
  if (/\.opus$/i.test(name)) return 'audio/ogg';
  if (/\.flac$/i.test(name)) return 'audio/flac';
  return 'audio/mpeg';
}

function stripAudioExtension(name: string): string {
  return name.replace(/\.(mp3|m4a|m4b|aac|ogg|opus|flac)$/i, '').slice(0, 200) || 'Аудиокнига';
}

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

/**
 * Моё место в конкретной книге.
 *
 * ─── Почему их много, а не одна ───────────────────────────────────────────────
 *
 * Позиция в `state.position` — это «где я сейчас читаю»: она нужна соседям
 * (присутствие), спойлерам и проценту прочтения. Но держать в ней место для
 * чтения **всех** книг нельзя: одна позиция на комнату означала, что стоит
 * открыть вторую книгу — и место в первой прочитать заново придётся с начала.
 *
 * Эти записи живут в IndexedDB, а не в CRDT-документе, и это осознанно:
 * документ синхронизируется с соседями, и личная история чтения в нём стала бы
 * читаемой любым участником комнаты. Присутствие и так рассказывает соседям,
 * где я сейчас, но не где я был за все прочитанные книги.
 */
export interface BookPosition {
  bookId: string;
  chapterIndex: number;
  blockIndex: number;
  /** Секунда остановки в аудиокниге; null для текстовой. */
  audioSec: number | null;
  progress: number;
  updatedAt: number;
}

export interface PeerReading {
  name: string;
  color: string;
  progress: number;
  chapterIndex: number;
  blockIndex: number;
  /**
   * Какую аудиокнигу слушает сосед, id из каталога комнаты.
   *
   * Обязательное поле, а не выводимое из `audioTimeSec`: без него список «кто
   * где слушает» показывал чужие позиции чужой записи. Сосед слушает вторую
   * книгу — а у меня в плеере отмечалась его секунда в моей, потому что время
   * было одно и то же поле у всех книг подряд.
   */
  audioBookId: string | null;
  /** Позиция в аудиокниге, секунды. null — сосед читает текст, а не слушает. */
  audioTimeSec: number | null;
  audioPlaying: boolean;
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
  /** Следует ли за чужой позицией воспроизведения. По умолчанию false. */
  audioFollow: boolean;
  /**
   * Идентификаторы книг, чей файл лежит на этом устройстве.
   *
   * В состоянии, а не в отдельном геттере сессии: список книг перерисовывается
   * по подписке, и изменение наличия файла должно попадать в тот же снимок.
   * Иначе после докачки кнопка «передать участникам» появлялась бы только
   * после перезагрузки страницы.
   */
  localFiles: string[];
  /**
   * Где я остановился в каждой книге: id книги → место.
   *
   * Личное и локальное (IndexedDB), в отличие от `position`, которое видно
   * соседям. Ключ — id книги, поэтому переключение между книгами не теряет
   * место ни в одной из них.
   */
  positions: Record<string, BookPosition>;
  /** Кто просит у меня книгу: id книги → список просивших. */
  incomingRequests: Record<string, IncomingBookRequest[]>;
  /** Мои запросы: id книги → что я запросил и что ответили. */
  outgoingRequests: Record<string, OutgoingBookRequest>;
}

/** Позиция воспроизведения в awareness. Всё здесь приходит из сети. */
export interface RemoteAudioState {
  bookId: string;
  timeSec: number;
  playing: boolean;
  follow: boolean;
  updatedAt: number;
}

/**
 * Участник, который просит книгу у меня.
 *
 * Запросы живут только в памяти и только между пирами: в CRDT-документ они не
 * попадают намеренно — это не содержимое комнаты, а личное намерение, которое
 * должно исчезнуть вместе с вкладкой.
 */
export interface IncomingBookRequest {
  peerId: string;
  name: string;
  color: string;
  at: number;
}

/** Мой запрос на книгу: кому я писал и что ему ответили. */
export interface OutgoingBookRequest {
  bookId: string;
  /** `requested` — ждём ответа, `declined` — отказали. */
  status: 'requested' | 'declined';
  reason: string;
  at: number;
}

/** Ключ настройки в IndexedDB: персональный, не общий для комнаты. */
const audioFollowKey = 'audio-follow';
/** Префикс ключа личных мест чтения; комната добавляется к нему. */
const positionsKeyPrefix = 'positions:';
/** Как часто личные места чтения сбрасываются на диск. */
const POSITIONS_SAVE_DEBOUNCE_MS = 800;

/**
 * Подменяемые части окружения.
 *
 * Нужны не для красоты: WebRTC в Node не работает физически, поэтому сквозной
 * тест передачи файла через web-слой иначе собрать нельзя. Подменяются ровно
 * те вещи, которые в Node не существуют: хранилище, сигналинг и сеть.
 */
export interface SessionDeps {
  store: ReturnType<typeof createLibraryStore>;
  /** Фабрика транспорта signaling. По умолчанию WebSocket. */
  transport?: (descriptor: PeerDescriptor) => SignalTransport;
  /** Фабрика RTCPeerConnection. */
  rtc?: RtcFactory;
  /** Итераций PBKDF2: в тестах 1000 вместо 600 тысяч. */
  kdfIterations?: number;
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
  transport: SignalTransport;
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
    audioFollow: false,
    localFiles: [],
    positions: {},
    incomingRequests: {},
    outgoingRequests: {},
  };

  /** Заменяемое окружение. Тесты подставляют своё: см. SessionDeps. */
#deps: SessionDeps = { store: createLibraryStore() };

  get #store(): ReturnType<typeof createLibraryStore> {
    return this.#deps.store;
  }

  readonly #doc = new RoomDoc();
  /** Плеер создаётся лениво: в комнате без аудиокниг он не нужен. */
  #audio: AudioPlayer | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #transfersByKey = new Map<string, TransferView>();
  /** Разобранные книги: разбор EPUB дорогой, поэтому кэшируем. */
  readonly #parsed = new Map<string, ParsedEpub>();
  /**
   * Книги, чей файл реально лежит в IndexedDB на этом устройстве.
   *
   * Отдельно от `#parsed`, потому что разбор есть только у EPUB, а аудиокнигу
   * нечем разбирать. Проверять наличие файла по кэшу разбора было ошибкой:
   * аудиокнига всегда считалась «не полученной».
   */
  readonly #localFiles = new LocalFiles();
  readonly #indexes = new Map<string, BookIndex>();
  readonly #audioDuration: Record<string, number> = {};
  readonly #options: SessionOptions;
  /** Личные места чтения по книгам; источник — IndexedDB, не CRDT. */
  readonly #positions = new Map<string, BookPosition>();

  #parts!: Parts;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #positionsTimer: ReturnType<typeof setTimeout> | null = null;
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
  static async create(
    options: SessionOptions,
    onChange: (state: SessionState) => void,
    deps?: Partial<SessionDeps>,
  ): Promise<RoomSession> {
    const session = new RoomSession(options);
    if (deps !== undefined) session.#deps = { ...session.#deps, ...deps };
    session.#listeners.add(() => onChange(session.state));
    session.#patch({ status: 'deriving' });

    await assertCryptoSupport();
    const identity = await createPeerIdentity();
    const passKey = await derivePassKey(
      options.passphrase,
      options.roomId,
      session.#deps.kdfIterations ?? PBKDF2_ITERATIONS,
    );

    // Офлайн-правки из IndexedDB применяем ДО подключения: тогда первая же
    // синхронизация с соседями увидит полное состояние.
    const saved = await session.#store.loadYState(options.roomId);
    if (saved !== null) session.#doc.applyUpdate(saved);

    // Личный выбор «следовать за позицией соседей» переживает перезагрузку
    // страницы. По умолчанию выключено: навязывание чужой позиции без
    // явного согласия — худшее, что может сделать плеер в чужой комнате.
    const follow = await session.#store.getSetting<boolean>(audioFollowKey).catch(() => undefined);
    session.#patch({ audioFollow: follow === true });
    // Личные места чтения — тоже личное, поэтому тоже с диска и не из CRDT.
    await session.#loadPositions();
    // Каталог комнаты уже загружен: сверяем его с тем, что лежит на диске,
    // иначе после перезагрузки все книги выглядят «не полученными».
    await session.refreshLocalFiles().catch(() => []);

    const descriptor: PeerDescriptor = {
      id: newId(),
      name: options.name,
      color: options.color,
      identityKey: toHex(identity.identityPubRaw),
      agreeKey: toHex(identity.agreePubRaw),
    };

    const transport =
      session.#deps.transport?.(descriptor) ??
      new WebSocketSignalTransport({
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
      rtc: session.#deps.rtc ?? defaultRtcFactory,
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
        // Защита от чужих файлов: без записи в каталоге комнаты книга не
        // принимается. Раньше проверка жила только в обработчике события
        // 'incoming' и влияла на ВИД в интерфейсе — сам приёмник при этом
        // создавался, и файл спокойно ложился на диск. Комментарий обещал
        // защиту, которой не было.
        if (book === undefined) {
          session.#warn(`файл отклонён: «${offer.name}» нет в каталоге комнаты`);
          return null;
        }
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
      // Подробный журнал — только в консоль: пользователю сотни строк «чанк #47,
      // буфер 120 КБ» не нужны, а при разборе зависшей передачи без них не обойтись.
      onTrace: (message) => {
        console.debug('[rd/передача]', message);
      },
      // Причины отказа видны пользователю: «файла нет в каталоге» иначе
      // выглядит как зависшая передача без объяснений.
      onLog: (message) => session.#warn(message),
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

  /**
   * Менеджер передач.
   *
   * Нужен сквозным тестам: они проверяют приём файла, которого нет в каталоге,
   * а `shareBook` такой файл отправлять не даст (и правильно — получатель его
   * всё равно отклонит).
   */
  get transfers(): FileTransferManager {
    return this.#parts.transfers;
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
    // Запросы и отказы по книгам. Слушаем сами, а не через FileTransferManager:
    // запрос не привязан к передаче (transferId ещё не существует), и он
    // приходит в том случае, когда файл у нас ЕСТЬ, — то есть передача
    // ещё не начиналась.
    mesh.events.on('ctrl', ({ peerId, payload }) => {
      if (payload.kind !== 'json') return;
      const msg = payload.msg;
      if (msg.k === 'book-request') this.#onBookRequest(peerId, msg.bookId);
      else if (msg.k === 'book-decline') this.#onBookDecline(peerId, msg.bookId, msg.reason);
    });
    // Пир вышел: его просьбы больше неактуальны, иначе кнопка «Передать» ждала
    // бы того, кого в комнате нет.
    mesh.events.on('peers', (peers) => this.#forgetGonePeers(peers.map((p) => p.id)));

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
      // Файл докачался и лежит в IndexedDB — отмечаем сразу. Иначе кнопка
      // «передать участникам» оставалась бы скрытой до следующей перезагрузки.
      this.#markLocal(offer.bookId);
      // Книгу получили — мой запрос к ней больше не нужен, и кнопка «Отменить
      // запрос» исчезает сама.
      if (direction === 'in') this.#onBookArrived(offer.bookId);
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
    // Плеер мог быть создан до подключения, когда peerId был ещё неизвестен.
    this.#audio?.setPeerId(peerId);
  }

  // ─── Позиция и присутствие ───────────────────────────────────────────────────

  setPosition(bookId: string | null, chapterIndex: number, blockIndex: number, progress: number): void {
    this.#patch({ position: { bookId, chapterIndex, blockIndex, progress } });
    // Личное место в книге запоминаем всегда, даже когда публикация в
    // присутствие прорежена троттлингом: троттлинг экономит трафик, а место
    // чтения нужно сохранять точно.
    if (bookId !== null) this.#rememberPosition(bookId, { chapterIndex, blockIndex, audioSec: null, progress });
    const now = Date.now();
    if (now - this.#lastPresenceAt < PRESENCE_THROTTLE_MS) return;
    this.#lastPresenceAt = now;
    this.#parts.provider.setLocalField('reading', { bookId, chapterIndex, blockIndex, progress });
  }

  /**
   * Запоминает место остановки в аудиокниге.
   *
   * Отдельный метод, а не `setPosition` с нулями: у аудио нет ни глав, ни
   * блоков, и забивать их нулями значило бы при возврате в книгу прыгать в
   * начало. Секунды хранятся отдельно от `progress`, потому что глобальная
   * доля округляется и на длинной записи даёт заметную ошибку.
   */
  setAudioPosition(bookId: string, seconds: number, progress: number): void {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    // Позицию соседям публикует syncAudioPositions, здесь только своё место.
    this.#patch({ position: { bookId, chapterIndex: 0, blockIndex: 0, progress } });
    this.#rememberPosition(bookId, { chapterIndex: 0, blockIndex: 0, audioSec: safe, progress });
  }

  /** Где я остановился в этой книге; null — книгу ещё не открывали. */
  positionOf(bookId: string): BookPosition | null {
    return this.#positions.get(bookId) ?? null;
  }

  /**
   * Обновляет личное место в книге и планирует запись на диск.
   *
   * Перезапись целиком, а не слияние по полям: у позиции есть один смысл —
   * «где я остановился», и смешивание старой главы с новой секундой дало бы
   * бессмысленное значение.
   */
  #rememberPosition(
    bookId: string,
    patch: { chapterIndex: number; blockIndex: number; audioSec: number | null; progress: number },
  ): void {
    const next: BookPosition = {
      bookId,
      chapterIndex: Math.max(0, Math.trunc(patch.chapterIndex)),
      blockIndex: Math.max(0, Math.trunc(patch.blockIndex)),
      audioSec: patch.audioSec,
      progress: clamp01(patch.progress),
      updatedAt: Date.now(),
    };
    const prev = this.#positions.get(bookId);
    // Прокрутка шлёт позицию десятки раз в секунду, а писать в IndexedDB на
    // каждый абзац нельзя. Поэтому запись идёт только при заметном сдвиге.
    if (
      prev !== undefined &&
      prev.chapterIndex === next.chapterIndex &&
      prev.blockIndex === next.blockIndex &&
      Math.abs((prev.audioSec ?? -1) - (next.audioSec ?? -1)) < 5 &&
      Math.abs(prev.progress - next.progress) < 0.001
    ) {
      return;
    }
    this.#positions.set(bookId, next);
    this.#patch({ positions: { ...this.state.positions, [bookId]: next } });
    this.#schedulePositionsSave();
  }

  /**
   * Поднимает сохранённые места чтения.
   *
   * Данные с диска считаются своими, но всё равно проверяются:IndexedDB мог
   * остаться со старой версией или с чужой комнаты, и битая запись не должна
   * уронить открытие книги (например, главой из миллиона или `NaN` в секундах).
   */
  async #loadPositions(): Promise<void> {
    const raw = await this.#store.getSetting<Record<string, unknown>>(`${positionsKeyPrefix}${this.roomId}`).catch(
      () => undefined,
    );
    if (raw === undefined || raw === null || typeof raw !== 'object') return;
    const clean: Record<string, BookPosition> = {};
    for (const [bookId, value] of Object.entries(raw)) {
      const pos = sanitizeBookPosition(bookId, value);
      if (pos !== null) {
        this.#positions.set(bookId, pos);
        clean[bookId] = pos;
      }
    }
    if (Object.keys(clean).length > 0) this.#patch({ positions: clean });
  }

  #schedulePositionsSave(): void {
    if (this.#positionsTimer !== null) clearTimeout(this.#positionsTimer);
    this.#positionsTimer = setTimeout(() => {
      this.#positionsTimer = null;
      this.flushPositions();
    }, POSITIONS_SAVE_DEBOUNCE_MS);
    this.#positionsTimer.unref?.();
  }

  /**
   * Сбрасывает личные места на диск.
   *
   * Вызывается по таймеру и при выходе из комнаты: незаписанная позиция —
   * это как раз та потерянная глава, ради которой всё затевалось.
   */
  flushPositions(): void {
    if (this.#positionsTimer !== null) {
      clearTimeout(this.#positionsTimer);
      this.#positionsTimer = null;
    }
    if (this.#positions.size === 0) return;
    const snapshot: Record<string, BookPosition> = {};
    for (const [id, pos] of this.#positions) snapshot[id] = pos;
    void this.#store.setSetting(`${positionsKeyPrefix}${this.roomId}`, snapshot).catch(() => {});
  }

  #rebuildPresence(): void {
    const next: Record<string, PeerReading> = {};
    const states = this.#parts.provider.awareness.getStates();
    const self = this.#parts.provider.doc.clientID;
    for (const [clientId, raw] of states) {
      if (clientId === self) continue;
      const s = raw as {
        user?: { name?: string; color?: string; peerId?: string };
        reading?: ReadingPosition;
        audio?: { bookId?: unknown; timeSec?: unknown; playing?: unknown };
      };
      const peerId = s.user?.peerId;
      if (peerId === undefined || peerId === '') continue;
      // Позиция из awareness недоверенная: пир мог прислать что угодно. Поэтому
      // числа приводим и зажимаем, а не берём как есть — иначе один мусорный
      // peerId с timeSec = NaN уронил бы перерисовку всего списка.
      const audioTime = s.audio?.timeSec;
      // Книгу соседа берём только если она есть в нашем каталоге: иначе в
      // плеере появился бы «слушает» для записи, которой у нас нет.
      const audioBook = typeof s.audio?.bookId === 'string' ? s.audio.bookId : null;
      const known = audioBook !== null && this.#doc.bookEntry(audioBook) !== undefined;
      next[peerId] = {
        name: s.user?.name ?? 'Участник',
        color: s.user?.color ?? '#8d8579',
        progress: s.reading?.progress ?? 0,
        chapterIndex: s.reading?.chapterIndex ?? 0,
        blockIndex: s.reading?.blockIndex ?? 0,
        audioBookId: known ? audioBook : null,
        audioTimeSec:
          known && typeof audioTime === 'number' && Number.isFinite(audioTime) && audioTime >= 0 ? audioTime : null,
        audioPlaying: s.audio?.playing === true,
      };
    }
    this.#patch({ others: next });
  }

  // ─── Библиотека ──────────────────────────────────────────────────────────────

  async importBook(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Аудиокнига не разбирается: это бинарный поток, и читать его в память
    // ради каталога незачем. Достаточно узнать длительность, а она становится
    // известна только после загрузки в плеер.
    const isAudio = looksLikeAudio(file.type, file.name);
    if (isAudio) return this.#importAudio(file, bytes);

    // Формат определяем по содержимому, а не по расширению: браузер для .fb2
    // обычно присылает пустой MIME, а переименованный файл вводит в
    // заблуждение и по расширению.
    const { book: parsed, format } = parseTextBook(bytes);
    const mime = textMime(format, file.type);
    const id = newId();

    await this.#store.putBook({
      id,
      roomId: this.roomId,
      title: parsed.title,
      author: parsed.author,
      format,
      size: file.size,
      mime,
      root: '',
      blob: new Blob([bytes.slice().buffer as ArrayBuffer]),
      received: file.size,
      complete: true,
      savedAt: Date.now(),
      lastOpenedAt: null,
    });

    this.#parsed.set(id, parsed);
    this.#markLocal(id);
    this.#indexes.set(id, new BookIndex(parsed));
    this.#doc.addBook({
      id,
      title: parsed.title,
      author: parsed.author,
      format,
      size: file.size,
      mime,
      root: '',
      addedBy: this.selfId === '' ? 'me' : this.selfId,
      durationSec: null,
      note: '',
    });
    this.#patch({ books: this.#doc.listBooks() });
    return id;
  }

  /**
   * Импорт аудиокниги.
   *
   * Параллельно с сохранением файла загружаем его в плеер ради длительности:
   * без неё шкала и спойлеры не работают, а получить её больше неоткуда — в
   * MP3 и M4B она в заголовке файла, и соседи её тоже не знают.
   */
  async #importAudio(file: File, bytes: Uint8Array): Promise<string> {
    const id = newId();
    const mime = file.type === '' ? guessAudioMime(file.name) : file.type;
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });

    await this.#store.putBook({
      id,
      roomId: this.roomId,
      title: stripAudioExtension(file.name),
      author: '',
      format: 'audio',
      size: file.size,
      mime,
      root: '',
      blob,
      received: file.size,
      complete: true,
      savedAt: Date.now(),
      lastOpenedAt: null,
    });

    this.#markLocal(id);
    this.#doc.addBook({
      id,
      title: stripAudioExtension(file.name),
      author: '',
      format: 'audio',
      size: file.size,
      mime,
      root: '',
      addedBy: this.selfId === '' ? 'me' : this.selfId,
      durationSec: null,
      note: '',
    });

    try {
      await this.audio.load({ bookId: id, title: stripAudioExtension(file.name), blob, mime });
      const duration = this.audio.durationSec;
      if (duration > 0) this.setAudioDuration(id, duration);
    } catch {
      // Файл сохранился, но плеер его не взял (браузер не знает формата).
      // Это не повод отказывать в импорте: файл в каталоге, его можно
      // передать соседям, у которых браузер другой.
      this.#warn(`аудиофайл сохранён, но длительность определить не удалось: ${file.name}`);
    }

    this.#patch({ books: this.#doc.listBooks() });
    return id;
  }

  /**
   * Передаёт книгу тем, кто её запросил.
   *
   * ─── Почему не «всем участникам» ─────────────────────────────────────────────
   *
   * Кнопка называлась «Передать участникам», а значила «всем, кто сейчас на
   * связи», и книга уезжала каждому молча — включая тех, кто её не просил.
   * Теперь круг передачи — ровно те, кто нажал «Запросить книгу». Если
   * запросивших нет, это сообщается прямо, а не делается вид, что файл у кого-то
   * скачался.
   *
   * @param only отправить только этому пиру. Для кнопки «Передать» рядом с
   *   конкретным запросом: один человек запросил — ему и уходит файл.
   */
  async shareBook(bookId: string, only?: string): Promise<void> {
    const stored = await this.#store.getBook(this.roomId, bookId);
    const book = this.#doc.bookEntry(bookId);
    if (stored?.blob == null) throw new Error('файл книги не найден локально: его нужно получить от участника');
    if (book === undefined) throw new Error('книга не найдена в каталоге комнаты');
    if (this.#parts.mesh.readyPeerCount === 0) throw new Error('нет готовых соединений с участниками');

    // Круг передачи: явный пир либо все, кто оставил запрос.
    const requesters = this.#requestersFor(bookId);
    const targets = only !== undefined ? [only] : [...requesters.keys()];
    if (targets.length === 0) {
      throw new Error('никто не просил эту книгу: сначала участник должен нажать «Запросить книгу»');
    }

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
      // Расширение берётся из формата, а не подставляется всегда `.epub`:
      // иначе получатель сохранял бы mp3 как «Книга.epub».
      name: transferFileName(book.title, book.format, stored.mime),
      mime: stored.mime,
      source: blobSource(stored.blob) as TransferSource,
      peers: targets,
    });
    const view = this.#transfersByKey.get(key);
    if (view !== undefined) view.transferId = offer.transferId;
    // Отправленные запросы снимаем: файл ушёл, ждать больше нечего. Просивший
    // увидит прогресс в списке передач.
    this.#clearRequests(bookId, targets);
    // Контрольная сумма известна только сейчас: записываем её в общий каталог,
    // чтобы получатели проверили файл, а повторно не качали.
    this.#doc.patchBook(bookId, { root: offer.root });
    this.#patch({ transfers: [...this.#transfersByKey.values()] });
  }

  /**
   * Просит книгу у всех участников, у которых она, вероятно, есть.
   *
   * Запрос уходит всем готовым соединениям: у нас нет точного знания, у кого
   * файл лежит на диске, — это видно только по факту. Ответит тот, у кого он
   * есть.
   */
  requestBook(bookId: string): void {
    if (this.#parts.mesh.readyPeerCount === 0) {
      this.#warn('некому отправить запрос: нет подключённых участников');
      return;
    }
    for (const peerId of this.#parts.mesh.readyPeers) {
      this.#parts.mesh.sendCtrlTo(peerId, { k: 'book-request', bookId });
    }
    this.state.outgoingRequests[bookId] = { bookId, status: 'requested', reason: '', at: Date.now() };
    this.#patch({ outgoingRequests: { ...this.state.outgoingRequests } });
  }

  /** Забирает свой запрос назад. */
  cancelBookRequest(bookId: string): void {
    const current = this.state.outgoingRequests[bookId];
    if (current === undefined) return;
    for (const peerId of this.#parts.mesh.readyPeers) {
      this.#parts.mesh.sendCtrlTo(peerId, { k: 'book-decline', bookId, reason: 'запросчик передумал' });
    }
    delete this.state.outgoingRequests[bookId];
    this.#patch({ outgoingRequests: { ...this.state.outgoingRequests } });
  }

  /** Отказ владельца: запрос снимается, книга не придёт. */
  declineBookRequest(bookId: string, peerId: string, reason = 'участник отказал в передаче'): void {
    this.#parts.mesh.sendCtrlTo(peerId, { k: 'book-decline', bookId, reason });
    this.#dropIncomingRequest(bookId, peerId);
  }

  /**
   * Кто-то попросил книгу.
   *
   * Показываем запрос только если файл действительно есть на диске: иначе
   * интерфейс звал бы человека нажать «Передать» с тем, чего нечего передавать.
   */
  #onBookRequest(peerId: string, bookId: string): void {
    const book = this.#doc.bookEntry(bookId);
    if (book === undefined) return; // не наш каталог — запрос не про нас
    if (!this.#localFiles.has(bookId)) return; // нечего отдавать
    const peer = this.state.peers.find((p) => p.id === peerId);
    const list = this.state.incomingRequests[bookId] ?? [];
    // Повторный запрос того же пира не должен плодить строки.
    if (list.some((r) => r.peerId === peerId)) return;
    this.state.incomingRequests[bookId] = [
      ...list,
      { peerId, name: peer?.name ?? 'Участник', color: peer?.color ?? '#8d8579', at: Date.now() },
    ];
    this.#patch({ incomingRequests: { ...this.state.incomingRequests } });
  }

  /**
   * `book-decline` — одно сообщение на два смысла, и их надо различать.
   *
   * Отправитель — всегда тот, кто передумал:
   *   - владелец отказал просившему → у меня есть ИСХОДЯЩИЙ запрос по этой книге,
   *     и его надо пометить «отказали»;
   *   - просивший забрал запрос назад → у меня есть ВХОДЯЩИЙ запрос от этого пира,
   *     и его надо убрать.
   *
   * Проверка входящих идёт первой: иначе отзыв запроса не убирал бы метку у
   * владельца, и кнопка «передать» продолжала бы звать того, кто уже передумал.
   * Одновременно иметь входящий и исходящий запрос по одной книге нельзя —
   * значит, порядок проверок однозначен.
   */
  #onBookDecline(peerId: string, bookId: string, reason: string): void {
    const incoming = this.state.incomingRequests[bookId] ?? [];
    if (incoming.some((r) => r.peerId === peerId)) {
      this.#dropIncomingRequest(bookId, peerId);
      return;
    }
    const current = this.state.outgoingRequests[bookId];
    if (current === undefined) return;
    this.state.outgoingRequests[bookId] = { ...current, status: 'declined', reason };
    this.#patch({ outgoingRequests: { ...this.state.outgoingRequests } });
  }

  /** Убирает просьбы ушедших участников. */
  #forgetGonePeers(alive: readonly string[]): void {
    let changed = false;
    const incoming: Record<string, IncomingBookRequest[]> = {};
    for (const [bookId, list] of Object.entries(this.state.incomingRequests)) {
      const rest = list.filter((r) => alive.includes(r.peerId));
      if (rest.length !== list.length) changed = true;
      if (rest.length > 0) incoming[bookId] = rest;
    }
    if (changed) this.#patch({ incomingRequests: incoming });
  }

  /** Кто именно просил книгу: id пира → имя для интерфейса. */
  #requestersFor(bookId: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const item of this.state.incomingRequests[bookId] ?? []) {
      // Пир мог выйти: отправлять ему в пустоту бессмысленно.
      if (!this.#parts.mesh.readyPeers.includes(item.peerId)) continue;
      out.set(item.peerId, item.name);
    }
    return out;
  }

  #clearRequests(bookId: string, peerIds: readonly string[]): void {
    const list = this.state.incomingRequests[bookId] ?? [];
    const rest = list.filter((r) => !peerIds.includes(r.peerId));
    if (rest.length === list.length) return;
    if (rest.length === 0) {
      delete this.state.incomingRequests[bookId];
      this.#patch({ incomingRequests: { ...this.state.incomingRequests } });
      return;
    }
    this.state.incomingRequests[bookId] = rest;
    this.#patch({ incomingRequests: { ...this.state.incomingRequests } });
  }

  #dropIncomingRequest(bookId: string, peerId: string): void {
    this.#clearRequests(bookId, [peerId]);
  }

  /** Пометить: книга дошла (файл уже на диске) — запрос снимается. */
  #onBookArrived(bookId: string): void {
    const current = this.state.outgoingRequests[bookId];
    if (current === undefined) return;
    delete this.state.outgoingRequests[bookId];
    this.#patch({ outgoingRequests: { ...this.state.outgoingRequests } });
  }

  async openBook(bookId: string): Promise<ParsedEpub | null> {
    const cached = this.#parsed.get(bookId);
    if (cached !== undefined) return cached;
    const stored = await this.#store.getBook(this.roomId, bookId);
    if (stored?.blob == null) return null;
    // Формат берём и из хранилища, и проверяем по содержимому: книга могла
    // прийти от соседа под чужим именем, и тогда только содержимое скажет, что
    // это FB2 (см. parse-book.ts).
    const { book: parsed } = parseTextBook(
      new Uint8Array(await stored.blob.arrayBuffer()),
      stored.format === 'fb2' ? 'fb2' : stored.format === 'epub' ? 'epub' : undefined,
    );
    this.#parsed.set(bookId, parsed);
    this.#markLocal(bookId);
    this.#indexes.set(bookId, new BookIndex(parsed));
    return parsed;
  }

  /**
   * Книги, у которых файл уже на этом устройстве.
   *
   * Нужна при входе в комнату: каталог приезжает по CRDT, а файлы лежат в
   * IndexedDB отдельно. Без этой сверки интерфейс после перезагрузки показывал
   * «получите от участника» даже для книг, которые лежат на диске.
   */
  async refreshLocalFiles(): Promise<string[]> {
    const catalog = this.#doc.listBooks().map((b) => b.id);
    const changed = await this.#localFiles.reconcile(async (bookId) => {
      const stored = await this.#store.getBook(this.roomId, bookId).catch(() => undefined);
      return stored?.blob != null;
    }, catalog);
    if (changed) this.#patch({ localFiles: [...this.#localFiles.ids] });
    return this.#localFiles.ids;
  }

  /**
   * Есть ли файл книги на этом устройстве.
   *
   * Проверяется по факту сохранения в IndexedDB, а НЕ по наличию разобранной
   * книги в `#parsed`. Разбор есть только у EPUB: аудиокнига разбирать нечем,
   * её файл лежит в хранилище как есть. Когда проверка шла по `#parsed`,
   * у любой аудиокниги «файла не было», интерфейс прятал кнопку «передать
   * участникам» и показывал «получите от участника» — то есть отправить
   * было нечем.
   */
  hasLocalFile(bookId: string): boolean {
    return this.#localFiles.has(bookId);
  }

  /**
   * Читает локально сохранённую книгу.
   *
   * Нужна UI и тестам: без неё нечем проверить, что файл доехал целиком, и
   * единственным признаком было бы «кнопка появилась».
   */
  async readLocalBook(bookId: string): Promise<StoredBook | null> {
    const stored = await this.#store.getBook(this.roomId, bookId).catch(() => undefined);
    return stored ?? null;
  }

  /**
   * Отмечает книгу как лежащую на диске и обновляет состояние.
   *
   * Снимок `localFiles` пересоздаётся при каждом изменении: `useSyncExternalStore`
   * сравнивает по ссылке, и переиспользование массива означало бы, что панель
   * книг не перерисуется — то есть исходный баг вернётся с другой стороны.
   */
  #markLocal(bookId: string): void {
    if (!this.#localFiles.add(bookId)) return;
    this.#patch({ localFiles: [...this.#localFiles.ids] });
  }

  bookIndex(bookId: string): BookIndex | null {
    return this.#indexes.get(bookId) ?? null;
  }

  setAudioDuration(bookId: string, seconds: number): void {
    this.#audioDuration[bookId] = seconds;
    // Длительность попадает в каталог: она нужна другим участникам для
    // спойлеров и для шкалы, а пересчитывать её у себя каждый должен заново.
    const entry = this.#doc.bookEntry(bookId);
    if (entry !== undefined && entry.durationSec !== seconds) {
      this.#doc.patchBook(bookId, { durationSec: seconds });
      this.#patch({ books: this.#doc.listBooks() });
    }
  }

  audioDuration(bookId: string): number {
    // Сначала то, что мы узнали сами: у нас длительность точная, из файла.
    const known = this.#audioDuration[bookId];
    if (known !== undefined && known > 0) return known;
    // Иначе берём из каталога комнаты — его заполнил тот, кто книгу уже играл.
    return this.#doc.bookEntry(bookId)?.durationSec ?? 0;
  }

  // ─── Аудиокнига ──────────────────────────────────────────────────────────────

  /**
   * Плеер создаётся один на сессию и переиспользуется между книгами: держать
   * два элемента `<audio>` означало бы держать в памяти два файла.
   */
  get audio(): AudioPlayer {
    if (this.#audio === null) {
      // peerId нужен плееру сразу: он участвует в выборе, кто ведёт позицию.
      // Без него каждый считал бы лидером другого, и пиры тянули бы друг друга.
      this.#audio = new AudioPlayer({ peerId: this.selfId });
    }
    return this.#audio;
  }

  get hasAudio(): boolean {
    return this.#audio !== null;
  }

  /**
   * Открывает аудиокнигу: достаёт Blob из IndexedDB и отдаёт плееру.
   * @returns false, если файл ещё не получен от участника комнаты.
   */
  async openAudio(bookId: string): Promise<boolean> {
    const entry = this.#doc.bookEntry(bookId);
    if (entry === undefined) return false;
    const stored = await this.#store.getBook(this.roomId, bookId);
    if (stored?.blob == null) return false;
    await this.audio.load({
      bookId,
      title: entry.title,
      blob: stored.blob,
      mime: stored.mime === '' ? entry.mime : stored.mime,
    });
    this.#markLocal(bookId);
    return true;
  }

  /**
   * Поддерживать ли чужую позицию. По умолчанию выключено.
   *
   * Значение живёт в awareness, а не в документе: это личный выбор человека, и
   * спорить о нём через CRDT незачем. Он же сохраняется в IndexedDB, чтобы
   * пережить перезагрузку страницы.
   */
  setAudioFollow(enabled: boolean): void {
    this.audio.setFollowEnabled(enabled);
    this.#parts.provider.setLocalField('audio', {
      bookId: this.audio.bookId,
      timeSec: this.audio.positionSec,
      playing: this.audio.state === 'playing',
      follow: enabled,
      updatedAt: Date.now(),
    });
    void this.#store.setSetting(audioFollowKey, enabled).catch(() => {});
    this.#patch({ audioFollow: enabled });
  }

  get audioFollow(): boolean {
    return this.state.audioFollow;
  }

  /**
   * Публикует нашу позицию и применяет чужую.
   *
   * Вызывается из интерфейса по таймеру: плеер сам в presence не ходит, иначе
   * о нём пришлось бы знать слою сессии, а он и так уже знает о ней слишком
   * много. Здесь же собираются позиции соседей из awareness.
   */
  syncAudioPositions(now = Date.now()): void {
    const player = this.#audio;
    if (player === null || player.bookId === null) return;

    const remotes = this.#remoteAudioPositions();
    // Сначала объявляемся, потом смотрим на соседей: иначе при входе в комнату
    // мы бы несколько секунд слушали чужую позицию, не сообщив свою.
    const mine = player.publishPosition(now);
    if (mine !== null) {
      this.#parts.provider.setLocalField('audio', {
        bookId: mine.bookId,
        timeSec: mine.timeSec,
        playing: mine.playing,
        follow: player.followEnabled,
        updatedAt: now,
      });
    }
    player.applyRemote(remotes, now);
  }

  /** Позиции соседей из awareness: id пира → позиция. */
  #remoteAudioPositions(): RemotePosition[] {
    const out: RemotePosition[] = [];
    const states = this.#parts.provider.awareness.getStates();
    const self = this.#parts.provider.doc.clientID;
    for (const [clientId, raw] of states) {
      if (clientId === self) continue;
      const s = raw as { user?: { peerId?: string }; audio?: RemoteAudioState };
      const peerId = s.user?.peerId;
      const audio = s.audio;
      // Всё из awareness недоверенное: проверяем типы, а не доверяем.
      if (peerId === undefined || peerId === '') continue;
      if (audio === undefined || typeof audio !== 'object') continue;
      if (typeof audio.bookId !== 'string' || audio.bookId === '') continue;
      const timeSec = Number(audio.timeSec);
      if (!Number.isFinite(timeSec) || timeSec < 0) continue;
      // Без метки времени позицию брать нельзя: по ней считается компенсация
      // сетевой задержки, и без неё мы бы догоняли устаревшую позицию как
      // свежую. Пропускаем такую запись целиком.
      const updatedAt = Number(audio.updatedAt);
      if (!Number.isFinite(updatedAt)) continue;
      out.push({ peerId, bookId: audio.bookId, timeSec, playing: audio.playing === true, at: updatedAt });
    }
    return out;
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
    // Плеер освобождаем ДО разрыва сети: он держит Blob-ссылку на аудиокнигу, а
    // разорванная сессия уже не сможет ни доиграть, ни досохранить позицию.
    //
    // Позицию воспроизведения снимаем до `destroy()`: после него `positionSec`
    // уже ничего не вернёт, и место остановки в аудиокниге потерялось бы.
    this.#saveAudioPosition();
    this.flushPositions();
    this.#audio?.destroy();
    this.#audio = null;
    this.#parts.provider.destroy();
    this.#parts.transfers.stop();
    this.#parts.mesh.stop();
    this.#listeners.clear();
  }

  /** Запоминает, на какой секунде остановился плеер, если он что-то играет. */
  #saveAudioPosition(): void {
    const player = this.#audio;
    if (player === null || player.bookId === null) return;
    const duration = player.durationSec;
    const progress = duration > 0 ? player.positionSec / duration : 0;
    this.setAudioPosition(player.bookId, player.positionSec, progress);
  }

  // ─── Внутреннее ──────────────────────────────────────────────────────────────

  /**
   * Все комментарии комнаты, без фильтра по книге.
   *
   * ─── Почему фильтр здесь, а не здесь же ─────────────────────────────────────
   *
   * Раньше список считался для книги из `state.position` — то есть для книги,
   * которую я читаю **сейчас**. Открытая в интерфейсе книга от этого не
   * зависит, поэтому панель показывала чужие комментарии и обновлялась только
   * тогда, когда что-то менялось в документе (то есть когда пользователь что-то
   * дописывал). Фильтр по открытой книге делает панель (`CommentsPanel`).
   */
  #comments(): CommentSnapshot[] {
    return this.#doc.commentsForRoom();
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Приводит запись с диска к `BookPosition` или отбрасывает её.
 *
 * Данные из IndexedDB — свои, но недоверенные: база могла остаться от прежней
 * версии или от другой комнаты. Битое место опаснее отсутствующего — с ним
 * читалка попыталась бы открыть главу из миллиона или перемотать аудио на
 * `NaN` секунд.
 */
function sanitizeBookPosition(bookId: string, value: unknown): BookPosition | null {
  if (typeof bookId !== 'string' || bookId === '') return null;
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const num = (raw: unknown): number | null => {
    const n = Number(raw);
    return typeof raw === 'number' && Number.isFinite(n) ? n : null;
  };
  const chapterIndex = num(v['chapterIndex']);
  const blockIndex = num(v['blockIndex']);
  const progress = num(v['progress']);
  const audioSecRaw = num(v['audioSec']);
  const updatedAt = num(v['updatedAt']);
  if (chapterIndex === null || blockIndex === null) return null;
  // Главы и блоки — индексы, а не доли: округляем и зажимаем, иначе старый или
  // чужой индекс ушёл бы в запрос несуществующей главы.
  return {
    bookId,
    chapterIndex: Math.max(0, Math.trunc(chapterIndex)),
    blockIndex: Math.max(0, Math.trunc(blockIndex)),
    audioSec: audioSecRaw === null ? null : Math.max(0, audioSecRaw),
    progress: clamp01(progress ?? 0),
    updatedAt: updatedAt ?? 0,
  };
}

export { CHUNK_SIZE };
