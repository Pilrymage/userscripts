// 对照测试：脚本处理 Ctrl+P/N 的落点 vs 浏览器原生 ↑/↓ 的落点
// 用法：node tests/visual-line.test.mjs [--verbose] [--strict]
//
// 说明：原生在混合宽度字体里用的是「设备像素对齐后的整数 x」，
// 与 CSS 浮点坐标有零点几像素的差异，因此少数边界位置会差 1 个字符。
// 默认要求整体一致率 ≥ 95% 且等宽用例 100%；--strict 要求全部逐点相等。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, '..', 'readline-keys.user.js'), 'utf8');
// 测试时把内部函数挂到 window.__dbg，方便定位差异；脚本本身不含调试代码。
const SCRIPT = RAW.replace(/\}\)\(\);\s*$/, `
  window.__dbg = { visualLineMove, buildModel, modelFor, resetGoal };
})();
`);
const PAGE = 'file:///' + join(HERE, 'page.html').replace(/\\/g, '/');
const VERBOSE = process.argv.includes('--verbose');
const STRICT = process.argv.includes('--strict');

const CASES = [
  {
    id: 't1', name: '等宽 / 3.5 视觉行（空格折行）',
    text: 'the quick brown fox jumps over the lazy dog and keeps running far away before it stops at the fence',
    tolerance: 0,
  },
  {
    id: 't2', name: '中英混排 / 比例字体（4 视觉行，含硬换行）',
    text: '第一行比较短\n这是一段中文和 English words 混排的测试文本，用来检查折行位置是否准确，再来一些标点。',
    tolerance: 0,
  },
  {
    id: 't4', name: '多段 + 空行 + 长短交错',
    text: 'first line\nsecond line is a longer one that wraps\n\nfourth after blank\nfifth unicorn line that also wraps around the narrow box edge',
    tolerance: 0.05,
  },
  {
    id: 't3', name: '窄框 / 超长单词 overflow-wrap',
    text: 'Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis tail',
    tolerance: 0.12,
  },
  { id: 't2', name: '空内容', text: '', tolerance: 0 },
  { id: 't2', name: '只有换行', text: '\n\n\n', tolerance: 0 },
  { id: 't2', name: '单行不折行', text: 'just one short line', tolerance: 0 },
  { id: 't1', name: '等宽 / 多行 + 空格', text: '  aaa  bbb  \n\n   ccc   ddd   \n     short    ', tolerance: 0 },
];

let fails = 0;
const failures = [];
const rows = [];

function check(name, ok, detail) {
  if (!ok) { fails++; failures.push(`${name}\n${detail}`); }
  if (VERBOSE || !ok) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

async function nativeMove(page, id, p, dir) {
  await page.eval(`const el=document.getElementById(${JSON.stringify(id)}); el.setSelectionRange(${p},${p}); return 1;`);
  if (dir < 0) await page.up(); else await page.down();
  return page.eval(`return document.getElementById(${JSON.stringify(id)}).selectionStart;`);
}

async function scriptMove(page, id, p, dir) {
  await page.eval(`
    const el=document.getElementById(${JSON.stringify(id)});
    el.focus();
    el.setSelectionRange(${p},${p});
    // 程序化设选区不会触发 keydown/beforeinput，等价于用户用鼠标把光标放到新位置，
    // 这里同步清掉目标列，模拟一次全新的上下移动。
    window.__dbg.resetGoal();
    return 1;
  `);
  if (dir < 0) await page.ctrlP(); else await page.ctrlN();
  return page.eval(`return document.getElementById(${JSON.stringify(id)}).selectionStart;`);
}

const page = await launch();
try {
  await page.goto(PAGE);
  await page.eval(`${SCRIPT}; return 1;`);

  for (const c of CASES) {
    await page.eval(`
      const el = document.getElementById(${JSON.stringify(c.id)});
      el.value = ${JSON.stringify(c.text)};
      el.focus();
      el.scrollTop = 0;
      return el.value;
    `);

    let total = 0, same = 0;
    const diffs = [];
    for (let p = 0; p <= c.text.length; p++) {
      for (const [dir, label] of [[-1, '↑'], [1, '↓']]) {
        const nat = await nativeMove(page, c.id, p, dir);
        await page.eval(`document.getElementById(${JSON.stringify(c.id)}).scrollTop=0; return 1;`);
        const got = await scriptMove(page, c.id, p, dir);
        total++;
        if (nat === got) { same++; continue; }
        diffs.push({ p, dir: label, nat, got, delta: got - nat });
      }
    }
    const rate = same / total;
    rows.push({ name: c.name, total, same, rate, diffs: diffs.length });

    const need = STRICT ? 1 : 1 - c.tolerance;
    check(`${c.name}：一致率 ${(rate * 100).toFixed(1)}%（${same}/${total}，要求 ≥ ${(need * 100).toFixed(0)}%）`,
      rate >= need - 1e-9,
      diffs.slice(0, 10).map((d) => `  p=${d.p} ${d.dir} 原生=${d.nat} 脚本=${d.got} (Δ${d.delta})`).join('\n'));

    // 所有偏差都必须是 ±1 个字符，不能出现跨行错位
    const bad = diffs.filter((d) => Math.abs(d.delta) > 1);
    check(`${c.name}：偏差都在 ±1 字符内`, bad.length === 0,
      bad.slice(0, 10).map((d) => `  p=${d.p} ${d.dir} 原生=${d.nat} 脚本=${d.got} (Δ${d.delta})`).join('\n'));
  }
} finally {
  await page.close();
}

console.log('\n用例汇总:');
for (const r of rows) {
  console.log(`  ${(r.rate * 100).toFixed(1).padStart(5)}%  ${r.same}/${r.total}  ${r.name}`);
}

if (fails) {
  console.log(`\n===== ${fails} 项未达标 =====`);
  for (const f of failures.slice(0, 6)) console.log(f + '\n---');
  process.exit(1);
}
console.log('\n全部达标');
