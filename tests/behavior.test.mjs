// 行为测试：连续 P/N 保持列、可逆、边界、与其他按键的交替
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, '..', 'readline-keys.user.js'), 'utf8');
const SCRIPT = RAW.replace(/\}\)\(\);\s*$/, '\n  window.__dbg = { resetGoal, modelFor };\n})();\n');
const PAGE = 'file:///' + join(HERE, 'page.html').replace(/\\/g, '/');

const TEXT = 'short line\nthis is a much longer line that will wrap over several rows for sure\nthird line which is medium length\nend';

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + detail}`);
  if (!ok) fails++;
}

const page = await launch();
try {
  await page.goto(PAGE);
  await page.eval(`${SCRIPT}; return 1;`);
  await page.eval(`
    const el = document.getElementById('t2');
    el.value = ${JSON.stringify(TEXT)};
    el.focus();
    el.scrollTop = 0;
    return 1;
  `);

  const sel = () => page.eval(`return document.getElementById('t2').selectionStart;`);
  const setSel = async (p) => {
    await page.eval(`const el=document.getElementById('t2'); el.setSelectionRange(${p},${p}); window.__dbg.resetGoal(); return 1;`);
  };

  // 1) 从长行中部连续 N 再连续 P，应回到原点（原生 ↑/↓ 的可逆性）
  const start = 30;
  await setSel(start);
  const chain = [await sel()];
  for (let i = 0; i < 3; i++) { await page.ctrlN(); chain.push(await sel()); }
  for (let i = 0; i < 3; i++) { await page.ctrlP(); chain.push(await sel()); }
  check('长行中部：↓↓↑↑ 能回到起点', chain[chain.length - 1] === chain[0],
    `链=${JSON.stringify(chain)}`);

  // 2) 同一串按键与原生 ↑/↓ 完全一致
  await setSel(start);
  const natChain = [await sel()];
  for (let i = 0; i < 6; i++) { await page.down(); natChain.push(await sel()); }
  for (let i = 0; i < 6; i++) { await page.up(); natChain.push(await sel()); }

  await setSel(start);
  const scrChain = [await sel()];
  for (let i = 0; i < 6; i++) { await page.ctrlN(); scrChain.push(await sel()); }
  for (let i = 0; i < 6; i++) { await page.ctrlP(); scrChain.push(await sel()); }
  check('连续 6 次上下：与原生 ↑/↓ 序列完全一致', JSON.stringify(natChain) === JSON.stringify(scrChain),
    `原生=${JSON.stringify(natChain)}\n脚本=${JSON.stringify(scrChain)}`);

  // 3) 短行被截断后，回到长行仍回到原来的列
  await setSel(0);
  const row1Start = TEXT.indexOf('this');
  const deep = row1Start + 40;
  await setSel(deep);
  const xDeep = await page.eval(`
    const el = document.getElementById('t2');
    const m = __dbg.modelFor(el, getComputedStyle(el));
    return m.at.get(${deep}).x;
  `);
  await page.ctrlP();            // 到上一行（短行），会被截断
  const onShort = await sel();
  const xShort = await page.eval(`
    const el = document.getElementById('t2');
    const m = __dbg.modelFor(el, getComputedStyle(el));
    return m.at.get(${onShort}).x;
  `);
  await page.ctrlN();            // 回长行
  const back = await sel();
  check('从长行深处 ↑ 到短行会被截断（x 变小）', xShort < xDeep, `xDeep=${xDeep} xShort=${xShort}`);
  check('再按 ↓ 回到长行深处（保持原列）', back === deep, `期望 ${deep} 实际 ${back}`);

  // 4) 首视觉行按 Ctrl+P 到开头，末视觉行 Ctrl+N 到结尾
  await setSel(0);
  await page.ctrlP();
  check('首行 Ctrl+P 停在 0', (await sel()) === 0);
  await setSel(TEXT.length);
  await page.ctrlN();
  check('末行 Ctrl+N 停在文本末尾', (await sel()) === TEXT.length);

  // 5) 中途用方向键打断后，目标列应重置（不再回到旧列）
  await setSel(deep);
  await page.ctrlP();                          // 目标列 = xDeep
  await page.key('ArrowRight', { code: 'ArrowRight', vk: 39 }); // 打断
  await page.ctrlN();
  const afterBreak = await sel();
  const expected = await (async () => {
    // 用原生做同样的动作作为参照
    await setSel(onShort);
    await page.key('ArrowRight', { code: 'ArrowRight', vk: 39 });
    await page.down();
    return sel();
  })();
  check('方向键打断后，Ctrl+N 以新位置为起点', afterBreak === expected,
    `脚本=${afterBreak} 原生=${expected}`);

  // 6) 单行 input：P/N 等价于行首/行尾
  await page.eval(`
    const input = document.createElement('input');
    input.id = 'single'; input.type = 'text'; input.value = 'abcdefghij';
    document.body.appendChild(input); input.focus(); input.setSelectionRange(4,4);
    return 1;
  `);
  await page.ctrlP();
  const p1 = await page.eval(`return document.getElementById('single').selectionStart;`);
  await page.ctrlN();
  const p2 = await page.eval(`return document.getElementById('single').selectionStart;`);
  check('单行 input：Ctrl+P 到行首', p1 === 0, `实际 ${p1}`);
  check('单行 input：Ctrl+N 到行尾', p2 === 10, `实际 ${p2}`);

  // 7) 内容为空时不报错、不移动
  await page.eval(`const el=document.getElementById('t2'); el.value=''; el.focus(); window.__dbg.resetGoal(); return 1;`);
  await page.ctrlP();
  const e1 = await page.eval(`return document.getElementById('t2').selectionStart;`);
  await page.ctrlN();
  const e2 = await page.eval(`return document.getElementById('t2').selectionStart;`);
  check('空内容：P/N 都停在 0', e1 === 0 && e2 === 0, `P=${e1} N=${e2}`);
} finally {
  await page.close();
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
