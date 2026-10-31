// core 公共层：工作目录 / 任务台账 / CDP 连接 / 统一输出
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CDP, waitForBrowser, sleep } from './cdp.mjs';

export { sleep };

export const PORT = Number(process.env.UP_PORT || 9229);
export const MATCH = process.env.UP_MATCH || 'unipus\\.cn';
// U校园的扫码登录只存在于 service 指向 uai 的这个 SSO 页；ucontent / u.unipus.cn 版只有密码/验证码 tab
export const LOGIN_URL = 'https://sso.unipus.cn/sso/login?service=https%3A%2F%2Fuai.unipus.cn%2F';
export const HOME = 'https://uai.unipus.cn';

export function workdir() {
  return process.env.UP_WORKDIR || process.cwd();
}

export function stateDir() {
  const d = join(workdir(), 'state');
  mkdirSync(d, { recursive: true });
  return d;
}

export function statePath(name) {
  return join(stateDir(), name);
}

/** 读 tasks.json；不存在返回 null */
export function readTasks() {
  const p = statePath('tasks.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeTasks(obj) {
  writeFileSync(statePath('tasks.json'), JSON.stringify(obj, null, 2), 'utf8');
  return statePath('tasks.json');
}

/** 本次运行的 jsonl 日志（runner 会回收它） */
let logFile = null;
export function logPath() {
  if (logFile) return logFile;
  const d = join(workdir(), 'logs');
  mkdirSync(d, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  logFile = join(d, `run-${ts}-${process.pid}.jsonl`);
  return logFile;
}

export function log(ev, data = {}) {
  const line = JSON.stringify({ ev, ts: Date.now(), ...data });
  try { appendFileSync(logPath(), line + '\n'); } catch { /* 日志失败不影响业务 */ }
  process.stderr.write(line + '\n');
}

/** 统一结果输出：stdout 只有一行 JSON，写完立即退出（CDP 的 WebSocket 会 hold 事件循环） */
function finish(line, code) {
  process.stdout.write(line + '\n', () => process.exit(code));
  const t = setTimeout(() => process.exit(code), 2000);
  if (typeof t.unref === 'function') t.unref();
}

export function emit(data) {
  finish(JSON.stringify({ ok: true, data }), 0);
}

export function fail(error, extra = {}) {
  finish(JSON.stringify({ ok: false, error: String(error && error.message || error), ...extra }), 1);
}

/** 连接已有 CDP 实例；没有就起一个（有头，用户可见） */
export async function attach({ match = MATCH, launchIfNeeded = true, waitMs = 60000 } = {}) {
  try {
    await waitForBrowser(PORT, 1200);
  } catch {
    if (!launchIfNeeded) throw new Error(`CDP :${PORT} 未就绪；先运行 \`node src/cli.mjs login\``);
    log('launch', { port: PORT });
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const p = spawn(process.execPath, [join(here, 'launch.mjs')], { detached: true, stdio: 'ignore' });
    p.unref();
    await waitForBrowser(PORT, waitMs);
  }
  const cdp = await CDP.attach(PORT, { match: new RegExp(match) });
  await cdp.enableDomains();
  await sleep(150);
  return cdp;
}

/** 当前页面是否还在登录页 */
export function looksLikeLogin(text) {
  return /密码登录|忘记密码|立即注册|扫码登录|二维码/.test(text || '');
}

/** 点掉所有遮挡弹窗（我知道了 / 确定 / 确认） */
export const KILL_MODALS = `(() => {
  let n = 0;
  for (const b of document.querySelectorAll('button,a,span,div')) {
    const t = (b.innerText || '').replace(/\\s/g, '');
    if (t === '我知道了' || t === '确定' || t === '确认') { try { b.click(); n++; } catch (e) {} }
  }
  return n;
})()`;

/** 用坐标点一个元素（先滚到视口中间，再重算 rect） */
export async function clickEl(cdp, jsSelectorFactory, { settleMs = 320, waitAfter = 420 } = {}) {
  await cdp.eval(`(() => { const el = ${jsSelectorFactory}; if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(settleMs);
  const box = await cdp.eval(`(() => { const el = ${jsSelectorFactory}; if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), Math.round(r.width), Math.round(r.height)]; })()`);
  if (!box) return null;
  await cdp.click(box[0], box[1]);
  await sleep(waitAfter);
  return box;
}
