/**
 * Книги: импорт, передача по запросу, открытие и рендер.
 *
 * Проверяется весь путь целиком: файл на диске → запись в общем каталоге (CRDT) →
 * запрос → передача чанками по P2P → разбор у получателя → текст на экране.
 *
 * ─── Почему книга НЕ появляется у соседа сама ──────────────────────────────────
 *
 * Это отдельное правило приложения, и тест закрепляет именно его: книга не
 * отправляется всем подряд, а только тем, кто нажал «Запросить книгу». Если бы
 * файл уезжал автоматически, тест прошёл бы и не заметил бы подмены — а
 * пользователь получал бы мегабайты без спроса. Поэтому здесь два шага: сначала
 * убеждаемся, что файл НЕ пришёл сам, потом просим и получаем.
 */

import { expect, test } from '@playwright/test';

import {
  expectBookAppears,
  expectTextVisible,
  importFile,
  joinRoom,
  pairUp,
  requestAndReceive,
  roomId,
} from './fixtures/app.js';
import { makeEpub, makeFb2 } from './fixtures/files.js';

test.describe('EPUB', () => {
  test('импорт, передача по запросу и рендер текста у обоих участников', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      const file = makeEpub();

      await importFile(a, file);
      await expectBookAppears(b, 'Тихая улица');

      // Файл не должен прийти сам: у соседа есть только запись каталога.
      await expect(b.getByTestId('book-item').filter({ hasText: 'Тихая улица' })).toHaveAttribute(
        'data-book-local',
        'false',
        { timeout: 5_000 },
      );

      await requestAndReceive(b, a, 'Тихая улица');

      // У обоих книга открывается автоматически (в комнате она одна), и текст
      // главы появляется на экране.
      await expectTextVisible(a, 'Ветер гулял по пустым улицам');
      await expectTextVisible(b, 'Ветер гулял по пустым улицам');

      // Заголовок главы тоже на месте — значит разбор прошёл по структуре, а не
      // «выкинул всё в один абзац».
      await expect(a.getByTestId('reader-host')).toContainText('Глава первая');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('вторая глава открывается по оглавлению', async ({ browser }) => {
    // Один участник: оглавление строится из файла книги, а не из данных
    // соседей, и проверять его сквозным сценарием значило бы платить ещё за
    // одно соединение ради ничего.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await joinRoom(page, { mode: 'create', roomId: roomId(), name: 'Аня' });
      await importFile(page, makeEpub());
      await expectTextVisible(page, 'Глава первая');

      await page.getByRole('button', { name: 'Оглавление' }).click();
      await page.getByRole('button', { name: 'Глава вторая' }).click();
      await expectTextVisible(page, 'Дом на краю был тёмным.');
    } finally {
      await context.close();
    }
  });
});

test.describe('FB2', () => {
  test('импорт в windows-1251, передача и рендер', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a, b } = await pairUp(contextA, contextB, room);
      const file = makeFb2();

      // Файл намеренно в windows-1251 и без BOM: если бы определение кодировки
      // не сработало, вместо русского текста на экране оказался бы мусор, и
      // тест упал бы здесь — а не у пользователя с реальной книгой.
      await importFile(a, file);
      await expectBookAppears(b, 'Тихая бухта');
      await requestAndReceive(b, a, 'Тихая бухта');

      await expectTextVisible(a, 'Ветер гулял по пустому берегу');
      await expectTextVisible(b, 'Ветер гулял по пустому берегу');

      // Кириллица прочиталась, а не превратилась в «Ð²ÐµÑ‚ÐµÑ» или в пустоту.
      const text = (await a.getByTestId('reader-host').innerText()).replace(/ /g, ' ');
      expect(text).not.toContain('Ð');
      expect(text).not.toContain('�');
      // Заголовок главы FB2 разбирается как заголовок, а не выбрасывается
      // вместе с тегом <title>, как это было бы по правилам EPUB.
      expect(text).toContain('Глава первая');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('вложенный раздел остаётся внутри главы', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const { a } = await pairUp(contextA, contextB, room);
      await importFile(a, makeFb2());
      // В FB2 раздел верхнего уровня — глава, а вложенный остаётся её частью.
      // Если бы мы дробили книгу на каждый раздел, в главе первой оказались бы
      // «главы» по одному абзацу, и этот текст уехал бы во вторую главу.
      await expectTextVisible(a, 'Внутри главы тоже есть текст.');
      await expect(a.getByTestId('book-item')).toHaveCount(1);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});