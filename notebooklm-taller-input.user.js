// ==UserScript==
// @name         NotebookLM 输入框加高
// @namespace    https://github.com/Pilrymage/userscripts
// @version      2.3.0
// @description  Firefox/Chromium 通用：输入框自动加高（40/60/80vh）、常用提示词菜单、对话区加宽、一键收起侧栏、复制时去掉引用角标、回答折叠（可被 Ctrl+F 搜到）。
// @author       Pilrymage
// @license      MIT
// @homepageURL  https://github.com/Pilrymage/userscripts
// @downloadURL  https://raw.githubusercontent.com/Pilrymage/userscripts/main/notebooklm-taller-input.user.js
// @updateURL    https://raw.githubusercontent.com/Pilrymage/userscripts/main/notebooklm-taller-input.user.js
// @match        *://notebook.google.com/*
// @match        *://notebooklm.google.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  const VERSION = '2.3.0';
  const TA = 'textarea.query-box-input'; // 不匹配左侧来源搜索框
  const STYLE_ID = 'nblm-taller-input-style';
  const HEIGHT_STEPS = [40, 60, 80];
  // v2 使用新开关键，避免沿用排查 v1 时保存的关闭状态；旧 force 开关不再需要。
  const K_ENABLED = 'nblm-taller-input.v2-enabled';
  const K_STEP = 'nblm-taller-input.step';
  const K_PROMPTS = 'nblm-taller-input.prompts-enabled';
  const K_WIDE = 'nblm-taller-input.wide-step';
  const K_CLEAN = 'nblm-taller-input.clean-copy';
  const rawStep = Number(GM_getValue(K_STEP, 0));
  const state = { enabled: GM_getValue(K_ENABLED, true) !== false,
    step: Number.isInteger(rawStep) && rawStep >= 0 && rawStep < HEIGHT_STEPS.length ? rawStep : 0 };
  const bound = new Map();
  let styleEl, scanPending = false;

  // ---------- 提示词 ----------
  // 想加或改提示词，直接编辑 PROMPTS。text 里含 PH 时，插入后会自动选中它，直接打字即可替换。
  const PH = '【在此填写章节，如：第 3 章 / 4.2 节】';
  const PROMPTS = [
    { label: '按论文结构总结', text: `请严格按照这篇论文原文的章节顺序进行总结，目的是帮助我理解作者的研究逻辑。

要求：
1. 用论文原有的章节编号和标题作小标题，逐章逐节对应，不合并、不调换顺序、不遗漏。
2. 每一节先用一两句话说明它在全文中的作用（提出问题 / 交代背景 / 提出方法 / 实验验证 / 讨论等），再概括主要内容。
3. 说明节与节之间如何衔接：上一节留下了什么问题，这一节怎样回应。
4. 最后用一段话串起全文的研究逻辑链：研究问题 → 方法 → 证据 → 结论，并列出作者自己承认的局限。` },
    { label: '详解某章 / 某节并举例', text: `请详细讲解这篇论文的${PH}。

要求：
1. 先说明这一部分在全文中的位置和作用，以及它要解决什么问题。
2. 按原文段落顺序展开，完整解释其中的概念、公式、方法步骤或论证过程，不要只给概括。
3. 每个关键概念或步骤都配一个具体例子：优先用论文里的例子、数据或实验；论文没有的，再自己构造一个简单例子，并注明“非原文”。
4. 最后说明这一部分的结论在后文哪里被用到。` },
  ];

  // ---------- 加宽 / 侧栏 / 干净复制 ----------
  const WIDE_STEPS = [{ label: '全宽', value: '100%' }, { label: '1100px', value: '1100px' }, { label: '原始', value: null }];
  const rawWide = Number(GM_getValue(K_WIDE, 0));
  let wideStep = Number.isInteger(rawWide) && rawWide >= 0 && rawWide < WIDE_STEPS.length ? rawWide : 0;
  let promptsOn = GM_getValue(K_PROMPTS, true) !== false;
  let cleanOn = GM_getValue(K_CLEAN, true) !== false;
  const PANELS = [
    { section: 'section.source-panel', btn: 'button.toggle-source-panel-button' },
    { section: 'section.studio-panel', btn: 'button.toggle-studio-panel-button' },
  ];
  const CITE_SEL = '.citation-marker, button.citation-marker, [panelclass*="citation"]';
  const BRACKET_G = /\[\s*\d+(?:[\s,，、–—-]+\d+)*\s*\]/g;
  const BRACKET = new RegExp(BRACKET_G.source); // 无 g 标志，test() 不受 lastIndex 影响

  // ---------- 回答折叠（标记“已理解”） ----------
  // 选择器参考开源 NotebookLM Chat Exporter（2026-05 仍在维护）。
  const ANSWER = '.to-user-container';
  const ANSWER_BODY = '.message-text-content';
  const K_FOLD_ON = 'nblm-taller-input.fold-enabled';
  const K_FOLDS = 'nblm-taller-input.folds'; // { 笔记本ID: { 回答指纹: 折叠时间 } }
  let foldsOn = GM_getValue(K_FOLD_ON, true) !== false;
  const folds = (() => { const v = GM_getValue(K_FOLDS, {}); return v && typeof v === 'object' ? v : {}; })();
  const foldChecked = new WeakSet();
  let answersPending = false;

  const UI_CSS = `
:host { --bg: #fff; --fg: #1f1f1f; --bd: #c4c7c5; --hover: #e9eef6; }
@media (prefers-color-scheme: dark) { :host { --bg: #2b2c2f; --fg: #e3e3e3; --bd: #5f6368; --hover: #3c4043; } }
.bar { position: fixed; display: flex; gap: 6px; }
.btn, .item { font: 13px/1.4 system-ui, sans-serif; cursor: pointer; color: var(--fg); }
.btn { padding: 3px 10px; border-radius: 999px; border: 1px solid var(--bd); white-space: nowrap;
  background: var(--bg); box-shadow: 0 1px 3px rgba(0,0,0,.15); opacity: .85; }
.btn:hover { opacity: 1; }
.btn[hidden], .menu[hidden] { display: none; }
.menu { position: fixed; display: flex; flex-direction: column; min-width: 180px; max-width: 320px; padding: 4px;
  border-radius: 10px; border: 1px solid var(--bd); background: var(--bg); box-shadow: 0 4px 16px rgba(0,0,0,.25); }
.item { text-align: left; padding: 7px 10px; border: 0; border-radius: 6px; background: transparent; }
.item:hover, .item:focus-visible { background: var(--hover); outline: none; }
.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 6px 14px; border-radius: 8px;
  background: var(--fg); color: var(--bg); font: 13px/1.4 system-ui, sans-serif; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: .92; }`;
  let host, bar, sideBtn, promptBtn, menu, toastEl, toastTimer, lastInput = null, placePending = false;
  let curPanel = null, addsPending = false;
  const touched = new WeakSet(); // 用户点过的输入框；没点过就追加到末尾而不是开头
  const widened = new Map();     // 被放宽的元素 → 原内联 max-width
  const pendingAdds = new Set();
  const inputRO = new ResizeObserver(() => queuePlace());
  const panelRO = new ResizeObserver(() => { queueWidenAll(); queuePlace(); });

  // ===== 输入框加高 =====
  function cap() { return Math.max(24, Math.floor(innerHeight * HEIGHT_STEPS[state.step] / 100)); }
  function renderStyle() {
    if (!document.documentElement) return;
    styleEl = document.getElementById(STYLE_ID) || document.createElement('style');
    styleEl.id = STYLE_ID;
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);
    let text = state.enabled ? `
${TA} {
  box-sizing: border-box !important;
  field-sizing: fixed !important;
  min-height: 0 !important; min-block-size: 0 !important;
  max-height: ${HEIGHT_STEPS[state.step]}vh !important;
  max-block-size: ${HEIGHT_STEPS[state.step]}vh !important;
  resize: none !important;
}
form.form:has(${TA}), .message-container:has(${TA}),
.query-box-input-wrapper:has(${TA}), .input-group:has(${TA}) {
  height: auto !important; max-height: none !important;
  max-block-size: none !important;
}` : '';
    if (cleanOn) text += `\n${CITE_SEL} { user-select: none !important; -webkit-user-select: none !important; }`;
    // 折叠只裁剪显示（max-height + overflow），文字仍在页面里，Ctrl+F 能搜到。
    if (foldsOn) text += `
${ANSWER} { position: relative; }
.nblm-fold-btn { position: absolute; top: 2px; right: 2px; z-index: 2; padding: 1px 8px; border-radius: 999px;
  font: 12px/1.4 system-ui, sans-serif; color: inherit; cursor: pointer; opacity: .4;
  border: 1px solid rgba(128,128,128,.45); background: rgba(128,128,128,.12); }
${ANSWER}:hover > .nblm-fold-btn, .nblm-folded > .nblm-fold-btn { opacity: 1; }
.nblm-folded ${ANSWER_BODY} { max-height: 4.5em !important; overflow: hidden !important; cursor: pointer;
  -webkit-mask-image: linear-gradient(#000 30%, transparent); mask-image: linear-gradient(#000 30%, transparent); }`;
    if (styleEl.textContent !== text) styleEl.textContent = text;
  }

  function observe(el, entry) {
    entry.mo.observe(el, { attributes: true, attributeFilter: ['style', 'class', 'rows'] });
  }
  function grow(el) {
    const entry = bound.get(el);
    if (!entry || !state.enabled || !el.isConnected || !el.getClientRects().length) return;
    // 暂停自身 observer：量高时必须清掉旧高度，否则删字后不能缩回。
    // 不依赖 CDK，也不依赖 Firefox ESR 尚不支持的 field-sizing:content。
    entry.mo.disconnect();
    try {
      const cs = getComputedStyle(el);
      const number = x => parseFloat(x) || 0;
      const line = number(cs.lineHeight) || number(cs.fontSize) * 1.5;
      const padding = number(cs.paddingTop) + number(cs.paddingBottom);
      const border = number(cs.borderTopWidth) + number(cs.borderBottomWidth);
      el.style.setProperty('height', '0px', 'important');
      el.style.setProperty('overflow-y', 'hidden', 'important');
      const need = Math.max(el.scrollHeight + border, line * 6 + padding + border);
      const height = Math.min(Math.ceil(need), cap());
      el.style.setProperty('height', height + 'px', 'important');
      el.style.setProperty('overflow-y', need > height ? 'auto' : 'hidden', 'important');
    } finally { observe(el, entry); }
  }
  function schedule(el) {
    const entry = bound.get(el);
    if (!entry || entry.pending) return;
    entry.pending = true;
    queueMicrotask(() => { entry.pending = false; grow(el); });
  }
  function restore(el, entry) {
    entry.mo.disconnect(); entry.ro.disconnect();
    for (const [prop, value, priority] of entry.original) {
      if (value) el.style.setProperty(prop, value, priority);
      else el.style.removeProperty(prop);
    }
  }
  function scan() {
    scanPending = false;
    renderStyle();
    for (const [el, entry] of bound) {
      if (!el.isConnected || !state.enabled) { restore(el, entry); bound.delete(el); }
    }
    if (!state.enabled) return;
    document.querySelectorAll(TA).forEach(el => {
      if (bound.has(el)) return;
      const entry = {
        original: ['height', 'overflow-y'].map(p => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]),
        pending: false, width: -1,
        mo: new MutationObserver(() => schedule(el)),
        ro: new ResizeObserver(records => {
          const width = records[0].contentRect.width;
          if (width !== entry.width) { entry.width = width; schedule(el); }
        })
      };
      bound.set(el, entry); observe(el, entry); entry.ro.observe(el);
      grow(el);
    });
  }
  function queueScan() {
    if (!scanPending) { scanPending = true; queueMicrotask(scan); }
  }

  // ===== 对话区加宽 =====
  // NotebookLM 的对话列没有稳定类名，改为运行时检测：
  // 对话面板里 max-width 是固定像素（≥480px 且窄于面板）的元素，统一放宽。小于 480px 的按钮、标签、气泡不动。
  function chatPanel() {
    const ta = document.querySelector(TA);
    return ta ? ta.closest('section.chat-panel') || ta.closest('section') : null;
  }
  function widenTree(root, panelW) {
    const value = WIDE_STEPS[wideStep].value;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = root; n; n = walker.nextNode()) {
      if (n === host) continue;
      if (widened.has(n)) { n.style.setProperty('max-width', value, 'important'); continue; }
      const mw = getComputedStyle(n).maxWidth;
      if (!mw.endsWith('px')) continue;
      const px = parseFloat(mw);
      if (px < 480 || px >= panelW - 8) continue;
      widened.set(n, [n.style.getPropertyValue('max-width'), n.style.getPropertyPriority('max-width')]);
      n.style.setProperty('max-width', value, 'important');
    }
  }
  function unwidenAll() {
    for (const [n, [value, priority]] of widened) {
      if (value) n.style.setProperty('max-width', value, priority); else n.style.removeProperty('max-width');
    }
    widened.clear();
  }
  let widenTimer = 0;
  function queueWidenAll() { clearTimeout(widenTimer); widenTimer = setTimeout(widenAll, 150); }
  function widenAll() {
    const panel = chatPanel();
    if (panel !== curPanel) { if (curPanel) panelRO.unobserve(curPanel); if (panel) panelRO.observe(panel); curPanel = panel; }
    for (const n of widened.keys()) if (!n.isConnected) widened.delete(n);
    if (!WIDE_STEPS[wideStep].value) { unwidenAll(); return; }
    if (panel) widenTree(panel, panel.clientWidth);
  }
  function queueAdds() {
    if (addsPending) return;
    addsPending = true;
    setTimeout(() => {
      addsPending = false;
      const nodes = [...pendingAdds]; pendingAdds.clear();
      if (!WIDE_STEPS[wideStep].value) return;
      if (!curPanel || !curPanel.isConnected) { queueWidenAll(); return; }
      const w = curPanel.clientWidth;
      for (const n of nodes) if (n.isConnected && curPanel.contains(n)) widenTree(n, w);
    }, 120);
  }

  // ===== 一键收起侧栏 =====
  function sidePanels() {
    return PANELS.map(p => ({ section: document.querySelector(p.section), btn: document.querySelector(p.btn) }))
      .filter(p => p.section && p.btn);
  }
  function anySideOpen(list) { return list.some(p => !p.section.classList.contains('panel-collapsed')); }
  function toggleSides() {
    const list = sidePanels();
    if (!list.length) { toast('没找到侧栏按钮，NotebookLM 可能改版了'); return; }
    const open = list.filter(p => !p.section.classList.contains('panel-collapsed'));
    (open.length ? open : list).forEach(p => p.btn.click()); // 有开着的就全收起，否则全展开
    setTimeout(queuePlace, 400);
  }

  // ===== 浮动工具条（侧栏 + 提示词） =====
  // 只用 createElement/textContent：Google 页面启用了 Trusted Types，innerHTML 会被拦。
  function h(tag, props, ...kids) { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; }
  function buildUI() {
    if (host || !document.body) return;
    host = h('div', { id: 'nblm-prompt-host' });
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:999;'; // 低于 CDK 弹层(1000)
    const root = host.attachShadow({ mode: 'closed' });
    sideBtn = h('button', { className: 'btn', type: 'button', title: '收起 / 展开左右侧栏', textContent: '收起侧栏' });
    promptBtn = h('button', { className: 'btn', type: 'button', title: '插入常用提示词', textContent: '提示词 ▾' });
    bar = h('div', { className: 'bar' }, sideBtn, promptBtn);
    menu = h('div', { className: 'menu', hidden: true });
    for (const p of PROMPTS) {
      const item = h('button', { className: 'item', type: 'button', textContent: p.label, title: p.text.slice(0, 160) });
      item.addEventListener('click', () => { closeMenu(); insertPrompt(p.text); });
      menu.append(item);
    }
    toastEl = h('div', { className: 'toast' });
    root.append(h('style', { textContent: UI_CSS }), menu, bar, toastEl);
    root.addEventListener('mousedown', e => e.preventDefault()); // 不抢焦点，保留输入框光标
    sideBtn.addEventListener('click', toggleSides);
    promptBtn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
    document.addEventListener('mousedown', e => { if (!e.composedPath().includes(host)) closeMenu(); }, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); }, true);
    document.body.append(host);
  }
  function toast(msg) {
    buildUI(); if (!toastEl) return;
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }
  function pickInput() {
    const list = [...document.querySelectorAll(TA)].filter(x => x.getClientRects().length);
    return list.find(x => x === document.activeElement) || list.find(x => x === lastInput) || list[0] || null;
  }
  function place() {
    placePending = false;
    buildUI(); if (!host) return;
    if (!promptsOn) { bar.style.display = 'none'; closeMenu(); return; }
    const ta = pickInput();
    if (ta !== lastInput) { if (lastInput) inputRO.unobserve(lastInput); if (ta) inputRO.observe(ta); lastInput = ta; }
    if (!ta) { bar.style.display = 'none'; closeMenu(); return; }
    bar.style.display = '';
    const sides = sidePanels();
    sideBtn.hidden = !sides.length;
    sideBtn.textContent = anySideOpen(sides) ? '收起侧栏' : '展开侧栏';
    const r = ta.getBoundingClientRect(), bw = bar.offsetWidth || 160, bh = bar.offsetHeight || 26;
    bar.style.left = Math.max(4, Math.min(r.right - bw, innerWidth - bw - 4)) + 'px';
    bar.style.top = Math.max(4, r.top - bh - 6) + 'px';
    if (!menu.hidden) placeMenu();
  }
  function queuePlace() { if (!placePending) { placePending = true; requestAnimationFrame(place); } }
  function placeMenu() {
    const b = promptBtn.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(b.right - mw, innerWidth - mw - 4)) + 'px';
    menu.style.top = (b.top - mh - 6 >= 4 ? b.top - mh - 6 : b.bottom + 6) + 'px';
  }
  function openMenu() { menu.hidden = false; placeMenu(); }
  function closeMenu() { if (menu) menu.hidden = true; }
  function insertPrompt(text) {
    const ta = pickInput(); if (!ta) return;
    const v = ta.value, useCaret = touched.has(ta);
    const start = useCaret ? ta.selectionStart : v.length, end = useCaret ? ta.selectionEnd : v.length;
    const before = v.slice(0, start), sep = before && !before.endsWith('\n') ? '\n\n' : '';
    ta.value = before + sep + text + v.slice(end);
    ta.dispatchEvent(new Event('input', { bubbles: true })); // 通知 Angular 表单，发送按钮才会亮
    ta.focus(); touched.add(ta);
    const base = before.length + sep.length, i = text.indexOf(PH);
    if (i >= 0) ta.setSelectionRange(base + i, base + i + PH.length);
    else ta.setSelectionRange(base + text.length, base + text.length);
  }

  // ===== 干净复制：去掉引用角标 =====
  function cleanClone(root) {
    root.querySelectorAll(`${CITE_SEL}, button, mat-icon, [role="button"]`).forEach(n => n.remove());
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      n.nodeValue = n.nodeValue.replace(BRACKET_G, '').replace(/[ \t]+([.,;:!?，。；：！？、])/g, '$1');
    }
  }
  function renderClone(root) { // innerText 需要元素在文档里才能正确处理换行和表格
    root.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;white-space:pre-wrap;';
    document.body.append(root);
    const text = root.innerText.replace(/\n{3,}/g, '\n\n').trim(), html = root.innerHTML;
    root.remove();
    return { text, html };
  }
  async function writeClipboard(text, html) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]);
      return true;
    } catch (_) { /* Firefox 沙箱或权限问题，降级 */ }
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* 再降级 */ }
    if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; }
    return false;
  }
  function isCopyButton(b) {
    const label = b.getAttribute('aria-label') || b.getAttribute('mattooltip') || b.title || '';
    return /copy|复制/i.test(label) || [...b.querySelectorAll('mat-icon')].some(i => /copy/i.test(i.textContent));
  }
  function answerOf(b) { // 从复制按钮往上找最小的、含正文的回答容器
    let c = b.parentElement;
    for (let i = 0; c && i < 14; i++, c = c.parentElement) {
      if (c.querySelector(TA)) return null; // 已经爬到整个对话面板，放弃
      if ((c.innerText || '').trim().length > 30 && c.querySelector('paragraph-element-view, .paragraph, p, li, table')) return c;
    }
    return null;
  }
  // Ctrl+C / 右键复制选中内容
  document.addEventListener('copy', e => {
    if (!cleanOn) return;
    const a = document.activeElement;
    if (a && (a.matches?.('textarea, input') || a.isContentEditable)) return;
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const box = document.createElement('div');
    for (let i = 0; i < sel.rangeCount; i++) box.append(sel.getRangeAt(i).cloneContents());
    if (!box.querySelector(CITE_SEL) && !BRACKET.test(box.textContent)) return; // 没有角标就走原生复制
    cleanClone(box);
    const { text, html } = renderClone(box);
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', html);
    e.preventDefault();
  }, true);
  // 回答下方的「复制」按钮：让 NotebookLM 先复制，稍后用清理过的内容覆盖剪贴板
  document.addEventListener('click', e => {
    if (!cleanOn || !e.isTrusted) return;
    const b = e.target instanceof Element ? e.target.closest('button') : null;
    if (!b || !isCopyButton(b)) return;
    const answer = answerOf(b);
    if (!answer) return;
    setTimeout(async () => {
      const clone = answer.cloneNode(true);
      cleanClone(clone);
      const { text, html } = renderClone(clone);
      if (text && await writeClipboard(text, html)) toast('已复制，去掉了引用角标');
    }, 150);
  }, true);

  // ===== 回答折叠 =====
  function nbId() { return location.pathname.match(/\/notebook\/([^/?#]+)/)?.[1] || 'global'; }
  function answerKey(ans) { // 用回答开头 300 字做指纹，刷新后能认回同一条回答
    const body = ans.querySelector(ANSWER_BODY);
    const t = (body ? body.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (t.length < 20) return null;
    let x = 5381;
    for (let i = 0; i < t.length; i++) x = ((x * 33) ^ t.charCodeAt(i)) >>> 0;
    return { key: x.toString(36) + '.' + t.length, full: t.length >= 300 };
  }
  function saveFold(key, on) {
    const nb = nbId(), m = folds[nb] || (folds[nb] = {});
    if (on) m[key] = Date.now(); else delete m[key];
    const keys = Object.keys(m);
    if (keys.length > 500) keys.sort((a, b) => m[a] - m[b]).slice(0, keys.length - 500).forEach(k => delete m[k]);
    if (!Object.keys(m).length) delete folds[nb];
    GM_setValue(K_FOLDS, folds);
  }
  function setFolded(ans, on) {
    ans.classList.toggle('nblm-folded', on);
    const b = ans.querySelector(':scope > .nblm-fold-btn');
    if (b) { b.textContent = on ? '✓ 已理解 · 展开' : '折叠'; b.title = on ? '展开并取消“已理解”标记' : '折叠并标记为已理解（刷新后保持）'; }
  }
  function onFoldClick(e) {
    e.preventDefault(); e.stopPropagation();
    const ans = e.currentTarget.parentElement, on = !ans.classList.contains('nblm-folded');
    const k = answerKey(ans);
    setFolded(ans, on);
    if (k) saveFold(k.key, on);
    if (on) { // 折叠后若回答顶部已滚出视野，把它拉回来，免得页面跳走
      const r = ans.getBoundingClientRect();
      if (r.top < 0) ans.scrollIntoView({ block: 'start' });
    }
  }
  function processAnswers() {
    answersPending = false;
    if (!foldsOn) return;
    const saved = folds[nbId()] || {};
    document.querySelectorAll(ANSWER).forEach(ans => {
      if (!ans.querySelector(':scope > .nblm-fold-btn')) {
        const b = h('button', { type: 'button', className: 'nblm-fold-btn' });
        b.addEventListener('click', onFoldClick);
        ans.prepend(b);
        setFolded(ans, ans.classList.contains('nblm-folded'));
      }
      if (foldChecked.has(ans)) return;
      const k = answerKey(ans);
      if (!k) return;
      if (saved[k.key]) { setFolded(ans, true); foldChecked.add(ans); }
      else if (k.full) foldChecked.add(ans); // 不足 300 字的回答可能还在渲染，下次再认
    });
  }
  function queueAnswers() { if (!answersPending) { answersPending = true; setTimeout(processAnswers, 300); } }
  function removeFoldUI() {
    document.querySelectorAll('.nblm-fold-btn').forEach(b => b.remove());
    document.querySelectorAll('.nblm-folded').forEach(a => a.classList.remove('nblm-folded'));
  }
  function scrollParent(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement;
  }
  // Ctrl+F 命中折叠区里的文字时，浏览器会滚动被裁剪的区域；据此临时展开，并补偿页面位置让命中处可见。
  document.addEventListener('scroll', e => {
    const t = e.target;
    if (!(t instanceof Element) || !t.scrollTop || !t.matches(`.nblm-folded ${ANSWER_BODY}`)) return;
    const s = t.scrollTop, ans = t.closest(ANSWER);
    setFolded(ans, false); // 临时展开，不清除“已理解”记录
    const sp = scrollParent(ans);
    if (sp) sp.scrollTop += s;
  }, true);
  // 点折叠区的预览文字：临时展开看一眼，刷新后仍是折叠
  document.addEventListener('click', e => {
    const body = e.target instanceof Element ? e.target.closest(`.nblm-folded ${ANSWER_BODY}`) : null;
    if (!body || e.target.closest('button, a')) return;
    e.preventDefault(); e.stopPropagation();
    setFolded(body.closest(ANSWER), false);
  }, true);

  // ===== 事件与启动 =====
  document.addEventListener('input', e => {
    if (!e.target.matches?.(TA)) return;
    if (!bound.has(e.target)) scan();
    schedule(e.target); queuePlace();
  }, true);
  document.addEventListener('focusin', e => {
    if (!e.target.matches?.(TA)) return;
    scan(); schedule(e.target);
    touched.add(e.target); lastInput = e.target; queuePlace();
  }, true);
  window.addEventListener('resize', () => { bound.forEach((_, el) => schedule(el)); queuePlace(); });
  window.addEventListener('scroll', queuePlace, true);
  const domObserver = new MutationObserver(records => {
    let changed = false;
    for (const r of records) {
      if (r.target === styleEl) continue;
      for (const n of r.addedNodes) if (n.nodeType === 1) { changed = true; pendingAdds.add(n); }
      if (!changed) changed = [...r.removedNodes].some(n => n.nodeType === 1);
    }
    if (!changed) return;
    queueScan(); queuePlace(); queueAnswers();
    if (!curPanel || !curPanel.isConnected) queueWidenAll(); else if (pendingAdds.size) queueAdds();
  });
  domObserver.observe(document, { childList: true, subtree: true });
  scan();
  queuePlace();
  queueWidenAll();
  queueAnswers();

  function probe() {
    return { version: VERSION, enabled: state.enabled, cap: cap(), prompts: promptsOn, cleanCopy: cleanOn,
      wide: WIDE_STEPS[wideStep].label, widened: widened.size, chatPanel: curPanel?.tagName + '.' + (curPanel?.className || ''),
      sidePanels: sidePanels().map(p => p.section.className),
      folds: foldsOn, answers: document.querySelectorAll(ANSWER).length,
      foldedHere: document.querySelectorAll('.nblm-folded').length, savedHere: Object.keys(folds[nbId()] || {}).length,
      fieldSizingSupported: CSS.supports('field-sizing', 'content'),
      inputs: [...document.querySelectorAll(TA)].map(el => ({ height: el.clientHeight, scrollHeight: el.scrollHeight,
        overflow: getComputedStyle(el).overflowY, inlineHeight: el.style.height })) };
  }
  try {
    unsafeWindow.__nblmProbe = probe;
    unsafeWindow.__nblmRefresh = () => { scan(); bound.forEach((_, el) => grow(el)); widenAll(); return probe(); };
  } catch (_) { /* 诊断导出受限不影响功能 */ }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('输入框加高：启用 / 关闭（v2 默认启用）', () => {
      state.enabled = !state.enabled; GM_setValue(K_ENABLED, state.enabled); scan();
      console.info('[NBLM 加高]', state.enabled ? '启用' : '关闭');
    });
    GM_registerMenuCommand('高度上限：40 → 60 → 80vh（当前 ' + HEIGHT_STEPS[state.step] + 'vh）', () => {
      state.step = (state.step + 1) % HEIGHT_STEPS.length; GM_setValue(K_STEP, state.step);
      renderStyle(); bound.forEach((_, el) => grow(el));
    });
    GM_registerMenuCommand('对话宽度：全宽 → 1100px → 原始（当前 ' + WIDE_STEPS[wideStep].label + '）', () => {
      wideStep = (wideStep + 1) % WIDE_STEPS.length; GM_setValue(K_WIDE, wideStep);
      widenAll(); toast('对话宽度：' + WIDE_STEPS[wideStep].label);
    });
    GM_registerMenuCommand('工具条（侧栏 + 提示词）：显示 / 隐藏', () => {
      promptsOn = !promptsOn; GM_setValue(K_PROMPTS, promptsOn); queuePlace();
    });
    GM_registerMenuCommand('干净复制（去引用角标）：启用 / 关闭', () => {
      cleanOn = !cleanOn; GM_setValue(K_CLEAN, cleanOn); renderStyle();
      toast('干净复制：' + (cleanOn ? '启用' : '关闭'));
    });
    GM_registerMenuCommand('一键收起 / 展开侧栏', toggleSides);
    GM_registerMenuCommand('回答折叠按钮：启用 / 关闭', () => {
      foldsOn = !foldsOn; GM_setValue(K_FOLD_ON, foldsOn); renderStyle();
      if (foldsOn) processAnswers(); else removeFoldUI();
      toast('回答折叠：' + (foldsOn ? '启用' : '关闭'));
    });
    GM_registerMenuCommand('本笔记本：清除所有“已理解”折叠', () => {
      delete folds[nbId()]; GM_setValue(K_FOLDS, folds);
      document.querySelectorAll('.nblm-folded').forEach(a => setFolded(a, false));
      toast('已清除本笔记本的折叠记录');
    });
    GM_registerMenuCommand('打印诊断信息', () => console.info('[NBLM 加高]', probe()));
  }
  console.info('[NBLM 加高] v' + VERSION, probe());
})();
