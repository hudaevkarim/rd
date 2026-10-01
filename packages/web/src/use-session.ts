/**
 * Тонкая обёртка над RoomSession для React.
 *
 * Почему не Zustand-срез: состояние живёт внутри RoomSession (там, где
 * происходят события WebRTC и Yjs), и дублировать его в сторе значило бы
 * поддерживать две копии. Здесь только принудительная перерисовка по факту
 * изменения.
 *
 * Важная деталь `useSyncExternalStore`: он сравнивает снимки по ссылке и, если
 * объект тот же, не перерисовывает компонент. Состояние сессии мутируется на
 * месте (так проще писать сам слой сессии), поэтому наружу отдаётся ссылка,
 * обновляемая только при росте `version`. Без этого UI замирал на первом же
 * кадре — об этом напомнила проверка в браузере, а не тесты.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { RoomSession, SessionState } from './room-session.js';

export function useSession(session: RoomSession | null): SessionState | null {
  const cache = useRef<{ version: number; snapshot: SessionState | null }>({ version: -1, snapshot: null });

  const subscribe = useCallback(
    (onChange: () => void): (() => void) => (session === null ? () => {} : session.onChange(onChange)),
    [session],
  );

  const getSnapshot = useCallback((): SessionState | null => {
    if (session === null) {
      cache.current = { version: -1, snapshot: null };
      return null;
    }
    if (cache.current.version !== session.version) {
      cache.current = { version: session.version, snapshot: { ...session.state } };
    }
    return cache.current.snapshot;
  }, [session]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
