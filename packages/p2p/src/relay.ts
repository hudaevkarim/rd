/**
 * Relay для больших комнат: star-топология поверх mesh.
 *
 * ─── Зачем ─────────────────────────────────────────────────────────────────────
 *
 * Полная mesh даёт n*(n-1)/2 соединений: на 8 участниках это 28 соединений и
 * 56 DataChannel, на 20 — уже 190 и 380. Дальше это не масштабируется ни по
 * числу соединений, ни по трафику: каждая книга едет по своему пути, и объём
 * растёт как n².
 *
 * Star-топология: один участник (relay) соединяется со всеми, остальные — только
 * с ним. Соединений n-1, трафик идёт через relay дважды. Relay видит только
 * шифротекст и метаданные маршрутизации (кто кому), но не содержимое.
 *
 * ─── Правила, и почему именно такие ──────────────────────────────────────────
 *
 * 1. **Relay — минимальный идентификатор среди доступных участников.** Все
 *    считают одно и то же из одного и того же списка, поэтому отдельный
 *    координатор не нужен: он и был бы единственной точкой отказа.
 *
 * 2. **Список участников один и тот же.** Он приходит через signaling при входе
 *    и дополняется сообщениями о приходе и уходе. Расхождения возможны только
 *    в момент гонки, и тогда решений ровно столько же, сколько возможных
 *    состояний, — это устраняется следующей сверкой.
 *
 * 3. **Перевыборы автоматические.** Relay вышел — он исчез из списка, и
 *    следующий минимум становится relay'ем. Ничего рассылать не нужно.
 *
 * 4. **Ручной выбор побеждает автоматический.** Если хотя бы один участник
 *    назвал relay, берётся минимальный из названных. Это сходится, потому что
 *    выбор публикуется тем же списком участников. Нужен для случая «relay
 *    оказался мобильным устройством с плохой связью».
 *
 * 5. **Перегруженный relay исключается из выборов.** Он сам объявляет высокую
 *    нагрузку, остальные перестают его предлагать. Объявление приходит из
 *    того же списка, поэтому вычисление остаётся детерминированным.
 *
 * 6. **Порог перехода в star.** Пока участников не больше порога, работает mesh
 *    и relay не нужен вовсе. Это важно: для маленькой комнаты лишний посредник
 *    только добавил бы задержку и точку отказа.
 */

import type { PeerId } from '@rd/protocol';

/** Вид топологии комнаты. */
export type Topology = 'mesh' | 'star';

/** Сведения об участнике, известные всем в комнате. */
export interface RelayMember {
  id: PeerId;
  /** Участник в сети: к нему есть живое соединение или он только что вошёл. */
  online: boolean;
  /** Ручной выбор relay, если пользователь его задал. null — «не задавал». */
  preferredRelay: PeerId | null;
  /** Заявленная нагрузка. Высокая исключает участника из выборов. */
  overloaded: boolean;
}

/** Решение о топологии: чем обосновано. */
export interface RelayDecision {
  topology: Topology;
  relayId: PeerId | null;
  /** Человекочитаемое обоснование — показывается в интерфейсе. */
  reason: string;
}

export interface RelayOptions {
  /** До какого числа участников держим mesh. */
  meshLimit?: number;
  /** Свой идентификатор. */
  selfId: PeerId;
  /**
   * Разрешено ли переключаться в star.
   *
   * Отдельный флаг, а не следствие `meshLimit`: сам по себе порог означает
   * только «сверх него нужна звезда», а решение о том, можно ли её включать,
   * принимает вызывающий код. В `RoomMesh` этот флаг по умолчанию выключен,
   * потому что пересылка трафика через relay ещё не дописана — см. `RoomMeshOptions.relay`.
   */
  enabled?: boolean;
}

export const DEFAULT_MESH_LIMIT = 8;

export class RoomRelay {
  #members = new Map<PeerId, RelayMember>();
  #selfId: PeerId;
  #meshLimit: number;
  #enabled: boolean;
  #last: RelayDecision = { topology: 'mesh', relayId: null, reason: 'состав комнаты неизвестен' };
  readonly #events = new Set<(d: RelayDecision) => void>();

  constructor(opts: RelayOptions) {
    this.#selfId = opts.selfId;
    this.#meshLimit = opts.meshLimit ?? DEFAULT_MESH_LIMIT;
    this.#enabled = opts.enabled ?? true;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Текущее решение. */
  get decision(): RelayDecision {
    return this.#last;
  }

  get selfId(): PeerId {
    return this.#selfId;
  }

  /** Список участников в том виде, в каком его видят все. */
  get members(): RelayMember[] {
    return [...this.#members.values()];
  }

  get meshLimit(): number {
    return this.#meshLimit;
  }

  /** Подписка на смену решения: топологии или relay. */
  onChange(cb: (d: RelayDecision) => void): () => void {
    this.#events.add(cb);
    return () => this.#events.delete(cb);
  }

  /** Полная замена списка (например, при входе в комнату). */
  setMembers(list: RelayMember[]): void {
    this.#members = new Map(list.map((m) => [m.id, { ...m }]));
    this.#members.set(this.#selfId, this.#memberOf(this.#selfId));
    this.#recompute('состав комнаты обновлён');
  }

  upsert(member: RelayMember): void {
    const prev = this.#members.get(member.id);
    this.#members.set(member.id, { ...(prev ?? { online: true, preferredRelay: null, overloaded: false }), ...member });
    this.#recompute('изменился участник');
  }

  remove(id: PeerId): void {
    if (id === this.#selfId) return;
    if (!this.#members.delete(id)) return;
    this.#recompute('участник вышел');
  }

  /** Смена своего идентификатора: она происходит при входе в комнату. */
  setSelfId(id: PeerId): void {
    this.#selfId = id;
    this.#members.set(id, this.#memberOf(id));
    this.#recompute('свой идентификатор назначен');
  }

  /**
   * Смена порога mesh.
   *
   * `0` отключает relay полностью: комната остаётся mesh'ем любого размера.
   * Нужно, чтобы оператор мог убрать посредника, не меняя код.
   */
  setMeshLimit(limit: number): void {
    if (this.#meshLimit === limit) return;
    this.#meshLimit = limit;
    this.#recompute('изменён порог mesh');
  }

  /** Ручной выбор relay. null — вернуть автоматический. */
  preferRelay(id: PeerId | null): void {
    const self = this.#memberOf(this.#selfId);
    this.#members.set(this.#selfId, { ...self, preferredRelay: id });
    this.#recompute(id === null ? 'ручной выбор снят' : 'задан ручной выбор relay');
  }

  /** Сообщить о своей нагрузке: высокая исключает нас из выборов. */
  setOverloaded(overloaded: boolean): void {
    const self = this.#memberOf(this.#selfId);
    if (self.overloaded === overloaded) return;
    this.#members.set(this.#selfId, { ...self, overloaded });
    this.#recompute(overloaded ? 'сообщено о перегрузке' : 'нагрузка в норме');
  }

  /**
   * Пересчёт решения.
   *
   * Чистая функция от состояния — именно поэтому выбор сходится у всех
   * участников без переговоров: одинаковый вход даёт одинаковый выход.
   */
  #recompute(cause: string): void {
    const next = decideRelay(this.members, this.#meshLimit, this.#enabled);
    const changed = next.topology !== this.#last.topology || next.relayId !== this.#last.relayId;
    this.#last = changed ? { ...next, reason: `${next.reason} (${cause})` } : this.#last;
    if (!changed) return;
    for (const cb of [...this.#events]) cb(this.#last);
  }

  #memberOf(id: PeerId): RelayMember {
    return (
      this.#members.get(id) ?? {
        id,
        online: true,
        preferredRelay: null,
        overloaded: false,
      }
    );
  }
}

/**
 * Правило выбора. Вынесено отдельной функцией ради тестируемости: это ровно та
 * логика, которую должны повторять за нас все участники комнаты.
 *
 * @param members список участников, одинаковый у всех
 * @param meshLimit до какого размера держим mesh
 * @param enabled разрешено ли переключаться в star. `false` — всегда mesh:
 *   сообщения идут напрямую, участников в комнате сколько угодно.
 */
export function decideRelay(
  members: RelayMember[],
  meshLimit: number = DEFAULT_MESH_LIMIT,
  enabled: boolean = true,
): RelayDecision {
  const online = members.filter((m) => m.online);
  // Нулевой порог — это «relay выключен», а не «порог равен нулю». Разница
  // принципиальная: при meshLimit = 0 условие `online.length <= 0` истинно только
  // для пустой комнаты, и любая непустая комната уходила бы в star — то есть
  // отключение работало бы наоборот.
  if (!enabled) {
    return {
      topology: 'mesh',
      relayId: null,
      reason: `участников ${online.length}, пересылка через relay не включена`,
    };
  }
  if (meshLimit === 0 || online.length <= meshLimit) {
    return {
      topology: 'mesh',
      relayId: null,
      reason: meshLimit === 0 ? 'relay выключен' : `участников ${online.length}, mesh до ${meshLimit}`,
    };
  }

  // Кандидаты: доступные и не перегруженные. Relay перегруженным быть не может:
  // иначе его пришлось бы выбрать снова и снова.
  const candidates = online.filter((m) => !m.overloaded);
  if (candidates.length === 0) {
    // Все перегружены: лучше выбрать хоть кого-то, чем оставить комнату без
    // маршрутизации. Случайность здесь хуже перегрузки.
    return {
      topology: 'star',
      relayId: minId(online),
      reason: 'все кандидаты перегружены, выбран наименьший идентификатор',
    };
  }

  // Ручной выбор важнее автоматического, но и он должен сходиться: при разных
  // ручных выборах побеждает минимальный, и это детерминировано.
  const manual = candidates
    .map((m) => m.preferredRelay)
    .filter((id): id is PeerId => id !== null)
    .filter((id) => candidates.some((m) => m.id === id));
  if (manual.length > 0) {
    return {
      topology: 'star',
      relayId: minId(manual.map((id) => candidates.find((m) => m.id === id) as RelayMember)),
      reason: 'ручной выбор relay',
    };
  }

  return {
    topology: 'star',
    relayId: minId(candidates),
    reason: `участников ${online.length}, выбран наименьший идентификатор`,
  };
}

function minId(list: RelayMember[]): PeerId {
  let best: PeerId | null = null;
  for (const m of list) if (best === null || m.id < best) best = m.id;
  if (best === null) throw new Error('пустой список участников');
  return best;
}

/** Кто должен создавать соединение с кем в заданной топологии. */
export function shouldConnect(
  topology: Topology,
  selfId: PeerId,
  otherId: PeerId,
  relayId: PeerId | null,
): boolean {
  if (topology === 'mesh') return true;
  if (relayId === null) return true;
  // В star соединяются только с relay, и только он — со всеми.
  return selfId === relayId || otherId === relayId;
}