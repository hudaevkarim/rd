/**
 * ВРЕМЕННО. Проверяет, проходит ли предложение файла через валидацию ctrl.
 */
import { describe, it } from 'vitest';
import { newId } from '@rd/protocol';
import { encodeCtrl, parseCtrl, CHUNK_SIZE } from '@rd/protocol';

describe('валидация предложения', () => {
  it('обычное имя', () => {
    const offer = {
      transferId: newId(),
      bookId: newId(),
      name: 'Лекции.mp3',
      size: 5_000_000,
      mime: 'audio/mpeg',
      chunkSize: CHUNK_SIZE,
      chunkCount: Math.ceil(5_000_000 / CHUNK_SIZE),
      root: 'a'.repeat(64),
    };
    const parsed = parseCtrl(encodeCtrl({ k: 'file-offer', offer }));
    console.log('обычное:', parsed.k);
  });

  it('длинное имя из файла с диска', () => {
    const base = 'А'.repeat(200);
    for (const name of [`${base}.mp3`, `${base.slice(0, 196)}.mp3`]) {
      const offer = {
        transferId: newId(),
        bookId: newId(),
        name,
        size: 1000,
        mime: 'audio/mpeg',
        chunkSize: CHUNK_SIZE,
        chunkCount: Math.ceil(1000 / CHUNK_SIZE),
        root: 'a'.repeat(64),
      };
      try {
        const parsed = parseCtrl(encodeCtrl({ k: 'file-offer', offer }));
        console.log(`имя ${name.length} символов: OK (${parsed.k})`);
      } catch (err) {
        console.log(`имя ${name.length} символов: ОТКЛОНЕНО — ${(err as Error).message}`);
      }
    }
  });

  it('размер и количество чанков', () => {
    const offer = {
      transferId: newId(),
      bookId: newId(),
      name: 'X.mp3',
      size: 800_000_000,
      mime: 'audio/mpeg',
      chunkSize: CHUNK_SIZE,
      chunkCount: Math.ceil(800_000_000 / CHUNK_SIZE),
      root: 'a'.repeat(64),
    };
    try {
      parseCtrl(encodeCtrl({ k: 'file-offer', offer }));
      console.log('800 МБ: OK');
    } catch (err) {
      console.log('800 МБ: ОТКЛОНЕНО —', (err as Error).message);
    }
  });
});