/**
 * Тесты на SerialQueue — очередь, которая держит порядок обработки кадров.
 *
 * ─── Что здесь ловится ─────────────────────────────────────────────────────────
 *
 * DataChannel доставляет кадры упорядоченно, и протокол на это опирается. Но
 * обработка кадра асинхронна (`crypto.subtle.decrypt`), поэтому «просто
 * запустить промисы» выдаёт кадры в порядке завершения расшифровки. Для файла
 * это означало потерю чанка, а после — вечно висящую передачу.
 *
 * Тесты проверяют не «очередь существует», а её свойства: порядок выдачи,
 * устойчивость к ошибке внутри задачи и возможность дождаться опустошения.
 */

import { describe, expect, it } from 'vitest';
import { SerialQueue } from '@rd/p2p';

/** Задача, которая завершается по требованию: так порядокCompletion задаётся вручную. */
function gated(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Пауза, достаточная, чтобы задачи завершились в обратном порядке. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('SerialQueue', () => {
  it('выполняет задачи строго в порядке добавления', async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const gates = [gated(), gated(), gated()];

    // Задачи завершаются В ОБРАТНОМ порядке: так же ведёт себя расшифровка.
    gates.forEach((gate, i) => {
      queue.push(async () => {
        await gate.promise;
        order.push(`задача ${i}`);
      });
    });

    gates[2]?.resolve();
    gates[1]?.resolve();
    await settle();
    // Ничего не вышло: третья задача не может завершиться раньше второй.
    expect(order).toEqual([]);

    gates[0]?.resolve();
    await queue.drain();
    expect(order).toEqual(['задача 0', 'задача 1', 'задача 2']);
  });

  it('пропускает задачу, бросившую исключение, и выполняет следующие', async () => {
    const queue = new SerialQueue();
    const done: string[] = [];

    queue.push(() => {
      done.push('до');
    });
    queue.push(() => {
      throw new Error('битый кадр');
    });
    queue.push(() => {
      done.push('после');
    });

    await queue.drain();
    // Одна ошибка не должна навсегда остановить приём: следующие кадры в жизни
    // приходят и должны обрабатываться.
    expect(done).toEqual(['до', 'после']);
  });

  it('пропускает задачу, отклонившую промис', async () => {
    const queue = new SerialQueue();
    const done: string[] = [];

    queue.push(async () => {
      await Promise.reject(new Error('прервано'));
    });
    queue.push(() => {
      done.push('следующая');
    });

    await queue.drain();
    expect(done).toEqual(['следующая']);
  });

  it('drain() ждёт только уже добавленные задачи', async () => {
    const queue = new SerialQueue();
    let finished = 0;
    queue.push(() => {
      finished++;
    });

    await queue.drain();
    expect(finished).toBe(1);
    expect(queue.pending).toBe(0);
  });

  it('считает глубину очереди', async () => {
    const queue = new SerialQueue();
    const gate = gated();
    queue.push(() => gate.promise);
    queue.push(() => gate.promise);
    await settle();
    expect(queue.pending).toBe(2);
    gate.resolve();
    await queue.drain();
    expect(queue.pending).toBe(0);
  });

  it('не запускает вторую задачу, пока первая не закончилась', async () => {
    const queue = new SerialQueue();
    let concurrent = 0;
    let maxConcurrent = 0;

    for (let i = 0; i < 5; i++) {
      queue.push(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await settle();
        concurrent--;
      });
    }

    await queue.drain();
    expect(maxConcurrent).toBe(1);
  });
});
