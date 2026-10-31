// 列课程：在已登录的 uai 页里读 bookshelf 接口 → value.groups.CLASS_COURSE[]
// 用法: node src/core/courses.mjs
// 输出: { courses: [{ name, instanceId, courseResourceId, courseId }] }
import { writeFile } from 'node:fs/promises';
import { attach, emit, fail, log, HOME, looksLikeLogin, statePath } from './common.mjs';

const API = '/api/cmgt/course/my/bookshelf';

// 只取标量，避免把对象当成 id 用
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** 兼容 groups 是对象 / 数组两种形态，返回 CLASS_COURSE 的课程数组（找不到返回 null） */
function classCourses(j) {
  const v = (j && (j.value || j.data || j.result)) || j || {};
  const g = v.groups;
  if (Array.isArray(g)) {
    const hit = g.find((x) => /CLASS_COURSE/i.test(String((x && (x.code || x.type || x.key || x.name)) || '')));
    if (hit) {
      for (const k of ['list', 'courses', 'items', 'rows', 'data', 'children']) {
        if (Array.isArray(hit[k])) return hit[k];
      }
    }
  }
  if (g && typeof g === 'object') {
    for (const k of Object.keys(g)) if (/CLASS_COURSE/i.test(k) && Array.isArray(g[k])) return g[k];
  }
  for (const k of ['CLASS_COURSE', 'classCourse', 'classCourseList']) {
    if (Array.isArray(v[k])) return v[k];
  }
  return null;
}

function shapeOf(j) {
  const v = (j && (j.value || j.data || j.result)) || j || {};
  const g = v.groups;
  return {
    top: Object.keys(j || {}),
    value: v && typeof v === 'object' ? Object.keys(v) : null,
    groups: Array.isArray(g) ? g.map((x) => Object.keys(x || {})) : (g && typeof g === 'object' ? Object.keys(g) : null),
  };
}

async function main() {
  const cdp = await attach({});
  log('nav', { url: HOME });
  await cdp.goto(HOME, { waitMs: 6000 });

  const body = await cdp.eval('document.body.innerText.slice(0,800)');
  if (looksLikeLogin(body)) {
    return fail('登录态已失效（页面回到 SSO 登录页）：先跑 `unipus login` 扫码', { stage: 'login' });
  }

  // 在页面里发请求，带页面自带的 cookie / 头
  const res = await cdp.eval(`(async () => {
    const r = await fetch(${JSON.stringify(API)}, { credentials: 'include' });
    const t = await r.text();
    return { status: r.status, len: t.length, text: t.slice(0, 200000) };
  })()`);

  if (!res || !res.text) return fail('bookshelf 接口没有返回内容', { res: res && { status: res.status, len: res.len } });
  if (res.status === 401 || res.status === 403) {
    return fail(`bookshelf 接口 ${res.status}，登录态已失效：先跑 \`unipus login\` 扫码`, { stage: 'login' });
  }

  let j;
  try {
    j = JSON.parse(res.text);
  } catch {
    return fail(`bookshelf 返回不是 JSON（HTTP ${res.status}，${res.len} 字节）：多半是掉登录或被重定向到 HTML 登录页`, {
      head: String(res.text).slice(0, 200),
    });
  }

  log('bookshelf.shape', shapeOf(j));
  const items = classCourses(j);
  if (!Array.isArray(items)) {
    return fail('bookshelf 响应里找不到 value.groups.CLASS_COURSE', { shape: shapeOf(j), code: j && j.code, msg: j && (j.msg || j.message) });
  }
  if (items.length) log('bookshelf.item', { keys: Object.keys(items[0] || {}) });

  const courses = items.map((it) => {
    const nested = it && typeof it.course === 'object' && it.course ? it.course : {};
    const inst = it && typeof it.instance === 'object' && it.instance ? it.instance : {};
    const src = { ...nested, ...inst, ...it };
    // 数字形式的 courseId / classId 只在 classCourses[0] 里
    const cc = Array.isArray(src.classCourses) && src.classCourses[0] ? src.classCourses[0] : {};
    return {
      name: pick(src, ['name', 'courseName', 'course_name', 'resourceName', 'title']),
      instanceId: pick(src, ['instanceId', 'instance_id', 'courseInstanceId', 'course_instance_id']),
      // bookshelf 只下发字符串形式的 resourceId（形如 course-v2:Unipus+xxx）；
      // 数字 courseResourceId（uai 目录页 /resource-detail/<id> 里那个）不在这个接口里，别拿 resourceId 冒充
      resourceId: pick(src, ['resourceId', 'resource_id']),
      courseResourceId: pick(src, ['courseResourceId', 'course_resource_id']),
      courseId: pick(cc, ['courseId', 'course_id']) || pick(src, ['courseId', 'course_id', 'cid']),
      classId: pick(cc, ['classId', 'class_id']) || pick(src, ['classId', 'class_id']),
    };
  });

  const noInst = courses.filter((c) => !c.instanceId).length;
  log('courses', { count: courses.length, noInstanceId: noInst });
  if (!courses.length) return fail('bookshelf 里 CLASS_COURSE 是空数组（这个账号没有班级课程？）', { shape: shapeOf(j) });

  // 落盘一份，后续 scan/status 可以直接按 idx 或名字选课，不必手抄 instanceId
  const saved = statePath('courses.json');
  await writeFile(saved, JSON.stringify({ courses, at: Date.now() }, null, 2), 'utf8');
  log('courses.saved', { path: saved });

  emit({ courses, coursesPath: saved });
}

main().catch((e) => fail(e));
