// 启动带 CDP 的有头 Edge（独立 profile，不干扰用户日常浏览器）
// 用法: node src/core/launch.mjs [url]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { waitForBrowser } from './cdp.mjs';

const DEFAULT_EDGE_WIN = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEFAULT_EDGE_MAC = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

const EDGE = process.env.UP_EDGE
  || (process.platform === 'win32' ? DEFAULT_EDGE_WIN : process.platform === 'darwin' ? DEFAULT_EDGE_MAC : 'microsoft-edge');
const PORT = Number(process.env.UP_PORT || 9229);
const PROFILE = process.env.UP_PROFILE || join(homedir(), '.unipus-kit', 'edge-profile');
const url = process.argv[2] || 'https://sso.unipus.cn/sso/login';

try {
  const v = await waitForBrowser(PORT, 1200);
  console.log('已存在 CDP 实例，复用:', v.Browser, 'port', PORT);
  process.exit(0);
} catch { /* 未启动，继续 */ }

mkdirSync(PROFILE, { recursive: true });

const args = [
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=msEdgeFirstRunExperience',
  '--disable-sync',
  '--no-service-autorun',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--mute-audio',
  '--start-maximized',
  url,
];

const p = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
p.unref();

const v = await waitForBrowser(PORT, 45000);
console.log('CDP 就绪:', v.Browser, '| port', PORT);
console.log('profile:', PROFILE);
