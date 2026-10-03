/**
 * Комментарии: привязка к тексту, синхронизация между участниками, таймкоды.
 *
 * Комментарий — самое сложное место приложения: якорь строится из выделения в
 * DOM, уезжает в CRDT и у другого участника должен разрешиться в ту же строку.
 * Проверить это в одном браузере нельзя: обе половины разных кодовых путей
 * (координаты из DOM и поиск цитаты в чужой копии книги) живут только в паре.
 */

import { expect, test } from '@playwright/test';

import {
  expectBookAppears,
  expectTextVisible,
  importFile,
  pairUp,
  requestAndReceive,
  roomId,
  selectText,
  soloParticipant,
} from './fixtures/app.js';
import { AUDIO_TITLE, makeAudioBook, makeEpub, makeFb2 } from './fixtures/files.js';

const EPUB_TITLE = 'Тихая улица';
const FB2_TITLE = 'Тихая бухта';


test.describe('комментарий к тексту', () => {
  test('комментарий по фрагменту виден у второго участника с тем же якорем', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      await importFile(a, makeEpub());
      await expectBookAppears(b, EPUB_TITLE);
      await requestAndReceive(b, a, EPUB_TITLE);
      await expectTextVisible(b, 'Ветер гулял по пустым улицам');

      const quote = 'не хотел останавливаться';
      const body = 'Вот на этом месте я всегда спотыкаюсь';

      await selectText(a, quote);
      await a.getByTestId('comment-input').fill(body);
      await a.getByTestId('comment-submit').click();

      // У автора комментарий виден сразу.
      await expect(a.getByTestId('comment-item')).toHaveCount(1);

      // У соседа он появляется из CRDT. Проверяем и текст, и цитату в якоре:
      // цитата доказывает, что якорь доехал с привязкой к фрагменту, а не
      // просто привязался к «текущему месту».
      const item = b.getByTestId('comment-item');
      await expect(item).toHaveCount(1, { timeout: 30_000 });
      await expect(item).toContainText(body);
      await expect(item).toContainText(`«${quote}»`);
      await expect(item).toContainText('Аня');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('реакция на комментарий синхронизируется', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      await importFile(a, makeEpub());
      await expectBookAppears(b, EPUB_TITLE);
      await requestAndReceive(b, a, EPUB_TITLE);

      await a.getByTestId('comment-input').fill('Просто заметка');
      await a.getByTestId('comment-submit').click();
      await expect(b.getByTestId('comment-item')).toHaveCount(1, { timeout: 30_000 });

      // Реакция ставится на конкретный комментарий и уезжает по CRDT.
      await a.getByTestId('comment-item').getByRole('button', { name: '👍' }).click();
      await expect(a.getByTestId('comment-item')).toContainText('👍 1');
      await expect(b.getByTestId('comment-item')).toContainText('👍 1', { timeout: 30_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('комментарий не показывается в другой книге', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      await importFile(a, makeEpub());
      await expectBookAppears(b, EPUB_TITLE);
      await requestAndReceive(b, a, EPUB_TITLE);
      await expectTextVisible(a, 'Глава первая');

      await a.getByTestId('comment-input').fill('Заметка к первой книге');
      await a.getByTestId('comment-submit').click();
      await expect(a.getByTestId('comment-item')).toHaveCount(1);

      await importFile(a, makeFb2());
      await expect(a.getByTestId('book-item')).toHaveCount(2);

      // Открываем книгу без комментариев: панель должна быть пустой.
      await a.getByTestId('book-item').filter({ hasText: FB2_TITLE }).getByTestId('book-open').click();
      await expect(a.getByTestId('comments-count')).toHaveText('Комментарии · 0');
      await expect(a.getByTestId('comment-item')).toHaveCount(0);

      // Возвращаемся: комментарий на месте. Раньше фильтр брал книгу из позиции
      // чтения, и при переключении чужие комментарии показывались в чужой книге.
      await a.getByTestId('book-item').filter({ hasText: EPUB_TITLE }).getByTestId('book-open').click();
      await expect(a.getByTestId('comment-item')).toHaveCount(1);
      await expect(a.getByTestId('comment-item')).toContainText('Заметка к первой книге');

      // У соседа открыта первая книга: он ничего не переключал, и его комментарий
      // не должен исчезнуть из-за чужих действий.
      await expect(b.getByTestId('comment-item')).toHaveCount(1);
      await expect(b.getByTestId('comment-item')).toContainText('Заметка к первой книге');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});

test.describe('комментарий по таймкоду', () => {
  test('комментарий по времени перематывает плеер к своему моменту', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { page, dialogs } = await soloParticipant(context);
      await importFile(page, makeAudioBook());
      await expect(page.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });
      // Длительность фикстуры известна точно, и она обязана показаться: если
      // звук не декодировался, плеер тихо работал бы с нулевой длиной, и все
      // проверки позиции проходили бы вхолостую.
      await expect(page.getByTestId('audio-duration')).toContainText('1:30');

      // Ставим комментарий на 45-й секунде.
      await page.getByTestId('audio-position').fill('45');
      await expect(page.getByTestId('audio-position')).toHaveValue('45');

      // Приложение спрашивает текст системным диалогом.
      dialogs.reply('Тут всё понятно');
      await page.getByTestId('audio-add-comment').click();

      const item = page.getByTestId('audio-comment-item');
      await expect(item).toHaveCount(1, { timeout: 15_000 });
      await expect(item).toContainText('Тут всё понятно');
      await expect(item).toContainText('0:45');

      // Уходим далеко и возвращаемся кликом по таймкоду — ровно то, что делает
      // пользователь, чтобы переслушать момент.
      await page.getByTestId('audio-position').fill('10');
      await expect(page.getByTestId('audio-position')).toHaveValue('10');
      await item.getByTestId('audio-comment-seek').click();
      await expect(page.getByTestId('audio-position')).toHaveValue('45');
    } finally {
      await context.close();
    }
  });

  test('комментарий по времени у соседа перематывает ЕГО плеер', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b, dialogsA } = await pairUp(contextA, contextB, room);
      await importFile(a, makeAudioBook());
      await expectBookAppears(b, AUDIO_TITLE);
      // Передача аудиофайла целиком: тот же P2P-канал, что и для книг, но с
      // бинарным содержимым.
      await requestAndReceive(b, a, AUDIO_TITLE);
      await expect(b.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });
      await expect(b.getByTestId('audio-duration')).toContainText('1:30');

      await a.getByTestId('audio-position').fill('60');
      dialogsA.reply('И тут он выключил свет');
      await a.getByTestId('audio-add-comment').click();
      await expect(a.getByTestId('audio-comment-item')).toHaveCount(1, { timeout: 15_000 });

      const item = b.getByTestId('audio-comment-item');
      await expect(item).toHaveCount(1, { timeout: 30_000 });
      await expect(item).toContainText('И тут он выключил свет');

      // Клик по таймкоду у соседа перематывает ЕГО плеер. Это и есть проверка
      // того, что якорь по времени разрешился в чужой копии записи, а не просто
      // отрисовался текстом.
      await item.getByTestId('audio-comment-seek').click();
      await expect(b.getByTestId('audio-position')).toHaveValue('60');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});