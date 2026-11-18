// 生成 Firefox 自测页：与 tests/invariants.test.mjs 用同一组不变量，
// 让 Chromium 和 Firefox 的结果可以直接对比。
// 用法：node tests/gen-ff-selftest.mjs；然后用 headless Firefox 截图查看。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(HERE, '..', 'readline-keys.user.js'), 'utf8');
const SCRIPT = RAW.replace(/\}\)\(\);\s*$/, `
  window.__dbg = { visualLineMove, buildModel, modelFor };
})();
`);

const CASES = [
  { id: 't1', name: '等宽 3.5 行', text: 'the quick brown fox jumps over the lazy dog and keeps running far away before it stops at the fence' },
  { id: 't2', name: '中英混排（含硬换行）', text: '第一行比较短\n这是一段中文和 English words 混排的测试文本，用来检查折行位置是否准确，再来一些标点。' },
  { id: 't4', name: '多段 + 空行', text: 'first line\nsecond line is a longer one that wraps\n\nfourth after blank\nfifth unicorn line that also wraps around the narrow box edge' },
  { id: 't3', name: '窄框超长单词', text: 'Supercalifragilisticexpialidocious antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis tail' },
];

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Firefox 自测</title>
<style>
body { font: 13px/1.5 Consolas, monospace; margin: 8px; background: #fff; color: #000; }
textarea { font: 14px/20px Consolas, monospace; width: 260px; height: 120px; }
textarea.wide { font: 16px/24px "Microsoft YaHei", sans-serif; width: 320px; height: 160px; }
textarea.narrow { width: 120px; }
.pass { color: #060; } .fail { color: #b00; font-weight: bold; }
h3 { margin: 8px 0 2px; font-size: 13px; }
</style></head><body>
<div id="report">running…</div>
<div style="position:absolute;left:-9999px;top:0;">
  <textarea id="t1" class="wide"></textarea>
  <textarea id="t2" class="wide"></textarea>
  <textarea id="t3" class="narrow"></textarea>
  <textarea id="t4" class="wide"></textarea>
</div>
<script>
${SCRIPT}
</script>
<script>
(function () {
  const lines = [];
  const log = (cls, msg) => lines.push('<div class="' + cls + '">' + msg + '</div>');
  const ok = (cond, msg) => log(cond ? 'pass' : 'fail', (cond ? 'PASS  ' : 'FAIL  ') + msg);

  log('', 'userAgent: ' + navigator.userAgent);
  ok(typeof document.caretPositionFromPoint === 'function', 'caretPositionFromPoint 可用');
  ok(typeof Intl.Segmenter === 'function', 'Intl.Segmenter 可用');

  const CASES = ${JSON.stringify(CASES)};

  for (const c of CASES) {
    const el = document.getElementById(c.id);
    el.value = c.text;
    el.focus();
    el.scrollTop = 0;

    const m = window.__dbg.modelFor(el, getComputedStyle(el));
    const rows = m.rows;
    log('', '<h3>' + c.name + '（' + rows.length + ' 视觉行）</h3>');

    // 行首 ↓ 必须落在下一行内
    let downBad = [];
    for (let r = 0; r < rows.length - 1; r++) {
      const first = rows[r].items[0];
      const next = window.__dbg.visualLineMove(el, first.p, 1, { x: first.x });
      if (!rows[r + 1].items.some(i => i.p === next)) downBad.push(first.p + '→' + next);
    }
    ok(downBad.length === 0, '行首 ↓ 落在下一行内' + (downBad.length ? ' 失败: ' + downBad.join(',') : ''));

    // 行尾 ↑ 必须落在上一行内（或上一行真正的最后一个字符）
    let upBad = [];
    for (let r = 1; r < rows.length; r++) {
      const last = rows[r].items[rows[r].items.length - 1];
      const prev = window.__dbg.visualLineMove(el, last.p, -1, { x: last.x });
      const prevPs = rows[r - 1].items.map(i => i.p);
      if (!prevPs.includes(prev) && prev !== last.p - 1) upBad.push(last.p + '→' + prev);
    }
    ok(upBad.length === 0, '行尾 ↑ 落在上一行内' + (upBad.length ? ' 失败: ' + upBad.join(',') : ''));

    // 可逆：从中间 ↓ 到底再 ↑ 回起点
    const mid = Math.min(el.value.length, Math.floor(el.value.length / 2));
    const start = m.at.has(mid) ? mid : rows[0].items[0].p;
    const x0 = m.at.get(start).x;
    let p = start, steps = 0;
    while (steps < 200) { const n = window.__dbg.visualLineMove(el, p, 1, { x: x0 }); if (n === p) break; p = n; steps++; }
    let back = 0;
    while (back < 200 && p !== start) { const n = window.__dbg.visualLineMove(el, p, -1, { x: x0 }); if (n === p) break; p = n; back++; }
    ok(p === start, '可逆：↓×' + steps + ' 再 ↑×' + back + ' 回到起点');
  }

  document.getElementById('report').innerHTML = lines.join('\\n') +
    '<div style="margin-top:10px;font-weight:bold">DONE</div>';
})();
</script>
</body></html>
`;

writeFileSync(join(HERE, 'firefox-selftest.html'), html, 'utf8');
console.log('wrote firefox-selftest.html');
