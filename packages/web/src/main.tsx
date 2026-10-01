import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { RoomId } from '@rd/protocol';
import './index.css';
import { Lobby } from './lobby.js';
import { Room } from './room.js';
import type { RoomSession } from './room-session.js';

/**
 * Разбор адреса: `#room=<uuid>`.
 *
 * Hash, а не query: хеш не уходит на сервер вообще. Даже если бы мы положили
 * туда что-то секретное, оно не попало бы в access-логи и в заголовок Referer.
 */
function roomFromLocation(): RoomId | null {
  const match = /#room=([0-9a-f-]{36})/i.exec(location.hash);
  const id = match?.[1];
  return id !== undefined && id !== null ? id.toLowerCase() : null;
}

function App() {
  const [session, setSession] = useState<RoomSession | null>(null);
  const [initialRoom, setInitialRoom] = useState<RoomId | null>(() => roomFromLocation());

  useEffect(() => {
    const onHashChange = (): void => setInitialRoom(roomFromLocation());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Сессия держит WebRTC-соединения и таймеры: при размонтировании её нужно
  // закрыть, иначе чашка продолжает держать соединение в фоне.
  useEffect(() => {
    if (session === null) return;
    return () => {
      void session.stop();
    };
  }, [session]);

  const leave = useCallback(() => {
    setSession(null);
    history.replaceState(null, '', location.pathname);
  }, []);

  if (session === null) {
    return <Lobby initialRoomId={initialRoom} onEnter={setSession} />;
  }
  return <Room session={session} onLeave={leave} />;
}

const host = document.getElementById('root');
if (host === null) throw new Error('не найден #root');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
