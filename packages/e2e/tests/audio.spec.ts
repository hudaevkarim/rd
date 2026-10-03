/**
 * Аудиоплеер: воспроизведение, пауза, перемотка, синхронизация позиций.
 *
 * ─── Что здесь можно, а что нет ───────────────────────────────────────────────
 *
 * В headless Chromium звук не слышен, но он ДЕКОДИРУЕТСЯ: `currentTime` растёт,
 * состояние play/pause меняется, длительность известна. Поэтому проверяется всё,
 * кроме самого звука — а сам звук пользователь уже проверил вживую на своём
 * компьютере (см. раздел «Известные ограничения» в README).
 *
 * Тесты гоняют настоящий файл, а не подставной элемент: подставной элемент
 * проверил бы, что компонент обращается к правильным полям, но не проверил бы,
 * что Chromium вообще отдаёт.duration для нашего файла. Длительность 1:30 в
 * фикстуре — это как раз такая проверка.
 */

import { expect, test } from '@playwright/test';

import {
  expectBookAppears,
  importFile,
  pairUp,
  requestAndReceive,
  roomId,
  soloParticipant,
} from './fixtures/app.js';
import { AUDIO_DURATION_SEC, AUDIO_TITLE, makeAudioBook } from './fixtures/files.js';



test.describe('аудиоплеер', () => {
  test('импорт, длительность и остановка на месте', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { page } = await soloParticipant(context);
      await importFile(page, makeAudioBook());
      await expect(page.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });

      // Книга опознана как аудио: открылся плеер, а не читалка с текстом.
      await expect(page.getByTestId('reader-host')).toHaveCount(0);
      await expect(page.getByTestId('audio-duration')).toContainText('1:30');
      await expect(page.getByTestId('audio-position')).toHaveValue('0');
      // Ползунок ограничен длительностью записи.
      await expect(page.getByTestId('audio-position')).toHaveAttribute('max', String(AUDIO_DURATION_SEC));
    } finally {
      await context.close();
    }
  });

  test('воспроизведение идёт, пауза останавливает', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { page } = await soloParticipant(context);
      await importFile(page, makeAudioBook());
      const toggle = page.getByTestId('audio-toggle');
      await expect(toggle).toHaveText('Слушать');

      // Старт: кнопка должна переключиться в «Пауза».
      await toggle.click();
      await expect(toggle).toHaveText('Пауза', { timeout: 15_000 });

      // Время действительно идёт. Ждём заметное продвижение, а не любое
      // изменение: иначе тест прошёл бы на дрожании последней цифры.
      const start = Number(await page.getByTestId('audio-position').inputValue());
      await expect
        .poll(async () => Number(await page.getByTestId('audio-position').inputValue()), { timeout: 20_000 })
        .toBeGreaterThan(start + 1);

      // Пауза: время перестаёт расти. Проверяем дважды — сразу и через пару
      // секунд: мгновенная проверка прошла бы и при задержке в один кадр.
      await toggle.click();
      await expect(toggle).toHaveText('Слушать');
      const paused = Number(await page.getByTestId('audio-position').inputValue());
      await page.waitForTimeout(2_000);
      expect(Number(await page.getByTestId('audio-position').inputValue())).toBe(paused);
    } finally {
      await context.close();
    }
  });

  test('перемотка ставит ровно на выбранную секунду', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { page } = await soloParticipant(context);
      await importFile(page, makeAudioBook());
      await expect(page.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('audio-position').fill('70');
      await expect(page.getByTestId('audio-position')).toHaveValue('70');

      // Кнопка «+30 c» отсчитывается от текущей позиции, а не от нуля.
      await page.getByRole('button', { name: '+30 c' }).click();
      await expect(page.getByTestId('audio-position')).toHaveValue('90');

      await page.getByRole('button', { name: '−30 c' }).click();
      await expect(page.getByTestId('audio-position')).toHaveValue('60');
    } finally {
      await context.close();
    }
  });

  test('перемотка не откатывается назад', async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { page } = await soloParticipant(context);
      await importFile(page, makeAudioBook());
      await expect(page.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('audio-position').fill('50');
      await page.getByTestId('audio-toggle').click();
      await expect(page.getByTestId('audio-toggle')).toHaveText('Пауза');

      // Ключевая проверка: во время воспроизведения позиция не должна
      // «откатываться» на ноль. Раньше это происходило, пока незавершённая
      // перемотка удерживала позицию, а потом срывалась.
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(500);
        samples.push(Number(await page.getByTestId('audio-position').inputValue()));
      }
      for (const value of samples) expect(value).toBeGreaterThanOrEqual(50);
      // И время реально двигалось, а не стояло.
      expect(samples[samples.length - 1]).toBeGreaterThan(samples[0] ?? 0);
    } finally {
      await context.close();
    }
  });
});

test.describe('синхронизация позиции', () => {
  test('включённая синхронизация догоняет слушающего', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      await importFile(a, makeAudioBook());
      await expectBookAppears(b, AUDIO_TITLE);
      await requestAndReceive(b, a, AUDIO_TITLE);
      await expect(b.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });

      // А уходит далеко: играет и перемотан на 40-ю секунду.
      await a.getByTestId('audio-position').fill('40');
      await a.getByTestId('audio-toggle').click();
      await expect(a.getByTestId('audio-toggle')).toHaveText('Пауза');

      // Б по умолчанию стоит в нуле и никуда не движется: синхронизация
      // выключена намеренно, и навязывание чужой позиции без согласия —
      // худшее, что может сделать плеер в чужой комнате.
      await expect(b.getByTestId('audio-position')).toHaveValue('0');
      await b.waitForTimeout(2_000);
      expect(Number(await b.getByTestId('audio-position').inputValue())).toBeLessThan(5);

      // Включаем и ждём, пока Б догонит.
      await b.getByTestId('audio-follow').check();
      await expect
        .poll(async () => Number(await b.getByTestId('audio-position').inputValue()), { timeout: 30_000 })
        .toBeGreaterThan(35);

      // Требование сформулировано как «задержка не больше 5 секунд»: проверяем
      // именно расхождение, а не точное совпадение. А продолжает играть, поэтому
      // Б обязан отставать не больше чем на порог мягкой синхронизации.
      const mine = Number(await a.getByTestId('audio-position').inputValue());
      const theirs = Number(await b.getByTestId('audio-position').inputValue());
      expect(Math.abs(mine - theirs)).toBeLessThanOrEqual(5);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('выключенная синхронизация оставляет позицию в покое', async ({ browser }) => {
    // Первый тест проверяет, что синхронизация работает. Этот — что она не
    // включается сама. Без него «мягкое следование» легко превращается в
    // «навязывание чужой позиции», а заметить это можно только здесь.
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      await importFile(a, makeAudioBook());
      await expectBookAppears(b, AUDIO_TITLE);
      await requestAndReceive(b, a, AUDIO_TITLE);
      await expect(b.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });

      await a.getByTestId('audio-position').fill('40');
      await a.getByTestId('audio-toggle').click();
      await expect(a.getByTestId('audio-toggle')).toHaveText('Пауза');

      await expect(b.getByTestId('audio-follow')).not.toBeChecked();
      await b.waitForTimeout(5_000);
      expect(Number(await b.getByTestId('audio-position').inputValue())).toBeLessThanOrEqual(1);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('позиция соседа по той же записи кликабельна', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      await importFile(a, makeAudioBook());
      await expectBookAppears(b, AUDIO_TITLE);
      await requestAndReceive(b, a, AUDIO_TITLE);
      await expect(b.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });

      // Б слушает и публикует позицию.
      await b.getByTestId('audio-position').fill('55');
      await b.getByTestId('audio-toggle').click();
      await expect(b.getByTestId('audio-toggle')).toHaveText('Пауза');

      // У А появляется та же запись с секундой соседа и кнопкой перемотки.
      const same = a.getByTestId('audio-peer-same-book');
      await expect(same).toHaveCount(1, { timeout: 30_000 });
      await expect(same).toContainText('Борис');
      await expect(a.getByTestId('audio-peer-position')).toBeVisible();
      await expect(a.getByText('Эту запись сейчас никто не слушает.')).toHaveCount(0);

      // Перемотка к позиции соседа работает и у А.
      await a.getByTestId('audio-position').fill('5');
      await a.getByTestId('audio-peer-position').click();
      await expect
        .poll(async () => Number(await a.getByTestId('audio-position').inputValue()), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(55);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('секунда соседа из другой записи не попадает в нашу шкалу', async ({ browser }) => {
    // Правило: чужая секунда из другой записи в нашей шкале не значит ничего.
    // Раньше позиция соседа показывалась как есть, и цифра выглядела правдоподобно,
    // будучи бессмысленной.
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      await importFile(a, makeAudioBook(AUDIO_TITLE));
      await expectBookAppears(b, AUDIO_TITLE);
      await requestAndReceive(b, a, AUDIO_TITLE);

      // У Б своя запись — другая.
      await importFile(b, makeAudioBook('Запись Бориса'));
      await expect(b.getByTestId('audio-player')).toBeVisible({ timeout: 30_000 });

      await b.getByTestId('audio-position').fill('70');
      await b.getByTestId('audio-toggle').click();
      await expect(b.getByTestId('audio-toggle')).toHaveText('Пауза');

      // У А: своей записи никто не слушает, перемотки нет, а сосед перечислен
      // отдельно — со своей записью.
      await expect(a.getByText('Эту запись сейчас никто не слушает.')).toBeVisible({ timeout: 30_000 });
      await expect(a.getByTestId('audio-peer-position')).toHaveCount(0);
      const other = a.getByTestId('audio-peer-other-book');
      await expect(other).toHaveCount(1, { timeout: 30_000 });
      await expect(other).toContainText('Борис');
      await expect(other).toContainText('Запись Бориса');
      // И наша шкала осталась на нуле: чужая секунда не дёрнула наш плеер.
      expect(Number(await a.getByTestId('audio-position').inputValue())).toBeLessThanOrEqual(1);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});