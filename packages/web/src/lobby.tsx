/**
 * Вход в комнату: создать новую или присоединиться по идентификатору.
 *
 * Парольная фраза вводится здесь и нигде не сохраняется: ни в URL, ни в
 * localStorage. Ссылка-приглашение несёт только идентификатор комнаты.
 */

import { useMemo, useState } from 'react';
import { newId, type RoomId } from '@rd/protocol';
import { MIN_PASSPHRASE_LEN, passphraseStrength, suggestPassphrase } from '@rd/crypto';
import { RoomSession, type SessionState } from './room-session.js';

const COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#d9534f', '#a855f7', '#14b8a6', '#ec4899'];

const DEFAULT_SIGNALING =
  (import.meta.env['VITE_SIGNALING_URL'] as string | undefined) ?? 'ws://localhost:8787/ws';

export interface LobbyProps {
  initialRoomId: RoomId | null;
  onEnter: (session: RoomSession) => void;
}

type Mode = 'create' | 'join';

export function Lobby({ initialRoomId, onEnter }: LobbyProps) {
  const [mode, setMode] = useState<Mode>(initialRoomId === null ? 'create' : 'join');
  const [roomId, setRoomId] = useState<string>(initialRoomId ?? newId());
  const [passphrase, setPassphrase] = useState<string>('');
  const [name, setName] = useState<string>(() => localStorage.getItem('rd:name') ?? '');
  const [color, setColor] = useState<string>(() => localStorage.getItem('rd:color') ?? COLORS[0] ?? '#3b82f6');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SessionState | null>(null);

  const strength = useMemo(() => passphraseStrength(passphrase), [passphrase]);
  const canEnter =
    name.trim().length > 0 &&
    passphrase.length >= MIN_PASSPHRASE_LEN &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(roomId) &&
    !busy;

  const enter = async (): Promise<void> => {
    if (!canEnter) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('rd:name', name.trim());
      localStorage.setItem('rd:color', color);
      const session = await RoomSession.create(
        { roomId, passphrase, name: name.trim(), color, signalingUrl: DEFAULT_SIGNALING },
        (state) => setProgress(state),
      );
      onEnter(session);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const inviteUrl = `${location.origin}${location.pathname}#room=${roomId}`;

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="font-serif text-4xl text-ink-50">rd</h1>
        <p className="text-ink-400">
          Чтение и аудиокниги в приватной комнате. Данные не покидают ваши устройства: сервер только помогает
          соединиться.
        </p>
      </header>

      <div className="flex gap-1 rounded-lg bg-ink-900 p-1">
        {(['create', 'join'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`flex-1 rounded-md px-3 py-2 text-sm transition ${
              mode === m ? 'bg-ink-800 text-ink-50' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {m === 'create' ? 'Создать комнату' : 'Присоединиться'}
          </button>
        ))}
      </div>

      <div className="space-y-5 rounded-xl border border-ink-800 bg-ink-900/60 p-6">
        {mode === 'create' && (
          <div className="space-y-2">
            <label htmlFor="room-id" className="block text-sm text-ink-400">
              Идентификатор комнаты
            </label>
            <div className="flex gap-2">
              <input
                id="room-id"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value.trim())}
                spellCheck={false}
                className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100"
              />
              <button
                type="button"
                onClick={() => setRoomId(newId())}
                className="rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800"
              >
                Новая
              </button>
            </div>
            <p className="break-all text-xs text-ink-600">
              Ссылка-приглашение: <span className="font-mono text-ink-400">{inviteUrl}</span>
            </p>
            <p className="text-xs text-ink-600">
              В ссылке нет парольной фразы — намеренно: ссылку пересылают в мессенджерах, и фраза в ней утекла бы
              вместе с историей.
            </p>
          </div>
        )}

        {mode === 'join' && (
          <div className="space-y-2">
            <label htmlFor="join-room" className="block text-sm text-ink-400">
              Идентификатор комнаты или ссылка
            </label>
            <input
              id="join-room"
              value={roomId}
              onChange={(e) => {
                const value = e.target.value.trim();
                const match = /#room=([0-9a-f-]{36})/.exec(value);
                setRoomId(match?.[1] ?? value);
              }}
              placeholder="a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
              spellCheck={false}
              className="w-full rounded-md border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100"
            />
          </div>
        )}

        <div className="space-y-2">
          <label htmlFor="passphrase" className="block text-sm text-ink-400">
            Парольная фраза комнаты
          </label>
          <div className="flex gap-2">
            <input
              id="passphrase"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100"
            />
            <button
              type="button"
              onClick={() => setPassphrase(suggestPassphrase())}
              className="whitespace-nowrap rounded-md border border-ink-700 px-3 py-2 text-sm text-ink-300 hover:bg-ink-800"
            >
              Сгенерировать
            </button>
          </div>
          {passphrase.length > 0 && (
            <p className="text-xs text-ink-600">
              Стойкость: <span className={strength.score < 2 ? 'text-warn-500' : 'text-ink-400'}>{strength.label}</span>
              {strength.score < 2 ? ' — лучше сгенерировать' : ''}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="name" className="block text-sm text-ink-400">
            Как вас показывать
          </label>
          <div className="flex items-center gap-3">
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              placeholder="Аня"
              className="flex-1 rounded-md border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100"
            />
            <div className="flex gap-1">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Цвет ${c}`}
                  onClick={() => setColor(c)}
                  style={{ background: c }}
                  className={`h-6 w-6 rounded-full transition ${color === c ? 'ring-2 ring-ink-100' : 'opacity-60'}`}
                />
              ))}
            </div>
          </div>
        </div>

        {error !== null && (
          <p role="alert" className="rounded-md border border-danger-500/40 bg-danger-500/10 px-3 py-2 text-sm text-danger-500">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={() => void enter()}
          disabled={!canEnter}
          className="w-full rounded-md bg-accent-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-accent-400 disabled:cursor-not-allowed disabled:bg-ink-800 disabled:text-ink-600"
        >
          {busy
            ? progress?.status === 'deriving'
              ? 'Выводим ключ комнаты…'
              : 'Подключаемся…'
            : mode === 'create'
              ? 'Создать и войти'
              : 'Войти'}
        </button>
        <p className="text-center text-xs text-ink-600">
          Нужен браузер с WebRTC и HTTPS (или localhost). Chrome 137+, Firefox 130+, Safari 17+.
        </p>
      </div>
    </main>
  );
}
