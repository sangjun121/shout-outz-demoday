// 발표 자료(HTML)를 자동으로 넘기면서 화면을 받아 WebM 동영상으로 만든다.
// 쓰는 법: node record.mjs <발표 자료 index.html 경로> <출력 webm 경로> [test]
// 준비물: Google Chrome, playwright-core(npm i playwright-core), Playwright 의 ffmpeg(npx playwright install ffmpeg).
// 경로는 모두 절대 경로로 준다. 예: node tools/record.mjs "$PWD/index.html" "$PWD/video/shout-outz-booth.webm"
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , HTML, OUT, MODE] = process.argv;
const FFMPEG = path.join(os.homedir(), 'Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac');
const W = 1920, H = 1080, FPS = 30;
const SPEED = 1;     // 녹화한 화면을 이 배율로 빠르게 돌려 담는다. 1 이면 원래 속도다.
const REST = 1900;   // 시연 단계에서 움직임이 끝난 뒤 머무는 시간(ms). 1300 보다 작게는 못 한다.
// [넘어갈 장면 번호(1부터), 머무는 시간(ms)]. 'auto' 는 시연 단계로, 움직임이 끝난 뒤 REST 만큼만 머문다.
// 3~5번(첫 시도, 문제, 해결)은 발표용 이야기라 뺀다.
const PLAN = MODE === 'test'
  ? [[1, 3500], [2, 5000], [7, 12500]]
  : [[1, 3500], [2, 4800], [6, 5500], [7, 'auto'], [8, 'auto'], [9, 'auto'], [10, 'auto'], [11, 'auto'], [12, 'auto'], [13, 'auto'], [14, 5000]];

const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-frames-'));
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
p.on('pageerror', (e) => console.log('ERR', e.message));
const cdp = await p.context().newCDPSession(p);
const meta = [];   // [시각(초), 파일]
let last = 0;
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  if (metadata.timestamp - last < 1 / 60 - 0.004) return;   // 초당 60장까지만 남긴다(빠르게 돌려도 움직임이 끊기지 않게).
  last = metadata.timestamp;
  const f = path.join(frames, String(meta.length).padStart(6, '0') + '.jpg');
  fs.writeFileSync(f, Buffer.from(data, 'base64')); meta.push([metadata.timestamp, f]);
});
await p.goto('file://' + HTML);
await p.addStyleTag({ content: '.hud{display:none!important}' });   // 쪽 번호와 진행 막대는 영상에서 숨긴다.
await document_fonts(p);
// 표지의 등장 움직임부터 담으려고, 글꼴이 준비된 뒤 처음부터 다시 연다.
await p.evaluate(() => { document.querySelectorAll('[data-stop]').forEach((s) => s.classList.remove('on')); });
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
await p.waitForTimeout(300);
const t0 = Date.now();
let cur = 1;
await p.evaluate(() => { document.querySelector('[data-stop]').classList.add('on'); });
for (const [scene, hold] of PLAN) {
  if (scene !== cur) {
    if (scene === cur + 1) await p.keyboard.press('ArrowDown');
    else await p.evaluate((i) => scrollTo({ top: (i - 1) * innerHeight, behavior: 'instant' }), scene);   // 장면을 건너뛸 때는 바로 바꾼다.
    cur = scene;
  }
  if (hold === 'auto') {
    // 시연 화면에 1.3초 동안 아무 변화가 없으면 그 단계의 움직임이 끝난 것으로 본다(단계 안의 가장 긴 쉼이 1.1초다).
    await p.waitForTimeout(600);
    await p.evaluate(() => new Promise((res) => { let t = setTimeout(done, 1300); const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 1300); });
      function done() { o.disconnect(); res(); } o.observe(document.querySelector('#stage'), { subtree: true, attributes: true, childList: true, characterData: true }); }));
    await p.waitForTimeout(REST - 1300);
  } else await p.waitForTimeout(hold);
  console.log('scene', scene, ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
const elapsed = (Date.now() - t0) / 1000;
await cdp.send('Page.stopScreencast');
await p.waitForTimeout(200);
await b.close();
console.log('captured', meta.length, 'frames in', ((Date.now() - t0) / 1000).toFixed(1), 's');

// 받은 화면을 일정한 간격(초당 30장)으로 늘어놓아 인코더에 넘긴다. 화면이 안 바뀐 구간은 앞 장면을 되풀이한다.
const ff = spawn(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
  '-an', '-c:v', 'libvpx', '-b:v', '9M', '-crf', '8', '-qmin', '0', '-qmax', '28', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
// 마지막 장면처럼 화면이 멈춰 있는 구간은 새 화면이 오지 않으므로, 끝 시각은 계획한 길이로 잡는다.
const start = meta[0][0], end = start + 0.3 + elapsed;
let k = 0, n = 0, buf = fs.readFileSync(meta[0][1]);
for (let t = start; t <= end; t += SPEED / FPS) {
  let moved = false;
  while (k + 1 < meta.length && meta[k + 1][0] <= t) { k++; moved = true; }
  if (moved) buf = fs.readFileSync(meta[k][1]);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  n++;
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
fs.rmSync(frames, { recursive: true, force: true });
console.log('wrote', OUT, (fs.statSync(OUT).size / 1e6).toFixed(1) + 'MB,', (n / FPS).toFixed(1) + 's');

async function document_fonts(page) { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500); }
