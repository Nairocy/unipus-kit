// unipus answer：注入答案 → 提交前回读核对（多选连点会被 React 吞掉，必须补点）→ 提交 → 读分数
// 输入：UP_TASK（任务 idx 或 leafId）+ UP_ANSWERS（JSON 字符串）
// 输出：{ score, correct, total, passed, canRetry, body }
import { attach, emit, fail, log, sleep, readTasks, clickEl, KILL_MODALS } from './common.mjs';

const NAV_WAIT = 9000;

// 不播完媒体，选项点不动：静音 + 16 倍速 + 直接推到结尾前 0.6s
const PLAY_OUT = `(() => {
  const ms = [...document.querySelectorAll('video,audio')];
  ms.forEach((m) => { try { m.muted = true; m.playbackRate = 16; m.currentTime = Math.max(0, (m.duration || 0) - 0.6); m.play(); } catch (e) {} });
  return ms.length;
})()`;

const MEDIA_STATE = `[...document.querySelectorAll('video,audio')].map((m) => ({ d: m.duration || 0, t: m.currentTime || 0, e: !!m.ended }))`;

const CHOICE_STATE = `[...document.querySelectorAll('.question-common-abs-choice')].map((b) => {
  const os = [...b.querySelectorAll('.option')];
  return {
    letters: os.map((o) => String(o.innerText || '').trim().slice(0, 1)),
    bits: os.map((o) => (/selected/.test(String(o.className || '')) ? 1 : 0)).join(''),
  };
})`;

const SEQ_LABELS = `(() => {
  const w = document.querySelector('.sortable-list-wrapper');
  if (!w) return null;
  return [...w.children].map((e, i) => {
    const t = String(e.innerText || '').replace(/\\s+/g, ' ').trim();
    const m = t.match(/^([A-H])(?![A-Za-z])/);
    return { i, text: t, letter: m ? m[1] : null };
  });
})()`;

const SUBMIT_PROBE = `(() => {
  document.querySelectorAll('[data-up-submit]').forEach((e) => e.removeAttribute('data-up-submit'));
  // 页面上有两个同文案「提交」元素：外层容器 882px、真按钮 100px —— 只认宽度 < 200 的
  const cands = [...document.querySelectorAll('button,a,span,div')].filter((e) => {
    if (e.offsetParent === null) return false;
    if (String(e.innerText || '').replace(/\\s/g, '') !== '提交') return false;
    const w = e.getBoundingClientRect().width;
    return w > 0 && w < 200;
  });
  const leaf = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
  const el = leaf[0] || cands[0];
  if (!el) return { found: false, total: cands.length };
  el.setAttribute('data-up-submit', '1');
  const r = el.getBoundingClientRect();
  return { found: true, width: Math.round(r.width), text: String(el.innerText || '').slice(0, 20) };
})()`;

const CONFIRM_PROBE = `(() => {
  document.querySelectorAll('[data-up-confirm]').forEach((e) => e.removeAttribute('data-up-confirm'));
  const cands = [...document.querySelectorAll('button,a,span,div')].filter((e) => {
    if (e.offsetParent === null) return false;
    const t = String(e.innerText || '').replace(/\\s/g, '');
    if (t !== '确定' && t !== '确认') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.width < 400 && r.height > 0 && r.height < 120;
  });
  const leaf = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
  const el = leaf[0] || cands[0];
  if (!el) return { found: false };
  el.setAttribute('data-up-confirm', '1');
  return { found: true, text: String(el.innerText || '').trim() };
})()`;

// 兜底 hook：只有 open 没装过（例如 answer 自己导航进来的）才装，好让 grade 读得到判分响应
const HOOK_MIN = `(() => {
  if (window.__up && Array.isArray(window.__up.resps)) return 'existing';
  window.__up = { reqs: [], resps: [] };
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
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    const i = window.__up.resps.push({ u: this.__u, text: '' }) - 1;
    this.addEventListener('load', () => { try { window.__up.resps[i].text = String(this.responseText).slice(0, 60000); } catch (e) {} });
    return oSend.apply(this, arguments);
  };
  return 'installed';
})()`;

function pickTask(tasks, ref) {
  if (!tasks || !Array.isArray(tasks.tasks)) return null;
  return tasks.tasks.find((t) => String(t.idx) === String(ref) || t.leafId === ref) || null;
}

function optExpr(q, j) {
  return `(() => {
  const b = [...document.querySelectorAll('.question-common-abs-choice')][${q}];
  if (!b) return null;
  return [...b.querySelectorAll('.option')][${j}] || null;
})()`;
}

function setValueExpr(selector, ctor, values) {
  return `(() => {
  const setter = Object.getOwnPropertyDescriptor(${ctor}.prototype, 'value').set;
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const vals = ${JSON.stringify(values)};
  let n = 0;
  els.forEach((el, i) => {
    if (i >= vals.length) return;
    setter.call(el, String(vals[i]));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    n++;
  });
  return { total: els.length, filled: n, values: els.map((e) => e.value) };
})()`;
}

function onSortEndExpr(oldIndex, newIndex) {
  return `(() => {
  const w = document.querySelector('.sortable-list-wrapper');
  if (!w) return { ok: false, err: 'no-wrapper' };
  const k = Object.keys(w).find((x) => x.startsWith('__reactFiber') || x.startsWith('__reactInternalInstance'));
  if (!k) return { ok: false, err: 'no-fiber' };
  let f = w[k];
  let depth = -1;
  for (let i = 0; f && i < 10; i++, f = f.return) {
    const p = f.memoizedProps;
    if (p && typeof p.onSortEnd === 'function') { depth = i; break; }
  }
  if (!f || depth < 0) return { ok: false, err: 'no-onSortEnd' };
  try { f.memoizedProps.onSortEnd({ oldIndex: ${oldIndex}, newIndex: ${newIndex} }); } catch (e) { return { ok: false, err: String(e) }; }
  return { ok: true, depth };
})()`;
}

/** 已经在任务页就复用；不在就照 open 的节奏（about:blank 中转）重新进 */
async function ensurePage(cdp, task) {
  const href = String((await cdp.eval('location.href')) || '');
  if (/courseware\//.test(href)) {
    if (task.leafId && !href.includes(String(task.leafId))) {
      log('page-maybe-wrong', { href: href.slice(0, 160), leafId: task.leafId });
    }
    return { href, navigated: false };
  }
  log('nav', { from: href.slice(0, 120), leafId: task.leafId });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(900);
  await cdp.send('Page.navigate', { url: task.url });
  await sleep(NAV_WAIT);
  await cdp.eval(KILL_MODALS);
  return { href: String((await cdp.eval('location.href')) || ''), navigated: true };
}

/** 把音视频推到结尾并轮询，最多 20s */
async function drainMedia(cdp) {
  const count = await cdp.eval(PLAY_OUT);
  if (!count) return { count: 0, waitedMs: 0 };
  const t0 = Date.now();
  let state = [];
  while (Date.now() - t0 < 20000) {
    state = await cdp.eval(MEDIA_STATE);
    if (state.every((m) => m.e || m.t >= (m.d || 0) - 1)) break;
    await sleep(700);
  }
  const done = state.every((m) => m.e || m.t >= (m.d || 0) - 1);
  log('media', { count, done, waitedMs: Date.now() - t0, state });
  return { count, done, waitedMs: Date.now() - t0, state };
}

function wantBits(answer, letters) {
  const targets = (Array.isArray(answer) ? answer : [answer]).map((x) => String(x).trim().toUpperCase());
  return letters.map((L) => (targets.includes(String(L).toUpperCase()) ? '1' : '0')).join('');
}

/** 选择题：先点掉不要的，再点要的；之后回读位串，不一致就补点 */
async function applyChoice(cdp, answers, warnings) {
  const st = await cdp.eval(CHOICE_STATE);
  if (answers.length > st.length) warnings.push(`choice 给了 ${answers.length} 题，页面上只有 ${st.length} 块选择题`);
  const plan = [];
  answers.forEach((a, i) => {
    if (!st[i]) return;
    const bits = st[i].bits.split('').map((b) => b === '1');
    const want = wantBits(a, st[i].letters);
    if (want.replace(/0/g, '').length === 0) {
      warnings.push(`第 ${i + 1} 题的答案字母在页面上匹配不到（选项字母：${st[i].letters.join('')}）`);
      return;
    }
    const toOff = [];
    const toOn = [];
    for (let j = 0; j < want.length; j++) {
      if (bits[j] && want[j] === '0') toOff.push(j);
      if (!bits[j] && want[j] === '1') toOn.push(j);
    }
    plan.push({ i, toOff, toOn });
  });
  for (const p of plan) {
    for (const j of p.toOff) await clickEl(cdp, optExpr(p.i, j));
    for (const j of p.toOn) await clickEl(cdp, optExpr(p.i, j));
  }
  return { plan, blocks: st.length };
}

/** 提交前回读位串并补点（最多 3 轮） */
async function verifyChoice(cdp, answers) {
  let bad = [];
  for (let round = 0; round < 3; round++) {
    const st = await cdp.eval(CHOICE_STATE);
    bad = [];
    answers.forEach((a, i) => {
      if (!st[i]) return;
      const want = wantBits(a, st[i].letters);
      if (want !== st[i].bits) bad.push({ i, want, got: st[i].bits });
    });
    if (!bad.length) return { ok: true, rounds: round };
    log('choice-repair', { round, bad });
    for (const b of bad) {
      const cur = (await cdp.eval(CHOICE_STATE))[b.i];
      if (!cur) continue;
      const want = wantBits(answers[b.i], cur.letters);
      for (let j = 0; j < want.length; j++) {
        if (want[j] !== cur.bits[j]) await clickEl(cdp, optExpr(b.i, j));
      }
      await sleep(300);
    }
  }
  const st = await cdp.eval(CHOICE_STATE);
  bad = [];
  answers.forEach((a, i) => {
    if (!st[i]) return;
    const want = wantBits(a, st[i].letters);
    if (want !== st[i].bits) bad.push({ i, want, got: st[i].bits });
  });
  return { ok: bad.length === 0, bad };
}

/** 填空 / 文本：原生 setter 注入后回读；不一致再注入一次 */
async function applyValues(cdp, selector, ctor, values) {
  const first = await cdp.eval(setValueExpr(selector, ctor, values));
  await sleep(250);
  let got = first.values;
  if (values.some((v, i) => got[i] !== String(v))) {
    log('value-repair', { selector, want: values, got });
    const again = await cdp.eval(setValueExpr(selector, ctor, values));
    await sleep(250);
    got = again.values;
  }
  const ok = values.every((v, i) => got[i] === String(v));
  return { ok, want: values, got, total: first.total, filled: first.filled };
}

/** sequence：从 fiber 上取 SortableContainer 的 onSortEnd，按选择排序逐步换位，每步回读 DOM */
async function applyOrder(cdp, tokens) {
  const before = await cdp.eval(SEQ_LABELS);
  if (!before) return { ok: false, err: '页面上没有 .sortable-list-wrapper' };
  const labelled = before.filter((x) => x.letter);
  const labels = labelled.map((x) => x.letter);
  log('seq-before', { childCount: before.length, labelled: labels.join(''), texts: before.map((x) => x.text.slice(0, 24)) });

  const resolve = (tok) => {
    const T = String(tok).trim();
    const up = T.toUpperCase();
    const j = labels.indexOf(up);
    if (j >= 0) return j;
    return labelled.findIndex((x) => x.text === T || (T.length >= 8 && x.text.includes(T)));
  };
  const idx = tokens.map(resolve);
  if (idx.some((x) => x < 0)) {
    return {
      ok: false,
      err: 'order 里的项在页面上匹配不到（既不是 A–H 字母，也不是项文本）',
      labels,
      items: before.map((x) => x.text),
    };
  }
  const want = idx.map((j) => labels[j]);

  let arr = labels.slice();
  let steps = 0;
  const ops = [];
  for (let i = 0; i < want.length && steps < 8; i++) {
    if (arr[i] === want[i]) continue;
    const from = arr.indexOf(want[i]);
    if (from < 0) return { ok: false, err: '目标项在 DOM 里消失了', order: arr.join('') };
    const r = await cdp.eval(onSortEndExpr(from, i));
    ops.push({ oldIndex: from, newIndex: i, r });
    if (!r || !r.ok) return { ok: false, err: 'onSortEnd 调用失败: ' + (r && r.err), order: arr.join(''), ops };
    steps++;
    await sleep(900);
    const now = await cdp.eval(SEQ_LABELS);
    const nowLabels = (now || []).filter((x) => x.letter).map((x) => x.letter);
    log('seq-step', { step: steps, from, to: i, now: nowLabels.join('') });
    if (nowLabels.length === arr.length) arr = nowLabels; // 只有页面真变了才更新本地顺序
  }

  const final = await cdp.eval(SEQ_LABELS);
  const finalLabels = (final || []).filter((x) => x.letter).map((x) => x.letter);
  return { ok: finalLabels.join('') === want.join(''), order: finalLabels.join(''), want: want.join(''), steps, ops, labels };
}

/** 点「提交」→ 等 2.5s → 点「确定/确认」→ 轮询「答题小结」最多 20s */
async function submit(cdp) {
  const probe = await cdp.eval(SUBMIT_PROBE);
  if (!probe.found) return { ok: false, err: '没找到「提交」按钮（宽度 < 200 的那个）', probe };
  log('submit', probe);
  await clickEl(cdp, `document.querySelector('[data-up-submit="1"]')`, { waitAfter: 600 });
  await sleep(2500);
  const confirm = await cdp.eval(CONFIRM_PROBE);
  if (confirm.found) {
    log('confirm', confirm);
    await clickEl(cdp, `document.querySelector('[data-up-confirm="1"]')`, { waitAfter: 800 });
  }
  const t0 = Date.now();
  let seen = false;
  while (Date.now() - t0 < 20000) {
    seen = await cdp.eval(`/答题小结/.test(document.body.innerText || '')`);
    if (seen) break;
    await sleep(800);
  }
  return { ok: true, probe, confirm, summarySeen: seen, waitedMs: Date.now() - t0 };
}

async function main() {
  const ref = process.env.UP_TASK || '';
  if (!ref) return fail('缺少 UP_TASK（任务 idx 或 leafId）');
  const tasks = readTasks();
  const task = pickTask(tasks, ref);
  if (!task) return fail(`tasks.json 里找不到任务 ${ref}：先跑 \`unipus scan\``);
  if (!task.url) return fail(`任务 ${ref} 缺 url 字段：重跑 \`unipus scan\``);

  let answers;
  try {
    answers = JSON.parse(process.env.UP_ANSWERS || '');
  } catch (e) {
    return fail('UP_ANSWERS 不是合法 JSON: ' + e.message);
  }
  if (!answers || typeof answers !== 'object') return fail('UP_ANSWERS 必须是对象，例如 {"choice":["B"]}');

  const warnings = [];
  const choiceAns = Array.isArray(answers.choice) ? answers.choice : null;
  const scoopAns = Array.isArray(answers.scoop) ? answers.scoop : null;
  const textAns = Array.isArray(answers.text) ? answers.text : null;
  const orderAns = Array.isArray(answers.order) ? answers.order : null;
  if (!choiceAns && !scoopAns && !textAns && !orderAns) {
    return fail('UP_ANSWERS 里没有可用的题型键（choice / scoop / text / order 至少给一个）');
  }

  const cdp = await attach({});
  const page = await ensurePage(cdp, task);

  const media = await drainMedia(cdp);
  if (media.count && media.done === false) warnings.push(`媒体 20s 内没播到结尾（${media.count} 个），选项可能点不动`);

  const report = {};
  if (choiceAns) {
    const applied = await applyChoice(cdp, choiceAns, warnings);
    report.choice = applied;
  }
  if (scoopAns) {
    report.scoop = await applyValues(cdp, '.fe-scoop input', 'HTMLInputElement', scoopAns);
  }
  if (textAns) {
    report.text = await applyValues(cdp, 'textarea', 'HTMLTextAreaElement', textAns);
  }
  if (orderAns) {
    report.order = await applyOrder(cdp, orderAns);
    if (!report.order.ok) {
      return fail('sequence 重排失败：' + (report.order.err || 'DOM 顺序与目标不一致'), { order: report.order.order || null, want: report.order.want || null, items: report.order.items || null });
    }
  }

  // 提交前回读核对
  if (choiceAns) {
    report.choiceVerify = await verifyChoice(cdp, choiceAns);
    if (!report.choiceVerify.ok) {
      return fail('选择题回读核对不通过（补点 3 轮仍未对齐），未提交', { bad: report.choiceVerify.bad });
    }
  }
  for (const k of ['scoop', 'text']) {
    if (report[k] && !report[k].ok) {
      log('value-mismatch', { kind: k, want: report[k].want, got: report[k].got });
      warnings.push(`${k} 回读与答案不一致（可能是前端做了格式化），仍继续提交`);
    }
  }

  if (process.env.UP_NO_SUBMIT === '1') {
    log('no-submit', { href: page.href.slice(0, 120) });
    return emit({ submitted: false, page, media, answers, report, warnings });
  }

  const hook = await cdp.eval(HOOK_MIN);
  log('hook', { state: hook });

  const sub = await submit(cdp);
  if (!sub.ok) return fail(sub.err, { probe: sub.probe, report });

  const body = String((await cdp.eval(`(document.body.innerText || '').slice(0, 4000)`)) || '');
  const scoreM = body.match(/(\d+)\s*分/);
  const corrM = body.match(/正确\s*[（(]?\s*(\d+)\s*\/\s*(\d+)/);
  const passed = /继续学习/.test(body);
  const canRetry = /返回修改/.test(body);
  if (!sub.summarySeen) warnings.push('20s 内没等到「答题小结」，分数可能还没渲染出来');
  if (!scoreM) warnings.push('没从结果页读到「NN分」');

  log('result', {
    score: scoreM ? Number(scoreM[1]) : null,
    correct: corrM ? Number(corrM[1]) : null,
    total: corrM ? Number(corrM[2]) : null,
    passed, canRetry, summarySeen: sub.summarySeen,
  });

  emit({
    score: scoreM ? Number(scoreM[1]) : null,
    correct: corrM ? Number(corrM[1]) : null,
    total: corrM ? Number(corrM[2]) : null,
    passed,
    canRetry,
    body: body.slice(0, 400),
    submitted: true,
    page,
    media,
    report,
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
