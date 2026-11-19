// 右侧浮窗（跳转历轮对话）冒烟测试：mock NotebookLM 的 DOM 结构，
// 验证宽窗口默认常开 / 搜索 / 跳转定位 / 懒加载拉全 / 窄窗口自动收起与恢复 / Esc 关闭，并回归输入框加高。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let RAW = readFileSync(join(HERE, '..', 'notebooklm-taller-input.user.js'), 'utf8');
// 仅测试用：closed shadow root 页面脚本进不去，改成 open 才能断言浮窗内部
RAW = RAW.replace("attachShadow({ mode: 'closed' })", "attachShadow({ mode: 'open' })");
if (RAW.includes("mode: 'closed'")) throw new Error('shadow root 测试补丁未生效');
const PAGE = 'file:///' + join(HERE, 'nblm-mock.html').replace(/\\/g, '/');

// 2.4.1 起窄于 1000px 自动收起：宽 / 窄两档视口来回切
const WIDE = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const NARROW = { width: 900, height: 800, deviceScaleFactor: 1, mobile: false };

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + detail}`);
  if (!ok) fails++;
}

const page = await launch();
try {
  const sr = expr => page.eval(`const sr = document.getElementById('nblm-prompt-host').shadowRoot;
${expr}`);
  const wait = ms => page.eval(`await new Promise(r => setTimeout(r, ${ms})); return 1;`);
  const vp = size => page.send('Emulation.setDeviceMetricsOverride', size).then(() => wait(300));

  await page.goto(PAGE);
  await vp(WIDE);
  await page.eval(`
    window.__gmStore = {};
    window.GM_getValue = (k, d) => Object.prototype.hasOwnProperty.call(window.__gmStore, k) ? window.__gmStore[k] : d;
    window.GM_setValue = (k, v) => { window.__gmStore[k] = v; };
    window.unsafeWindow = window;
    return 1;
  `);
  await page.eval(`${RAW}; return 1;`);
  await wait(600);

  // 1) 宽窗口：浮窗默认常开，无需点竖条
  check('宽窗口浮窗默认常开（竖条隐藏）',
    await sr(`return innerWidth >= 1000 && !sr.querySelector('.jpanel').hidden && sr.querySelector('.jtab').hidden;`),
    `innerWidth=${await page.eval('return innerWidth;')}`);
  check('列出 6 轮',
    await sr(`return sr.querySelectorAll('.jrow').length === 6 && sr.querySelector('.jcount').textContent === '6';`));
  check('标题=提问首行，预览=提问其余行',
    await sr(`const r = sr.querySelectorAll('.jrow')[0];
      return r.querySelector('.jtitle').textContent.startsWith('第1问') && r.querySelector('.jprev').textContent.includes('第二行预览文字 0');`));

  // 2) 搜索过滤
  await sr(`const s = sr.querySelector('.jsearch'); s.value = '第3问'; s.dispatchEvent(new Event('input')); return 1;`);
  check('搜索后只剩 1 条', await sr(`return [...sr.querySelectorAll('.jrow')].filter(r => !r.hidden).length === 1;`));
  await sr(`const s = sr.querySelector('.jsearch'); s.value = '不存在的关键词'; s.dispatchEvent(new Event('input')); return 1;`);
  check('无匹配时显示空态',
    await sr(`return !sr.querySelector('.jempty').hidden && sr.querySelector('.jempty').textContent === '没有匹配的对话';`));
  await sr(`const s = sr.querySelector('.jsearch'); s.value = ''; s.dispatchEvent(new Event('input')); return 1;`);

  // 3) 点条目：浮窗收起 + 平滑滚动定位 + 闪烁高亮
  await page.eval(`const b = document.getElementById('chatbox'); b.scrollTop = b.scrollHeight; return 1;`);
  await sr(`sr.querySelectorAll('.jrow')[1].click(); return 1;`);
  check('点条目后浮窗收起', await sr(`return sr.querySelector('.jpanel').hidden;`));
  await wait(900);
  const jumped = await page.eval(`
    const box = document.getElementById('chatbox');
    const pair = document.querySelectorAll('.chat-message-pair')[1];
    return { top: pair.getBoundingClientRect().top - box.getBoundingClientRect().top,
      flash: pair.classList.contains('nblm-jump-flash') };
  `);
  check('滚动定位到目标轮（顶部对齐）', Math.abs(jumped.top + 8) < 60, `top=${jumped.top}`);
  check('目标轮带闪烁高亮', jumped.flash);

  // 4) 加载更早：模拟懒加载两批（各 3 轮），拉全后弹回原位
  await sr(`sr.querySelector('.jtab').click(); return 1;`);
  await page.eval(`window.__lazyOn = true; return 1;`);
  await sr(`sr.querySelector('.jmini').click(); return 1;`);
  let n = 0;
  for (let i = 0; i < 40; i++) {
    n = await page.eval(`return document.querySelectorAll('.chat-message-pair').length;`);
    if (n === 12) break;
    await wait(300);
  }
  await wait(1800); // 等加载循环收尾、弹回原位、toast
  const loaded = await page.eval(`
    const box = document.getElementById('chatbox');
    const pair = document.querySelectorAll('.chat-message-pair')[7]; // 原来的第 2 问
    return { loads: window.__loads, rows: document.querySelectorAll('.chat-message-pair').length,
      top: pair.getBoundingClientRect().top - box.getBoundingClientRect().top };
  `);
  const loadToast = await sr(`return sr.querySelector('.toast').textContent;`);
  check('懒加载拉全到 12 轮', loaded.rows === 12 && loaded.loads === 2, `rows=${loaded.rows} loads=${loaded.loads}`);
  check('提示已加载 6 轮', loadToast.includes('6'), `toast=${loadToast}`);
  check('拉全后弹回原位（原第 2 问仍在顶部）', Math.abs(loaded.top + 8) < 60, `top=${loaded.top}`);
  check('浮窗列表补全到 12 条',
    await sr(`return sr.querySelectorAll('.jrow').length === 12 && sr.querySelector('.jcount').textContent === '12';`));

  // 5) 窄窗口自动收起；竖条仍在，可手动展开，且不会被同侧 resize 收回
  await vp(NARROW);
  check('窗口变窄自动收起',
    await sr(`return innerWidth < 1000 && sr.querySelector('.jpanel').hidden && !sr.querySelector('.jtab').hidden;`),
    `innerWidth=${await page.eval('return innerWidth;')}`);
  check('收起时 toast 提示', (await sr(`return sr.querySelector('.toast').textContent;`)).includes('窗口变窄'));
  await sr(`sr.querySelector('.jtab').click(); return 1;`);
  check('窄窗口仍可用竖条手动展开', await sr(`return !sr.querySelector('.jpanel').hidden;`));
  await page.eval(`window.dispatchEvent(new Event('resize')); return 1;`);
  await wait(200);
  check('窄窗口手动展开不被同侧 resize 收回', await sr(`return !sr.querySelector('.jpanel').hidden;`));
  await vp(WIDE);
  check('窗口恢复变宽后浮窗仍在', await sr(`return !sr.querySelector('.jpanel').hidden;`));

  // 6) 手动关闭后，宽度来回变化不再自动打开
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 1;`);
  check('Esc 关闭浮窗', await sr(`return sr.querySelector('.jpanel').hidden;`));
  await vp(NARROW); await vp(WIDE);
  check('手动关闭后宽度变化不自动打开', await sr(`return sr.querySelector('.jpanel').hidden;`));

  // 7) 回归：输入框加高仍然工作
  const h = await page.eval(`
    const ta = document.getElementById('ta');
    ta.value = 'x'.repeat(600);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    return parseFloat(ta.style.height) || 0;
  `);
  check('输入框加高仍然工作', h > 100, `height=${h}`);

  // 8) 诊断探针带上浮窗状态
  check('probe 报告浮窗状态与版本',
    await page.eval(`const p = window.__nblmProbe(); return p.jump.rounds === 12 && p.jump.narrow === false && p.version === '2.4.1';`));
} finally {
  await page.close();
}
console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
