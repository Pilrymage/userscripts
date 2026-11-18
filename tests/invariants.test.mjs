// 不变量测试（浏览器无关）：行首↓落在下一行、行尾↑落在上一行、上下可逆
// 与 Firefox 自测页用的是同一组断言，这样两个浏览器可以直接对比。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, '..', 'readline-keys.user.js'), 'utf8');
const SCRIPT = RAW.replace(/\}\)\(\);\s*$/, '\n  window.__dbg = { visualLineMove, buildModel, modelFor };\n})();\n');
const PAGE = 'file:///' + join(HERE, 'page.html').replace(/\\/g, '/');

const CASES = [
  { id: 't1', name: '等宽 3.5 行', text: 'the quick brown fox jumps over the lazy dog and keeps running far away before it stops at the fence' },
  { id: 't2', name: '中英混排（含硬换行）', text: '第一行比较短\n这是一段中文和 English words 混排的测试文本，用来检查折行位置是否准确，再来一些标点。' },
  { id: 't4', name: '多段 + 空行', text: 'first line\nsecond line is a longer one that wraps\n\nfourth after blank\nfifth unicorn line that also wraps around the narrow box edge' },
  { id: 't3', name: '窄框超长单词', text: 'Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis tail' },
];

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + detail}`);
  if (!ok) fails++;
}

const page = await launch();
try {
  await page.goto(PAGE);
  await page.eval(`${SCRIPT}; return 1;`);

  for (const c of CASES) {
    const r = await page.eval(`
      const el = document.getElementById(${JSON.stringify(c.id)});
      el.value = ${JSON.stringify(c.text)};
      el.focus();
      el.scrollTop = 0;
      const m = window.__dbg.modelFor(el, getComputedStyle(el));
      const rows = m.rows;
      const down = [], up = [];
      for (let r = 0; r < rows.length - 1; r++) {
        const first = rows[r].items[0];
        const next = window.__dbg.visualLineMove(el, first.p, 1, { x: first.x });
        down.push({ from: first.p, to: next, ok: rows[r + 1].items.some(i => i.p === next), candidates: rows[r + 1].items.map(i => i.p) });
      }
      for (let r = 1; r < rows.length; r++) {
        const last = rows[r].items[rows[r].items.length - 1];
        const prev = window.__dbg.visualLineMove(el, last.p, -1, { x: last.x });
        // 上一行的「行尾」在原生里是下一行的第一个 offset（也就是 from），
        // 往回退一格就是上一行真正的最后一个字符，两者都算正确。
        const prevPs = rows[r - 1].items.map(i => i.p);
        const ok = prevPs.includes(prev) || prev === last.p - 1;
        up.push({ from: last.p, to: prev, ok, candidates: prevPs });
      }
      // 可逆性：从起点 ↓ 到末行，再 ↑ 回到起点，offset 必须完全相同
      const mid = Math.min(el.value.length, Math.floor(el.value.length / 2));
      const at = m.at.has(mid) ? mid : rows[0].items[0].p;
      const x0 = m.at.get(at).x;
      let p = at, steps = 0;
      while (steps < 200) { const n = window.__dbg.visualLineMove(el, p, 1, { x: x0 }); if (n === p) break; p = n; steps++; }
      const downSteps = steps;
      let back = 0;
      while (back < 200 && p !== at) { const n = window.__dbg.visualLineMove(el, p, -1, { x: x0 }); if (n === p) break; p = n; back++; }
      return { rowCount: rows.length, down, up, downSteps, back, start: at, end: p, returned: p === at };
    `);

    console.log(`\n${c.name} (${r.rowCount} 行)`);
    check(`  ${c.name}：行首 ↓ 落在下一行内`, r.down.every(d => d.ok),
      r.down.filter(d => !d.ok).map(d => `from=${d.from} to=${d.to} 下一行=${JSON.stringify(d.candidates)}`).join('\n      '));
    check(`  ${c.name}：行尾 ↑ 落在上一行内`, r.up.every(d => d.ok),
      r.up.filter(d => !d.ok).map(d => `from=${d.from} to=${d.to} 上一行=${JSON.stringify(d.candidates)}`).join('\n      '));
    check(`  ${c.name}：可逆（↓×${r.downSteps} 后 ↑×${r.back} 回到起点）`, r.returned,
      `起 ${r.start} 终 ${r.end}`);
  }
} finally {
  await page.close();
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
