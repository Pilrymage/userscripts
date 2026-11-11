// ==UserScript==
// @name         Readline 键位（网页输入框）
// @namespace    https://github.com/Pilrymage/userscripts
// @version      1.1.0
// @description  在网页输入框 / textarea / contenteditable 中启用 Bash readline 风格的 Ctrl 键：A E P N F B K D。
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
  const KEYS = new Set(['KeyA', 'KeyE', 'KeyP', 'KeyN', 'KeyF', 'KeyB', 'KeyK', 'KeyD']);

  let goalColumn = null; // 连续 P/N 时保持列

  function getTarget(e) {
    let el = e.composedPath ? e.composedPath()[0] : e.target;
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

  // ---------- input / textarea ----------
  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
  const nextPos = (v, p) => Math.min(v.length, p + (isHigh(v.charCodeAt(p)) && isLow(v.charCodeAt(p + 1)) ? 2 : 1));
  const prevPos = (v, p) => Math.max(0, p - (isLow(v.charCodeAt(p - 1)) && isHigh(v.charCodeAt(p - 2)) ? 2 : 1));
  const lineStart = (v, p) => v.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (v, p) => { const i = v.indexOf('\n', p); return i < 0 ? v.length : i; };

  function moveTo(el, p) { el.setSelectionRange(p, p); }

  // Ctrl+K 删掉的内容写入系统剪贴板
  function copyKill(text) {
    if (!text) return;
    try { GM_setClipboard(text, 'text'); } catch (_) {
      navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function deleteRange(el, from, to, copy) {
    if (from >= to) return;
    if (copy) copyKill(el.value.slice(from, to));
    el.setSelectionRange(from, to);
    // execCommand 保留撤销栈，并触发 input 事件让 React/Vue 同步
    if (!document.execCommand('delete')) {
      el.setRangeText('', from, to, 'start');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentForward' }));
    }
  }

  function handleField(code, el, multiline) {
    const v = el.value;
    const p = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd;
    const ls = lineStart(v, p);
    const le = lineEnd(v, p);
    if (code !== 'KeyP' && code !== 'KeyN') goalColumn = null;

    switch (code) {
      case 'KeyA': moveTo(el, ls); break;
      case 'KeyE': moveTo(el, le); break;
      case 'KeyF': moveTo(el, nextPos(v, p)); break;
      case 'KeyB': moveTo(el, prevPos(v, p)); break;
      case 'KeyP':
      case 'KeyN': {
        if (!multiline) break;
        if (goalColumn === null) goalColumn = p - ls;
        if (code === 'KeyP') {
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
    }
  }

  // ---------- contenteditable ----------
  function handleRich(code) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const move = (dir, unit) => {
      if (!sel.isCollapsed) sel.collapseToEnd();
      sel.modify('move', dir, unit);
    };
    switch (code) {
      case 'KeyA': move('backward', 'lineboundary'); break;
      case 'KeyE': move('forward', 'lineboundary'); break;
      case 'KeyF': move('forward', 'character'); break;
      case 'KeyB': move('backward', 'character'); break;
      case 'KeyP': move('backward', 'line'); break;
      case 'KeyN': move('forward', 'line'); break;
      case 'KeyK':
        if (!sel.isCollapsed) sel.collapseToEnd();
        sel.modify('extend', 'forward', 'lineboundary');
        if (sel.isCollapsed) sel.modify('extend', 'forward', 'character');
        if (!sel.isCollapsed) { copyKill(sel.toString()); document.execCommand('delete'); }
        break;
      case 'KeyD': document.execCommand('forwardDelete'); break;
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.isComposing) return;
    if (!KEYS.has(e.code)) return;
    const t = getTarget(e);
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (t.kind === 'field') handleField(e.code, t.el, t.multiline);
    else { goalColumn = null; handleRich(e.code); }
  }, true);
})();
