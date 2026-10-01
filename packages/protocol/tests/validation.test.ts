import { describe, expect, it } from 'vitest';
import { newId, parseClientMessage, parseCtrl, encodeCtrl, parseHello, handshakeTranscript, isHex, PROTOCOL_VERSION, IDENTITY_KEY_BYTES, AGREE_KEY_BYTES } from '@rd/protocol';

const peer = {
  id: newId(),
  name: 'Аня',
  color: '#3b82f6',
  identityKey: 'a'.repeat(IDENTITY_KEY_BYTES * 2),
  agreeKey: 'b'.repeat(AGREE_KEY_BYTES * 2),
};

describe('валидация signaling-сообщений', () => {
  it('принимает корректный join', () => {
    const msg = parseClientMessage({ t: 'join', room: newId(), peer, protocol: PROTOCOL_VERSION });
    expect(msg.t).toBe('join');
  });

  it('отвергает join с чужим протоколом', () => {
    expect(() => parseClientMessage({ t: 'join', room: newId(), peer, protocol: 999 })).toThrow(/протокол/);
  });

  it.each([
    ['не-uuid комнаты', { t: 'join', room: '../etc/passwd', peer, protocol: PROTOCOL_VERSION }],
    ['пустое имя', { t: 'join', room: newId(), peer: { ...peer, name: '' }, protocol: PROTOCOL_VERSION }],
    ['имя с управляющими символами', { t: 'join', room: newId(), peer: { ...peer, name: 'Аня\u0000B' }, protocol: PROTOCOL_VERSION }],
    ['цвет не в формате', { t: 'join', room: newId(), peer: { ...peer, color: 'red' }, protocol: PROTOCOL_VERSION }],
    ['ключ не того размера', { t: 'join', room: newId(), peer: { ...peer, identityKey: 'a'.repeat(62) }, protocol: PROTOCOL_VERSION }],
  ])('отвергает %s', (_name, payload) => {
    expect(() => parseClientMessage(payload)).toThrow();
  });

  it('отвергает пустой SDP и слишком длинный', () => {
    const to = newId();
    expect(() => parseClientMessage({ t: 'signal', to, kind: 'offer', sdp: '' })).toThrow(/sdp/);
    expect(() => parseClientMessage({ t: 'signal', to, kind: 'offer', sdp: 'v=0'.repeat(40_000) })).toThrow(/sdp/);
  });

  it('отвергает неизвестный тип и не-объект', () => {
    expect(() => parseClientMessage({ t: 'drop-tables' })).toThrow(/неизвестный тип/);
    expect(() => parseClientMessage('строка')).toThrow();
    expect(() => parseClientMessage([1, 2, 3])).toThrow();
    expect(() => parseClientMessage(null)).toThrow();
  });

  it('пропускает нормальный ICE-кандидат и режет мусор', () => {
    const to = newId();
    const ok = parseClientMessage({
      t: 'candidate',
      to,
      candidate: { candidate: 'candidate:1 1 udp 2130706431 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    expect(ok.t).toBe('candidate');

    expect(() => parseClientMessage({ t: 'candidate', to, candidate: { candidate: '' } })).toThrow();
    expect(() => parseClientMessage({ t: 'candidate', to, candidate: { candidate: 'x'.repeat(5000) } })).toThrow();
    expect(() => parseClientMessage({ t: 'candidate', to, candidate: { candidate: 'ok', sdpMLineIndex: -1 } })).toThrow();
  });
});

describe('управляющие сообщения P2P-канала', () => {
  it('круговой разбор chat', () => {
    const id = newId();
    const msg = encodeCtrl({ k: 'chat', id, text: 'смотри сюда', at: 5 });
    expect(parseCtrl(msg)).toEqual({ k: 'chat', id, text: 'смотри сюда', at: 5 });
  });

  it('отвергает предложение файла с несостыкованным chunkCount', () => {
    // chunkCount обязан сходиться с size, иначе получатель не может
    // заранее проверить целостность и принять битый файл.
    const offer = {
      transferId: newId(),
      bookId: newId(),
      name: 'book.epub',
      size: 100,
      mime: 'application/epub+zip',
      chunkSize: 16_384,
      chunkCount: 999,
      root: 'c'.repeat(64),
    };
    expect(() => parseCtrl(encodeCtrl({ k: 'file-offer', offer }))).toThrow(/offer/);
  });

  it('отвергает пустое тело сообщения и не-JSON', () => {
    expect(() => parseCtrl(new Uint8Array(0))).toThrow(/JSON/);
    expect(() => parseCtrl(new Uint8Array([0xff, 0xfe]))).toThrow(/UTF-8/);
  });

  it('ограничивает длину чата', () => {
    expect(() => parseCtrl(encodeCtrl({ k: 'chat', id: newId(), text: 'x'.repeat(5000), at: 1 }))).toThrow(/text/);
  });
});

describe('рукопожатие', () => {
  it('строит одинаковый транскрипт у обеих сторон', () => {
    const idA = 'a'.repeat(IDENTITY_KEY_BYTES * 2);
    const idB = 'b'.repeat(IDENTITY_KEY_BYTES * 2);
    const n1 = '1'.repeat(32);
    const n2 = '2'.repeat(32);

    const left = handshakeTranscript({ roomId: 'room', identityA: idA, identityB: idB, nonceA: n1, nonceB: n2 });
    const right = handshakeTranscript({ roomId: 'room', identityA: idB, identityB: idA, nonceA: n2, nonceB: n1 });
    // Порядок полей в подписи не должен зависеть от того, кто первый пришёл.
    expect(Array.from(left)).toEqual(Array.from(right));
  });

  it('меняет транскрипт при смене комнаты', () => {
    const base = {
      identityA: 'a'.repeat(IDENTITY_KEY_BYTES * 2),
      identityB: 'b'.repeat(IDENTITY_KEY_BYTES * 2),
      nonceA: '1'.repeat(32),
      nonceB: '2'.repeat(32),
    };
    const one = handshakeTranscript({ roomId: 'room-1', ...base });
    const two = handshakeTranscript({ roomId: 'room-2', ...base });
    expect(Array.from(one)).not.toEqual(Array.from(two));
  });

  it('проверяет поля hello', () => {
    const valid = {
      v: PROTOCOL_VERSION,
      stage: 2,
      e: 'a'.repeat(IDENTITY_KEY_BYTES * 2),
      x: 'b'.repeat(AGREE_KEY_BYTES * 2),
      n: 'c'.repeat(32),
      s: 'd'.repeat(128),
    };
    expect(parseHello(valid).stage).toBe(2);
    expect(() => parseHello({ ...valid, stage: 3 })).toThrow(/стадия/);
    expect(() => parseHello({ ...valid, n: 'c'.repeat(30) })).toThrow(/nonce/);
    expect(() => parseHello({ ...valid, v: 42 })).toThrow(/версия/);
    expect(() => parseHello({ ...valid, x: 'b'.repeat(64) })).toThrow(/agree-ключ/);
  });
});

describe('генерация идентификаторов', () => {
  it('выдаёт корректные UUIDv4', () => {
    for (let i = 0; i < 50; i++) {
      const id = newId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('не повторяется', () => {
    const set = new Set(Array.from({ length: 2_000 }, () => newId()));
    expect(set.size).toBe(2_000);
  });

  it('валидирует hex', () => {
    expect(isHex('ff00', 2)).toBe(true);
    expect(isHex('FF00', 2)).toBe(false);
    expect(isHex('ff0', 2)).toBe(false);
  });
});
