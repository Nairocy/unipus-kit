// 子进程运行器：spawn core/*.mjs，透传 UP_* 环境变量，回收 stdout 里的结果行 + jsonl 事件日志
import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export function corePath(name) {
  return join(HERE, 'core', name);
}

function newestLog(dir) {
  const d = join(dir, 'logs');
  if (!existsSync(d)) return null;
  const files = readdirSync(d).filter((f) => /^run-.*\.jsonl$/.test(f));
  if (!files.length) return null;
  files.sort((a, b) => statSync(join(d, b)).mtimeMs - statSync(join(d, a)).mtimeMs);
  return join(d, files[0]);
}

function parseEvents(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { ev: 'unparsed', raw: l }; }
    });
  } catch { return []; }
}

/** 从 stdout 里找最后一行 `{ok:...}` 结果 */
function parseResult(stdout) {
  const lines = String(stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s.startsWith('{')) continue;
    try {
      const j = JSON.parse(s);
      if (typeof j.ok === 'boolean') return j;
    } catch { /* 继续往上找 */ }
  }
  return null;
}

/**
 * 跑一个 core 脚本。
 * @param {string} script   core 下的文件名，如 'status.mjs'
 * @param {object} opts     { env: {}, args: [], workdir, timeoutMs }
 * @returns {Promise<{code:number, result:object|null, stdout:string, stderr:string, events:object[], logPath:string|null}>}
 */
export function runCore(script, opts = {}) {
  const workdir = opts.workdir || process.env.UP_WORKDIR || process.cwd();
  const env = { ...process.env, ...(opts.env || {}), UP_WORKDIR: workdir };
  const before = newestLog(workdir);
  const file = corePath(script);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...(opts.args || [])], {
      cwd: workdir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, opts.timeoutMs) : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const after = newestLog(workdir);
      const logPath = after && after !== before ? after : null;
      resolve({
        code: code ?? -1,
        result: parseResult(stdout),
        stdout,
        stderr,
        events: logPath ? parseEvents(logPath) : [],
        logPath,
      });
    });
  });
}
