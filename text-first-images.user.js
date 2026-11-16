// ==UserScript==
// @name         图片屏蔽（文字优先）
// @namespace    https://github.com/Pilrymage/userscripts
// @version      1.0.0
// @description  隔绝图片与视频封面，只留原尺寸虚线框和 alt 文字；点击单张可恢复原图，Alt+Shift+I 一键全开本页，每站记忆开关。拦 img / picture / video poster / CSS 背景，放过行内 SVG、canvas 和 .ico 图标。
// @author       Pilrymage
// @license      MIT
// @homepageURL  https://github.com/Pilrymage/userscripts
// @downloadURL  https://raw.githubusercontent.com/Pilrymage/userscripts/main/text-first-images.user.js
// @updateURL    https://raw.githubusercontent.com/Pilrymage/userscripts/main/text-first-images.user.js
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 常量 ----------
  const CLS_ON = 'dsh-ni-on';       // 挂在 <html> 上，CSS 的总开关
  const CLS_PH = 'dsh-ni-ph';       // 已替换成占位框
  const CLS_KEEP = 'dsh-ni-keep';   // 用户主动放行，或判定为图标而放过
  const ATTR_WANT = 'data-dsh-ni-want';
  const ATTR_SKIP = 'data-dsh-ni-skip';
  const STORE_KEY = 'dsh-ni.sites.v1';
  const IS_TOP = window.top === window;
  const HOST = location.hostname || location.protocol;

  // ---------- 站点开关 ----------
  function readSites() {
    try {
      const raw = typeof GM_getValue === 'function' ? GM_getValue(STORE_KEY, '{}') : '{}';
      const v = JSON.parse(raw || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch (_) {
      return {};
    }
  }
  function writeSites(v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORE_KEY, JSON.stringify(v));
    } catch (_) {}
  }

  const sites = readSites();
  let siteEnabled = sites[HOST] !== 'off'; // 全站默认开
  let pageOverride = null;                 // null | 'on' | 'off'，Alt+Shift+I 的临时覆盖
  let blocking = true;

  function computeBlocking() {
    return pageOverride === 'off' ? false : pageOverride === 'on' ? true : siteEnabled;
  }

  // ---------- 样式 ----------
  const CSS = `
html.${CLS_ON} :is(img, video):not(.${CLS_PH}):not(.${CLS_KEEP}) { visibility: hidden !important; }
html.${CLS_ON} img.${CLS_PH}, html.${CLS_ON} video.${CLS_PH} { cursor: zoom-in !important; }
html.${CLS_ON} video.${CLS_PH} { outline: 1px dashed #c8c8c8 !important; outline-offset: -1px !important; }
html.${CLS_ON} *::before, html.${CLS_ON} *::after { background-image: none !important; }
`;

  function injectCSS() {
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(CSS);
        return;
      }
    } catch (_) {}
    const put = () => {
      const s = document.createElement('style');
      s.textContent = CSS;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.documentElement) put();
    else document.addEventListener('readystatechange', put, { once: true });
  }

  // ---------- 占位 SVG ----------
  const PH_CACHE = new Map();

  function escXML(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  }

  // 全角字符按 1em，其余按 0.55em 估宽
  function charWidth(ch) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    return wide ? 1 : 0.55;
  }

  function wrapLines(text, maxPx, fs) {
    const lines = [];
    let cur = '';
    let curW = 0;
    for (const ch of text) {
      if (ch === '\n' || ch === '\r') {
        lines.push(cur);
        cur = '';
        curW = 0;
        continue;
      }
      const cw = charWidth(ch) * fs;
      if (cur !== '' && curW + cw > maxPx) {
        lines.push(cur);
        cur = '';
        curW = 0;
      }
      cur += ch;
      curW += cw;
    }
    if (cur !== '') lines.push(cur);
    return lines;
  }

  function placeholderURI(alt, rawW, rawH) {
    const w = Math.max(24, Math.min(4096, Math.round(rawW)));
    const h = Math.max(18, Math.min(4096, Math.round(rawH)));
    const label = (alt || '').trim();
    const key = w + 'x' + h + '\u0000' + label;
    const hit = PH_CACHE.get(key);
    if (hit) return hit;

    const pad = Math.min(12, Math.max(3, Math.round(Math.min(w, h) * 0.09)));
    let fs = 0;
    if (w >= 100 && h >= 56) fs = Math.min(14, Math.max(11, Math.round(Math.min(w, h) / 9)));

    let body =
      `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" ` +
      `fill="#fafafa" stroke="#c8c8c8" stroke-width="1" stroke-dasharray="4 3"/>`;

    if (fs > 0 && label !== '') {
      const lh = fs + 4;
      const maxPx = w - pad * 2;
      const maxLines = Math.max(1, Math.floor((h - pad * 2) / lh));
      let lines = wrapLines(label, maxPx, fs);
      if (lines.length > maxLines) {
        lines = lines.slice(0, maxLines);
        const last = lines[maxLines - 1];
        lines[maxLines - 1] = (last.length > 1 ? last.slice(0, -1) : last) + '…';
      }
      const baseY = pad + fs;
      lines.forEach((line, i) => {
        body +=
          `<text x="${pad}" y="${baseY + i * lh}" ` +
          `font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="${fs}" ` +
          `fill="#9a9a9a">${escXML(line)}</text>`;
      });
    }

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
      `viewBox="0 0 ${w} ${h}">${body}</svg>`;
    const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    if (PH_CACHE.size < 400) PH_CACHE.set(key, uri);
    return uri;
  }

  // 1x1 透明图，用于立刻掐掉原图
  const BLANK = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');

  // ---------- 尺寸队列 ----------
  const sizeQueue = new Set();
  let rafId = 0;

  function queueSize(el) {
    sizeQueue.add(el);
    if (rafId) return;
    rafId = requestAnimationFrame(flushSizes);
  }

  function flushSizes() {
    rafId = 0;
    const batch = Array.from(sizeQueue);
    sizeQueue.clear();
    // 先集中读，再集中写，避免反复触发重排
    const reads = [];
    for (const el of batch) {
      if (!el.isConnected || !el.classList.contains(CLS_PH)) continue;
      const r = el.getBoundingClientRect();
      reads.push({ el, w: r.width, h: r.height });
    }
    for (const it of reads) {
      const { el } = it;
      let w = it.w;
      let h = it.h;
      if (!(w >= 8 && h >= 8)) {
        const aw = parseFloat(el.getAttribute('width'));
        const ah = parseFloat(el.getAttribute('height'));
        if (aw >= 8 && ah >= 8) {
          w = aw;
          h = ah;
        }
      }
      if (!(w >= 8 && h >= 8)) {
        if (el.naturalWidth >= 8 && el.naturalHeight >= 8) {
          w = el.naturalWidth;
          h = el.naturalHeight;
        }
      }
      if (!(w >= 8 && h >= 8)) {
        w = 320;
        h = 180;
      }
      // 图标尺寸（≤24px）放过：它们是按钮和功能图标，不是吸引注意力的图片
      if (w <= 24 || h <= 24) {
        revealImg(el, true);
        continue;
      }
      const uri = placeholderURI(el.__dshNiAlt || '', w, h);
      el.__dshNiPh = uri;
      el.setAttribute('src', uri);
    }
  }

  // ---------- 图片 ----------
  function isIconSrc(src) {
    return /\.ico(\?|#|$)/i.test(src) || /favicon/i.test(src) || /apple-touch-icon/i.test(src);
  }

  function handleImg(img) {
    if (!blocking) return;
    if (img.__dshNiDone) return;
    if (img.classList.contains(CLS_PH) || img.classList.contains(CLS_KEEP)) return;
    if (img.hasAttribute(ATTR_WANT) || img.hasAttribute(ATTR_SKIP)) return;

    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src) return; // 懒加载还没写 src，等观察器再叫我们
    if (src === img.__dshNiPh) return; // 我们自己写的占位图回环
    if (isIconSrc(src)) {
      img.classList.add(CLS_KEEP);
      return;
    }
    // 明确声明为图标的尺寸，直接放过
    const aw = parseFloat(img.getAttribute('width'));
    const ah = parseFloat(img.getAttribute('height'));
    if (aw > 0 && ah > 0 && aw <= 24 && ah <= 24) {
      img.classList.add(CLS_KEEP);
      return;
    }
    if (/^data:image\/svg\+xml/i.test(src) && img.hasAttribute(ATTR_WANT)) return;

    // 存档原始属性
    img.__dshNiDone = true;
    img.__dshNiAlt = img.getAttribute('alt') || '';
    img.__dshNiSrc = src;
    img.__dshNiSrcset = img.getAttribute('srcset');
    img.__dshNiSizes = img.getAttribute('sizes');

    // <picture> 里的 <source> 也要掐掉，否则 srcset 仍会命中
    const pic = img.parentElement;
    if (pic && pic.tagName === 'PICTURE') {
      for (const s of pic.querySelectorAll('source')) {
        if (s.__dshNiSrcset === undefined) {
          s.__dshNiSrcset = s.getAttribute('srcset');
          s.__dshNiSizes = s.getAttribute('sizes');
        }
        s.removeAttribute('srcset');
        s.removeAttribute('sizes');
      }
    }

    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.__dshNiPh = BLANK;
    img.setAttribute('src', BLANK);
    img.classList.add(CLS_PH);
    queueSize(img);
  }

  function revealImg(img, asIcon) {
    if (!img.__dshNiDone) {
      img.classList.add(CLS_KEEP);
      return;
    }
    const src = img.__dshNiSrc;
    if (src) img.setAttribute('src', src);
    if (img.__dshNiSrcset != null) img.setAttribute('srcset', img.__dshNiSrcset);
    if (img.__dshNiSizes != null) img.setAttribute('sizes', img.__dshNiSizes);

    const pic = img.parentElement;
    if (pic && pic.tagName === 'PICTURE') {
      for (const s of pic.querySelectorAll('source')) {
        if (s.__dshNiSrcset != null) s.setAttribute('srcset', s.__dshNiSrcset);
        if (s.__dshNiSizes != null) s.setAttribute('sizes', s.__dshNiSizes);
      }
    }

    img.classList.remove(CLS_PH);
    img.classList.add(CLS_KEEP);
    if (asIcon) img.setAttribute(ATTR_SKIP, '1');
    else img.setAttribute(ATTR_WANT, '1');
    img.__dshNiDone = false;
  }

  // ---------- 视频 ----------
  function handleVideo(v) {
    if (!blocking) return;
    if (v.__dshNiDone || v.classList.contains(CLS_PH) || v.classList.contains(CLS_KEEP)) return;
    if (v.hasAttribute(ATTR_WANT) || v.hasAttribute(ATTR_SKIP)) return;

    v.__dshNiDone = true;
    v.__dshNiPoster = v.getAttribute('poster');
    if (v.hasAttribute('poster')) v.removeAttribute('poster');
    v.setAttribute('preload', 'none');
    try {
      v.pause();
    } catch (_) {}
    v.classList.add(CLS_PH);
  }

  function revealVideo(v) {
    if (!v.__dshNiDone) {
      v.classList.add(CLS_KEEP);
      return;
    }
    if (v.__dshNiPoster != null) v.setAttribute('poster', v.__dshNiPoster);
    v.classList.remove(CLS_PH);
    v.classList.add(CLS_KEEP);
    v.setAttribute(ATTR_WANT, '1');
    v.__dshNiDone = false;
  }

  // ---------- CSS 背景 ----------
  // 只掐含 url() 的背景，保留渐变，避免弄坏按钮、进度条和骨架屏
  const bgStash = new WeakMap();

  function handleBg(el) {
    if (!blocking) return;
    if (el.__dshNiBgDone) return;
    el.__dshNiBgDone = true;
    let bg;
    try {
      bg = getComputedStyle(el).backgroundImage;
    } catch (_) {
      return;
    }
    if (!bg || bg === 'none' || !bg.includes('url(')) return;
    bgStash.set(el, {
      had: el.style.getPropertyValue('background-image') !== '',
      value: el.style.getPropertyValue('background-image'),
      priority: el.style.getPropertyPriority('background-image'),
    });
    el.style.setProperty('background-image', 'none', 'important');
  }

  function restoreBg(el) {
    const st = bgStash.get(el);
    if (!st) return;
    if (st.had) el.style.setProperty('background-image', st.value, st.priority);
    else el.style.removeProperty('background-image');
    bgStash.delete(el);
    el.__dshNiBgDone = false;
  }

  // ---------- 扫描 ----------
  function processNode(root) {
    if (!blocking) return;
    let n = root;
    if (n.nodeType === Node.TEXT_NODE) return;
    if (n.nodeType !== Node.ELEMENT_NODE) return;

    const own = (el) => {
      if (el.tagName === 'IMG') handleImg(el);
      else if (el.tagName === 'VIDEO') handleVideo(el);
      if (el.shadowRoot) {
        observeShadow(el.shadowRoot);
        scanElement(el.shadowRoot);
      }
    };

    own(n);
    const walker = document.createTreeWalker(n, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        const t = el.tagName;
        if (t === 'SVG' || t === 'svg') return NodeFilter.FILTER_REJECT; // 行内 SVG 整棵放过
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let el = walker.nextNode();
    while (el) {
      own(el);
      el = walker.nextNode();
    }
  }

  // 背景扫描较重，单独排队分片跑
  const bgQueue = [];
  let bgRunning = false;

  function enqueueBg(el) {
    if (!blocking) return;
    if (el.__dshNiBgDone) return;
    if (el.tagName === 'SVG' || el.tagName === 'svg') return;
    bgQueue.push(el);
    if (!bgRunning) {
      bgRunning = true;
      scheduleBgDrain();
    }
  }

  function scheduleBgDrain() {
    const idle =
      window.requestIdleCallback ||
      ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 16));
    idle(() => {
      const t0 = performance.now();
      while (bgQueue.length && performance.now() - t0 < 8) {
        const el = bgQueue.shift();
        if (el.isConnected) handleBg(el);
      }
      if (bgQueue.length) scheduleBgDrain();
      else bgRunning = false;
    }, { timeout: 500 });
  }

  function scanElement(root) {
    if (!blocking) return;
    let el = root.nodeType === Node.ELEMENT_NODE ? root : null;
    if (!el) return;
    processNode(el);
    const all = el.querySelectorAll('*');
    for (const node of all) {
      if (node.tagName === 'SVG' || node.tagName === 'svg') continue;
      if (node.tagName === 'IMG') handleImg(node);
      else if (node.tagName === 'VIDEO') handleVideo(node);
      enqueueBg(node);
      if (node.shadowRoot) {
        observeShadow(node.shadowRoot);
        scanElement(node.shadowRoot);
      }
    }
    enqueueBg(el);
  }

  // ---------- 观察器 ----------
  const shadowObservers = new WeakSet();

  function observeShadow(root) {
    if (shadowObservers.has(root)) return;
    shadowObservers.add(root);
    const mo = new MutationObserver(onMutations);
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'style'],
    });
  }

  function onMutations(records) {
    if (!blocking) return;
    for (const rec of records) {
      if (rec.type === 'childList') {
        for (const node of rec.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) scanElement(node);
        }
      } else if (rec.type === 'attributes') {
        const t = rec.target;
        if (!(t instanceof Element)) continue;
        if (t.tagName === 'IMG') {
          if (t.__dshNiPh && t.getAttribute('src') === t.__dshNiPh) continue;
          if (t.classList.contains(CLS_PH)) continue;
          t.__dshNiDone = false;
          handleImg(t);
        } else if (t.tagName === 'VIDEO') {
          if (t.classList.contains(CLS_PH)) continue;
          t.__dshNiDone = false;
          handleVideo(t);
        } else if (rec.attributeName === 'style') {
          t.__dshNiBgDone = false;
          enqueueBg(t);
        }
      }
    }
  }

  let observer = null;

  function startObserving() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'style'],
    });
    if (document.body) scanElement(document.body);
  }

  // ---------- 全开 / 全关 ----------
  function revealAll() {
    for (const img of document.querySelectorAll('img')) {
      if (img.classList.contains(CLS_PH)) revealImg(img);
    }
    for (const v of document.querySelectorAll('video')) {
      if (v.classList.contains(CLS_PH)) revealVideo(v);
    }
    // 放行所有元素背景
    for (const el of document.querySelectorAll('*')) restoreBg(el);
  }

  function blockAll() {
    if (!document.body) return;
    for (const el of document.querySelectorAll('img, video')) {
      el.classList.remove(CLS_KEEP, CLS_PH);
      el.removeAttribute(ATTR_WANT);
      el.removeAttribute(ATTR_SKIP);
      el.__dshNiDone = false;
      const pic = el.parentElement;
      if (pic && pic.tagName === 'PICTURE') {
        for (const s of pic.querySelectorAll('source')) delete s.__dshNiSrcset;
      }
    }
    for (const el of document.querySelectorAll('*')) el.__dshNiBgDone = false;
    scanElement(document.body);
  }

  function applyState() {
    blocking = computeBlocking();
    const rootEl = document.documentElement;
    if (rootEl) {
      if (blocking) rootEl.classList.add(CLS_ON);
      else rootEl.classList.remove(CLS_ON);
    }
    if (blocking) {
      startObserving();
      // 重新开启时先清掉「已放行」标记，否则 handleImg 会直接跳过
      blockAll();
    } else {
      revealAll();
    }
  }

  // document-start 时可能还没有 <html>，等它出现再挂总开关
  function whenRoot(fn) {
    if (document.documentElement) {
      fn();
      return;
    }
    const mo = new MutationObserver(() => {
      if (document.documentElement) {
        mo.disconnect();
        fn();
      }
    });
    mo.observe(document, { childList: true, subtree: true });
  }

  // ---------- 提示条 ----------
  let toastEl = null;
  let toastTimer = 0;

  function toast(msg) {
    if (!IS_TOP) return;
    if (!document.documentElement) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'padding:8px 14px;border-radius:8px;background:rgba(20,20,20,.88);' +
        'color:#fff;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;' +
        'pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.24);' +
        'opacity:0;transition:opacity .16s ease;';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = '0';
    }, 1600);
  }

  // ---------- 点击恢复 ----------
  document.addEventListener(
    'click',
    (e) => {
      if (!blocking) return;
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // 组合键放行链接
      const path = e.composedPath ? e.composedPath() : [e.target];
      for (const el of path) {
        if (el instanceof HTMLImageElement && el.classList.contains(CLS_PH)) {
          e.preventDefault();
          e.stopPropagation();
          revealImg(el);
          return;
        }
        if (el instanceof HTMLVideoElement && el.classList.contains(CLS_PH)) {
          e.preventDefault();
          e.stopPropagation();
          revealVideo(el);
          return;
        }
      }
    },
    true
  );

  // ---------- 快捷键与菜单 ----------
  function broadcastFrameState(state) {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage({ __dshNi: 1, state }, '*');
      } catch (_) {}
    }
  }

  function setOverride(state) {
    pageOverride = state;
    applyState();
    broadcastFrameState(state);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== 'KeyI') return;
      e.preventDefault();
      e.stopPropagation();
      const next = blocking ? 'off' : 'on';
      setOverride(next);
      toast(next === 'off' ? '本页已全部显示图片（临时）' : '本页已恢复屏蔽');
    },
    true
  );

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__dshNi !== 1) return;
    pageOverride = d.state;
    applyState();
    broadcastFrameState(d.state); // 继续向下传给子框架
  });

  if (IS_TOP && typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(
      `本网站图片屏蔽：${siteEnabled ? '开' : '关'}（点击切换，长期记忆）`,
      () => {
        siteEnabled = !siteEnabled;
        sites[HOST] = siteEnabled ? 'on' : 'off';
        writeSites(sites);
        pageOverride = null;
        applyState();
        toast(`已长期${siteEnabled ? '开启' : '关闭'} ${HOST} 的图片屏蔽`);
      }
    );
  }

  // ---------- 启动 ----------
  injectCSS();
  whenRoot(() => {
    applyState();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        startObserving();
        if (blocking && document.body) scanElement(document.body);
      }, { once: true });
    } else {
      startObserving();
    }
  });

  // 兜底扫一遍：捡漏动态插入和延迟布局的元素
  window.addEventListener('load', () => {
    if (!blocking) return;
    startObserving();
    if (document.body) scanElement(document.body);
  }, { once: true });
})();
