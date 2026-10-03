/**
 * Передача книги только по запросу.
 *
 * ─── Что ловится ──────────────────────────────────────────────────────────────
 *
 * Пользователь делился книгой, и она молча уезжала всем участникам комнаты:
 * кнопка называлась «Передать участникам», а значила «всем, кто на связи»,
 * минуя согласие получателя. У другого человека в каталоге висела надпись
 * «получите от участника» — без кнопки и без возможности отказаться.
 *
 * Теперь цепочка такая: получатель нажимает «Запросить книгу» → владелец видит
 * метку «Борис хочет скачать» и решает сам → файл уходит только тому, кто
 * запросил. Ниже проверяется каждый шаг, и главное: без запроса передачи быть
 * не должно вовсе.
 *
 * ─── Чего здесь нет ───────────────────────────────────────────────────────────
 *
 * Сценария «Ваня и Дима просят, файл уходит только Диме» на трёх участниках:
 * mock-сеть держит ровно две стороны соединения, и трёхживая комната в ней не
 * собирается. Круг передачи поэтому проверяется по-другому: ушедшим пиром
 * (см. тест про ушедшего) — тем же фильтром, что отсекает лишних.
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@rd/protocol';
import { MockRtcNetwork } from '../../p2p/tests/mock-webrtc.js';
import { MemorySignalRoom, MemorySignalTransport } from '../../p2p/tests/loopback-signal.js';
import { createLibraryStore } from '@rd/library';
import { RoomSession } from '../src/room-session.js';

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

function fakeAudio(size: number, name = 'Книга.mp3'): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 17) % 251;
  const blob = new Blob([bytes as unknown as ArrayBuffer], { type: 'audio/mpeg' });
  return Object.assign(blob, { name, lastModified: Date.now() }) as unknown as File;
}

interface Pair {
  anna: RoomSession;
  boris: RoomSession;
}

async function makeSessions(): Promise<Pair> {
  const roomId = newId();
  const passphrase = 'север-берег-звезда-улица';
  const network = new MockRtcNetwork({ mode: 'instant' });
  const signalRoom = new MemorySignalRoom();

  const make = async (name: string, color: string): Promise<RoomSession> => {
    // У каждой сессии своя база: иначе они видели бы одну и ту же «память», и
    // приём выглядел бы успешным без всякой передачи.
    const store = createLibraryStore(`req-${name}-${Math.random().toString(36).slice(2)}`);
    const session = await RoomSession.create(
      { roomId, passphrase, name, color, signalingUrl: 'ws://неиспользуется.invalid' },
      () => {},
      { store, transport: (d) => new MemorySignalTransport(d, signalRoom), rtc: network.factory, kdfIterations: 1_000, iceServers: [] },
    );
    cleanup.push(async () => {
      await session.stop();
      await store.db.delete().catch(() => {});
    });
    return session;
  };

  // Второй заходит первым: так проверяется ветка «новый участник инициирует
  // предложение», а не только «оба подключились одновременно».
  const boris = await make('Борис', '#f59e0b');
  const anna = await make('Аня', '#3b82f6');

  await waitFor(
    () => anna.state.peers.some((p) => p.state === 'ready') && boris.state.peers.some((p) => p.state === 'ready'),
    'участники не соединились',
  );
  return { anna, boris };
}

/** Книга добавлена и её каталог доехал до второй стороны. */
async function shareableBook(pair: Pair, size = 200_000): Promise<string> {
  const bookId = await pair.anna.importBook(fakeAudio(size));
  await waitFor(() => pair.boris.state.books.some((b) => b.id === bookId), 'каталог не синхронизирован');
  return bookId;
}

describe('передача книги по запросу', () => {
  it('не передаёт книгу никому, пока её не попросили', async () => {
    // ─── Главная регрессия ─────────────────────────────────────────────────────
    //
    // Раньше `shareBook` слал `file-offer` всем готовым пирам. Файл уезжал
    // каждому молча: согласие получателя не требовалось и отказаться было
    // нечем.
    const pair = await makeSessions();
    const bookId = await shareableBook(pair);

    // Владелец жмёт «передать», хотя никто не просил.
    await expect(pair.anna.shareBook(bookId)).rejects.toThrow(/не просил/i);
    await new Promise((r) => setTimeout(r, 1200));

    expect(pair.boris.state.localFiles).not.toContain(bookId);
    expect(await pair.boris.readLocalBook(bookId)).toBeNull();
  }, 60_000);

  it('владелец видит, кто именно просит книгу', async () => {
    const pair = await makeSessions();
    const bookId = await shareableBook(pair);

    expect(pair.anna.state.incomingRequests[bookId]).toBeUndefined();
    pair.boris.requestBook(bookId);

    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length > 0, 'запрос не дошёл');
    const requests = pair.anna.state.incomingRequests[bookId] ?? [];
    expect(requests).toHaveLength(1);
    // Имя просившего: иначе метка «хочет скачать» была бы бессмысленной.
    expect(requests[0]?.name).toBe('Борис');
    // У запрашивающего видно, что запрос висит.
    expect(pair.boris.state.outgoingRequests[bookId]?.status).toBe('requested');
  }, 60_000);

  it('по запросу книга доезжает', async () => {
    const pair = await makeSessions();
    const bookId = await shareableBook(pair, 400_000);

    pair.boris.requestBook(bookId);
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length > 0, 'запрос не дошёл');
    await pair.anna.shareBook(bookId);

    await waitFor(
      () => pair.boris.state.localFiles.includes(bookId),
      `файл не доехал; ошибки: ${pair.boris.state.warnings.join(' | ')}`,
      40_000,
    );
    expect((await pair.boris.readLocalBook(bookId))?.blob?.size).toBe(400_000);
    // Отправленный запрос снимается, иначе «Отменить запрос» висела бы после
    // того, как файл уже у человека.
    await waitFor(() => pair.boris.state.outgoingRequests[bookId] === undefined, 'запрос не снялся после получения');
  }, 90_000);

  it('не передаёт ушедшему: отказ вместо молчания', async () => {
    // Просьба была, но просившего в комнате уже нет. Молча отправить файл в
    // пустоту нельзя, но и «успешную» передачу показывать нельзя тем более —
    // пользователь потом гадал бы, куда делся файл.
    const pair = await makeSessions();
    const bookId = await shareableBook(pair);

    pair.boris.requestBook(bookId);
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length > 0, 'запрос не дошёл');

    await pair.boris.stop();
    // Сообщение может быть любым из двух отказов («нет соединений» или
    // «запросивших нет»): важно, что это отказ, а не тишина.
    await expect(pair.anna.shareBook(bookId)).rejects.toThrow();
  }, 60_000);

  it('отказ снимает запрос у запрашивающего', async () => {
    const pair = await makeSessions();
    const bookId = await shareableBook(pair, 150_000);

    pair.boris.requestBook(bookId);
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length > 0, 'запрос не дошёл');

    pair.anna.declineBookRequest(bookId, pair.boris.selfId, 'не сейчас');
    await waitFor(
      () => pair.boris.state.outgoingRequests[bookId]?.status === 'declined',
      'отказ не дошёл до запрашивающего',
    );
    expect(pair.boris.state.outgoingRequests[bookId]?.reason).toBe('не сейчас');
    // У владельца запрос снят: нечего предлагать тому, кому уже отказали.
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length === 0, 'запрос у владельца не снят');

    // И файл не приходит: отказ — это отказ.
    await new Promise((r) => setTimeout(r, 1200));
    expect(pair.boris.state.localFiles).not.toContain(bookId);
  }, 60_000);

  it('запросчик может забрать запрос назад', async () => {
    const pair = await makeSessions();
    const bookId = await shareableBook(pair, 140_000);

    pair.boris.requestBook(bookId);
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length > 0, 'запрос не дошёл');
    pair.boris.cancelBookRequest(bookId);

    expect(pair.boris.state.outgoingRequests[bookId]).toBeUndefined();
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length === 0, 'запрос у владельца не снят');
  }, 60_000);

  it('дублирующий запрос не плодит строки', async () => {
    // Иначе в списке появилось бы несколько «Борис хочет скачать» на одного
    // человека, и кнопка «передать» предложила бы отправить ему дважды.
    const pair = await makeSessions();
    const bookId = await shareableBook(pair, 130_000);

    pair.boris.requestBook(bookId);
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length > 0, 'запрос не дошёл');
    pair.boris.requestBook(bookId);
    await new Promise((r) => setTimeout(r, 800));

    expect(pair.anna.state.incomingRequests[bookId]).toHaveLength(1);
  }, 60_000);

  it('отзыв запроса убирает метку у владельца', async () => {
    // Отдельный тест, потому что `book-decline` означает два разных вещи: отказ
    // владельца и отзыв запроса самим просившим. Путаница между ними оставляла
    // у владельца метку «хочет скачать» от того, кто уже передумал.
    const pair = await makeSessions();
    const bookId = await shareableBook(pair, 125_000);

    pair.boris.requestBook(bookId);
    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length > 0, 'запрос не дошёл');
    pair.boris.cancelBookRequest(bookId);

    await waitFor(() => (pair.anna.state.incomingRequests[bookId] ?? []).length === 0, 'метка у владельца не убрана');
    // И отправлять больше некому: книга осталась у получателя.
    await expect(pair.anna.shareBook(bookId)).rejects.toThrow(/не просил/i);
  }, 60_000);
});
