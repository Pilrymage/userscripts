// 极简 CDP 客户端：启动本地 Chromium（headless），开一个页面，注入脚本、发真实按键。
// 只用 Node 22 自带的 WebSocket，不需要 playwright / puppeteer。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME_PATH ||
  'C:/Users/pilrymage/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每次运行都会新建一个几十 MB 的临时 profile。正常路径在 close() 里删，
// 这里再兜一层：脚本崩了 / 被 Ctrl+C / 断言失败时也要清干净，
// 否则反复跑测试会在 TEMP 里堆出一堆 rlk-cdp-* 目录。
const LIVE = new Set();
function cleanupAll() {
  for (const d of LIVE) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
  LIVE.clear();
}
process.on('exit', cleanupAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { cleanupAll(); process.exit(1); });
}
process.on('uncaughtException', (err) => { cleanupAll(); console.error(err); process.exit(1); });
process.on('unhandledRejection', (err) => { cleanupAll(); console.error(err); process.exit(1); });

async function waitFor(pred, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('等待超时：' + pred.name);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

export async function launch() {
  if (!existsSync(CHROME)) throw new Error('找不到 Chromium：' + CHROME);
  const dir = mkdtempSync(join(tmpdir(), 'rlk-cdp-'));
  LIVE.add(dir);                        // 进程异常退出时由下面的钩子兜底清理
  const child = spawn(CHROME, [
    `--user-data-dir=${dir}`,
    '--remote-debugging-port=0',
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--allow-file-access-from-files',
    '--disable-lcd-text',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const portFile = join(dir, 'DevToolsActivePort');
  const port = await waitFor(() => {
    // Chrome 写完端口文件后仍可能短暂持有句柄，EBUSY 时下一轮重试
    try {
      if (!existsSync(portFile)) return 0;
      const line = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      return Number(line) || 0;
    } catch { return 0; }
  });

  const wsUrl = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { return null; }
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new Cdp(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const s = {
    send: (m, p) => cdp.send(m, p, sessionId),

    async goto(url) {
      const loaded = new Promise((resolve) => {
        const onMsg = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.method === 'Page.loadEventFired') {
            ws.removeEventListener('message', onMsg);
            resolve();
          }
        };
        ws.addEventListener('message', onMsg);
      });
      await s.send('Page.navigate', { url });
      await loaded;
      await sleep(80);
    },

    async eval(expr) {
      const r = await s.send('Runtime.evaluate', {
        expression: `(async () => { ${expr} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    },

    // 真实按键（trusted），浏览器默认行为与网页监听都会生效
    async key(key, { code, vk, modifiers = 0 } = {}) {
      const base = {
        modifiers,
        key,
        code: code || key,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      };
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(20);
    },

    async up() { await s.key('ArrowUp', { code: 'ArrowUp', vk: 38 }); },
    async down() { await s.key('ArrowDown', { code: 'ArrowDown', vk: 40 }); },

    // Ctrl+N 是浏览器保留快捷键（新建窗口），CDP 真实按键到不了页面。
    // 用脚本派发同样的 KeyboardEvent，走完全相同的监听器路径。
    async ctrl(code, key) {
      await s.eval(`
        const target = document.activeElement || document.body;
        const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, ctrlKey: true, bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new KeyboardEvent('keydown', init));
        return 1;
      `);
      await sleep(20);
    },
    async ctrlP() { await s.key('p', { code: 'KeyP', vk: 80, modifiers: 2 }); },
    async ctrlN() { await s.ctrl('KeyN', 'n'); },

    async close() {
      try { ws.close(); } catch {}
      if (!child.killed) child.kill();
      // 等 Chrome 真正退出再删，否则 profile 目录会被占用残留
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
      });
      for (let i = 0; i < 5; i++) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { await sleep(150); }
      }
      LIVE.delete(dir);
    },
  };

  return s;
}
