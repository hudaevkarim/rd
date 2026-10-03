/**
 * Выбор relay: перевыборы, ручной выбор, перегрузка, переключение топологии.
 *
 * ─── Что здесь проверяется ────────────────────────────────────────────────────
 *
 * Правило выбора обязано быть ЧИСТЫМ: одинаковый список участников на всех
 * сторонах обязан давать одинаковый ответ. Если оно перестанет быть чистым,
 * участники разойдутся в мнениях о том, кто relay, и сообщения начнут
 * теряться — без единой ошибки в журнале.
 *
 * Поэтому основная часть тестов подаёт в `decideRelay` один и тот же список и
 * проверяет, что все участники приходят к одному решению. Отдельная группа
 * проверяет, что список и правда одинаковый: список формируется одинаково у
 * всех на общих событиях (приход, уход, перегрузка).
 */

import { describe, expect, it } from 'vitest';
import {
  decideRelay,
  shouldConnect,
  RoomRelay,
  DEFAULT_MESH_LIMIT,
  type RelayMember,
} from '@rd/p2p';

/** Участник с заданными свойствами. */
function member(id: string, over: Partial<RelayMember> = {}): RelayMember {
  return { id, online: true, preferredRelay: null, overloaded: false, ...over };
}

/** Комната из `count` участников с последовательными идентификаторами. */
function room(count: number): RelayMember[] {
  return Array.from({ length: count }, (_, i) => member(String(i).padStart(2, '0')));
}

/**
 * Ответ КАЖДОГО участника на ОДИН И ТОТ ЖЕ список.
 *
 * Именно так всё и устроено в жизни: список приходит через signaling, и у
 * всех он один. Моделируем «все считают сами» — сравниваем решения, а не
 * результат одного.
 */
function decisionsOfEveryone(members: RelayMember[], meshLimit = DEFAULT_MESH_LIMIT): string[] {
  const answers = new Set<string>();
  for (const self of members) {
    // У каждого своя копия списка — ровно так в комнате.
    const local = members.map((m) => ({ ...m }));
    answers.add(JSON.stringify(decideRelay(local, meshLimit)));
  }
  return [...answers];
}

describe('выбор топологии', () => {
  it('до восьми участников работает mesh, relay не нужен', () => {
    for (const n of [1, 2, 5, 8]) {
      const decision = decideRelay(room(n));
      expect(decision.topology, `${n} участников`).toBe('mesh');
      expect(decision.relayId).toBeNull();
    }
  });

  it('на девятом участнике включается star', () => {
    const decision = decideRelay(room(9));
    expect(decision.topology).toBe('star');
    expect(decision.relayId).toBe('00');
  });

  it('выбор не зависит от того, кто именно считает', () => {
    // Ключевое свойство: все участники получают одно решение. Расхождение
    // означало бы, что часть сообщений уйдёт не туда.
    expect(decisionsOfEveryone(room(9)).length).toBe(1);
    expect(decisionsOfEveryone(room(40)).length).toBe(1);
  });

  it('не зависит от порядка участников в списке', () => {
    const forward = decideRelay(room(12));
    const backward = decideRelay([...room(12)].reverse());
    expect(backward).toEqual(forward);
  });

  it('учитывает только участников в сети', () => {
    // Выбывший не может быть relay, даже если его идентификатор минимальный.
    const list = room(10);
    list[0] = member('00', { online: false });
    const decision = decideRelay(list);
    expect(decision.relayId).not.toBe('00');
    expect(decision.relayId).toBe('01');
  });

  it('оставшиеся участники помещаются в mesh и возвращают mesh', () => {
    // Обратный переход важен не меньше прямого: комната сократилась, и relay
    // больше не нужен.
    const list = room(10);
    for (let i = 0; i < 3; i++) list[i] = member(String(i).padStart(2, '0'), { online: false });
    expect(decideRelay(list).topology).toBe('mesh');
  });
});

describe('перевыборы при уходе relay', () => {
  it('после ухода relay выбирается следующий по идентификатору', () => {
    // Свой идентификатор — '09', чтобы уход '00' моделировал уход СОСЕДА.
    // Уход самого себя — это другое событие, и `remove` его отбрасывает
    // намеренно: очищать собственный список участников нельзя.
    const relay = new RoomRelay({ selfId: '09' });
    relay.setMembers(room(14));
    expect(relay.decision.relayId).toBe('00');

    relay.remove('00');
    expect(relay.decision.relayId).toBe('01');

    relay.remove('01');
    expect(relay.decision.relayId).toBe('02');
  });

  it('выбывание до порога возвращает mesh, и relay больше не нужен', () => {
    // Обратный переход проверен отдельно, потому что здесь легко ошибиться:
    // «решения перестали меняться» и «решение перестало существовать» — разные
    // вещи, и второе должно происходить само.
    const relay = new RoomRelay({ selfId: '09' });
    relay.setMembers(room(11));
    expect(relay.decision.topology).toBe('star');
    // 11 → 9 участников: всё ещё star, но relay уже другой.
    relay.remove('00');
    expect(relay.decision.topology).toBe('star');
    expect(relay.decision.relayId).toBe('01');
    // 9 → 8: порог пройден, relay больше не нужен.
    relay.remove('01');
    relay.remove('02');
    expect(relay.decision.topology).toBe('mesh');
    expect(relay.decision.relayId).toBeNull();
  });

  it('уход самого себя не трогает состав комнаты', () => {
    // Если бы очищал, участник потерял бы список соседей ровно тогда, когда
    // список ему нужнее всего, — при выходе соседа.
    const relay = new RoomRelay({ selfId: '00' });
    relay.setMembers(room(10));
    relay.remove('00');
    expect(relay.decision.relayId).toBe('00');
  });

  it('событие о смене relay приходит всем заинтересованным', () => {
    // Подписчик должен узнать о смене ДО того, как начнёт слать трафик по
    // старой схеме, иначе сообщения уйдут туда, где их не ждут.
    const seen: Array<string | null> = [];
    const relay = new RoomRelay({ selfId: '09' });
    relay.onChange((d) => seen.push(d.relayId));
    relay.setMembers(room(10));
    expect(seen).toEqual(['00']);
    relay.remove('00');
    expect(seen).toEqual(['00', '01']);
  });

  it('не шлёт событие, если решение не изменилось', () => {
    // Иначе перерисовка интерфейса на каждом обновлении состава комнаты.
    const relay = new RoomRelay({ selfId: '00' });
    let calls = 0;
    relay.onChange(() => calls++);
    relay.setMembers(room(10));
    relay.upsert(member('05', { preferredRelay: null }));
    relay.upsert(member('06', { overloaded: false }));
    expect(calls).toBe(1);
  });
});

describe('перегрузка relay', () => {
  it('перегруженный не предлагается, и relay смещается', () => {
    const list = room(10);
    list[0] = member('00', { overloaded: true });
    const decision = decideRelay(list);
    expect(decision.relayId).toBe('01');
  });

  it('если перегружены все, выбирается хоть кто-то', () => {
    // Комната без маршрутизации хуже, чем комната с перегруженным relay.
    const list = room(10).map((m) => ({ ...m, overloaded: true }));
    const decision = decideRelay(list);
    expect(decision.topology).toBe('star');
    expect(decision.relayId).toBe('00');
  });

  it('участник может объявить перегрузку и вернуть себя в выборы', () => {
    const relay = new RoomRelay({ selfId: '01' });
    relay.setMembers(room(10));
    relay.setOverloaded(true);
    expect(relay.decision.relayId).not.toBe('01');
    relay.setOverloaded(false);
    expect(relay.decision.relayId).toBe('00');
  });
});

describe('ручной выбор relay', () => {
  it('названный relay побеждает автоматический', () => {
    // Нужен для случая «автоматически выбрали мобильное устройство».
    const list = room(10);
    list[5] = member('05', { preferredRelay: '07' });
    expect(decideRelay(list).relayId).toBe('07');
  });

  it('ручной выбор учитывается всеми одинаково', () => {
    const list = room(10);
    list[5] = member('05', { preferredRelay: '07' });
    expect(decisionsOfEveryone(list).length).toBe(1);
  });

  it('при разных ручных выборах побеждает минимальный', () => {
    // Иначе участники разойдутся: один пошёл к '07', другой к '03'.
    const list = room(10);
    list[1] = member('01', { preferredRelay: '07' });
    list[2] = member('02', { preferredRelay: '03' });
    const decision = decideRelay(list);
    expect(decision.relayId).toBe('03');
    expect(decisionsOfEveryone(list).length).toBe(1);
  });

  it('выбор участника, который уже вышел, игнорируется', () => {
    const list = room(10);
    list[1] = member('01', { preferredRelay: '07', online: false });
    list[5] = member('05', { preferredRelay: '09' });
    expect(decideRelay(list).relayId).toBe('09');
  });

  it('снятие ручного выбора возвращает автоматический', () => {
    const relay = new RoomRelay({ selfId: '00' });
    relay.setMembers(room(10));
    relay.preferRelay('07');
    expect(relay.decision.relayId).toBe('07');
    relay.preferRelay(null);
    expect(relay.decision.relayId).toBe('00');
  });
});

describe('какие соединения создавать', () => {
  it('в mesh соединяются все со всеми', () => {
    for (const a of ['00', '01']) {
      for (const b of ['00', '01', '02']) {
        if (a === b) continue;
        expect(shouldConnect('mesh', a, b, null)).toBe(true);
      }
    }
  });

  it('в star соединение есть только с relay', () => {
    expect(shouldConnect('star', '01', '00', '00')).toBe(true);
    expect(shouldConnect('star', '00', '05', '00')).toBe(true);
    // Листья между собой не соединяются: это и есть смысл star.
    expect(shouldConnect('star', '01', '02', '00')).toBe(false);
    expect(shouldConnect('star', '05', '06', '00')).toBe(false);
  });

  it('участник может узнать свой идентификатор после входа', () => {
    // Идентификатор назначается signaling'ом уже после создания сессии,
    // поэтому relay создаётся раньше, чем известно, кто мы.
    const relay = new RoomRelay({ selfId: '' });
    relay.setSelfId('04');
    relay.setMembers(room(10));
    expect(relay.selfId).toBe('04');
    expect(relay.decision.relayId).toBe('00');
  });
});

describe('переключение топологии на девятом участнике', () => {
  it('восьмой участник ещё в mesh, девятый переводит в star', () => {
    const relay = new RoomRelay({ selfId: '00' });
    const members: RelayMember[] = [];
    const seen: string[] = [];
    relay.onChange((d) => seen.push(`${d.topology}:${d.relayId ?? '-'}`));

    for (let n = 1; n <= 10; n++) {
      members.push(member(String(n - 1).padStart(2, '0')));
      relay.setMembers(members);
    }

    // Событие срабатывает только при СМЕНЕ решения, а не на каждом обновлении
    // состава. На участниках 1..8 решение «mesh без relay» не меняется, поэтому
    // событий там нет вовсе; единственный переход — на девятом участнике.
    // Если бы событие стреляло на каждом `setMembers`, интерфейс
    // перерисовывался бы при каждом входе и уходе впустую.
    expect(seen).toEqual(['star:00']);
  });

  it('переход обратно в mesh тоже даёт событие', () => {
    const relay = new RoomRelay({ selfId: '00' });
    const seen: string[] = [];
    relay.setMembers(room(10));
    relay.onChange((d) => seen.push(`${d.topology}:${d.relayId ?? '-'}`));
    relay.setMembers(room(5));
    expect(seen).toEqual(['mesh:-']);
  });

  it('после ухода участников комната возвращается в mesh', () => {
    const relay = new RoomRelay({ selfId: '00' });
    relay.setMembers(room(10));
    expect(relay.decision.topology).toBe('star');
    relay.setMembers(room(6));
    expect(relay.decision.topology).toBe('mesh');
    expect(relay.decision.relayId).toBeNull();
  });

  it('порог задаётся конфигом', () => {
    // Для маленькой комнаты в тесте или для оператора с запасом по соединениям.
    const decision = decideRelay(room(5), 4);
    expect(decision.topology).toBe('star');
  });
});