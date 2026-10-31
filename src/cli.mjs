#!/usr/bin/env node
// unipus-kit CLI —— 人类入口，和 MCP 共用同一套 core
import { runCore } from './runner.mjs';

const HELP = `unipus-kit —— U校园（Unipus）课程自动化工具包

用法:
  unipus login                                    打开浏览器，导出扫码登录二维码
  unipus courses                                  列出账号下的课程
  unipus scan    --course <instanceId> [--resource <id>] [--name <n>]
                                                  盘点必修清单 → state/tasks.json
  unipus status  [--task <idx>] [--url <url>]     全量进度 + 真待办（required && !pass）
  unipus open    <task>                           抓题，打印结构化 JSON
  unipus answer  <task> --answers '<json>' [--no-submit]
                                                  注入答案并提交
  unipus grade   <task>                           读判分真相（isRight / judgmentResult）
  unipus transcribe <task> [--no-transcribe]      下载媒体（可选转写）

通用选项:
  --port <n>        浏览器调试端口，默认 9229
  --profile <dir>   浏览器用户目录（登录态持久化）
  --workdir <dir>   state/ 与 logs/ 的位置，默认当前目录

示例:
  unipus login
  unipus courses
  unipus scan --course "course-v2:xxxx+book_1+2026xxxx"
  unipus status
  unipus open 3
  unipus answer 3 --answers '{"choice":["B",["A","C"]]}'
  unipus grade 3
`;

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { flags[k] = true; }
      else { flags[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

function baseEnv(f) {
  const env = {};
  if (f.port) env.UP_PORT = String(f.port);
  if (f.profile) env.UP_PROFILE = String(f.profile);
  return env;
}

function out(res) {
  const r = res.result;
  if (r) {
    process.stdout.write(JSON.stringify(r.ok ? r.data : { error: r.error }, null, 2) + '\n');
  } else {
    if (res.stdout) process.stdout.write(res.stdout.trim() + '\n');
    if (res.stderr) process.stderr.write(res.stderr.trim().split('\n').slice(-12).join('\n') + '\n');
  }
  if (res.logPath) process.stderr.write('[log] ' + res.logPath + '\n');
  process.exitCode = r && r.ok ? 0 : 1;
}

function opts(f, env = {}, timeoutMs = 180000) {
  const o = { env: { ...baseEnv(f), ...env }, timeoutMs };
  if (f.workdir) o.workdir = String(f.workdir);
  return o;
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos[0];

  if (!cmd || cmd === 'help' || flags.help) { process.stdout.write(HELP); return; }

  if (cmd === 'login') {
    const env = {};
    if (flags['no-wait'] || flags.noWait) env.UP_LOGIN_NO_WAIT = '1';
    return out(await runCore('login.mjs', opts(flags, env, 240000)));
  }
  if (cmd === 'courses') return out(await runCore('courses.mjs', opts(flags)));

  if (cmd === 'scan') {
    const instanceId = flags.course || flags.instanceId;
    if (!instanceId) throw new Error('缺少 --course <instanceId>（先用 `unipus courses` 查）');
    const env = { UP_INSTANCE_ID: String(instanceId) };
    if (flags.resource || flags.courseResourceId) env.UP_COURSE_RESOURCE_ID = String(flags.resource || flags.courseResourceId);
    if (flags.name) env.UP_NAME = String(flags.name);
    return out(await runCore('scan.mjs', opts(flags, env, 300000)));
  }

  if (cmd === 'status') {
    const env = {};
    if (flags.task) env.UP_TASK = String(flags.task);
    if (flags.url) env.UP_URL = String(flags.url);
    return out(await runCore('status.mjs', opts(flags, env)));
  }

  const task = pos[1] || flags.task;
  if (!task) throw new Error(`子命令 ${cmd} 需要一个任务参数（idx 或 leafId）`);

  if (cmd === 'open') return out(await runCore('open.mjs', opts(flags, { UP_TASK: String(task) })));

  if (cmd === 'answer') {
    if (!flags.answers) throw new Error('缺少 --answers \'{"choice":["B"]}\'');
    let parsed;
    try { parsed = JSON.parse(String(flags.answers)); } catch (e) { throw new Error('--answers 不是合法 JSON: ' + e.message); }
    const env = { UP_TASK: String(task), UP_ANSWERS: JSON.stringify(parsed) };
    if (flags['no-submit'] || flags.noSubmit) env.UP_NO_SUBMIT = '1';
    return out(await runCore('answer.mjs', opts(flags, env)));
  }

  if (cmd === 'grade') return out(await runCore('grade.mjs', opts(flags, { UP_TASK: String(task) }, 120000)));

  if (cmd === 'transcribe') {
    const env = { UP_TASK: String(task), UP_TRANSCRIBE: (flags['no-transcribe'] || flags.noTranscribe) ? '0' : '1' };
    return out(await runCore('media.mjs', opts(flags, env, 900000)));
  }

  process.stderr.write('未知子命令: ' + cmd + '\n\n' + HELP);
  process.exitCode = 2;
}

main().catch((e) => {
  process.stderr.write('[error] ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exitCode = 1;
});
