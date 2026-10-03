/**
 * Два участника в одной комнате.
 *
 * Это первый тест не случайно: всё остальное e2e строится на связке
 * «signaling соединил → E2EE сошлись → P2P-канал работает → по каналу едут
 * книги и комментарии». Если этот сценарий не проходит, остальные не имеют
 * смысла запускать, и падение надо читать сразу в нём.
 *
 * Отдельно проверяется, что участники видят друг друга поимённо: само наличие
 * «двух участников» не доказывает, что список отфильтрован правильно, а не
 * показал дубль самого себя.
 */

import { expect, test } from '@playwright/test';

import { expectPeerCount, expectConnected, joinRoom, roomId } from './fixtures/app.js';

test.describe('комната и участники', () => {
  test('второй участник подключается по идентификатору, и оба видят друг друга', async ({ browser }) => {
    const room = roomId();
    // Отдельные контексты, а не две вкладки: у них разные localStorage,
    // IndexedDB и кэш Service Worker. Две вкладки одного контекста делили бы
    // состояние, и второй участник вошёл бы в ту же «сессию», а проверка
    // ничего бы не значила.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const a = await contextA.newPage();
      await joinRoom(a, { mode: 'create', roomId: room, name: 'Аня' });
      // Создатель сразу «на связи»: до второго участника соединений нет, но
      // сессия поднята и signaling отвечает.
      await expect(a.getByTestId('peers-count')).toHaveText('Участники · 1');

      const b = await contextB.newPage();
      await joinRoom(b, { mode: 'join', roomId: room, name: 'Борис' });

      await expectPeerCount(a, 2);
      await expectPeerCount(b, 2);

      // Поимённо: список отфильтрован, а не показал дважды себя.
      await expect(a.getByTestId('peer-item')).toHaveCount(1);
      await expect(a.getByTestId('peer-item')).toHaveAttribute('data-peer-name', 'Борис');
      await expect(b.getByTestId('peer-item')).toHaveCount(1);
      await expect(b.getByTestId('peer-item')).toHaveAttribute('data-peer-name', 'Аня');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('участники соединяются по P2P, а не только через signaling', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const a = await contextA.newPage();
      await joinRoom(a, { mode: 'create', roomId: room, name: 'Аня' });

      const b = await contextB.newPage();
      await joinRoom(b, { mode: 'join', roomId: room, name: 'Борис' });

      // «на связи» значит, что сессия поднята; `data-peer-state=ready` — что с
      // соседом работающий канал, ключи сошлись и RTT измерен. Пока этого нет,
      // список участников может показывать соседа по signaling-данным, а по
      // каналу ничего не пойдёт — и все остальные тесты падали бы с
      // необъяснимым таймаутом на передаче файла.
      await expect(a.getByTestId('room-status')).toContainText('на связи', { timeout: 60_000 });
      await expect(b.getByTestId('room-status')).toContainText('на связи', { timeout: 60_000 });
      await expect(a.getByTestId('peer-item')).toHaveAttribute('data-peer-state', 'ready', { timeout: 60_000 });
      await expect(b.getByTestId('peer-item')).toHaveAttribute('data-peer-state', 'ready', { timeout: 60_000 });
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('в комнату нельзя войти с другой фразой', async ({ browser }) => {
    const room = roomId();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();

    try {
      const a = await contextA.newPage();
      await joinRoom(a, { mode: 'create', roomId: room, name: 'Аня' });
      await expect(a.getByTestId('peers-count')).toHaveText('Участники · 1');

      const b = await contextB.newPage();
      await joinRoom(b, { mode: 'join', roomId: room, name: 'Борис' });
      await expectPeerCount(a, 2);

      // Третий участник с заведомо другой фразой.
      const c = await contextB.newPage();
      await c.goto('/');
      await c.getByTestId('lobby-mode-join').click();
      await c.getByTestId('lobby-join-room').fill(room);
      await c.getByTestId('lobby-name').fill('Ваня');
      await c.getByTestId('lobby-passphrase').fill('совсем другая фраза для этой комнаты');
      await c.getByTestId('lobby-enter').click();

      // Он не должен получить доступ к содержимому комнаты. Проверяем не то,
      // что он не вошёл (ошибка зависит от того, где именно не сошлись ключи), а
      // что он НЕ видит книгу: иначе секретная фраза перестала бы что-то
      // значить.
      await expect(c.getByTestId('library-panel')).toBeVisible({ timeout: 20_000 });
      const visibleTitles = await c.getByTestId('book-item').count();
      expect(visibleTitles).toBe(0);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});