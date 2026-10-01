/**
 * Панель кодов безопасности.
 *
 * Код выводится из пары публичных ключей и одинаков у обеих сторон. Смысл:
 * если кто-то стоит между вами и другим участником (MITM), он подменит свои
 * ключи, и коды не совпадут. Парольная фраза от этого не спасает — она уже
 * у посредника. Единственная доступная пользователю проверка — сверить код
 * голосом или в мессенджере, и для этого он должен быть на экране.
 *
 * Поэтому панель не спрятана в настройки и показывается всегда, пока есть
 * соединения.
 */

export function SafetyCodes({ safety }: { safety: Record<string, string> }) {
  const entries = Object.entries(safety);
  if (entries.length === 0) return null;

  return (
    <section className="space-y-2 border-t border-ink-800 pt-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Коды безопасности</h2>
      <p className="text-[11px] text-ink-600">
        Сверьте код голосом с каждым участником. Если не совпал — вас подменяют, прекратите чтение.
      </p>
      <ul className="space-y-1">
        {entries.map(([peerId, code]) => (
          <li key={peerId} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-ink-500">{peerId.slice(0, 8)}</span>
            <code className="rounded bg-ink-950 px-2 py-0.5 font-mono text-ink-200">{code}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
