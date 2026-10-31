// 全量进度快照：注入 XHR hook → reload → 合并所有 /course_progress/ 响应的 leafs
// 输出 required / pass / required&!pass 三项统计与待办清单
import { attach, emit, fail, readTasks, writeTasks, log, sleep, KILL_MODALS, looksLikeLogin } from './common.mjs';

const HOOK = `(() => {
  if (window.__upInstalled) return;
  window.__upInstalled = true;
  window.__up = { reqs: [], resps: [] };
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    let body = '';
    try { body = typeof b === 'string' ? b.slice(0, 4000) : ''; } catch (e) {}
    window.__up.reqs.push({ m: this.__m, u: this.__u, body });
    const i = window.__up.resps.push({ u: this.__u, text: '' }) - 1;
    this.addEventListener('load', () => {
      try { window.__up.resps[i].text = String(this.responseText).slice(0, 60000); } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };
  const of = window.fetch;
  window.fetch = function () {
    const url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url);
    const idx = window.__up.resps.push({ u: url, text: '' }) - 1;
    window.__up.reqs.push({ m: (arguments[1] && arguments[1].method) || 'GET', u: url, body: '' });
    return of.apply(this, arguments).then((r) => {
      const c = r.clone();
      c.text().then((t) => { window.__up.resps[idx].text = String(t).slice(0, 60000); }).catch(() => {});
      return r;
    });
  };
})();`;

function pickTask(tasks, ref) {
  if (!tasks || !Array.isArray(tasks.tasks) || !tasks.tasks.length) return null;
  if (!ref) return tasks.tasks[0];
  return tasks.tasks.find((t) => String(t.idx) === String(ref) || t.leafId === ref) || null;
}

async function main() {
  const ref = process.env.UP_TASK || '';
  const tasks = readTasks();
  const t = pickTask(tasks, ref);
  const url = process.env.UP_URL || (t && t.url);
  if (!url) {
    return fail('没有可用的页面 URL：先跑 `unipus scan --course <instanceId>`，或用 UP_URL 指定一个 leaf 页地址');
  }

  const cdp = await attach({});
  log('nav', { url: url.slice(0, 120) });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(900);
  await cdp.send('Page.navigate', { url });
  await sleep(9000);
  await cdp.eval(KILL_MODALS);

  const body = await cdp.eval('document.body.innerText.slice(0,800)');
  if (looksLikeLogin(body)) {
    return fail('登录态已失效（页面回到 SSO 登录页）：先跑 `unipus login` 扫码', { stage: 'login' });
  }

  // 装 hook 并 reload，让首屏请求也被捕获
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await cdp.eval('location.reload()');
  await sleep(14000);

  const resps = await cdp.eval('(() => (window.__up && window.__up.resps) || [])()');
  try { await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch { /* 忽略 */ }

  const leafs = {};
  let progressHits = 0;
  for (const r of resps || []) {
    if (!/course_progress/.test(r.u || '')) continue;
    progressHits++;
    try {
      const j = JSON.parse(r.text);
      if (j.rt && j.rt.leafs) Object.assign(leafs, j.rt.leafs);
    } catch { /* 非 JSON 跳过 */ }
  }

  const ids = Object.keys(leafs);
  if (!ids.length) {
    return fail(`没有抓到任何 course_progress 数据（响应 ${resps.length} 条，命中 ${progressHits} 条）。页面可能没加载完，重试一次；仍失败就用 UP_URL 指到另一个 leaf 页。`, { resps: (resps || []).length });
  }

  const required = ids.filter((k) => leafs[k].strategies && leafs[k].strategies.required);
  const passed = ids.filter((k) => leafs[k].state && leafs[k].state.pass === 1);
  const pending = required.filter((k) => !(leafs[k].state && leafs[k].state.pass === 1));

  // 回写 tasks.json 的 pass 字段
  if (tasks) {
    let changed = 0;
    for (const it of tasks.tasks || []) {
      const lf = leafs[it.leafId];
      if (!lf) continue;
      const p = (lf.state && lf.state.pass) || 0;
      const req = !!(lf.strategies && lf.strategies.required);
      if (it.pass !== p || it.required !== req) { it.pass = p; it.required = req; changed++; }
    }
    if (changed) writeTasks(tasks);
    log('writeback', { changed });
  }

  log('summary', { leaves: ids.length, required: required.length, passed: passed.length, pending: pending.length });
  emit({
    leaves: ids.length,
    required: required.length,
    passed: passed.length,
    pendingCount: pending.length,
    // 真待办：required && pass!=1（必须取交集，required 与 pass 各自都是 31 条时集合并不相同）
    pending: pending.map((k) => {
      const it = tasks && (tasks.tasks || []).find((x) => x.leafId === k);
      return { leafId: k, idx: it ? it.idx : null, path: it ? it.path : null, base: it ? it.base : null };
    }),
  });
}

main().catch((e) => fail(e));
