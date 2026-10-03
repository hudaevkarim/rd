/**
 * Точка входа signaling-сервера.
 *
 * Требование «должен работать на 1 vCPU / 1 ГБ RAM» отражается здесь:
 * никаких БД, никаких файловых логов по умолчанию, никаких фоновых задач
 * тяжелее двух setInterval. Всё состояние — в памяти и сбрасывается при
 * рестарте, что и является правильным поведением stateless-сервера.
 */

import { createSignalingServer } from './index.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const server = await createSignalingServer({ config });

  // Graceful shutdown: завершаем текущие WebSocket'ы и ждём, пока Fastify
  // перестанет принимать новые соединения.
  const shutdown = async (signal: string): Promise<void> => {
    server.app.log.info({ signal }, 'завершение работы');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.app.listen({ host: config.host, port: config.port, backlog: config.listenBacklog });
  server.app.log.info(
    {
      publicUrl: config.publicUrl,
      maxRoomPeers: config.maxRoomPeers,
      ratePerSec: config.ratePerSec,
      note: 'сервер хранит только реестр участников; данные комнат не проходят через него',
    },
    'signaling готов',
  );
}

main().catch((err: unknown) => {
  // Пишем в stderr напрямую: к этому моменту логгер Fastify может не инициализироваться.
  process.stderr.write(`не удалось запустить signaling: ${(err as Error).message}\n`);
  process.exit(1);
});
