// unipus media：把任务页的音视频直链下载到 state/media/，可选（UP_TRANSCRIBE=1）调 ffmpeg + faster-whisper 转写
// 转写是可选链路：python / ffmpeg / faster-whisper 缺失时只记 skipped，不报错退出
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attach, emit, fail, log, sleep, readTasks, writeTasks, statePath, KILL_MODALS } from './common.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const TRANSCRIBE_PY = join(HERE, '../../scripts/transcribe.py');
const NAV_WAIT = 9000;

const SCRAPE_MEDIA = `[...document.querySelectorAll('video,audio')].map((m) => ({
  kind: m.tagName.toLowerCase(),
  url: String(m.currentSrc || m.src || '').split('#')[0],
  duration: m.duration || 0,
})).filter((m) => m.url)`;

function pickTask(tasks, ref) {
  if (!tasks || !Array.isArray(tasks.tasks)) return null;
  return tasks.tasks.find((t) => String(t.idx) === String(ref) || t.leafId === ref) || null;
}

/** 后缀优先取 URL 路径后缀，没有就按 kind 兜底 */
function extFrom(url, kind) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(mp4|mp3|m4a|m4v|aac|wav|webm|ogg|flv|mov)$/i);
    if (m) return m[1].toLowerCase();
  } catch { /* 非标准 URL 走 kind */ }
  return kind === 'video' ? 'mp4' : 'mp3';
}

function shortErr(e) {
  const s = String((e && (e.stderr || e.message)) || e);
  return s.replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

/** 没装 hook 也行：直接导航到任务页抓一次媒体直链 */
async function scrapeMedia(cdp, task) {
  log('nav', { idx: task.idx, leafId: task.leafId, url: String(task.url).slice(0, 120) });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(900);
  await cdp.send('Page.navigate', { url: task.url });
  await sleep(NAV_WAIT);
  await cdp.eval(KILL_MODALS);
  return (await cdp.eval(SCRAPE_MEDIA)) || [];
}

/** 抽轨 + 调 scripts/transcribe.py；缺依赖返回 skipped 文案，不抛 */
async function transcribeAll(audios, base) {
  if (!audios.length) return { status: 'skipped: 任务里没有音频（只对 audio 转写）', files: [] };
  try {
    await run('ffmpeg', ['-version'], { timeoutMs: 8000, windowsHide: true });
  } catch (e) {
    return { status: 'skipped: ffmpeg 不可用（' + shortErr(e) + '）', files: [] };
  }
  try {
    await run('python', ['--version'], { timeoutMs: 8000, windowsHide: true });
  } catch (e) {
    return { status: 'skipped: python 不可用（' + shortErr(e) + '）', files: [] };
  }

  await mkdir(statePath('trans'), { recursive: true });
  const files = [];
  for (let i = 0; i < audios.length; i++) {
    const a = audios[i];
    const wav = statePath('media/' + base + '_' + a.index + '.wav');
    // 规格是 state/trans/<leafId>.txt；多段音频时额外加序号，避免互相覆盖
    const out = statePath('trans/' + base + (i === 0 ? '' : '_' + a.index) + '.txt');
    try {
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', a.path, '-ac', '1', '-ar', '16000', '-b:a', '64k', wav], { timeoutMs: 300000, windowsHide: true });
    } catch (e) {
      files.push({ src: a.path, err: 'ffmpeg 抽轨失败: ' + shortErr(e) });
      continue;
    }
    try {
      const r = await run('python', [TRANSCRIBE_PY, wav, out], { timeoutMs: 900000, windowsHide: true });
      files.push({ src: a.path, wav, out, ok: true, msg: String(r.stdout || '').trim() });
    } catch (e) {
      files.push({ src: a.path, wav, err: '转写失败: ' + shortErr(e) });
    }
  }
  const okCount = files.filter((f) => f.ok).length;
  const status = okCount === files.length ? 'ok: ' + okCount + '/' + files.length
    : okCount === 0 ? 'failed: 0/' + files.length + '（见 files）'
      : 'partial: ' + okCount + '/' + files.length;
  return { status, files };
}

async function main() {
  const ref = process.env.UP_TASK || '';
  if (!ref) return fail('缺少 UP_TASK（任务 idx 或 leafId）');
  const tasks = readTasks();
  const task = pickTask(tasks, ref);
  if (!task) return fail(`tasks.json 里找不到任务 ${ref}：先跑 \`unipus scan\``);

  let cdp = null;
  let media = Array.isArray(task.media) ? task.media.filter((m) => m && m.url) : [];
  if (!media.length) {
    if (!task.url) return fail(`任务 ${ref} 既没有 media 也没有 url：重跑 \`unipus scan\` 或 \`unipus open ${ref}\``);
    cdp = await attach({});
    media = await scrapeMedia(cdp, task);
    task.media = media;
    if (tasks && Array.isArray(tasks.tasks)) writeTasks(tasks);
    log('scraped', { count: media.length });
  }
  if (!media.length) return emit({ downloaded: [], transcribe: 'skipped: 任务页里没有 video/audio 元素', task: { idx: task.idx, leafId: task.leafId } });

  await mkdir(statePath('media'), { recursive: true });
  const base = String(task.leafId || task.idx || 'task').replace(/[^\w.-]/g, '_');

  const downloaded = [];
  const failed = [];
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const ext = extFrom(m.url, m.kind);
    const dest = statePath('media/' + base + '_' + i + '.' + ext);
    try {
      const size = await download(m.url, dest);
      downloaded.push({ kind: m.kind, path: dest, size });
      log('dl', { i, kind: m.kind, size, path: dest });
    } catch (e) {
      failed.push({ kind: m.kind, url: m.url, error: shortErr(e) });
      log('dl-fail', { i, kind: m.kind, error: shortErr(e) });
    }
  }

  const wantTr = /^(1|true|yes|on)$/i.test(String(process.env.UP_TRANSCRIBE || ''));
  let transcribe = 'skipped: UP_TRANSCRIBE 未设为 1';
  let transcriptions = [];
  if (wantTr) {
    const audios = downloaded
      .map((d, i) => ({ ...d, index: i }))
      .filter((d) => d.kind === 'audio');
    const r = await transcribeAll(audios, base);
    transcribe = r.status;
    transcriptions = r.files;
    log('transcribe', { status: r.status, files: r.files.length });
  }

  emit({
    downloaded,
    transcribe,
    transcriptions,
    failed,
    task: { idx: task.idx, leafId: task.leafId, base: task.base },
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
