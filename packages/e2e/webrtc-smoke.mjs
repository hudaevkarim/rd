/**
 * Проверка окружения перед e2e: работает ли WebRTC в headless Chromium.
 *
 * Не тест приложения — проверка возможности. От ответа зависит, можно ли
 * проверять P2P-сценарии настоящими контекстами браузера или придётся это
 * документировать.
 *
 * Оба соединения живут на одной странице и соединяются сами с собой: это
 * ровно тот случай, который и должен работать в CI — два участника на одной
 * машине, без внешней сети. SDP и ICE пересылаются вручную, как их пересылает
 * signaling-сервер.
 *
 * Запуск: node webrtc-smoke.mjs
 */

import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const PAGE = '<!doctype html><meta charset="utf-8"><title>smoke</title><body>ok';

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
console.log('страница:', url, '\n');

const FLAGS = [
  { name: 'без флагов', args: [] },
  { name: 'mdns выключен', args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
  {
    name: 'mdns выключен + fake-device',
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
];

for (const variant of FLAGS) {
  const browser = await chromium.launch({ args: variant.args });
  const page = await browser.newPage();
  await page.goto(url);

  const result = await page.evaluate(async () => {
    const log = [];
    const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const pc1 = new RTCPeerConnection(config);
    const pc2 = new RTCPeerConnection(config);

    pc1.onicecandidate = (e) => {
      log.push(`A-ice:${e.candidate === null ? 'end' : e.candidate.type + '/' + (e.candidate.address ?? '?')}`);
      if (e.candidate) void pc2.addIceCandidate(e.candidate).catch(() => {});
    };
    pc2.onicecandidate = (e) => {
      log.push(`B-ice:${e.candidate === null ? 'end' : e.candidate.type + '/' + (e.candidate.address ?? '?')}`);
      if (e.candidate) void pc1.addIceCandidate(e.candidate).catch(() => {});
    };

    // Никаких гонок с таймаутами: только события в журнал. Гонка разрешается
    // повторным использованием уже завершившегося промиса, и на таком тесте
    // легко объявить неработающий WebRTC там, где он работает.
    pc2.ondatachannel = (e) => {
      log.push('B-канал-открыт');
      e.channel.onmessage = (m) => log.push(`B-получил:${m.data}`);
    };
    const channel1 = pc1.createDataChannel('rd');
    channel1.onopen = () => {
      log.push('A-канал-открыт');
      channel1.send('пинг');
    };
    channel1.onerror = () => log.push('A-ошибка-канала');
    pc1.onconnectionstatechange = () => log.push(`A-состояние:${pc1.connectionState}`);
    pc2.onconnectionstatechange = () => log.push(`B-состояние:${pc2.connectionState}`);

    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    await new Promise((r) => setTimeout(r, 12000));

    return {
      log,
      state: `${pc1.iceConnectionState}/${pc1.connectionState}`,
      channelReady: channel1.readyState,
    };
  });

  console.log(`=== ${variant.name} ===`);
  console.log('  состояние:', result.state, '| канал:', result.channelReady);
  for (const line of result.log) console.log('   ', line);
  console.log();
  await browser.close();
}

server.close();