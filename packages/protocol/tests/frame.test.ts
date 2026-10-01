import { describe, expect, it } from 'vitest';
import {
  buildChunkHead,
  buildJsonHead,
  encodePlainFrame,
  FrameType,
  readFrame,
  SEALED_OVERHEAD,
} from '@rd/protocol';

const enc = new TextEncoder();

describe('бинарный фрейм', () => {
  it('разбирает JSON-кадр без потерь', () => {
    const header = { k: 'chat', id: 'a', text: 'привет', at: 1 };
    const body = new Uint8Array([1, 2, 3]);
    const head = buildJsonHead(FrameType.Json, header, false);
    const frame = encodePlainFrame(FrameType.Json, head, body);

    const parsed = readFrame(frame);
    expect(parsed.type).toBe(FrameType.Json);
    expect(parsed.sealed).toBe(false);
    expect(parsed.json).toEqual(header);
    expect(Array.from(parsed.payload)).toEqual([1, 2, 3]);
  });

  it('отдаёт заголовок кадра как есть — он пойдёт в AAD', () => {
    // Заголовок не шифруется, но передаётся как additionalData. Проверяем,
    // что разборщик отдаёт ровно те же байты, которые шифратор положил в AAD:
    // любое расхождение здесь означало бы, что AEAD-тег никогда не сойдётся.
    const head = buildJsonHead(FrameType.Json, { k: 'ping' }, true);
    const parsed = readFrame(encodePlainFrame(FrameType.Json, head, new Uint8Array([1, 2])));
    expect(Array.from(parsed.aad)).toEqual(Array.from(head));
    expect(Array.from(parsed.payload)).toEqual([1, 2]);
  });

  it('учитывает AEAD-оверхед в длине зашифрованного чанка', () => {
    // Длина в заголовке — это размер ОТКРЫТЫХ данных, а в кадре лежит
    // шифротекст (nonce + тег). Без поправки каждый чанк файла считался бы
    // повреждённым.
    const transferId = new Uint8Array(16);
    const data = new Uint8Array(1_000);
    const head = buildChunkHead(transferId, 0, data.length, true);
    const sealedPayload = new Uint8Array(data.length + SEALED_OVERHEAD);
    const parsed = readFrame(encodePlainFrame(FrameType.Chunk, head, sealedPayload));
    expect(parsed.chunk?.length).toBe(1_000);

    // Незашифрованный кадр такой же длины уже невалиден.
    const openHead = buildChunkHead(transferId, 0, data.length, false);
    expect(() => readFrame(encodePlainFrame(FrameType.Chunk, openHead, sealedPayload))).toThrow(/длина чанка/);
  });

  it('разбирает CHUNK-кадр с фиксированным заголовком', () => {
    const transferId = new Uint8Array(16).fill(7);
    const data = new Uint8Array([9, 8, 7]);
    const head = buildChunkHead(transferId, 65536, data.length, false);
    // headLen обязан совпадать с реальной длиной заголовка: любое расхождение
    // сдвигает начало тела и ломает разбор зашифрованных кадров.
    expect(head.length).toBe(28);
    expect(head[4] as number).toBe(0);
    expect(head[5] as number).toBe(22);

    const frame = encodePlainFrame(FrameType.Chunk, head, data);
    const parsed = readFrame(frame);
    expect(parsed.type).toBe(FrameType.Chunk);
    expect(parsed.chunk).toBeDefined();
    expect(Array.from(parsed.chunk?.transferId ?? [])).toEqual(Array.from(transferId));
    expect(parsed.chunk?.offset).toBe(65536);
    expect(parsed.chunk?.length).toBe(3);
  });

  it('отвергает CHUNK, у которого длина в заголовке не совпадает с телом', () => {
    const transferId = new Uint8Array(16);
    const head = buildChunkHead(transferId, 0, 10, true);
    const frame = encodePlainFrame(FrameType.Chunk, head, new Uint8Array([1, 2, 3]));
    expect(() => readFrame(frame)).toThrow(/длина чанка/);
  });

  it('отвергает неизвестную версию', () => {
    const head = buildJsonHead(FrameType.Json, { k: 'ping' }, false);
    const frame = encodePlainFrame(FrameType.Json, head, new Uint8Array(0));
    frame[0] = 0x99;
    expect(() => readFrame(frame)).toThrow(/версия/);
  });

  it('отвергает неизвестные флаги', () => {
    const head = buildJsonHead(FrameType.Json, { k: 'ping' }, false);
    const frame = encodePlainFrame(FrameType.Json, head, new Uint8Array(0));
    frame[3] = 0x80; // бит 7 не определён
    expect(() => readFrame(frame)).toThrow(/флаги/);
  });

  it('отвергает короткий кадр', () => {
    expect(() => readFrame(new Uint8Array([1, 4, 0, 0]))).toThrow(/короче/);
  });

  it('не пускает JSON-заголовок в Yjs-кадр', () => {
    // Иначе получатель Yjs попытался бы распарсить мусор как протокол.
    const head = buildJsonHead(FrameType.YjsSync, { nope: true }, false);
    const frame = encodePlainFrame(FrameType.YjsSync, head, new Uint8Array(0));
    expect(() => readFrame(frame)).toThrow(/не должен нести JSON/);
  });

  it('не принимает невалидный JSON в заголовке', () => {
    const head = buildJsonHead(FrameType.Json, { ok: 1 }, false);
    const broken = enc.encode('{not json');
    const frame = new Uint8Array(6 + broken.length);
    frame.set([1, FrameType.Json, 0, 0, (broken.length >> 8) & 0xff, broken.length & 0xff]);
    frame.set(broken, 6);
    expect(() => readFrame(frame)).toThrow(/JSON/);
  });

  it('выставляет флаг sealed в заголовке', () => {
    const open = buildJsonHead(FrameType.Json, { k: 'ping' }, false);
    const closed = buildJsonHead(FrameType.Json, { k: 'ping' }, true);
    // sealed лежит в младшем бите байта флагов: он попадает в AAD, поэтому
    // разборщик обязан прочитать его именно оттуда.
    expect(((open[2] as number) | (open[3] as number)) & 0x01).toBe(0);
    expect(((closed[2] as number) | (closed[3] as number)) & 0x01).toBe(1);
  });
});
