/**
 * Минимальные структурные типы для WebRTC.
 *
 * Зачем своя абстракция вместо `lib.dom.d.ts`: весь P2P-слой (mesh, Yjs-провайдер,
 * передача файлов) должен тестироваться в Node. Если завязываться напрямую на
 * `RTCPeerConnection`, тесты потребуют браузера или тяжёлого мока. С этими
 * интерфейсами достаточно подставить in-memory реализацию (см. tests/mock-webrtc.ts)
 * и проверить весь протокол целиком без сети.
 *
 * Намеренно НЕ наследуемся от DOM-типов: иначе мок обязан реализовать
 * `addTransceiver` и ещё пол-экземпляра.
 */

import type { IceCandidatePayload } from '@rd/protocol';

export type ChannelReadyState = 'connecting' | 'open' | 'closing' | 'closed';

export interface RtcDataChannel {
  readonly label: string;
  readonly readyState: ChannelReadyState;
  binaryType: 'arraybuffer' | 'blob';
  /** Сколько байт ещё в очереди отправки. */
  readonly bufferedAmount: number;
  /** Порог, ниже которого срабатывает событие `bufferedamountlow`. */
  bufferedAmountLowThreshold: number;
  /** Максимальный размер одного сообщения, известный браузеру. */
  readonly maxMessageSize?: number;
  send(data: ArrayBufferView | ArrayBuffer | string): void;
  close(): void;
  addEventListener(type: 'open', cb: () => void): void;
  addEventListener(type: 'close', cb: () => void): void;
  addEventListener(type: 'error', cb: (ev: unknown) => void): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'bufferedamountlow', cb: () => void): void;
  removeEventListener(type: string, cb: (ev: never) => void): void;
}

export type SessionDescriptionType = 'offer' | 'answer' | 'pranswer' | 'rollback';

export interface SessionDescription {
  type: SessionDescriptionType;
  sdp?: string;
}

export type ConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
export type IceState = 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';
export type SignalingState = 'stable' | 'have-local-offer' | 'have-remote-offer' | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed';

export interface RtcPeerConnection {
  localDescription: SessionDescription | null;
  remoteDescription: SessionDescription | null;
  readonly signalingState: SignalingState;
  readonly connectionState: ConnectionState;
  readonly iceConnectionState: IceState;
  createDataChannel(label: string, options?: { ordered?: boolean; protocol?: string }): RtcDataChannel;
  createOffer(): Promise<SessionDescription>;
  createAnswer(): Promise<SessionDescription>;
  setLocalDescription(desc: SessionDescription): Promise<void>;
  setRemoteDescription(desc: SessionDescription): Promise<void>;
  addIceCandidate(candidate: IceCandidatePayload): Promise<void>;
  close(): void;
  addEventListener(type: 'icecandidate', cb: (ev: { candidate: IceCandidatePayload | null }) => void): void;
  addEventListener(type: 'datachannel', cb: (ev: { channel: RtcDataChannel }) => void): void;
  addEventListener(type: 'connectionstatechange', cb: () => void): void;
  addEventListener(type: 'negotiationneeded', cb: () => void): void;
  removeEventListener(type: string, cb: (ev: never) => void): void;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RtcConfig {
  iceServers?: IceServerConfig[];
  /** Пул ICE-кандидатов не задаём намеренно: он ускоряет старт, но тратит
   *  трафик и раскрывает больше сетевой информации, чем нужно для приватного
   *  приложения. */
}

/** Фабрика соединений. В браузере — глобальный RTCPeerConnection. */
export type RtcFactory = (config: RtcConfig) => RtcPeerConnection;

export class WebRtcUnavailableError extends Error {
  constructor() {
    super('RTCPeerConnection недоступен: приложение требует HTTPS или localhost');
    this.name = 'WebRtcUnavailableError';
  }
}

export const defaultRtcFactory: RtcFactory = (config) => {
  const Ctor = (globalThis as { RTCPeerConnection?: new (c?: RtcConfig) => RtcPeerConnection }).RTCPeerConnection;
  if (!Ctor) throw new WebRtcUnavailableError();
  return new Ctor(config);
};
