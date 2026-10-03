/**
 * Помощники сквозных тестов: вход в комнату, ожидание P2P, работа с диалогами.
 *
 * Всё, что касается «как подключиться», живёт здесь, а тесты читаются как
 * сценарий. Иначе каждый тест повторяет двадцать строк ожидания, и при падении
 * непонятно, что именно сломалось: сценарий или его обвязка.
 */

import { expect, type BrowserContext, type Page } from '@playwright/test';

import type { TextFile } from './files.js';

/** Парольная фраза. Должна быть длинной: клиент проверяет минимальную длину. */
export const PASSPHRASE = 'тихая улица и ветер тест 2026';

/** Разрешение имена — uniqueID в node:crypto, но так его не видно в браузере. */
export function roomId(): string {
  return crypto.randomUUID();
}

// ─── Диалоги ──────────────────────────────────────────────────────────────────

/**
 * Подписка на `alert` и `prompt`.
 *
 * Приложение пользуется системными диалогами: `prompt` спрашивает текст
 * комментария по таймкоду, `alert` сообщает об ошибках. Без обработчика Playwright
 * закроет `prompt` пустым значением по умолчанию, и комментарий молча не
 * создастся — тест упал бы с невнятным «элемент не найден».
 *
 * Диалоги ловятся все и складываются в список: тест может потом разобраться, что
 * именно приложение хотело сказать, вместо того чтобы гадать.
 */
export interface Dialogs {
  /** Тексты всех показанных диалогов — для разбора падения. */
  messages: string[];
  /** Очередь ответов на `prompt`. */
  answers: string[];
  /** Ответить на следующий `prompt`. */
  reply(text: string): void;
}

export function catchDialogs(page: Page): Dialogs {
  const messages: string[] = [];
  const answers: string[] = [];
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'beforeunload') {
      await dialog.accept();
      return;
    }
    messages.push(dialog.message());
    const answer = answers.shift();
    if (answer === undefined) {
      // Молча гасим: неотвеченный `prompt` в Playwright блокирует страницу, и
      // тест падал бы с невнятным таймаутом там, где на самом деле надо было
      // просто прочитать текст диалога из `messages`.
      await dialog.dismiss();
      return;
    }
    await dialog.accept(answer);
  });
  return {
    messages,
    answers,
    reply: (text: string) => {
      answers.push(text);
    },
  };
}

// ─── Вход в комнату ───────────────────────────────────────────────────────────

export interface JoinOptions {
  /** `create` — создать комнату и взять её идентификатор. */
  mode?: 'create' | 'join';
  /** Уже известный идентификатор: нужен для второго участника. */
  roomId?: string;
  name: string;
}

/**
 * Вход в комнату и ожидание, что сессия поднялась.
 *
 * Парольная фраза вводится здесь и больше нигде не фигурирует: проверка
 * однонаправленная, ключи должны совпасть у обоих участников сами.
 */
export async function joinRoom(page: Page, options: JoinOptions): Promise<string> {
  const { mode = 'create', name } = options;
  await page.goto('/');

  if (mode === 'join') {
    await page.getByTestId('lobby-mode-join').click();
    const field = page.getByTestId('lobby-join-room');
    await field.fill(options.roomId ?? '');
  }

  await page.getByTestId('lobby-name').fill(name);
  await page.getByTestId('lobby-passphrase').fill(PASSPHRASE);

  if (mode === 'create') {
    const id = options.roomId ?? roomId();
    await page.getByTestId('lobby-room-id').fill(id);
    await page.getByTestId('lobby-enter').click();
    await expect(page.getByTestId('library-panel')).toBeVisible();
    return id;
  }

  await page.getByTestId('lobby-enter').click();
  await expect(page.getByTestId('library-panel')).toBeVisible();
  return options.roomId ?? '';
}

// ─── Ожидание соединения ──────────────────────────────────────────────────────

/**
 * Ждёт, пока страница увидит ожидаемое число соседей.
 *
 * Проверяется надпись «Участники · N», а не наличие элементов: она меняется
 * одним счётчиком, который считает и меняется целиком, тогда как список
 * перерисовывается по частям и может показать «2», когда список ещё не готов.
 */
export async function expectPeerCount(page: Page, total: number): Promise<void> {
  await expect(page.getByTestId('peers-count')).toHaveText(`Участники · ${total}`, { timeout: 45_000 });
}

/**
 * Ждёт, что сессия поднята, но ещё никто не подключился.
 *
 * Отдельно от `expectConnected` потому, что это разные состояния: сессия может
 * быть «на связи» с signaling и при этом не иметь ни одного соседа. Ждать
 * соседа до того, как он вошёл, — таймаут на 60 секунд вместо работы.
 */
export async function expectSessionUp(page: Page): Promise<void> {
  await expect(page.getByTestId('room-status')).toContainText('на связи', { timeout: 60_000 });
}

/**
 * Ждёт готовности P2P-соединения с соседом.
 *
 * Проверяются две разные вещи, потому что означают разное:
 *   - `room-status` = «на связи» — сессия поднята и signaling отвечает;
 *   - `peer-item[data-peer-state=ready]` — с соседом есть РАБОТАЮЩИЙ канал: ключи
 *     сошлись, ICE соединён, RTT измерен.
 *
 * Первое без второго — обычное дело сразу после входа, и на него опираться
 * нельзя: по нему тест «передача файла» проходит до того, как передавать есть
 * чем, и падает потом с необъяснимым таймаутом.
 *
 * Таймаут заметно больше стандартного: 60 секунд — это с запасом на медленный CI,
 * а не «обычно столько не занимает».
 */
export async function expectConnected(page: Page): Promise<void> {
  await expectSessionUp(page);
  await expect(page.getByTestId('peer-item').first()).toHaveAttribute('data-peer-state', 'ready', {
    timeout: 60_000,
  });
}

/** Полный сценарий подключения второго участника. */
export async function pairUp(
  contextA: BrowserContext,
  contextB: BrowserContext,
  room: string,
  nameA = 'Аня',
  nameB = 'Борис',
): Promise<{ a: Page; b: Page; dialogsA: Dialogs; dialogsB: Dialogs }> {
  const a = await contextA.newPage();
  const dialogsA = catchDialogs(a);
  await joinRoom(a, { mode: 'create', roomId: room, name: nameA });
  // A пока один: ждём только поднятия сессии. Соседа ещё нет, и ждать его здесь
  // означало бы всегда упираться в таймаут.
  await expectSessionUp(a);

  const b = await contextB.newPage();
  const dialogsB = catchDialogs(b);
  await joinRoom(b, { mode: 'join', roomId: room, name: nameB });

  await expectPeerCount(b, 2);
  await expectPeerCount(a, 2);
  // Вот теперь канал должен быть рабочим — у обоих.
  await expectConnected(a);
  await expectConnected(b);
  return { a, b, dialogsA, dialogsB };
}

/** Отдельный участник без соседа — для сценариев, где сосед не нужен. */
export async function soloParticipant(browser: BrowserContext, name = 'Аня'): Promise<{ page: Page; dialogs: Dialogs }> {
  const page = await browser.newPage();
  const dialogs = catchDialogs(page);
  await joinRoom(page, { mode: 'create', roomId: roomId(), name });
  return { page, dialogs };
}

// ─── Работа с файлами ─────────────────────────────────────────────────────────

/** Кладёт файл в поле импорта и ждёт, пока он появится в списке книг. */
export async function importFile(page: Page, file: TextFile): Promise<void> {
  const before = await page.getByTestId('book-item').count();
  await page.getByTestId('library-file-input').setInputFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: file.buffer,
  });
  await expect(page.getByTestId('book-item')).toHaveCount(before + 1, { timeout: 30_000 });
}

/** Ждёт, пока книга появится в каталоге у соседа. */
export async function expectBookAppears(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId('book-item').filter({ hasText: title })).toHaveCount(1, { timeout: 45_000 });
}

/**
 * Просит книгу и дожидается её у себя.
 *
 * Передача идёт по требованию, а не автоматически: сначала запрос, потом
 * «Передать» у владельца. Это не деталь теста, а проверка самого правила —
 * раньше книга уезжала всем подряд, и e2e это бы зафиксировал как норму.
 */
export async function requestAndReceive(page: Page, owner: Page, title: string): Promise<void> {
  const item = page.getByTestId('book-item').filter({ hasText: title });
  await expect(item.getByTestId('book-request')).toBeVisible({ timeout: 30_000 });
  await item.getByTestId('book-request').click();

  const ownerItem = owner.getByTestId('book-item').filter({ hasText: title });
  await expect(ownerItem.getByTestId('book-share')).toBeVisible({ timeout: 30_000 });
  await ownerItem.getByTestId('book-share').click();

  await expect(item).toHaveAttribute('data-book-local', 'true', { timeout: 90_000 });
}

// ─── Чтение ───────────────────────────────────────────────────────────────────

/** Ждёт, что читалка показала текст главы. */
export async function expectTextVisible(page: Page, needle: string): Promise<void> {
  await expect(page.getByTestId('reader-host')).toContainText(needle, { timeout: 30_000 });
}

/**
 * Выделяет фрагмент текста так, как это сделал бы человек.
 *
 * ─── Почему не через настоящую мышь ───────────────────────────────────────────
 *
 * Двойной клик выделяет СЛОВО, границы которого зависят от шрифта, размера и
 * разбиения строк. На другой машине или при другом масштабе выделится другое
 * слово, и тест упадёт на своём устройстве. Здесь диапазон строится прямо по
 * тексту, поэтому проверяется то, что должна проверять библиотека, — перевод
 * выделения в координаты блока, — а не то, как Chromium считает слова.
 *
 * Событие `mouseup` отправляется настоящее: именно его слушает читалка, и
 * подделать его через присваивание состояния означало бы проверить не тот путь.
 */
export async function selectText(page: Page, needle: string): Promise<void> {
  const found = await page.evaluate((text) => {
    const host = document.querySelector('[data-testid="reader-host"]');
    if (host === null) return 'нет хоста читалки';
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at >= 0) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return '';
      }
      node = walker.nextNode();
    }
    return `в главе нет текста «${text}»`;
  }, needle);

  expect(found, `выделение фрагмента: ${found}`).toBe('');

  // Читалка показывает, что именно выделено. Без этой проверки тест прошёл бы
  // и при том, что якорь привязался бы ко всей главе.
  await expect(page.getByText(`Выделено: «${needle}`)).toBeVisible({ timeout: 10_000 });
}