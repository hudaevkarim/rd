/**
 * YRoomProvider — синхронизация Yjs-документа комнаты поверх mesh'а.
 *
 * Почему не y-webrtc: тот ходит через публичные signaling-трекеры и не
 * шифрует полезную нагрузку, то есть несовместим с требованием E2EE. Свой
 * провайдер — это ~200 строк поверх уже готовых `y-protocols/sync` и
 * `y-protocols/awareness`, которые мы переиспользуем как есть.
 *
 * Протокол синхронизации стандартный, поэтому документы остаются совместимыми
 * с любым другим Yjs-клиентом: state vector → diff → update. Никакой
 * «нашей» семантики в самих данных нет.
 *
 * Ключевой момент — различение источников обновлений. Обновление, пришедшее
 * из сети, применяется с origin'ом REMOTE_ORIGIN, и обработчик `doc.on('update')`
 * такие обновления НЕ пересылает дальше. Без этого разойдётся лавина: A шлёт B,
 * B применяет и шлёт C и A обратно, и так до бесконечности. Yjs идемпотентен
 * по содержимому, но лишний сетевой трафик в комнате с аудиокнигами недопустим.
 *
 * Синхронизация инициируется на стороне НОВОГО соединения: как только канал
 * стал `ready`, отправляем своему state vector, а в ответ получаем разницу.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { createEncoder, toUint8Array, length as encoderLength } from 'lib0/encoding';
import { createDecoder } from 'lib0/decoding';
import { Emitter } from './emitter.js';
import type { RoomMesh, RoomPeerInfo } from './room-mesh.js';
import type { CtrlMessage } from '@rd/protocol';

export type { Awareness } from 'y-protocols/awareness';
export const { Awareness: AwarenessCtor, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } =
  awarenessProtocol;

/** Origin для обновлений, пришедших по сети. Символ, а не строка: строки легко случайно сравнить. */
const REMOTE_ORIGIN = Symbol('rd-remote');

export interface YProviderEvents extends Record<string, unknown> {
  /** Соединение с пиром синхронизировано (или хотя бы обменялись state vector). */
  synced: { peerId: string };
  /** Локальный presence изменился. */
  awareness: { clientId: number };
}

export interface YRoomProviderOptions {
  mesh: RoomMesh;
  doc?: Y.Doc;
  awareness?: awarenessProtocol.Awareness;
  /** Период пинга провайдера; awareness сам рассылает изменения сам. */
  staleTimeoutMs?: number;
}

export class YRoomProvider {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly events = new Emitter<YProviderEvents>();
  /** Принадлежит ли документ провайдеру (false — документ переживёт destroy). */
  readonly #ownsDoc: boolean;

  readonly #mesh: RoomMesh;
  readonly #synced = new Set<string>();
  #unsubscribe: Array<() => void> = [];
  #onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  #onAwarenessUpdate: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  #destroyed = false;

  constructor(opts: YRoomProviderOptions) {
    this.#mesh = opts.mesh;
    this.doc = opts.doc ?? new Y.Doc();
    this.#ownsDoc = opts.doc === undefined;
    this.awareness = opts.awareness ?? new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalStateField('peerId', this.#mesh.isOpen ? this.#mesh.self : null);

    // ВНИМАНИЕ: ObservableV2.on() возвращает САМ обработчик, а не функцию
    // отписки (в отличие от привычного addEventListener). Поэтому обработчики
    // сохраняем в поля и снимаем через .off() в destroy().
    this.#onDocUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE_ORIGIN) return;
      // Сырой апдейт Yjs передать нельзя: получатель ждёт сообщение протокола
      // y-protocols/sync, где первым идёт varUint с типом. Без обёртки
      // writeUpdate разбор сбивается («Unexpected end of array»).
      const encoder = createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.#mesh.broadcastYjsSync(toUint8Array(encoder));
    };
    this.doc.on('update', this.#onDocUpdate);

    this.#onAwarenessUpdate = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === REMOTE_ORIGIN) return;
      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;
      // При выходе пира удалённое состояние тоже нужно разослать, иначе у
      // остальных навсегда останется его «призрак» в списке участников.
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      this.#mesh.broadcastYjsAwareness(update);
      this.events.emit('awareness', { clientId: this.doc.clientID });
    };
    this.awareness.on('update', this.#onAwarenessUpdate);

    this.#unsubscribe.push(
      this.#mesh.events.on('ctrl', ({ peerId, payload }) => {
        if (payload.kind === 'yjs-sync') this.#onSync(peerId, payload.data);
        else if (payload.kind === 'yjs-awareness') this.#onAwareness(peerId, payload.data);
        else this.#onCtrl(peerId, payload.msg);
      }),
      this.#mesh.events.on('peers', (peers: RoomPeerInfo[]) => this.#onPeers(peers)),
      this.#mesh.events.on('closed', () => this.#onMeshClosed()),
    );
  }

  /** Уникальный идентификатор нашего состояния в awareness. */
  get clientId(): number {
    return this.doc.clientID;
  }

  // ─── Синхронизация ──────────────────────────────────────────────────────────

  #onPeers(peers: RoomPeerInfo[]): void {
    const alive = new Set(peers.map((p) => p.id));
    for (const id of [...this.#synced]) {
      if (!alive.has(id)) this.#synced.delete(id);
    }
    for (const peer of peers) {
      if (peer.state !== 'ready') continue;
      if (this.#synced.has(peer.id)) continue;
      this.#synced.add(peer.id);
      this.#startSyncWith(peer.id);
    }
  }

  #onMeshClosed(): void {
    // После обрыва все каналы пересоздадутся: сбрасываем отметки, чтобы при
    // следующем `ready` отправить sync заново.
    this.#synced.clear();
    // Чужие presence-состояния относятся к мёртвым соединениям. Их сохранение
    // приведёт к тому, что список участников будет показывать призраков.
    this.#removeForeignAwareness();
  }

  #startSyncWith(peerId: string): void {
    const encoder = createEncoder();
    // Шаг 1: наш state vector. Пир ответит шагом 2 — недостающей разницей.
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.#mesh.sendYjsSyncTo(peerId, toUint8Array(encoder));

    // Сразу отдаём своё presence, чтобы собеседник увидел нас, не дожидаясь
    // первого изменения в документе.
    const own = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    this.#mesh.sendYjsAwarenessTo(peerId, own);
    this.events.emit('synced', { peerId });
  }

  #onSync(peerId: string, data: Uint8Array): void {
    const decoder = createDecoder(data);
    const encoder = createEncoder();
    try {
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE_ORIGIN);
      // encoderLength > 1 означает, что протокол что-то записал в ответ.
      if (encoderLength(encoder) > 1) {
        this.#mesh.sendYjsSyncTo(peerId, toUint8Array(encoder));
      }
    } catch {
      // Битый пакет не должен рвать соединение: у Yjs-протокола нет собственного
      // кода ошибок, поэтому единственная защита — не распространять мусор дальше.
      this.#mesh.events.emit('warning', { message: `Yjs: некорректное обновление от ${peerId.slice(0, 8)}` });
    }
  }

  #onAwareness(peerId: string, data: Uint8Array): void {
    try {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, data, REMOTE_ORIGIN);
    } catch {
      this.#mesh.events.emit('warning', { message: `Yjs: некорректный presence от ${peerId.slice(0, 8)}` });
    }
  }

  #onCtrl(peerId: string, msg: CtrlMessage): void {
    switch (msg.k) {
      case 'pong':
        this.#mesh.handlePong(peerId, msg.id);
        return;
      case 'trust-ack':
        this.#mesh.events.emit('warning', { message: `пир ${peerId.slice(0, 8)} подтвердил код безопасности` });
        return;
      case 'ping':
        this.#mesh.sendCtrlTo(peerId, { k: 'pong', id: msg.id, at: msg.at });
        return;
      case 'chat':
        this.#mesh.events.emit('warning', { message: `чат: ${msg.text.slice(0, 40)}` });
        return;
      default:
        return;
    }
  }

  // ─── Presence ────────────────────────────────────────────────────────────────

  setLocalField(field: string, value: unknown): void {
    if (this.#destroyed) return;
    this.awareness.setLocalStateField(field, value);
  }

  getLocalState(): Record<string, unknown> {
    return this.awareness.getLocalState() ?? {};
  }

  /**
   * Убирает из awareness состояния пиров, с которыми нет соединения.
   *
   * Сделано по полю `user.peerId`, а не по clientID: после переподключения
   * Yjs выдаёт документу новый clientID, и сопоставление по нему было бы
   * бессмысленным.
   */
  #removeForeignAwareness(): void {
    const connected = new Set(this.#mesh.peers.map((p) => p.id));
    const stale: number[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const peerId = (state as { user?: { peerId?: string } }).user?.peerId;
      if (typeof peerId !== 'string' || !connected.has(peerId)) stale.push(clientId);
    }
    if (stale.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, stale, REMOTE_ORIGIN);
    }
  }

  /** Принудительно очистить presence конкретного пира (после `peer-left`). */
  forgetPeer(peerId: string): void {
    const stale: number[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      if ((state as { user?: { peerId?: string } }).user?.peerId === peerId) stale.push(clientId);
    }
    if (stale.length > 0) awarenessProtocol.removeAwarenessStates(this.awareness, stale, REMOTE_ORIGIN);
  }

  /** Состояние документа для сохранения в IndexedDB (офлайн-режим). */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.doc.off('update', this.#onDocUpdate);
    this.awareness.off('update', this.#onAwarenessUpdate);
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    // Сбрасываем локальное состояние, чтобы соседи сразу убрали нас из списка,
    // не дожидаясь таймаута awareness.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.awareness.destroy();
    this.events.clear();
    if (this.#ownsDoc) this.doc.destroy();
  }
}

export { REMOTE_ORIGIN, syncProtocol, Y };
