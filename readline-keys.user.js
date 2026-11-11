// ==UserScript==
// @name         Readline 键位（网页输入框）
// @namespace    https://github.com/Pilrymage/userscripts
// @version      1.4.0
// @description  在网页输入框 / textarea / contenteditable 中启用 Bash readline / Emacs 风格按键：Ctrl+A E P N F B K D，Ctrl+J 换行，Alt+F B D Backspace（中文按词），Alt+< > 跳到文本开头/结尾。
// @author       Pilrymage
// @license      MIT
// @homepageURL  https://github.com/Pilrymage/userscripts
// @downloadURL  https://raw.githubusercontent.com/Pilrymage/userscripts/main/readline-keys.user.js
// @updateURL    https://raw.githubusercontent.com/Pilrymage/userscripts/main/readline-keys.user.js
// @match        *://*/*
// @grant        GM_setClipboard
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 自带按键处理的代码编辑器（隐藏 textarea 方案），交给它们自己处理
  const SKIP_SELECTOR = '.monaco-editor, .CodeMirror, .ace_editor';
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);
  const CTRL_KEYS = new Set(['KeyA', 'KeyE', 'KeyP', 'KeyN', 'KeyF', 'KeyB', 'KeyK', 'KeyD', 'KeyJ']);
  const ALT_KEYS = { KeyF: 'AltF', KeyB: 'AltB', KeyD: 'AltD', Backspace: 'AltBackspace' };

  let goalColumn = null; // 连续 P/N 时保持列

  function getAction(e) {
    if (e.metaKey || e.isComposing) return null;
    if (e.ctrlKey && !e.altKey && !e.shiftKey && CTRL_KEYS.has(e.code)) return e.code;
    if (e.altKey && !e.ctrlKey) { // AltGr 是 Ctrl+Alt，不会命中
      if (e.key === '<') return 'AltLt'; // Alt+Shift+,
      if (e.key === '>') return 'AltGt'; // Alt+Shift+.
      if (!e.shiftKey && ALT_KEYS[e.code]) return ALT_KEYS[e.code];
    }
    return null;
  }

  function getTarget(e) {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(el instanceof Element)) return null;
    if (el.closest(SKIP_SELECTOR)) return null;
    if (el instanceof HTMLTextAreaElement) return el.readOnly || el.disabled ? null : { kind: 'field', el, multiline: true };
    if (el instanceof HTMLInputElement) {
      if (!TEXT_INPUT_TYPES.has(el.type) || el.readOnly || el.disabled) return null;
      return { kind: 'field', el, multiline: false };
    }
    if (el.isContentEditable) return { kind: 'rich', el };
    return null;
  }

  // ---------- 文本工具 ----------
  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
  const nextPos = (v, p) => Math.min(v.length, p + (isHigh(v.charCodeAt(p)) && isLow(v.charCodeAt(p + 1)) ? 2 : 1));
  const prevPos = (v, p) => Math.max(0, p - (isLow(v.charCodeAt(p - 1)) && isHigh(v.charCodeAt(p - 2)) ? 2 : 1));
  const lineStart = (v, p) => v.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (v, p) => { const i = v.indexOf('\n', p); return i < 0 ? v.length : i; };

  // 中文等用 Intl.Segmenter 分词；找不到词返回 -1
  const WINDOW = 4000;
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;

  // p 之后下一个词的词尾（readline forward-word / kill-word）
  function wordEnd(text, p) {
    const chunk = text.slice(p, p + WINDOW);
    if (segmenter) {
      for (const s of segmenter.segment(chunk)) if (s.isWordLike) return p + s.index + s.segment.length;
      return -1;
    }
    const m = /[^\p{L}\p{N}_]*[\p{L}\p{N}_]+/u.exec(chunk);
    return m ? p + m[0].length : -1;
  }

  // p 之前上一个词的词首（readline backward-word / backward-kill-word）
  function wordStart(text, p) {
    const from = Math.max(0, p - WINDOW);
    const chunk = text.slice(from, p);
    if (segmenter) {
      let start = -1;
      for (const s of segmenter.segment(chunk)) if (s.isWordLike) start = from + s.index;
      return start;
    }
    const m = /[\p{L}\p{N}_]+[^\p{L}\p{N}_]*$/u.exec(chunk);
    return m ? from + m.index : -1;
  }

  // 删除的内容写入系统剪贴板
  function copyKill(text) {
    if (!text) return;
    try { GM_setClipboard(text, 'text'); } catch (_) {
      navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  // ---------- input / textarea ----------
  function moveTo(el, p) { el.setSelectionRange(p, p); }

  function deleteRange(el, from, to, copy) {
    if (from >= to) return;
    if (copy) copyKill(el.value.slice(from, to));
    el.setSelectionRange(from, to);
    // execCommand 保留撤销栈，并触发 input 事件让 React/Vue 同步
    if (!document.execCommand('delete')) {
      el.setRangeText('', from, to, 'start');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    }
  }

  function handleField(action, el, multiline) {
    const v = el.value;
    const p = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
    const ls = lineStart(v, p);
    const le = lineEnd(v, p);
    if (action !== 'KeyP' && action !== 'KeyN') goalColumn = null;

    switch (action) {
      case 'KeyA': moveTo(el, ls); break;
      case 'KeyE': moveTo(el, le); break;
      case 'KeyF': moveTo(el, nextPos(v, p)); break;
      case 'KeyB': moveTo(el, prevPos(v, p)); break;
      case 'KeyP':
      case 'KeyN': {
        if (!multiline) break;
        if (goalColumn === null) goalColumn = p - ls;
        if (action === 'KeyP') {
          if (ls === 0) { moveTo(el, 0); break; }
          const pls = lineStart(v, ls - 1);
          moveTo(el, Math.min(pls + goalColumn, ls - 1));
        } else {
          if (le === v.length) { moveTo(el, v.length); break; }
          const nls = le + 1;
          moveTo(el, Math.min(nls + goalColumn, lineEnd(v, nls)));
        }
        break;
      }
      case 'KeyK': deleteRange(el, p, le === p ? nextPos(v, p) : le, true); break;
      case 'KeyD':
        if (el.selectionStart !== el.selectionEnd) deleteRange(el, el.selectionStart, el.selectionEnd);
        else deleteRange(el, p, nextPos(v, p));
        break;
      case 'KeyJ':
        // 直接插入换行，不经过页面的 Enter 处理（不会误发送）
        if (multiline && !document.execCommand('insertText', false, '\n')) {
          el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
        }
        break;
      case 'AltF': { const we = wordEnd(v, p); moveTo(el, we < 0 ? v.length : we); break; }
      case 'AltB': { const ws = wordStart(v, p); moveTo(el, ws < 0 ? 0 : ws); break; }
      case 'AltD': { const we = wordEnd(v, p); deleteRange(el, p, we < 0 ? v.length : we, true); break; }
      case 'AltBackspace': { const ws = wordStart(v, p); deleteRange(el, ws < 0 ? 0 : ws, p, true); break; }
      case 'AltLt': moveTo(el, 0); el.scrollTop = 0; break;
      case 'AltGt': moveTo(el, v.length); el.scrollTop = el.scrollHeight; break;
    }
  }

  // ---------- contenteditable ----------
  function editingHost(el) {
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    return el;
  }

  function scrollCaretIntoView(sel) {
    const n = sel.focusNode;
    const target = n && (n.nodeType === Node.TEXT_NODE ? n.parentElement : n);
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'nearest' });
  }

  // 富文本编辑器（ProseMirror、Lexical、Quill 等）自己维护文档模型，直接改 DOM 不可靠。
  // 先模拟一次 Shift+Enter（各家聊天框通用的换行键），页面处理了就会 preventDefault；
  // 没人处理时再用 execCommand 兜底。
  function insertRichNewline(el) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true, cancelable: true, composed: true };
    const down = new KeyboardEvent('keydown', init);
    const handled = !el.dispatchEvent(down);
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (handled) return;
    if (!document.execCommand('insertLineBreak')) document.execCommand('insertParagraph');
  }

  function handleRich(action, el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    // readline 没有选区概念：先收拢到光标所在端
    if (!sel.isCollapsed && action !== 'KeyD') sel.collapse(sel.focusNode, sel.focusOffset);
    const node = sel.focusNode, off = sel.focusOffset;
    const text = node && node.nodeType === Node.TEXT_NODE ? node.data : null;
    const kill = () => { if (!sel.isCollapsed) { copyKill(sel.toString()); document.execCommand('delete'); } };

    switch (action) {
      case 'KeyA': sel.modify('move', 'backward', 'lineboundary'); break;
      case 'KeyE': sel.modify('move', 'forward', 'lineboundary'); break;
      case 'KeyF': sel.modify('move', 'forward', 'character'); break;
      case 'KeyB': sel.modify('move', 'backward', 'character'); break;
      case 'KeyP': sel.modify('move', 'backward', 'line'); break;
      case 'KeyN': sel.modify('move', 'forward', 'line'); break;
      case 'KeyK':
        sel.modify('extend', 'forward', 'lineboundary');
        if (sel.isCollapsed) sel.modify('extend', 'forward', 'character');
        kill();
        break;
      case 'KeyD': document.execCommand('forwardDelete'); break;
      case 'KeyJ': insertRichNewline(el); break;
      // 词操作：优先在当前文本节点内分词；跨节点时交给浏览器的按词移动
      case 'AltF': {
        const we = text !== null ? wordEnd(text, off) : -1;
        if (we > off) sel.collapse(node, we); else sel.modify('move', 'forward', 'word');
        break;
      }
      case 'AltB': {
        const ws = text !== null ? wordStart(text, off) : -1;
        if (ws >= 0 && ws < off) sel.collapse(node, ws); else sel.modify('move', 'backward', 'word');
        break;
      }
      case 'AltD': {
        const we = text !== null ? wordEnd(text, off) : -1;
        if (we > off) sel.setBaseAndExtent(node, off, node, we); else sel.modify('extend', 'forward', 'word');
        kill();
        break;
      }
      case 'AltBackspace': {
        const ws = text !== null ? wordStart(text, off) : -1;
        if (ws >= 0 && ws < off) sel.setBaseAndExtent(node, off, node, ws); else sel.modify('extend', 'backward', 'word');
        kill();
        break;
      }
      case 'AltLt':
      case 'AltGt': {
        const range = document.createRange();
        range.selectNodeContents(editingHost(el));
        range.collapse(action === 'AltLt');
        sel.removeAllRanges();
        sel.addRange(range);
        scrollCaretIntoView(sel);
        break;
      }
    }
  }

  window.addEventListener('keydown', (e) => {
    const action = getAction(e);
    if (!action) return;
    const t = getTarget(e);
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (t.kind === 'field') handleField(action, t.el, t.multiline);
    else { goalColumn = null; handleRich(action, t.el); }
  }, true);
})();
