#!/usr/bin/env node
// unipus-kit MCP server（stdio）—— 把 U校园 课程自动化能力暴露给支持 MCP 的 agent
// 注意：stdout 只用于协议帧，调试信息一律走 stderr
import { createInterface } from 'node:readline';
import { runCore } from './runner.mjs';

const log = (...a) => console.error('[unipus-kit]', ...a);
const VERSION = '0.1.0';

const envParams = {
  port: { type: 'number', description: '浏览器调试端口，默认 9229' },
  profile: { type: 'string', description: '浏览器用户目录（登录态持久化），默认 ~/.unipus-kit/edge-profile' },
  workdir: { type: 'string', description: '工作目录（state/ 与 logs/ 落在这里），默认进程 cwd' },
};

function baseEnv(a = {}) {
  const env = {};
  if (a.port) env.UP_PORT = String(a.port);
  if (a.profile) env.UP_PROFILE = String(a.profile);
  return env;
}

function opts(a = {}, env = {}, timeoutMs = 180000) {
  const o = { env: { ...baseEnv(a), ...env }, timeoutMs };
  if (a.workdir) o.workdir = a.workdir;
  return o;
}

const TOOLS = [
  {
    name: 'unipus_login',
    description: '打开有头浏览器让用户扫码登录 U校园（SSO 只有扫码入口）。导出二维码 png 并返回绝对路径，供调用方展示给用户扫。登录态写入 profile，后续命令复用。扫码成功后本工具会在 180s 内返回。',
    inputSchema: { type: 'object', properties: { ...envParams } },
  },
  {
    name: 'unipus_courses',
    description: '列出账号下的课程（读 bookshelf 接口），并写 state/courses.json。返回 name / instanceId / resourceId / courseId / classId。注意：bookshelf 只下发字符串形式的 resourceId，数字 courseResourceId 不在这个接口里 —— scan 只需要 instanceId。',
    inputSchema: { type: 'object', properties: { ...envParams } },
  },
  {
    name: 'unipus_scan',
    description: '盘点某门课的必修清单，写 state/tasks.json。产出每项 { idx, path, base, leafId, ids, url, required, pass }。传入 courseResourceId 时会额外去目录页逐单元展开核对必修标记。',
    inputSchema: {
      type: 'object',
      properties: {
        ...envParams,
        instanceId: { type: 'string', description: '课程实例 id，形如 "course-v2:xxx+book_1+2026xxxx"（从 unipus_courses 取）' },
        courseResourceId: { type: 'string', description: '目录页数字 id（读写课有，视听说通常没有）' },
        name: { type: 'string', description: '课程名，仅用于写入台账' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'unipus_status',
    description: '读全量进度：注入网络 hook 后 reload，合并所有 course_progress 响应（一次可拿数百个 leaf），返回 required / passed / pendingCount 与真待办清单（required && pass!=1 的交集）。这是唯一的完成度权威判据。',
    inputSchema: {
      type: 'object',
      properties: {
        ...envParams,
        task: { type: 'string', description: '任务 idx 或 leafId（用它的页面做落点），默认取台账第一条' },
        url: { type: 'string', description: '直接指定一个 leaf 页地址（台账缺失时用）' },
      },
    },
  },
  {
    name: 'unipus_open',
    description: '导航到某个任务并抓题，返回结构化 JSON：选择题（题干+选项+已选态）、填空（带 ___ 占位的上下文 + 当前值）、简答、排序/匹配（12 项文本 + 图/陈述数量）、媒体直链与时长。本工具不含任何答案 —— 答案由调用方产出后交 unipus_answer。',
    inputSchema: {
      type: 'object',
      properties: { ...envParams, task: { type: 'string', description: '任务 idx 或 leafId' } },
      required: ['task'],
    },
  },
  {
    name: 'unipus_answer',
    description: '注入答案并提交，返回得分与是否通过（≥60% 通过）。answers 按题型取用：choice（单选字符串 / 多选字符串数组）、scoop（填空按空位顺序，注意句首空必须首字母大写）、text（简答）、order（sequence 的 options 目标顺序）。提交前会自动回读核对选中状态。',
    inputSchema: {
      type: 'object',
      properties: {
        ...envParams,
        task: { type: 'string', description: '任务 idx 或 leafId' },
        answers: { type: 'string', description: '答案 JSON 字符串，形如 {"choice":["B",["A","C"]]} 或 {"scoop":["relaxing","Amazing"]} 或 {"order":["B","D","E","C","F","A"]}' },
        noSubmit: { type: 'boolean', description: '只填不提交（默认提交）' },
      },
      required: ['task', 'answers'],
    },
  },
  {
    name: 'unipus_grade',
    description: '读判分真相，用于「只改错的那题」或反解多选题：items 给逐题 isRight；judgmentResult 给逐选项布尔数组（与本次 answers 同序，长度=选中数）。多选题的通用打法是先全选提交一次拿 judgmentResult，再提交精确集合。',
    inputSchema: {
      type: 'object',
      properties: { ...envParams, task: { type: 'string', description: '任务 idx 或 leafId' } },
      required: ['task'],
    },
  },
  {
    name: 'unipus_transcribe',
    description: '把任务的音视频直链下载到 state/media/，可选调 faster-whisper 转写（需要本机 python + faster-whisper + ffmpeg，缺失时跳过而不报错）。听力/视频题要靠转写才能答准。',
    inputSchema: {
      type: 'object',
      properties: {
        ...envParams,
        task: { type: 'string', description: '任务 idx 或 leafId' },
        transcribe: { type: 'boolean', description: '是否同时转写（默认 true）' },
      },
      required: ['task'],
    },
  },
];

function text(res, hint) {
  const r = res.result;
  const parts = [];
  if (r) parts.push(JSON.stringify(r.ok ? r.data : { error: r.error }));
  else parts.push(res.stdout.trim() || '(no output)');
  if (!r) parts.push('[exit ' + res.code + ']' + (res.stderr ? '\n' + res.stderr.trim().slice(-1200) : ''));
  if (r && !r.ok && res.stderr) {
    const tail = res.stderr.trim().split('\n').slice(-6).join('\n');
    if (tail) parts.push('[stderr]\n' + tail);
  }
  if (hint) parts.push(hint);
  if (res.logPath) parts.push('[log] ' + res.logPath);
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: !(r && r.ok) };
}

function needTask(a) {
  if (!a.task) return '缺少 task 参数（任务 idx 或 leafId）';
  return null;
}

async function callTool(name, a = {}) {
  if (name === 'unipus_login') {
    return text(await runCore('login.mjs', opts(a, {}, 240000)));
  }
  if (name === 'unipus_courses') {
    return text(await runCore('courses.mjs', opts(a)));
  }
  if (name === 'unipus_scan') {
    if (!a.instanceId) return { content: [{ type: 'text', text: '缺少 instanceId（从 unipus_courses 取）' }], isError: true };
    const env = { UP_INSTANCE_ID: String(a.instanceId) };
    if (a.courseResourceId) env.UP_COURSE_RESOURCE_ID = String(a.courseResourceId);
    if (a.name) env.UP_NAME = String(a.name);
    return text(await runCore('scan.mjs', opts(a, env, 300000)));
  }
  if (name === 'unipus_status') {
    const env = {};
    if (a.task) env.UP_TASK = String(a.task);
    if (a.url) env.UP_URL = String(a.url);
    return text(await runCore('status.mjs', opts(a, env, 180000)));
  }
  if (name === 'unipus_open') {
    const miss = needTask(a);
    if (miss) return { content: [{ type: 'text', text: miss }], isError: true };
    return text(await runCore('open.mjs', opts(a, { UP_TASK: String(a.task) }, 180000)));
  }
  if (name === 'unipus_answer') {
    const miss = needTask(a);
    if (miss) return { content: [{ type: 'text', text: miss }], isError: true };
    if (!a.answers) return { content: [{ type: 'text', text: '缺少 answers（JSON 字符串）' }], isError: true };
    let parsed;
    try { parsed = typeof a.answers === 'string' ? JSON.parse(a.answers) : a.answers; } catch (e) { return { content: [{ type: 'text', text: 'answers 不是合法 JSON: ' + e.message }], isError: true }; }
    const env = { UP_TASK: String(a.task), UP_ANSWERS: JSON.stringify(parsed) };
    if (a.noSubmit) env.UP_NO_SUBMIT = '1';
    return text(await runCore('answer.mjs', opts(a, env, 180000)));
  }
  if (name === 'unipus_grade') {
    const miss = needTask(a);
    if (miss) return { content: [{ type: 'text', text: miss }], isError: true };
    return text(await runCore('grade.mjs', opts(a, { UP_TASK: String(a.task) }, 120000)));
  }
  if (name === 'unipus_transcribe') {
    const miss = needTask(a);
    if (miss) return { content: [{ type: 'text', text: miss }], isError: true };
    const env = { UP_TASK: String(a.task), UP_TRANSCRIBE: a.transcribe === false ? '0' : '1' };
    return text(await runCore('media.mjs', opts(a, env, 900000)));
  }
  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
}

function reply(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function error(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      process.stdout.write(reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'unipus-kit', version: VERSION },
      }) + '\n');
      return;
    }
    if (method === 'tools/list') {
      process.stdout.write(reply(id, { tools: TOOLS }) + '\n');
      return;
    }
    if (method === 'tools/call') {
      const r = await callTool(params?.name, params?.arguments || {});
      process.stdout.write(reply(id, r) + '\n');
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') { process.stdout.write(reply(id, {}) + '\n'); return; }
    process.stdout.write(error(id, -32601, 'method not found: ' + method) + '\n');
  } catch (e) {
    log('tool error', e.message);
    process.stdout.write(error(id, -32603, e.message) + '\n');
  }
});
rl.on('close', () => process.exit(0));
log('MCP server ready (stdio)');
