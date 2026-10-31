// 扫码登录：切扫码面板 → 自检二维码有效 → 放大截图存 state/qr-login.png → 轮询跳转判成功
// 用法: node src/core/login.mjs
// 输出: { qrPath, loginUrl, loggedIn } 或 { loggedIn:true, alreadyLoggedIn:true }
import { writeFile } from 'node:fs/promises';
import { attach, emit, fail, log, sleep, statePath, clickEl, LOGIN_URL } from './common.mjs';

// 扫码入口是 img.login-icon[alt="扫码登录"]；同页还有一个 alt="web登录" 的 0×0 图标，别点错
const SCAN_ICON = 'document.querySelector(\'img.login-icon[alt="扫码登录"]\') || document.querySelector("#login-mode-web .login-icon")';
const QR_PATH = statePath('qr-login.png');
const POLL_MS = 2000;
const POLL_TOTAL_MS = 180000;

// 二维码自检：① .qrcode-status 不是盖着的「刷新二维码」遮罩 ② src 是完整 data URL ③ 真的可见
const CHECK = `(() => {
  const img = document.querySelector('#qrcode img');
  const st = document.querySelector('.qrcode-status');
  const r = img ? img.getBoundingClientRect() : null;
  return {
    statusDisplay: st ? getComputedStyle(st).display : null,
    srcLen: img ? String(img.src || '').length : 0,
    visible: !!(img && img.offsetParent !== null && r && r.width > 0 && r.height > 0),
  };
})()`;

// 截图区域（CSS 像素，含滚动偏移；captureScreenshot 的 clip 是页面坐标不是视口坐标）
const RECT = `(() => {
  const el = document.querySelector('#qrcode img') || document.querySelector('#qrcode');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
})()`;

const isHttp = (u) => /^https?:\/\//i.test(u || '');
const isSso = (u) => /^https?:\/\/sso\.unipus\.cn/i.test(u || '');

function qrOk(c) {
  // statusDisplay 为 null = 没有遮罩元素，同样算通过（没有元素就盖不住二维码）
  return !!c && (c.statusDisplay === null || c.statusDisplay === 'none') && c.srcLen > 500 && c.visible;
}

async function href(cdp) {
  try { return String((await cdp.eval('location.href')) || ''); } catch { return ''; } // 跳转瞬间上下文可能已销毁
}

async function check(cdp) {
  try { return await cdp.eval(CHECK); } catch { return null; } // 页面正在跳转时求值会失败，当作「没就绪」
}

async function main() {
  const cdp = await attach({ launchIfNeeded: true });

  // 走 about:blank 中转，保证是全新文档（否则可能停在上一轮的失效二维码态）
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(700);
  log('nav', { url: LOGIN_URL });
  await cdp.goto(LOGIN_URL, { waitMs: 6000 });

  const start = await href(cdp);
  if (isHttp(start) && !isSso(start)) {
    log('login.already', { href: start });
    return emit({ loginUrl: LOGIN_URL, loggedIn: true, alreadyLoggedIn: true });
  }

  let chk = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      // 原地反复点刷新拿不到新码，整页重开再切扫码最稳
      log('qr.retry', { attempt });
      await cdp.send('Page.navigate', { url: LOGIN_URL });
      await sleep(6000);
      if (!isSso(await href(cdp))) break;
    }
    const box = await clickEl(cdp, SCAN_ICON, { waitAfter: 2000 });
    log('qr.tab', { attempt, box });
    chk = await check(cdp);
    log('qr.check', { attempt, ...chk });
    if (qrOk(chk)) break;
  }
  if (!qrOk(chk)) {
    // 重试期间用户可能已经扫上了：先看当前域名，别把登录成功误报成失败
    const now = await href(cdp);
    if (isHttp(now) && !isSso(now)) {
      log('login.ok', { href: now, note: '二维码自检未过，但页面已离开 SSO' });
      return emit({ loginUrl: LOGIN_URL, loggedIn: true });
    }
    return fail('二维码没就绪（扫码面板没切出来，或仍是「刷新二维码」失效态）：重跑一次 `unipus login`', { check: chk });
  }

  await cdp.bringToFront(); // 后台/被遮挡的标签页截图会挂
  const rect = await cdp.eval(RECT);
  if (!rect || !rect.w || !rect.h) return fail('找不到可见的二维码元素（#qrcode img）', { rect });
  await sleep(300);

  const pad = 8;
  const clip = {
    x: Math.max(0, Math.round(rect.x - pad)),
    y: Math.max(0, Math.round(rect.y - pad)),
    width: Math.round(rect.w + pad * 2),
    height: Math.round(rect.h + pad * 2),
    scale: 4, // 原图只有 ~134px，放大 4 倍才扫得出
  };
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, { timeoutMs: 20000 });
  const buf = Buffer.from(data, 'base64');
  await writeFile(QR_PATH, buf);
  log('qr.saved', { path: QR_PATH, bytes: buf.length, clip, srcLen: chk.srcLen });

  // 只要二维码不要等扫码：调用方自己决定什么时候验证登录态（CI / 分两步跑时用）
  if (process.env.UP_LOGIN_NO_WAIT === '1') {
    log('qr.noWait', {});
    return emit({ qrPath: QR_PATH, loginUrl: LOGIN_URL, loggedIn: false, waiting: false });
  }

  const deadline = Date.now() + POLL_TOTAL_MS;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const u = await href(cdp);
    if (u && u !== last) { log('qr.href', { href: u }); last = u; }
    if (isHttp(u) && !isSso(u)) {
      log('login.ok', { href: u });
      return emit({ qrPath: QR_PATH, loginUrl: LOGIN_URL, loggedIn: true });
    }
  }

  return fail('二维码过期或未扫码：重跑一次会重新截图', { qrPath: QR_PATH });
}

main().catch((e) => fail(e));
