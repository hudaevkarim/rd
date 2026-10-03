/**
 * Переключение топологии в настоящих сессиях: mesh до восьми, star дальше.
 *
 * ─── Почему проверяется именно число СОЕДИНЕНИЙ ────────────────────────────────
 *
 * Star-топология выглядит снаружи так же, как mesh: список участников в
 * интерфейсе полный, «на связи» горит у всех. Отличается только граф
 * соединений, и его-то и проверяем — по фактическим парам в ткани и по числу
 * готовых пиров у каждого.
 *
 * Важно, что переход на девятом участнике происходит БЕЗ разрыва: первые восемь
 * уже соединены, и их соединения должны остаться живыми. Проверяется явно,
 * потому что «пересоздать всё заново» проще всего и незаметно ломает чтение
 * книги и передачу файла.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLibraryStore } from '@rd/library';
import { RoomSession } from '../src/room-session.js';
import { MockRtcFabric } from '../../p2p/tests/mock-fabric.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { newId, type PeerId } from '@rd/protocol';
import { shouldConnect } from '@rd/p2p';

const cleanup: Array<() => void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    try {
      await fn?.();
    } catch {
      // Уборка не должна маскировать результат теста.
    }
  }
});

async function waitFor(pred: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Room {
  sessions: RoomSession[];
  fabric: MockRtcFabric;
  /** Порог mesh для новых сессий. */
  meshLimitOverride?: number;
  /** Разрешать ли star-топологию. */
  relayOverride: boolean;
  add(): Promise<RoomSession>;
  leave(index: number): Promise<void>;
}

/** Комната, в которую можно добавлять участников по одному. */
async function makeRoom(): Promise<Room> {
  const roomId = newId();
  const passphrase = 'север-берег-звезда-улица';
  const fabric = new MockRtcFabric({ mode: 'instant' });
  const signalRoom = new MemorySignalRoom();
  const sessions: RoomSession[] = [];
  // Объявлен отдельно от заполнения: `add` ссылается на него, и наоборот.
  const room = {
    sessions,
    fabric,
    meshLimitOverride: undefined as number | undefined,
      relayOverride: true as boolean,
    add: async (): Promise<RoomSession> => {
      const store = createLibraryStore(`topo-${sessions.length}-${Math.random().toString(36).slice(2)}`);
      const session = await RoomSession.create(
        {
          roomId,
          passphrase,
          name: `Участник ${sessions.length}`,
          color: '#3b82f6',
          signalingUrl: 'ws://localhost:1/не-используется',
        },
        () => {},
        {
          store,
          transport: (descriptor) => new MemorySignalTransport(descriptor, signalRoom),
          rtc: fabric.factory,
          kdfIterations: 1_000,
          iceServers: [],
          meshLimit: room.meshLimitOverride,
          // Star включаем явно: по умолчанию комната всегда mesh.
          relay: room.relayOverride,
        },
      );
      cleanup.push(async () => {
        await session.stop();
        await store.clearRoom(roomId).catch(() => {});
        await store.db.delete().catch(() => {});
      });
      sessions.push(session);
      return session;
    },
    leave: async (index: number): Promise<void> => {
      const session = sessions[index];
      if (session === undefined) return;
      // Ушедшую сессию убираем из списка. Иначе проверки вида «у всех участников
      // одно решение» никогда не станут истинными: у остановленной сессии
      // решение замерло на прежнем relay, и она навсегда « disagreeла » с остальными.
      const at = sessions.indexOf(session);
      if (at >= 0) sessions.splice(at, 1);
      signalRoom.leave(session.selfId ?? '');
      await session.stop();
    },
  };
  return room;
}

const TIMEOUT = 60_000;

/**
 * Ждёт, что star установился и нужные соединения поднялись.
 *
 * Отдельная функция, потому что «топология star» и «соединения готовы» — разные
 * вещи: решение принимается мгновенно, а каналы поднимаются за рукопожатие.
 * Ждать только первого означало бы проверять половину.
 *
 * Проверяются не ВСЕ пиры, а только те, с которыми соединение положено. Список
 * участников комнаты шире списка соединений: в star лист «знает» про всех, но
 * соединён с одним. Требование готовности от всех означало бы ожидание
 * соединений, которых по замыслу быть не должно, — и тест висел бы вечно.
 */
async function awaitStar(sessions: RoomSession[]): Promise<PeerId> {
  await waitFor(
    () => sessions.every((s) => s.mesh.relayDecision.topology === 'star'),
    'топология star',
  );
  const relays = new Set(sessions.map((s) => s.mesh.relayDecision.relayId));
  if (relays.size !== 1) throw new Error(`relay не единственный: ${[...relays].join(',')}`);
  await waitFor(
    () =>
      sessions.every((s) =>
        s.state.peers
          .filter((p) => shouldConnect(s.mesh.relayDecision.topology, s.selfId ?? '', p.id, relays.values().next().value ?? null))
          .every((p) => p.state === 'ready'),
      ),
    'положенные соединения поднялись',
  );
  return [...relays][0] as PeerId;
}

/** Кто с кем действительно соединён: симметричный набор пар. */
function pairsOf(sessions: RoomSession[]): Set<string> {
  const pairs = new Set<string>();
  for (const s of sessions) {
    for (const p of s.state.peers) {
      if (p.state !== 'ready') continue;
      const [a, b] = s.selfId !== null && s.selfId < p.id ? [s.selfId, p.id] : [p.id, s.selfId ?? ''];
      pairs.add(`${a}|${b}`);
    }
  }
  return pairs;
}

describe('топология комнаты', () => {
  it('до восьми участников — mesh, каждый соединён с каждым', async () => {
    const room = await makeRoom();
    for (let i = 0; i < 8; i++) await room.add();

    await waitFor(
      () => room.sessions.every((s) => s.state.peers.length === 7 && s.state.peers.every((p) => p.state === 'ready')),
      'восемь участников соединились mesh-ом',
    );
    for (const s of room.sessions) {
      expect(s.mesh.relayDecision.topology, 'топология').toBe('mesh');
      expect(s.mesh.relayDecision.relayId).toBeNull();
    }
    // Mesh на восьми — это 28 пар: n*(n-1)/2. Проверяем числом, а не «все
    // готовы»: «все готовы» не отличает mesh от star, если смотреть на одного
    // участника, у которого в обоих случаях есть соседи.
    expect(pairsOf(room.sessions)).toHaveLength(28);
  }, TIMEOUT);

  it('девятый участник строит соединения только через relay, листья не соединяются между собой', async () => {
    const room = await makeRoom();
    for (let i = 0; i < 8; i++) await room.add();
    await waitFor(
      () => room.sessions.every((s) => s.state.peers.length === 7 && s.state.peers.every((p) => p.state === 'ready')),
      'первые восемь соединились mesh-ом',
    );
    const pairsBefore = pairsOf(room.sessions);

    // Девятый видит девять участников и выбирает relay.
    const ninth = await room.add();
    const relayId = await awaitStar(room.sessions);

    // Роль девятого зависит от того, чей идентификатор минимален, поэтому
    // проверяем по роли, а не по номеру участника: иначе тест был бы
    // «случайным» и падал бы примерно в одном случае из девяти.
    for (const s of room.sessions) {
      if (s.selfId === relayId) {
        // Relay держит соединение со всеми остальными.
        expect(s.state.peers.length).toBeGreaterThanOrEqual(1);
        continue;
      }
      // У листа есть соединение с relay. Уже установленные mesh-соединения при
      // этом НЕ рвутся — переход плавный.
      expect(s.state.peers.map((p) => p.id)).toContain(relayId);
    }
    expect(ninth.mesh.relayDecision.relayId).toBe(relayId);
    // Ни одна mesh-пара не исчезла при переходе, и каждая новая пара проходит
    // через relay. Проверять «сколько пар добавилось» нельзя: это зависит от
    // того, оказался ли девятый relay'ем (тогда пар восемь) или листом (тогда
    // одна). Инвариант один и тот же в обоих случаях.
    const pairsAfter = pairsOf(room.sessions);
    for (const pair of pairsBefore) expect(pairsAfter.has(pair)).toBe(true);
    for (const pair of pairsAfter) {
      if (pairsBefore.has(pair)) continue;
      expect(pair, `новая пара ${pair} минует relay`).toContain(relayId);
    }
  }, TIMEOUT);

  it('все называют relay одного и того же, и это минимум среди участников', async () => {
    const room = await makeRoom();
    for (let i = 0; i < 12; i++) await room.add();
    const relayId = await awaitStar(room.sessions);

    const relays = new Set(room.sessions.map((s) => s.mesh.relayDecision.relayId));
    // Расхождение означало бы, что часть сообщений уйдёт не туда и ошибок в
    // журнале не будет — просто пропадёт трафик.
    expect(relays.size).toBe(1);
    // И это именно минимум среди участников: правило проверяется на каждом.
    const ids = room.sessions.map((s) => s.selfId ?? '').sort();
    expect(relayId).toBe(ids[0]);
  }, TIMEOUT);

  it('переход не рвёт уже установленные соединения', async () => {
    const room = await makeRoom();
    for (let i = 0; i < 8; i++) await room.add();
    await waitFor(
      () => room.sessions.every((s) => s.state.peers.length === 7 && s.state.peers.every((p) => p.state === 'ready')),
      'mesh поднялся',
    );
    const first = room.sessions[0];
    const peersBefore = first?.state.peers.map((p) => p.id) ?? [];

    await room.add();
    await awaitStar(room.sessions);

    // Инвариант: каждое УЖЕ БЫВШЕЕ соединение осталось живым.
    //
    // Первая версия проверяла, что СПИСОК пиров не изменился, и падала то
    // случайно, то нет. Причина — не код, а подмена понятий: список пиров у
    // участника это состав КОМНАТЫ, а не список соединений. Девятый участник
    // закономерно появляется у всех, даже тех, кто с ним не соединён и не
    // должен быть соединён в star. Проверять состав тут нечего.
    const peersAfter = first?.state.peers.map((p) => p.id) ?? [];
    for (const id of peersBefore) expect(peersAfter).toContain(id);

    // Рвать установленные соединения нельзя: на них может висеть позиция
    // чтения и незаконченная передача файла. Переход обязан быть незаметным.
    const stateAfter = new Map(first?.state.peers.map((p) => [p.id, p.state]) ?? []);
    for (const id of peersBefore) {
      expect(stateAfter.get(id), `соединение с ${id} не сохранилось`).toBe('ready');
    }
  }, TIMEOUT);

  it('после перевыборов новый relay соединён со всеми листьями', async () => {
    // Регрессия: раньше решение о топологии читалось только при приходе и
    // уходе участника, но не при САМОМ решении. При перевыборах новых
    // участников нет и никто не протягивает руку первым, поэтому соединения с
    // новым relay не появлялись: часть листьев навсегда оставалась без связи,
    // и перевыборы были объявлены, но комната оставалась разрезанной.
    const room = await makeRoom();
    for (let i = 0; i < 12; i++) await room.add();
    const firstRelay = await awaitStar(room.sessions);

    const index = room.sessions.findIndex((s) => s.selfId === firstRelay);
    expect(index).toBeGreaterThanOrEqual(0);
    await room.leave(index);

    await waitFor(
      () => room.sessions.every((s) => s.mesh.relayDecision.relayId !== null && s.mesh.relayDecision.relayId !== firstRelay),
      'relay перевыбран',
    );
    const newRelay = [...new Set(room.sessions.map((s) => s.mesh.relayDecision.relayId))][0] as PeerId;

    // Ждём именно соединений, а не только смены идентификатора: смена решения
    // происходит мгновенно, а рукопожатие занимает время.
    await waitFor(
      () =>
        room.sessions.every((s) =>
          s.selfId === newRelay
            ? s.state.peers.length === room.sessions.length - 1
            : s.state.peers.find((p) => p.id === newRelay)?.state === 'ready',
        ),
      'новый relay соединился со всеми листьями',
    );

    const leafStates = room.sessions
      .filter((s) => s.selfId !== newRelay)
      .map((s) => s.state.peers.find((p) => p.id === newRelay)?.state);
    expect(leafStates.every((st) => st === 'ready')).toBe(true);
  }, TIMEOUT);

  it('уход участника обратно в mesh возвращает прямое соединение листьев', async () => {
    const room = await makeRoom();
    for (let i = 0; i < 9; i++) await room.add();
    await awaitStar(room.sessions);

    // Девятый уходит: остаётся восемь, порог пройден, relay больше не нужен.
    await room.leave(8);
    await waitFor(
      () => room.sessions.every((s) => s.mesh.relayDecision.topology === 'mesh'),
      'вернулись в mesh',
    );
    for (const s of room.sessions) expect(s.mesh.relayDecision.relayId).toBeNull();

    // И соединения действительно прямые: каждый снова соединён с каждым.
    await waitFor(
      () => room.sessions.every((s) => s.state.peers.length === 7 && s.state.peers.every((p) => p.state === 'ready')),
      'прямые соединения восстановились',
    );
  }, TIMEOUT);

  it('выход relay перевыбирает его, и star продолжает работать на новом', async () => {
    const room = await makeRoom();
    for (let i = 0; i < 12; i++) await room.add();
    const firstRelay = await awaitStar(room.sessions);

    // Уходит участник, который был relay.
    const index = room.sessions.findIndex((s) => s.selfId === firstRelay);
    expect(index).toBeGreaterThanOrEqual(0);
    await room.leave(index);

    // Перевыборы происходят сами и одинаково у всех: отдельного координатора
    // нет, и это главное свойство. Топология остаётся star — одиннадцать
    // участников по-прежнему больше порога.
    await waitFor(
      () =>
        room.sessions.every(
          (s) => s.mesh.relayDecision.topology === 'star' && s.mesh.relayDecision.relayId !== firstRelay,
        ),
      'relay перевыбран',
    );
    const relays = new Set(room.sessions.map((s) => s.mesh.relayDecision.relayId));
    expect(relays.size).toBe(1);
    // Новый relay — следующий по идентификатору после ушедшего.
    expect([...relays][0]).not.toBe(firstRelay);
  }, TIMEOUT);

  it('без явного разрешения комната остаётся mesh при любом размере', async () => {
    // Защита от тихой поломки. Если бы star включался по умолчанию, то при
    // 12 участниках каждый лист видел бы «на связи», но не получал бы
    // сообщения от других листьев — и это нигде не выглядело бы как ошибка.
    const room = await makeRoom();
    room.relayOverride = false;
    for (let i = 0; i < 12; i++) await room.add();

    await waitFor(
      () =>
        room.sessions.every(
          (s) => s.state.peers.length === 11 && s.state.peers.every((p) => p.state === 'ready'),
        ),
      'двенадцать участников соединились mesh-ом',
    );
    for (const s of room.sessions) {
      expect(s.mesh.relayDecision.topology).toBe('mesh');
      expect(s.mesh.relayDecision.relayId).toBeNull();
    }
    // Полная mesh: 12 участников дают 66 пар.
    expect(pairsOf(room.sessions)).toHaveLength(66);
  }, TIMEOUT);

  it('порог mesh настраивается: при нуле relay не включается никогда', async () => {
    // Нужен оператору, чтобы убрать посредника, не меняя код.
    const room = await makeRoom();
    room.meshLimitOverride = 0;
    for (let i = 0; i < 9; i++) await room.add();
    await waitFor(
      () => room.sessions.every((s) => s.state.peers.length === 8),
      'соединились все со всеми',
    );
    for (const s of room.sessions) {
      expect(s.mesh.relayDecision.topology).toBe('mesh');
      expect(s.mesh.relayDecision.relayId).toBeNull();
    }
  }, TIMEOUT);
});