// 盘点必修清单：课程树（ucontent）递归出叶子；有目录页则逐单元点开抓「必修 / 已完成」→ state/tasks.json
// 用法: UP_INSTANCE_ID=course-v2:xxx [UP_COURSE_RESOURCE_ID=2000xxxx] [UP_NAME=课程名] [UP_UNIT_LIMIT=n] node src/core/scan.mjs
// 输出: { total, required, done, tasksPath }
import { attach, emit, fail, log, writeTasks, clickEl, KILL_MODALS, looksLikeLogin } from './common.mjs';

const INSTANCE_ID = String(process.env.UP_INSTANCE_ID || '').trim();
const RESOURCE_ID = String(process.env.UP_COURSE_RESOURCE_ID || '').trim();
const COURSE_NAME = String(process.env.UP_NAME || '').trim();
const UNIT_LIMIT = Math.max(0, Number(process.env.UP_UNIT_LIMIT || 0) || 0);

const UCONTENT = 'https://ucontent.unipus.cn/_explorationpc_default/pc.html';
const UAI_CATALOG = (id) => `https://uai.unipus.cn/app/cmgt/resource-detail/${encodeURIComponent(id)}`;

function pageUrl() {
  return `${UCONTENT}?courseResourceId=${encodeURIComponent(RESOURCE_ID)}`;
}

// hash 只用 5 段 id 里的第 1 段 + 末尾 3 段（跳过第 2 段 Section）；instanceId 自带 course-v2: 前缀
function leafUrl(ids) {
  const tail = ids.length >= 4
    ? [ids[0], ids[ids.length - 3], ids[ids.length - 2], ids[ids.length - 1]]
    : ids.slice();
  return `${pageUrl()}#/${INSTANCE_ID}/courseware/${tail.join('/')}`;
}

const lastSeg = (p) => String(p || '').split(' / ').pop();

/** 递归课程树：每个节点取 id 进 id 链，取 name/title/caption 进 path；无 children 即叶子 */
function walkTree(units) {
  const leaves = [];
  const walk = (node, names, ids) => {
    const nm = String(node.name || node.title || node.caption || '').replace(/\s+/g, ' ').trim();
    const nmChain = nm ? names.concat(nm) : names;
    const idChain = node.id !== undefined && node.id !== null && String(node.id) ? ids.concat(String(node.id)) : ids;
    const kids = Array.isArray(node.children) ? node.children : [];
    if (!kids.length) {
      leaves.push({
        path: nmChain.join(' / '),
        base: node.base || null,
        leafId: node.id ? String(node.id) : null,
        ids: idChain,
      });
      return;
    }
    for (const k of kids) walk(k, nmChain, idChain);
  };
  for (const u of units) walk(u, [], []);
  return leaves;
}

/** 依次点开每个单元（目录树懒渲染），按「快照增量」切出本单元的任务行 */
const CATALOG_SNAP = `(() => [...document.querySelectorAll('div[class*="taskItemContainer"]')].map((el) => {
  const t = String(el.innerText || '').replace(/\\s+/g, ' ').trim();
  return { t, req: !!el.querySelector('[class*="taskRequireIcon"]') };
}))()`;

async function readCatalog(cdp, unitCount) {
  const domUnits = await cdp.eval(`document.querySelectorAll('[class*="richName_name-item"]').length`);
  log('catalog.units', { domUnits, treeUnits: unitCount });
  const total = Math.min(domUnits, unitCount);
  const perUnit = [];
  let prev = [];

  for (let i = 0; i < total; i++) {
    const sel = `document.querySelectorAll('[class*="richName_name-item"]')[${i}]`;
    let box = await clickEl(cdp, sel, { waitAfter: 2000 });
    if (!box) { log('catalog.miss', { i }); break; }

    let snap = (await cdp.eval(CATALOG_SNAP)) || [];
    // 首单元常默认展开，第一次点可能反而是「收起」→ 再点一次让它展开
    if (!snap.length && i === 0) {
      log('catalog.reclick', { i });
      box = await clickEl(cdp, sel, { waitAfter: 2000 });
      snap = (await cdp.eval(CATALOG_SNAP)) || [];
    }

    const texts = snap.map((s) => s.t);
    // 展开式：新列表以旧列表为前缀 → 只取尾部；替换式：列表被整体换掉 → 整份都算本单元的
    const grew = texts.length >= prev.length && prev.every((t, k) => texts[k] === t);
    const chunk = grew ? snap.slice(prev.length) : snap;
    log('catalog.click', { i, seen: texts.length, grew, chunk: chunk.length });
    perUnit.push(chunk);
    prev = texts;
  }
  return perUnit.flat();
}

/** 「名称 必修 未开始|已完成」→ { text, name, required, pass } */
function parseItem(x) {
  const t = String((x && x.t) || '');
  const noNeg = t.replace(/非必修/g, '');
  const required = !!(x && x.req) || /必修/.test(noNeg);
  const pass = /已完成/.test(t) ? 1 : 0;
  const name = noNeg
    .replace(/必修/g, '')
    .replace(/未开始|已完成|进行中|学习中/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: t, name, required, pass };
}

async function main() {
  if (!INSTANCE_ID) {
    return fail('缺少 UP_INSTANCE_ID（课程实例 id，形如 course-v2:xxx+nhce_4_vls_1+2026xxxx）：先跑 `unipus courses` 查');
  }

  const cdp = await attach({});

  log('nav', { url: pageUrl(), instanceId: INSTANCE_ID });
  await cdp.goto(pageUrl(), { waitMs: 8000 });

  const body = await cdp.eval('document.body.innerText.slice(0,800)');
  if (looksLikeLogin(body)) {
    return fail('登录态已失效（页面回到 SSO 登录页）：先跑 `unipus login` 扫码', { stage: 'login' });
  }

  // 1) 课程树：course 字段是一个 JSON 字符串，要二次 parse
  //    ⚠️ instanceId 里的 ':' 和 '+' 在 URL path 里是合法字符，不能 encodeURIComponent
  //    （编码成 %3A/%2B 后服务端不解码，会返回 code=2）
  const res = await cdp.eval(`(async () => {
    const r = await fetch('/course/api/course/' + ${JSON.stringify(INSTANCE_ID)} + '/default', { credentials: 'include' });
    const t = await r.text();
    return { status: r.status, len: t.length, text: t };
  })()`);

  if (!res || !res.text) return fail('课程树接口没有返回内容', { res: res && { status: res.status } });
  if (res.status === 401 || res.status === 403) {
    return fail(`课程树接口 ${res.status}，登录态已失效：先跑 \`unipus login\` 扫码`, { stage: 'login' });
  }

  let raw;
  try {
    raw = JSON.parse(res.text);
  } catch {
    return fail(`课程树返回不是 JSON（HTTP ${res.status}，${res.len} 字节）：多半是掉登录或被重定向到 HTML`, {
      head: String(res.text).slice(0, 200),
    });
  }
  if (!raw || raw.code !== 0) return fail(`课程树接口 code=${raw && raw.code} ${(raw && (raw.msg || raw.message)) || ''}`.trim(), { keys: Object.keys(raw || {}) });
  if (!raw.course) return fail('课程树响应里没有 course 字段', { keys: Object.keys(raw) });

  let course;
  try {
    course = typeof raw.course === 'string' ? JSON.parse(raw.course) : raw.course;
  } catch (e) {
    return fail('course 字段二次 JSON.parse 失败：' + e.message, { head: String(raw.course).slice(0, 200) });
  }

  const allUnits = Array.isArray(course && course.units) ? course.units : null;
  if (!allUnits || !allUnits.length) {
    return fail('课程树里没有 units（结构可能变了）', { courseKeys: Object.keys(course || {}), topKeys: Object.keys(raw) });
  }

  // 字段名先打一次原始结构，别靠猜
  const sampleLeaf = (function first() {
    const st = [allUnits[0]];
    while (st.length) {
      const n = st.pop();
      const kids = Array.isArray(n.children) ? n.children : [];
      if (!kids.length) return n;
      st.push(...kids);
    }
    return null;
  })();
  log('tree.shape', {
    topKeys: Object.keys(raw),
    courseKeys: Object.keys(course),
    unitKeys: Object.keys(allUnits[0] || {}),
    leafKeys: sampleLeaf ? Object.keys(sampleLeaf) : null,
    units: allUnits.length,
  });

  const units = UNIT_LIMIT > 0 ? allUnits.slice(0, UNIT_LIMIT) : allUnits;
  const leaves = walkTree(units);
  log('tree.walk', {
    units: units.length,
    leaves: leaves.length,
    oddIdChains: leaves.filter((l) => l.ids.length !== 5).length,
    noBase: leaves.filter((l) => !l.base).length,
    bases: leaves.reduce((m, l) => { const k = l.base || 'null'; m[k] = (m[k] || 0) + 1; return m; }, {}),
  });
  if (!leaves.length) return fail('课程树递归后没有任何叶子', { units: units.length });

  // 2) 目录页逐单元展开，拿「必修 / 完成态」
  let parsed = null;
  if (RESOURCE_ID) {
    log('nav', { url: UAI_CATALOG(RESOURCE_ID) });
    await cdp.goto(UAI_CATALOG(RESOURCE_ID), { waitMs: 8000 });
    await cdp.eval(KILL_MODALS);
    const rows = await readCatalog(cdp, units.length);
    if (!rows.length) {
      log('catalog.empty', { msg: '目录页一条 taskItemContainer 都没抓到（选择器可能变了 / 树没展开）：required/pass 记为 null' });
    } else {
      parsed = rows.map(parseItem);
      let matched = 0;
      const n = Math.min(parsed.length, leaves.length);
      for (let i = 0; i < n; i++) {
        const nm = lastSeg(leaves[i].path);
        if (nm && parsed[i].text.includes(nm)) matched++;
      }
      log('catalog.align', { items: parsed.length, leaves: leaves.length, nameMatched: matched });
      if (matched !== leaves.length) {
        log('catalog.warn', {
          msg: '名称匹配数 != 叶子数：仍按顺序 1:1 硬对齐，required/pass 可能错位，请人工核一眼',
          nameMatched: matched,
          leaves: leaves.length,
          items: parsed.length,
        });
      }
    }
  } else {
    log('catalog.skip', { msg: '没给 UP_COURSE_RESOURCE_ID：required/pass 记为 null（未知），跑 `unipus status` 会用 course_progress 回填' });
  }

  // 3) 台账
  const tasks = leaves.map((lf, i) => {
    const c = parsed && i < parsed.length ? parsed[i] : null;
    return {
      idx: i,
      path: lf.path,
      base: lf.base,
      leafId: lf.leafId,
      ids: lf.ids,
      url: leafUrl(lf.ids),
      required: c ? c.required : null,
      pass: c ? c.pass : null,
    };
  });

  const tasksPath = writeTasks({
    course: { name: COURSE_NAME || null, instanceId: INSTANCE_ID, courseResourceId: RESOURCE_ID || null },
    scannedAt: new Date().toISOString(),
    tasks,
  });

  const required = parsed ? tasks.filter((t) => t.required).length : null;
  const done = parsed ? tasks.filter((t) => t.pass === 1).length : null;
  log('scan.done', { total: tasks.length, required, done, catalogued: !!parsed, tasksPath });

  emit({ total: tasks.length, required, done, tasksPath });
}

main().catch((e) => fail(e));
