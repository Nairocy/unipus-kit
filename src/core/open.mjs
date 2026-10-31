// unipus open：导航到某个任务 → 点 tab → 内容级校验 → 抓题（选择题 / 填空 / 简答 / 排序+匹配）+ 媒体直链
// 输出不含任何答案 —— 答案由调用方（agent / LLM）产出后交 answer.mjs 注入
import { attach, emit, fail, log, sleep, readTasks, writeTasks, clickEl, KILL_MODALS, looksLikeLogin } from './common.mjs';

const NAV_WAIT = 9000; // SPA 首屏 + 题目渲染的实测等待
const TAB_GAP = 2000; // 两次 tab 点击之间的间隔

// 网络 hook：这个任务页装上后，answer.mjs 提交产生的 /api/mobile/user_module/ 响应才能被 grade.mjs 读到
// （grade 的 hint 明确假定「页面装过 hook」，所以这里在导航前注册到新文档上）
const HOOK = `(() => {
  if (window.__up) return;
  window.__up = { reqs: [], resps: [] };
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const i = window.__up.resps.push({ u: this.__u, text: '' }) - 1;
    this.addEventListener('load', () => {
      try { window.__up.resps[i].text = String(this.responseText).slice(0, 60000); } catch (e) {}
    });
    return oSend.apply(this, arguments);
  };
  const of = window.fetch;
  window.fetch = function () {
    const url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url);
    const i = window.__up.resps.push({ u: url, text: '' }) - 1;
    return of.apply(this, arguments).then((r) => {
      const c = r.clone();
      c.text().then((t) => { window.__up.resps[i].text = String(t).slice(0, 60000); }).catch(() => {});
      return r;
    });
  };
})();`;

function pickTask(tasks, ref) {
  if (!tasks || !Array.isArray(tasks.tasks)) return null;
  return tasks.tasks.find((t) => String(t.idx) === String(ref) || t.leafId === ref) || null;
}

/** 面包屑归一：去掉空白、大小写、把「练习」当 exercise，便于中英对照 */
function segKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/练习/g, 'exercise').replace(/^[.．\-_:：、]+/, '');
}

/** 页面头 300 字里能对上 path 的倒数两段吗（对不上只警告，不阻塞） */
function contentMatch(head, segs) {
  const h = segKey(head);
  const keys = segs.slice(-2).map(segKey).filter(Boolean);
  if (!keys.length) return { ok: true, hits: 0 };
  let hits = 0;
  for (const k of keys) {
    if (h.includes(k)) { hits++; continue; }
    const d = (k.match(/\d+/) || [''])[0];
    if (d && !/[a-z]/.test(k) && h.includes(d)) hits++; // 纯数字段（例如 "3"）才允许弱匹配
  }
  return { ok: hits > 0, hits };
}

/** 在页面里按 path 段找可见 tab：过滤 offsetParent、只留最内层节点、命中后打标记属性供 clickEl 用 */
function tabProbeExpr(seg) {
  return `(() => {
  document.querySelectorAll('[data-up-tab]').forEach((e) => e.removeAttribute('data-up-tab'));
  const all = [...document.querySelectorAll('[class*="pc-task"]')].filter((e) => e.offsetParent !== null);
  // [class*="pc-task"] 同时命中容器 / item / 文字节点，只点最内层，避免点到 882px 的外壳
  const leaves = all.filter((e) => !e.querySelector('[class*="pc-task"]'));
  const tabs = leaves.length ? leaves : all;
  const norm = (s) => String(s || '').toLowerCase().replace(/\\s+/g, '')
    .replace(/exercise/g, '').replace(/练习/g, '')
    .replace(/^[.．\\-_:：、\\s]+/, '');
  const key = norm(${JSON.stringify(String(seg))});
  const digits = (key.match(/\\d+/) || [''])[0];
  let hit = -1;
  let reason = '';
  for (let i = 0; i < tabs.length; i++) {
    const t = norm(tabs[i].innerText || tabs[i].textContent || '');
    if (!t) continue;
    if (t === key) { hit = i; reason = 'exact'; break; }
    if (digits && (t.match(/\\d+/) || [''])[0] === digits) { hit = i; reason = 'digits'; break; }
    if (key.length >= 4 && (t.indexOf(key) >= 0 || key.indexOf(t) >= 0)) { hit = i; reason = 'contains'; break; }
  }
  if (hit >= 0) tabs[hit].setAttribute('data-up-tab', String(hit));
  return {
    hit, reason, count: tabs.length,
    text: hit >= 0 ? String(tabs[hit].innerText || '').replace(/\\s+/g, ' ').trim() : '',
    tabs: tabs.slice(0, 20).map((e) => String(e.innerText || '').replace(/\\s+/g, ' ').trim()),
  };
})()`;
}

// 选择题 / 填空 / 简答：全部用 clone，避免 innerText 被已填答案污染
const SCRAPE_TEXT = `(() => {
  const clean = (s) => String(s || '').replace(/\\n{2,}/g, '\\n').trim();
  const isSel = (o) => /selected/.test(String(o.className || ''));
  const choice = [...document.querySelectorAll('.question-common-abs-choice')].map((b, i) => {
    const c = b.cloneNode(true);
    const options = [...b.querySelectorAll('.option')].map((o) => {
      const t = String(o.innerText || '').trim();
      return { letter: t.slice(0, 1), text: t, selected: isSel(o) };
    });
    return { index: i, stem: clean(c.innerText), options };
  });
  // 单个 .fe-scoop 里只有空编号，句子必须从整块 clone 出来的上下文里读
  const root = document.querySelector('.layout-reply-container');
  let scoopContext = '';
  if (root) {
    const c = root.cloneNode(true);
    c.querySelectorAll('input').forEach((i) => i.replaceWith(document.createTextNode('___')));
    c.querySelectorAll('img').forEach((i) => i.replaceWith(document.createTextNode('[IMG]')));
    scoopContext = clean(c.innerText);
  }
  const scoopValues = [...document.querySelectorAll('.fe-scoop input')].map((i) => i.value);
  const tas = [...document.querySelectorAll('textarea')];
  const text = tas.map((t, i) => {
    let stem = '';
    let p = t.parentElement;
    for (let d = 0; p && d < 6; d++, p = p.parentElement) {
      if (/question|stem|title/i.test(String(p.className || ''))) {
        const c = p.cloneNode(true);
        c.querySelectorAll('textarea').forEach((x) => x.replaceWith(document.createTextNode('')));
        stem = clean(c.innerText);
        if (stem) break;
      }
    }
    if (!stem) {
      // 退一步：题干常是 textarea 前面的标题兄弟节点
      let s = t.previousElementSibling;
      for (let d = 0; s && d < 2; d++, s = s.previousElementSibling) {
        const txt = clean(s.innerText);
        if (txt) { stem = txt; break; }
      }
    }
    return { index: i, stem, value: t.value };
  });
  return { choice, scoopContext, scoopValues, text, head: (document.body.innerText || '').slice(0, 300) };
})()`;

// sequence / 匹配：12 个子元素交替是「人物图+编号」与「陈述 A..F」；数量真相在 fiber 的 props 里
const SCRAPE_SEQ = `(() => {
  const w = document.querySelector('.sortable-list-wrapper');
  if (!w) return null;
  const items = [...w.children].map((e) => String(e.innerText || '').replace(/\\s+/g, ' ').trim());
  let itemsData = null;
  let options = null;
  const k = Object.keys(w).find((x) => x.startsWith('__reactFiber') || x.startsWith('__reactInternalInstance'));
  let f = k ? w[k] : null;
  for (let i = 0; f && i < 8; i++, f = f.return) {
    const p = f.memoizedProps || {};
    if (itemsData === null && Array.isArray(p.itemsData)) itemsData = p.itemsData.length;
    if (options === null && Array.isArray(p.options)) options = p.options.length;
  }
  return { items, itemsData, options };
})()`;

const SCRAPE_MEDIA = `[...document.querySelectorAll('video,audio')].map((m) => ({
  kind: m.tagName.toLowerCase(),
  url: String(m.currentSrc || m.src || '').split('#')[0],
  duration: m.duration || 0,
})).filter((m) => m.url)`;

async function main() {
  const ref = process.env.UP_TASK || '';
  if (!ref) return fail('缺少 UP_TASK（任务 idx 或 leafId）：先跑 `unipus scan` 生成 state/tasks.json');

  const tasks = readTasks();
  const task = pickTask(tasks, ref);
  if (!task) return fail(`tasks.json 里找不到任务 ${ref}：先跑 \`unipus scan --course <instanceId>\``);
  if (!task.url) return fail(`任务 ${ref} 缺 url 字段（台账可能是旧版）：重跑 \`unipus scan\``);

  const warnings = [];
  const cdp = await attach({});
  log('nav', { idx: task.idx, leafId: task.leafId, base: task.base, url: String(task.url).slice(0, 120) });

  // 必须 about:blank 中转：U校园是 SPA，直接改 hash 不重渲染，题目会串台
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(900);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await cdp.send('Page.navigate', { url: task.url });
  await sleep(NAV_WAIT);
  await cdp.eval(KILL_MODALS);

  const segs = String(task.path || '').split('/').map((s) => s.trim()).filter(Boolean);
  const tabSegs = segs.slice(-2);

  // 按 path 倒数两段点 tab（没有 tab 条就跳过）；reload 之后要再点一次，否则又回到第一题
  const clickTabs = async () => {
    const done = [];
    for (const seg of tabSegs) {
      const probe = await cdp.eval(tabProbeExpr(seg));
      log('tab-probe', { seg, hit: probe.hit, reason: probe.reason, count: probe.count, tabs: probe.tabs });
      if (probe.hit < 0) continue;
      await clickEl(cdp, `document.querySelector('[data-up-tab="${probe.hit}"]')`);
      done.push({ seg, reason: probe.reason, text: probe.text });
      await sleep(TAB_GAP);
    }
    return done;
  };

  let clickedTabs = await clickTabs();
  await sleep(1500);

  let head = await cdp.eval(`(document.body.innerText || '').slice(0, 300)`);
  if (looksLikeLogin(head)) return fail('登录态已失效（页面回到 SSO 登录页）：先跑 `unipus login` 扫码', { stage: 'login' });

  let match = contentMatch(head, segs);
  if (!match.ok) {
    log('verify-fail', { hits: match.hits, head: String(head || '').replace(/\s+/g, ' ').slice(0, 160) });
    await cdp.eval('location.reload()');
    await sleep(NAV_WAIT);
    await cdp.eval(KILL_MODALS);
    clickedTabs = await clickTabs();
    await sleep(1500);
    head = await cdp.eval(`(document.body.innerText || '').slice(0, 300)`);
    match = contentMatch(head, segs);
    if (!match.ok) warnings.push('内容级校验未通过：页面面包屑与任务 path 对不上（已 reload 重试一次），题目可能不是目标题');
  }
  log('verify', { hits: match.hits, tabs: clickedTabs.map((t) => t.text) });

  const scraped = await cdp.eval(SCRAPE_TEXT);
  const seq = await cdp.eval(SCRAPE_SEQ);
  const media = (await cdp.eval(SCRAPE_MEDIA)) || [];

  if (!clickedTabs.length) warnings.push('页面上没有可见的 pc-task tab 条（已跳过点击），依赖当前页面已停在目标题');
  if (!scraped.choice.length && !scraped.scoopContext && !scraped.text.length && !seq) {
    warnings.push('没抓到任何题目：页面可能还在加载，或该 base 是纯视频/阅读页；重跑一次 open 或人工确认');
  }
  if (seq && (seq.itemsData === null || seq.options === null)) {
    log('seq-props-miss', { itemsData: seq.itemsData, options: seq.options, items: seq.items.length });
    warnings.push('sequence 的结构数量没从 fiber props 读到（itemsData / options 为 null），仅凭 orderItems 判断');
  }
  // 填空判分对大小写敏感：句首空必须大写（Amazing 对、amazing 错）
  if (String(task.base || '').includes('basic-scoop-content')) {
    warnings.push('填空判分大小写敏感，句首的空必须首字母大写（Amazing 对、amazing 错）');
  }

  // 回写媒体直链，供 media.mjs 直接下载（同一个 task 对象引用，直接改即可）
  task.media = media;
  if (tasks && Array.isArray(tasks.tasks)) writeTasks(tasks);

  log('scrape', {
    choice: scraped.choice.length,
    scoop: scraped.scoopValues.length,
    text: scraped.text.length,
    seqItems: seq ? seq.items.length : 0,
    media: media.length,
  });

  emit({
    task: {
      idx: task.idx, path: task.path, base: task.base, leafId: task.leafId,
      url: task.url, required: task.required, pass: task.pass, media,
    },
    questions: {
      choice: scraped.choice,
      scoop: { context: scraped.scoopContext, values: scraped.scoopValues },
      text: scraped.text,
      textValues: scraped.text.map((t) => t.value),
      sequence: seq,
    },
    media,
    tabs: clickedTabs,
    warnings,
  });
}

// CDP 的 WebSocket 会一直 hold 住事件循环：不主动退出的话脚本在 emit 之后永不结束，
// runner / mcp 的 spawn 只能等到超时。结果写完后再退（空写回调保证 stdout 已 flush）。
function finish() {
  const code = process.exitCode || 0;
  try { process.stdout.write('', () => process.exit(code)); } catch { process.exit(code); }
  setTimeout(() => process.exit(code), 2000).unref();
}

main().catch((e) => fail(e)).finally(finish);
