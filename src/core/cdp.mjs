// 零依赖 CDP 客户端（Node >= 22：全局 fetch + WebSocket）
// U校园自动化 · 基础层：连接 / 求值 / 帧树 / 点击 / 截图
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 由环境变量 UP_MATCH（正则）决定挑哪个标签页；未设则取第一个 page target */
export function pageMatcher() {
  const re = process.env.UP_MATCH ? new RegExp(process.env.UP_MATCH) : null;
  return re ? (t) => re.test(t.url) : undefined;
}

export async function httpJson(port, path = '/json/list') {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.json();
}

export async function waitForBrowser(port, timeoutMs = 40000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      return await httpJson(port, '/json/version');
    } catch (e) {
      last = e;
      await sleep(300);
    }
  }
  throw new Error(`CDP :${port} 未就绪 (${last && last.message})`);
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._handlers = new Map();
    this.contexts = new Map(); // contextId -> {frameId, origin, name, isDefault}
    this.targetInfo = null;
  }

  static async connect(wsUrl, { timeoutMs = 20000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('ws 连接超时 ' + wsUrl)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(to); res(); });
      ws.addEventListener('error', () => { clearTimeout(to); rej(new Error('ws 连接失败 ' + wsUrl)); });
    });
    const c = new CDP(ws);
    c._wire();
    return c;
  }

  /** 按 URL 片段挑选 page target；选中优先级：显式 match > 环境变量 UP_MATCH > 第一个 page target */
  static async attach(port, { match, type = 'page' } = {}) {
    const list = await httpJson(port, '/json/list');
    const cands = list.filter((t) => t.type === type);
    const m = match || pageMatcher();
    const test = typeof m === 'function' ? m : (m ? (c) => m.test(c.url) : null);
    const t = test ? cands.find(test) : cands[0];
    if (!t) throw new Error(`无匹配的 ${type} target；现有: ` + JSON.stringify(cands.map((c) => c.url)));
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    cdp.targetInfo = t;
    return cdp;
  }

  _wire() {
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(`[CDP ${msg.error.code}] ${msg.error.message}`)) : resolve(msg.result);
        return;
      }
      const m = msg.method;
      if (!m) return;
      if (m === 'Runtime.executionContextCreated') {
        const c = msg.params.context;
        this.contexts.set(c.id, {
          frameId: c.auxData && c.auxData.frameId,
          origin: c.origin,
          name: c.name,
          isDefault: !!(c.auxData && c.auxData.isDefault),
        });
      } else if (m === 'Runtime.executionContextDestroyed') {
        this.contexts.delete(msg.params.executionContextId);
      } else if (m === 'Runtime.executionContextsCleared') {
        this.contexts.clear();
      }
      for (const h of this._handlers.get(m) || []) h(msg.params || {}, msg.sessionId);
    });
  }

  on(method, fn) {
    const a = this._handlers.get(method) || [];
    a.push(fn);
    this._handlers.set(method, a);
    return () => this.off(method, fn);
  }

  off(method, fn) {
    const a = (this._handlers.get(method) || []).filter((x) => x !== fn);
    this._handlers.set(method, a);
  }

  send(method, params = {}, { sessionId, timeoutMs = 30000 } = {}) {
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        if (this._pending.delete(id)) reject(new Error(`CDP 超时 ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async enableDomains() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    return this;
  }

  /** 在指定 frame 的默认执行上下文里求值（不传 frameId = 顶层文档） */
  async eval(expression, { frameId, awaitPromise = true, returnByValue = true } = {}) {
    let contextId;
    if (frameId) {
      for (const [id, c] of this.contexts) {
        if (c.frameId === frameId && c.isDefault) { contextId = id; break; }
      }
      if (!contextId) throw new Error('未找到 frame 的执行上下文: ' + frameId);
    }
    const r = await this.send('Runtime.evaluate', {
      expression, contextId, returnByValue, awaitPromise, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || '';
      throw new Error(`页面求值异常: ${d.text || ''} ${desc}`.trim());
    }
    return returnByValue ? r.result.value : r.result;
  }

  async frameTree() {
    const { frameTree } = await this.send('Page.getFrameTree', {}, { timeoutMs: 60000 });
    const flat = [];
    (function walk(n, depth) {
      flat.push({
        id: n.frame.id, url: n.frame.url, name: n.frame.name || '',
        parentId: n.frame.parentId || null, depth,
      });
      (n.childFrames || []).forEach((c) => walk(c, depth + 1));
    })(frameTree, 0);
    return flat;
  }

  async bringToFront() {
    try { await this.send('Page.bringToFront', {}, { timeoutMs: 5000 }); } catch { /* 忽略 */ }
  }

  async screenshot(path, { fullPage = false, retry = 2 } = {}) {
    await this.bringToFront(); // 后台/遮挡标签页截图会挂
    const params = { format: 'png', captureBeyondViewport: !!fullPage };
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(cs.height), scale: 1 };
    }
    let last;
    for (let i = 0; i <= retry; i++) {
      try {
        const { data } = await this.send('Page.captureScreenshot', params, { timeoutMs: 20000 });
        const fs = await import('node:fs/promises');
        await fs.writeFile(path, Buffer.from(data, 'base64'));
        return path;
      } catch (e) { last = e; await sleep(800); }
    }
    throw last;
  }

  async goto(url, { waitMs = 3000, frameId } = {}) {
    await this.send('Page.navigate', { url, frameId });
    await sleep(waitMs);
  }

  /** 真实鼠标点击（受信任事件）；x/y 为 CSS 像素视口坐标 */
  async click(x, y, { button = 'left' } = {}) {
    const base = { x: Math.round(x), y: Math.round(y), button, clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(40);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  /** 鼠标移动（喂给反挂机检测：证明"有人在操作"） */
  async move(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}
