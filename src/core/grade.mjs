// unipus grade：读判分真相（不导航，就用当前页）
// 1) 逐题 isRight：从 .option / .fe-scoop input 的 fiber 往上找带 userAnswer 的组件 props
// 2) 逐选项 judgmentResult：hook 缓冲里 /api/mobile/user_module/ 响应的 __SUMMARY__.answerList["0"]
import { attach, emit, fail, log, readTasks } from './common.mjs';

const NO_HOOK_HINT = '本页未安装 hook；判断多选逐选项需先跑 status 或重新 open';

// 往上找带 userAnswer 的 fiber：选择题实测 4 层、填空实测 7 层，所以两组深度都试一遍
const READ_USER_ANSWER = `(() => {
  const fiberOf = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber') || x.startsWith('__reactInternalInstance'));
    return k ? el[k] : null;
  };
  const findUA = (el, depths) => {
    const f0 = fiberOf(el);
    if (!f0) return null;
    for (const d of depths) {
      let f = f0;
      for (let i = 0; i < d && f; i++) f = f.return;
      if (f && f.memoizedProps && f.memoizedProps.userAnswer) return { ua: f.memoizedProps.userAnswer, depth: d };
    }
    return null;
  };
  const simplify = (ua) => {
    const ch = (ua && ua.content && ua.content.children) || [];
    return ch.map((c) => ({ value: c.value, isRight: c.isRight }));
  };
  const out = { choice: [], scoop: [] };
  [...document.querySelectorAll('.question-common-abs-choice')].forEach((b, i) => {
    const o = b.querySelector('.option');
    const hit = o ? findUA(o, [4, 7, 3, 5, 6, 8]) : null;
    out.choice.push({ index: i, hit: !!hit, depth: hit ? hit.depth : null, children: hit ? simplify(hit.ua) : [] });
  });
  [...document.querySelectorAll('.fe-scoop input')].forEach((inp, i) => {
    const hit = findUA(inp, [7, 4, 3, 5, 6, 8]);
    out.scoop.push({ index: i, hit: !!hit, depth: hit ? hit.depth : null, children: hit ? simplify(hit.ua) : [] });
  });
  return out;
})()`;

// hook 缓冲里最后一条 user_module 响应 → answerList["0"] 的 judgmentResult / student_answer.answers
const READ_JUDGMENT = `(() => {
  if (!window.__up || !Array.isArray(window.__up.resps)) return { installed: false };
  const rs = window.__up.resps;
  let last = null;
  for (const r of rs) if (/\\/api\\/mobile\\/user_module\\//.test(r.u || '')) last = r;
  if (!last) {
    return { installed: true, found: false, count: rs.length, urls: rs.slice(-8).map((r) => String(r.u || '').slice(0, 120)) };
  }
  let j = null;
  try { j = JSON.parse(last.text || ''); } catch (e) {
    return { installed: true, found: true, parseErr: String(e), raw: String(last.text || '').slice(0, 300) };
  }
  const pack = j && j.data && j.data.state && j.data.state.__EXTEND_DATA__ && j.data.state.__EXTEND_DATA__.__SUMMARY__;
  if (!pack) {
    return { installed: true, found: true, noSummary: true, dataKeys: Object.keys((j && j.data) || {}), stateKeys: Object.keys((j && j.data && j.data.state) || {}) };
  }
  const list = pack.answerList;
  const a0 = Array.isArray(list) ? list[0] : (list && list['0']);
  if (!a0) {
    return { installed: true, found: true, noAnswer0: true, answerKeys: list && typeof list === 'object' ? Object.keys(list) : String(list) };
  }
  return {
    installed: true, found: true,
    judgmentResult: a0.judgmentResult === undefined ? null : a0.judgmentResult,
    answers: (a0.student_answer && a0.student_answer.answers) || null,
    keys: Object.keys(a0 || {}),
  };
})()`;

function pickTask(tasks, ref) {
  if (!tasks || !Array.isArray(tasks.tasks)) return null;
  return tasks.tasks.find((t) => String(t.idx) === String(ref) || t.leafId === ref) || null;
}

/** 字符串形态的 judgmentResult 要二次 JSON.parse；解析不了就原样返回 */
function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

async function main() {
  const ref = process.env.UP_TASK || '';
  const tasks = readTasks();
  const task = ref ? pickTask(tasks, ref) : null;
  if (ref && !task) return fail(`tasks.json 里找不到任务 ${ref}：先跑 \`unipus scan\``);

  const cdp = await attach({});
  const href = String((await cdp.eval('location.href')) || '');
  log('page', { href: href.slice(0, 160), leafId: task ? task.leafId : null });
  if (task && task.leafId && !href.includes(String(task.leafId))) {
    log('warn-page', { msg: '当前页 URL 里没有该任务的 leafId，读到的可能是别的题的判分', leafId: task.leafId });
  }

  const raw = await cdp.eval(READ_USER_ANSWER);
  const items = [];
  raw.choice.forEach((b) => {
    if (!b.hit || !b.children.length) return;
    const value = b.children.flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value])).filter((x) => x !== undefined && x !== null).join('');
    items.push({ index: items.length, value, isRight: b.children.every((c) => c.isRight === true) });
  });
  raw.scoop.forEach((s) => {
    if (!s.hit || !s.children.length) return;
    const value = s.children.flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value])).filter((x) => x !== undefined && x !== null).join('');
    items.push({ index: items.length, value, isRight: s.children.every((c) => c.isRight === true) });
  });
  log('fiber', {
    choiceBlocks: raw.choice.length,
    choiceHit: raw.choice.filter((x) => x.hit).length,
    scoopInputs: raw.scoop.length,
    scoopHit: raw.scoop.filter((x) => x.hit).length,
    depths: raw.choice.concat(raw.scoop).map((x) => x.depth),
  });

  const jr = await cdp.eval(READ_JUDGMENT);
  log('hook', { installed: jr.installed, found: jr.found, count: jr.count, keys: jr.keys, err: jr.parseErr || jr.noSummary || jr.noAnswer0 || null });

  // 没装 hook 不是错误：返回 null + 提示，让调用方去跑 status / 重新 open
  if (!jr.installed) {
    return emit({
      items,
      judgmentResult: null,
      answers: null,
      hint: NO_HOOK_HINT,
      hook: { installed: false },
    });
  }
  if (!jr.found) {
    return emit({
      items,
      judgmentResult: null,
      answers: null,
      hint: 'hook 已装但没抓到 /api/mobile/user_module/ 响应：判分接口还没回包，先提交一次或稍后再读',
      hook: { installed: true, found: false, count: jr.count, urls: jr.urls },
    });
  }

  const judgmentResult = parseMaybeJson(jr.judgmentResult);
  const answers = parseMaybeJson(jr.answers);
  const hint = jr.noSummary || jr.noAnswer0 || jr.parseErr
    ? '响应结构里没找到 __SUMMARY__.answerList["0"]，逐选项真值不可用（见 hook 字段）'
    : null;

  emit({
    items,
    judgmentResult: judgmentResult === undefined ? null : judgmentResult,
    answers: answers === undefined ? null : answers,
    hint,
    hook: { installed: true, found: true, keys: jr.keys || null, parseErr: jr.parseErr || null },
    task: task ? { idx: task.idx, leafId: task.leafId, base: task.base } : null,
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
