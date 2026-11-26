/* =====================================================================
   字形工坊 · app.js
   交互层：字体装载 / 字符网格 / 长按多选 / 写字符 / 批量替换 /
           合集操作 / 字形编辑 / 导出
   ===================================================================== */
(function () {
  'use strict';
  const FE = window.FontEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const COLOR_SWATCHES = ['#1c2126', '#0f766e', '#b45309', '#b91c1c', '#2563eb', '#7c3aed', '#98a2ad'];

  const state = {
    A: null,            // {fileName, collection, faces, faceIndex, face, shared}
    B: null,
    tab: 'A',
    plans: new Map(),   // 计划键 → 编辑计划（共享轮廓的合集共用一个键 -1）
    selection: new Set(),
    multi: false,
    anchor: null,       // 区间连选的锚点（长按的那个字符）
    rangeArm: false,    // 锚点已就位，下一次点击即连选
    filter: 'all',
    query: '',
    cells: new Map(),   // cp → 元素
    list: [],
    rendered: 0,
    undo: [],
    draftColor: null,
    busy: false,
    bulkMode: 'copy',
    styleMode: 'sel',
    centerAll: false,
    oneShotPendingAt: 0,
    expKind: 'ttf',
    expFaceOnly: true
  };

  /* ----------------------------- 工具 ----------------------------- */
  const hex = cp => cp.toString(16).toUpperCase().padStart(4, '0');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function fmtSize(n) {
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.className = 'toast' + (isErr ? ' err' : ''); }, 2800);
  }
  function loading(show, text) {
    $('#loading').classList.toggle('show', !!show);
    if (text) $('#loadText').textContent = text;
  }
  function hexToRgb(h) {
    if (!h) return null;
    const m = h.replace('#', '');
    if (m.length !== 6) return null;
    return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16), a: 255 };
  }
  const idle = () => new Promise(r => setTimeout(r, 0));

  /* ----------------------------- 存档 ----------------------------- */
  let _db = null;
  function db() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('glyph-atelier', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { _db = r.result; res(_db); };
      r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(k) {
    const d = await db();
    return new Promise(res => {
      const t = d.transaction('kv', 'readonly').objectStore('kv').get(k);
      t.onsuccess = () => res(t.result);
      t.onerror = () => res(null);
    });
  }
  async function kvSet(k, v) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', 'readwrite').objectStore('kv').put(v, k);
      t.onsuccess = () => res(true);
      t.onerror = () => rej(t.error);
    });
  }

  /* ----------------------------- 计划 -----------------------------
   * 合集若各字面共享同一套轮廓表（PingFang 就是），改动天然对全部字面生效，
   * 因此共用一份计划，键记为 -1。
   */
  function planKey() {
    if (!state.A) return 0;
    return state.A.shared ? -1 : state.A.faceIndex;
  }
  function newPlan() {
    return { overrides: new Map(), deletions: new Set(), appended: new Map(), styles: new Map(), colors: new Map(), lineGap: null, baseStyle: null, baseColor: null, centerAll: false };
  }
  function planFor(idx) {
    const key = state.A && state.A.shared ? -1 : idx;
    if (!state.plans.has(key)) state.plans.set(key, newPlan());
    return state.plans.get(key);
  }
  function plan() {
    if (!state.A) return newPlan();
    return planFor(state.A.faceIndex);
  }
  function snapshot() {
    const p = plan();
    return {
      key: planKey(),
      overrides: new Map(p.overrides), deletions: new Set(p.deletions), appended: new Map(p.appended),
      styles: new Map(p.styles), colors: new Map(p.colors), lineGap: p.lineGap,
      baseStyle: p.baseStyle, baseColor: p.baseColor, centerAll: p.centerAll
    };
  }
  function pushUndo() {
    if (!state.A) return;
    state.undo.push(snapshot());
    if (state.undo.length > 24) state.undo.shift();
    updateUndoBtn();
  }
  function restoreSnap(s) {
    if (s.key === -1) {
      state.plans.set(-1, {
        overrides: new Map(s.overrides), deletions: new Set(s.deletions), appended: new Map(s.appended),
        styles: new Map(s.styles), colors: new Map(s.colors), lineGap: s.lineGap,
        baseStyle: s.baseStyle, baseColor: s.baseColor, centerAll: s.centerAll
      });
    } else {
      state.A.faceIndex = s.key;
      state.A.face = state.A.faces[s.key];
      $('#aFaceSelect').value = String(s.key);
      state.plans.set(s.key, {
        overrides: new Map(s.overrides), deletions: new Set(s.deletions), appended: new Map(s.appended),
        styles: new Map(s.styles), colors: new Map(s.colors), lineGap: s.lineGap,
        baseStyle: s.baseStyle, baseColor: s.baseColor, centerAll: s.centerAll
      });
    }
  }
  function updateUndoBtn() {
    const b = $('#btnUndo');
    if (b) b.disabled = !state.undo.length;
  }
  function styleFor(cp) {
    const p = plan();
    return p.styles.get(cp) || p.baseStyle || {};
  }
  function colorFor(cp) {
    const p = plan();
    return p.colors.get(cp) || p.baseColor || null;
  }
  function isEdited(cp) {
    const p = plan();
    return !!p.baseStyle || !!p.baseColor || p.centerAll ||
      p.overrides.has(cp) || p.deletions.has(cp) || p.appended.has(cp) || p.styles.has(cp) || p.colors.has(cp);
  }
  function editedCount() {
    const p = plan(), s = new Set();
    for (const k of p.overrides.keys()) s.add(k);
    for (const k of p.deletions) s.add(k);
    for (const k of p.appended.keys()) s.add(k);
    for (const k of p.styles.keys()) s.add(k);
    for (const k of p.colors.keys()) s.add(k);
    if ((p.baseStyle || p.baseColor || p.centerAll) && state.A) {
      for (const cp of charsOf(state.A.face)) s.add(cp);
    }
    return s.size;
  }

  function currentFace() {
    if (state.tab === 'A') return state.A ? state.A.face : null;
    return state.B ? state.B.face : null;
  }

  /* ----------------------------- 字形绘制 ----------------------------- */
  function drawContour(ctx, pts, k, ox, oy) {
    const n = pts.length;
    if (!n) return;
    const P = pts.map(p => ({ x: ox + p.x * k, y: oy - p.y * k, on: p.on }));
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const firstOn = P.findIndex(p => p.on);
    if (firstOn < 0) {
      const s0 = mid(P[n - 1], P[0]);
      ctx.moveTo(s0.x, s0.y);
      for (let i = 0; i < n; i++) {
        const q = P[i], m = mid(q, P[(i + 1) % n]);
        ctx.quadraticCurveTo(q.x, q.y, m.x, m.y);
      }
      ctx.closePath();
      return;
    }
    ctx.moveTo(P[firstOn].x, P[firstOn].y);
    let lastOff = null;
    for (let c = 1; c <= n; c++) {
      const p = P[(firstOn + c) % n];
      if (c === n) {
        if (lastOff) ctx.quadraticCurveTo(lastOff.x, lastOff.y, P[firstOn].x, P[firstOn].y);
        else ctx.lineTo(P[firstOn].x, P[firstOn].y);
        break;
      }
      if (p.on) {
        if (lastOff) { ctx.quadraticCurveTo(lastOff.x, lastOff.y, p.x, p.y); lastOff = null; }
        else ctx.lineTo(p.x, p.y);
      } else {
        if (lastOff) {
          const m = mid(lastOff, p);
          ctx.quadraticCurveTo(lastOff.x, lastOff.y, m.x, m.y);
        }
        lastOff = p;
      }
    }
    ctx.closePath();
  }

  function paintGlyph(ctx, contours, opt) {
    const upem = opt.upem || 1000;
    const style = opt.style || {};
    const scale = (style.scale === undefined ? 100 : style.scale) / 100;
    const k = (opt.size / upem) * scale;
    const dyPx = ((style.dy || 0) / 1000) * opt.size;
    const adv = (opt.advance || 0) * k;
    const ox = opt.cx - adv / 2;
    const oy = opt.baseline - dyPx;
    const color = opt.color || '#1c2126';
    const alpha = (style.shade === undefined ? 100 : style.shade) / 100;
    const weight = ((style.weight || 0) / 1000) * opt.size;

    let oxx = ox;
    if (style.center && contours.length) {
      let x0 = Infinity, x1 = -Infinity;
      for (const c of contours) for (const pt of c) {
        if (pt.x < x0) x0 = pt.x;
        if (pt.x > x1) x1 = pt.x;
      }
      if (x0 !== Infinity) oxx = opt.cx - ((x0 + x1) / 2) * k;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const c of contours) drawContour(ctx, c, k, oxx, oy);
    ctx.fill();
    if (weight > 0) {
      ctx.lineWidth = weight;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else if (weight < 0) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = -weight;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 取某字符在指定字体下的轮廓与宽度（含编辑结果） */
  function glyphFor(cp, kind) {
    if (kind === 'B') {
      const face = state.B && state.B.face;
      if (!face) return null;
      const gid = face.gidOf(cp);
      if (!gid) return null;
      const g = face.getGlyph(gid);
      return { contours: g.contours, advance: g.advance, upem: face.upem };
    }
    const face = state.A.face;
    const p = plan();
    if (p.appended.has(cp)) {
      const a = p.appended.get(cp);
      return { contours: a.contours, advance: a.advance, upem: face.upem };
    }
    if (p.deletions.has(cp)) return { contours: [], advance: 0, upem: face.upem };
    if (p.overrides.has(cp)) {
      const o = p.overrides.get(cp);
      return { contours: o.contours, advance: o.advance, upem: face.upem };
    }
    const gid = face.gidOf(cp);
    if (!gid) return null;
    const g = face.getGlyph(gid);
    return { contours: g.contours, advance: g.advance, upem: face.upem };
  }

  /** 原始轮廓（忽略一切编辑），用于「原」画布 */
  function origGlyphFor(cp) {
    const face = state.A && state.A.face;
    if (!face) return null;
    const gid = face.gidOf(cp);
    if (!gid) return null;
    const g = face.getGlyph(gid);
    return { contours: g.contours, advance: g.advance, upem: face.upem };
  }

  /* ----------------------------- 字符集合 ----------------------------- */
  function charsOf(face) {
    if (!face) return [];
    if (face._chars) return face._chars;
    const arr = [];
    for (const cp of face.cmap.keys()) {
      if (cp < 0x20 || cp === 0xffff || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) continue;
      arr.push(cp);
    }
    arr.sort((a, b) => a - b);
    face._chars = arr;
    return arr;
  }
  const isHan = cp => (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || cp >= 0x20000;
  const isLatin = cp => (cp >= 0x20 && cp <= 0x24f) || (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x0370 && cp <= 0x03ff);
  const isPunct = cp => (cp >= 0x2000 && cp <= 0x206f) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xff65) || (cp >= 0x21 && cp <= 0x40);

  function computeList() {
    const face = currentFace();
    if (!face) return [];
    let list = charsOf(face).slice();
    if (state.tab === 'A') {
      const p = plan();
      if (p.appended.size) {
        const extra = [...p.appended.keys()].filter(cp => !face.gidOf(cp));
        if (extra.length) { list = list.concat(extra); list.sort((a, b) => a - b); }
      }
    }
    if (state.filter === 'han') list = list.filter(isHan);
    else if (state.filter === 'latin') list = list.filter(isLatin);
    else if (state.filter === 'punct') list = list.filter(isPunct);
    else if (state.filter === 'edited') list = state.tab === 'A' ? list.filter(cp => isEdited(cp)) : [];
    const q = state.query.trim();
    if (q) {
      const range = q.match(/^([0-9a-f]{2,6})\s*[-~]\s*([0-9a-f]{2,6})$/i);
      if (range) {
        const a = parseInt(range[1], 16), b = parseInt(range[2], 16);
        list = list.filter(cp => cp >= a && cp <= b);
      } else if (q.length === 1) {
        const cp = q.codePointAt(0);
        list = list.filter(c => c === cp);
      } else if (/^[0-9a-f]{2,6}$/i.test(q)) {
        const n = parseInt(q, 16);
        list = list.filter(cp => cp === n || hex(cp).includes(q.toUpperCase().padStart(4, '0')));
      } else {
        const cps = Array.from(q).map(c => c.codePointAt(0));
        list = list.filter(cp => cps.includes(cp));
      }
    }
    return list;
  }

  /* ----------------------------- 网格（虚拟列表，DOM 只留可视行） ----------------------------- */
  const MAX_CELLS = 200000;
  let metrics = null;              // { cw, ch, gap, cols, rowH }
  let win = { i0: -1, i1: -1 };    // 当前 DOM 里装的是哪一段
  let prevSel = new Set();

  function computeMetrics() {
    const wrap = $('#gridWrap');
    const cs = getComputedStyle(wrap);
    const padL = parseFloat(cs.paddingLeft) || 14;
    const padR = parseFloat(cs.paddingRight) || 14;
    const avail = Math.max(160, wrap.clientWidth - padL - padR - 10);
    const gap = 7, minW = 74;
    const cols = Math.max(3, Math.floor((avail + gap) / (minW + gap)));
    const cw = Math.floor(((avail - gap * (cols - 1)) / cols) * 100) / 100;
    return { cw, ch: cw, gap, cols, rowH: cw + gap };
  }

  function makeCell(cp, i, m) {
    const cell = document.createElement('div');
    cell.className = 'cell' + (state.tab === 'B' ? ' b-font' : '');
    cell.dataset.cp = String(cp);
    cell.dataset.i = String(i);
    cell.style.width = m.cw + 'px';
    cell.style.height = m.ch + 'px';
    cell.style.transform = 'translate(' + ((i % m.cols) * (m.cw + m.gap)) + 'px,' + (Math.floor(i / m.cols) * m.rowH) + 'px)';
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    const lab = document.createElement('span');
    lab.className = 'cp';
    lab.textContent = hex(cp);
    cell.appendChild(lab);
    const ring = document.createElement('div');
    ring.className = 'press-ring';
    cell.appendChild(ring);
    return cell;
  }

  function renderGrid() {
    const grid = $('#grid');
    const wrap = $('#gridWrap');
    const empty = $('#gridEmpty');
    grid.innerHTML = '';
    grid.style.height = '0px';
    state.cells.clear();
    state.rendered = 0;
    state.list = computeList();
    state.fullList = state.list;
    if (state.list.length > MAX_CELLS) {
      state.list = state.list.slice(0, MAX_CELLS);
      if (!state.truncToast) {
        state.truncToast = true;
        toast('字符太多，先显示前 ' + MAX_CELLS + ' 个；用搜索或筛选缩小范围');
      }
    }
    empty.hidden = state.list.length > 0;
    if (!state.A && state.tab === 'A') {
      empty.innerHTML = '<div class="eh-glyph">字</div><p>先在左侧载入 A 字体</p><span>系统字面 PingFang.ttc 载入后会自动记住</span>';
      empty.hidden = false;
      return;
    }
    if (!state.list.length) {
      empty.innerHTML = '<div class="eh-glyph">空</div><p>没有匹配的字符</p><span>换个关键词或筛选条件</span>';
      empty.hidden = false;
      return;
    }
    prevSel = new Set();
    metrics = null;
    win = { i0: -1, i1: -1 };
    wrap.scrollTop = 0;
    metrics = computeMetrics();
    const rows = Math.ceil(state.list.length / metrics.cols);
    grid.style.height = Math.max(0, rows * metrics.rowH - metrics.gap) + 'px';
    renderWindow(true);
    syncSelectionUI();
  }

  /** 只把视口那几行塞进 DOM，其余用占位高度撑滚动条 */
  function renderWindow(force) {
    const wrap = $('#gridWrap'), grid = $('#grid');
    if (!wrap || !grid || !state.list.length) return;
    if (!metrics) metrics = computeMetrics();
    const m = metrics;
    const padTop = parseFloat(getComputedStyle(wrap).paddingTop) || 14;
    const visRows = Math.ceil(wrap.clientHeight / m.rowH) + 1;
    const startRow = Math.max(0, Math.floor((wrap.scrollTop - padTop) / m.rowH) - 1);
    const endRow = startRow + visRows + 2;
    const i0 = startRow * m.cols;
    const i1 = Math.min(state.list.length, (endRow + 1) * m.cols);
    if (!force && i0 === win.i0 && i1 === win.i1) return;
    win = { i0, i1 };

    const rows = Math.ceil(state.list.length / m.cols);
    grid.style.height = Math.max(0, rows * m.rowH - m.gap) + 'px';
    grid.innerHTML = '';
    state.cells.clear();
    const frag = document.createDocumentFragment();
    for (let i = i0; i < i1; i++) {
      const cp = state.list[i];
      const cell = makeCell(cp, i, m);
      state.cells.set(cp, cell);
      frag.appendChild(cell);
    }
    grid.appendChild(frag);
    state.rendered = i1;
    for (const [, cell] of state.cells) paintCell(cell, m.cw);
  }

  function paintVisibleNow() { renderWindow(false); }
  function appendAll() { renderWindow(true); }
  /* ----------------------------- 网格绘制 ----------------------------- */
  function unpaintCell(cell) {
    const cv = cell.querySelector('canvas');
    if (cv.width) { cv.width = 0; cv.height = 0; }
    cell.dataset.painted = '';
  }

  function repaintVisible() {
    renderWindow(true);
    syncSelectionUI();
  }

  function paintCell(cell, wHint) {
    const cp = +cell.dataset.cp;
    const cv = cell.querySelector('canvas');
    const w = wHint || cell.clientWidth || 0;
    if (!w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(w * dpr);
    if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, w);
    cell.dataset.painted = '1';
    cell.classList.toggle('sel', state.selection.has(cp));
    if (state.tab === 'A') cell.classList.toggle('dirty', isEdited(cp));
    const g = glyphFor(cp, state.tab);
    if (!g) return;
    const style = state.tab === 'A' ? styleFor(cp) : {};
    const color = state.tab === 'A' ? colorFor(cp) : null;
    const sc = ((style.scale === undefined ? 100 : style.scale) / 100) || 1;
    // 格子只是选字用的，放大到放不下时收一收，别让字形被裁掉
    const size = Math.min(w * 0.60, (w * 0.82) / Math.max(1, sc));
    paintGlyph(ctx, g.contours, {
      upem: g.upem, size, cx: w / 2, baseline: w * 0.79,
      advance: g.advance, color: color || '#1c2126', style
    });
  }

  function unpaintCell(cell) {
    const cv = cell.querySelector('canvas');
    if (cv.width) { cv.width = 0; cv.height = 0; }
    cell.dataset.painted = '';
  }

  function repaintVisible() {
    renderWindow(true);
    syncSelectionUI();
  }

  /** 改动角标：DOM 里只有可视那几十格，直接按当前窗口标 */
  function syncDirty() {
    for (const [cp, el] of state.cells) {
      el.classList.toggle('dirty', state.tab === 'A' && !!state.A && isEdited(cp));
    }
  }

  /* ----------------------------- 选择 ----------------------------- */
  function setSelection(cps) {
    state.selection = new Set(cps);
    syncSelectionUI();
  }
  function toggleSel(cp) {
    if (state.selection.has(cp)) state.selection.delete(cp);
    else state.selection.add(cp);
    syncSelectionUI();
  }
  function addSel(cp) {
    state.selection.add(cp);
    syncSelectionUI();
  }

  /** 区间连选：锚点 → 终点，含首尾 */
  function selectRange(fromCp, toCp) {
    const list = state.list;
    let i = list.indexOf(fromCp), j = list.indexOf(toCp);
    if (i < 0 || j < 0) { state.anchor = toCp; addSel(toCp); return; }
    const a = Math.min(i, j), b = Math.max(i, j);
    for (let k = a; k <= b; k++) state.selection.add(list[k]);
    state.anchor = fromCp;
    syncSelectionUI();
    if (b - a + 1 > 4) toast('区间连选：' + (b - a + 1).toLocaleString() + ' 个字符');
  }

  function chooseRange(from, to, tailAnchor) {
    selectRange(from, to);
    state.multi = true;
    state.rangeArm = true;
    if (tailAnchor) state.anchor = to;
  }
  function selectAllInList() {
    if (!state.list.length) return;
    state.multi = true;
    setSelection(state.list);
    repaintVisible();
    toast('已选中当前结果 ' + state.list.length + ' 个字符');
  }
  function selectEveryChar() {
    const face = currentFace();
    if (!face) return;
    const all = charsOf(face);
    state.multi = true;
    setSelection(all);
    repaintVisible();
    toast('已选中全部 ' + all.length + ' 个字符');
  }
  function clearSelection() {
    state.selection.clear();
    state.multi = false;
    state.anchor = null;
    state.rangeArm = false;
    syncSelectionUI();
    repaintVisible();
  }

  function syncSelectionUI() {
    // DOM 里只有可视那几十格，直接按当前窗口刷新选中态
    for (const [cp, el] of state.cells) el.classList.toggle('sel', state.selection.has(cp));
    syncDirty();
    prevSel = new Set(state.selection);
    const n = state.selection.size;
    $('#selNum').textContent = String(n);
    const isA = state.tab === 'A';
    $('#selActionsA').hidden = !isA;
    $('#selActionsB').hidden = isA;
    $$('[data-act]').forEach(b => {
      const act = b.dataset.act;
      if (act === 'copyToA' || act === 'replaceA') { b.disabled = n === 0 || !state.B; return; }
      b.disabled = n === 0;
    });
    const visible = state.list.length;
    const total = state.fullList ? state.fullList.length : visible;
    const cap = state.list.length < total;
    $('#selScope').textContent = visible
      ? (n ? '已选 ' + n.toLocaleString() + ' · ' : '') + '列表 ' + visible.toLocaleString() + (cap ? '（上限）' : '')
      : '';
    const cps = [...state.selection];
    $('#inspChars').textContent = n === 0 ? '未选择'
      : (n <= 12 ? cps.map(c => String.fromCodePoint(c)).join(' ') : cps.slice(0, 12).map(c => String.fromCodePoint(c)).join(' ') + ' …');
    if (n === 1) loadStyleIntoPanel(cps[0]);
    drawPreview();
  }

  function loadStyleIntoPanel(cp) {
    const p = plan();
    const st = styleFor(cp);
    if (!p.baseStyle) {
      $('#sScale').value = st.scale === undefined ? 100 : st.scale;
      $('#sWeight').value = st.weight || 0;
      $('#sTrack').value = st.tracking || 0;
      $('#sShade').value = st.shade === undefined ? 100 : st.shade;
      $('#sDy').value = st.dy || 0;
    }
    state.draftColor = colorFor(cp);
    syncOutputs();
    syncSwatches();
  }

  /* ----------------------------- 预览（单幅，跟随当前标签的字体） ----------------------------- */
  function drawPreview() {
    const cv = $('#previewCanvas'), box = $('#previewBox'), ph = $('#previewPh'), note = $('#previewNote');
    if (!cv || !box) return;
    const tab = state.tab === 'B' ? 'B' : 'A';
    const font = tab === 'A' ? state.A : state.B;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(240, Math.floor(box.clientWidth || 320));
    const H = 176;
    const pw = Math.round(W * dpr), phh = Math.round(H * dpr);
    if (cv.width !== pw || cv.height !== phh) { cv.width = pw; cv.height = phh; }
    cv.style.height = H + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const showPh = (msg) => {
      if (ph) { ph.hidden = false; const s = ph.querySelector('span'); if (s) s.textContent = msg; }
      cv.style.visibility = 'hidden';
      if (note) note.textContent = (tab === 'A' ? 'A' : 'B') + ' · ' + msg;
    };
    if (!font) {
      showPh(tab === 'A' ? '先在左侧载入 A 字体' : '先在左侧导入 B 字体');
      return;
    }

    if (ph) ph.hidden = true;
    cv.style.visibility = 'visible';

    const picked = [...state.selection].filter(cp => glyphFor(cp, tab));
    const showSample = picked.length === 0;
    const cps = (showSample ? [0x6C38, 0x548C, 0x4E5D, 0x5E74] : picked).slice(0, 8);
    const items = [];
    for (const cp of cps) {
      const g = glyphFor(cp, tab);
      if (g) items.push({ cp, g });
    }
    if (!items.length) {
      showPh(tab === 'B' ? 'B 字体里没有这些字符' : '没有可显示的字符');
      return;
    }

    const p = plan();
    const baseline = H - 58;
    ctx.strokeStyle = '#eef1f4';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(14, baseline + 0.5); ctx.lineTo(W - 14, baseline + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    let size = [0, 116, 96, 74, 60, 50, 43, 38, 33][items.length] || 33;
    const advanceOf = (it) => {
      const st = tab === 'A' ? styleFor(it.cp) : {};
      const k = (size / it.g.upem) * ((st.scale === undefined ? 100 : st.scale) / 100);
      return Math.max(size * 0.2, (it.g.advance || 0) * k + ((st.tracking || 0) / 1000) * size);
    };
    let total = items.reduce((s, it) => s + advanceOf(it), 0);
    if (total > W - 30) {
      size = Math.max(22, size * ((W - 30) / total));
      total = items.reduce((s, it) => s + advanceOf(it), 0);
    }
    let x = Math.max(12, (W - total) / 2);
    for (const it of items) {
      const adv = advanceOf(it);
      const st = tab === 'A' ? styleFor(it.cp) : {};
      const color = tab === 'A' ? (colorFor(it.cp) || '#1c2126') : '#1c2126';
      paintGlyph(ctx, it.g.contours, {
        upem: it.g.upem, size, cx: x + adv / 2, baseline, advance: it.g.advance, color, style: st
      });
      x += adv;
    }

    ctx.fillStyle = '#98a2ad';
    ctx.font = '9.5px ui-monospace, monospace';
    ctx.fillText('U+' + hex(items[0].cp) + (items.length > 1 ? '  ·  ' + items.length + ' 个' : ''), 14, 16);

    if (note) {
      if (tab === 'A') note.textContent = showSample ? 'A · 未选中，显示样张「永和九年」' : 'A · 改动后的字形，与导出同源';
      else note.textContent = showSample ? 'B · 未选中，显示样张' : 'B · 原字形，复制或替换后进 A';
    }
  }

  /* ----------------------------- 面板同步 ----------------------------- */
  const NUM_PAIRS = [['sScale', 'nScale'], ['sWeight', 'nWeight'], ['sTrack', 'nTrack'], ['sShade', 'nShade'], ['sDy', 'nDy'], ['sLine', 'nLine']];
  function syncOutputs() {
    for (const [sid, nid] of NUM_PAIRS) {
      const n = $('#' + nid);
      if (n && document.activeElement !== n) n.value = $('#' + sid).value;
    }
  }
  function syncSwatches() {
    $$('#swatches .sw').forEach(el => {
      el.classList.toggle('active', (el.dataset.color || null) === (state.draftColor || null));
    });
    if (state.draftColor) {
      $('#colorHex').value = state.draftColor.toUpperCase();
      $('#colorPick').value = state.draftColor;
    } else {
      $('#colorHex').value = '';
    }
  }
  function draftStyle() {
    return {
      scale: +$('#sScale').value,
      weight: +$('#sWeight').value,
      tracking: +$('#sTrack').value,
      shade: +$('#sShade').value,
      dy: +$('#sDy').value,
      dirty: true
    };
  }

  /** 面板一改就整面生效：不再有「应用到所选字符」这一步 */
  function liveApplyStyle() {
    if (!state.A) { drawPreview(); return; }
    const p = plan();
    const st = draftStyle();
    const neutral = st.scale === 100 && st.weight === 0 && st.tracking === 0 &&
      st.shade === 100 && st.dy === 0 && !state.centerAll;
    p.baseStyle = neutral ? null : Object.assign(st, { center: state.centerAll ? 1 : 0 });
    const ink = state.draftColor && state.draftColor.toLowerCase();
    // 默认墨色不算上色，免得整面 3 万字都去生成 COLR 层
    p.baseColor = (!ink || ink === '#1c2126') ? null : state.draftColor;
    p.centerAll = !!state.centerAll;
    p.lineGap = +$('#sLine').value || null;
    repaintVisible();
    syncSelectionUI();
    updateCounts();
  }

  function syncCenterBtn() {
    const b = $('#btnCenter');
    if (!b) return;
    b.classList.toggle('on', !!state.centerAll);
    b.setAttribute('aria-pressed', state.centerAll ? 'true' : 'false');
  }

  function syncPanelsFromPlan() {
    if (!state.A) return;
    const p = plan();
    const b = p.baseStyle || {};
    $('#sScale').value = b.scale === undefined ? 100 : b.scale;
    $('#sWeight').value = b.weight === undefined ? 0 : b.weight;
    $('#sTrack').value = b.tracking === undefined ? 0 : b.tracking;
    $('#sShade').value = b.shade === undefined ? 100 : b.shade;
    $('#sDy').value = b.dy === undefined ? 0 : b.dy;
    $('#sLine').value = p.lineGap || state.A.face.lineGap || 0;
    state.centerAll = !!p.centerAll;
    state.draftColor = p.baseColor || null;
    syncOutputs();
    syncCenterBtn();
    syncSwatches();
  }

  /* ----------------------------- 字体装载 ----------------------------- */
  function faceSelectFill(sel, collection, current) {
    sel.innerHTML = '';
    const groups = new Map();
    collection.faces.forEach((f, i) => {
      const key = f.familyName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ f, i });
    });
    for (const [family, arr] of groups) {
      const og = document.createElement('optgroup');
      og.label = family;
      for (const { f, i } of arr) {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `${f.subfamilyName} · ${f.psName}`;
        if (i === current) o.selected = true;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
  }

  async function loadAFont(file, keepFace) {
    state.busy = true;
    loading(true, '读取字体文件…');
    try {
      const buf = await file.arrayBuffer();
      await loadAFromBuffer(buf, file.name, keepFace);
    } catch (e) {
      console.error(e);
      toast('字体解析失败：' + e.message, true);
      loading(false);
      state.busy = false;
    }
  }

  /** 由字节装载 A（文件输入与开发预览共用） */
  async function loadAFromBuffer(buf, fileName, keepFace) {
    state.busy = true;
    loading(true, '解析字体结构…');
    try {
      await new Promise(r => setTimeout(r, 16));
      const col = FE.parse(new Uint8Array(buf));
      if (!col.faces.length) throw new Error('没有可用的字面');
      let idx = 0;
      if (keepFace && state.A) idx = Math.min(state.A.faceIndex, col.faces.length - 1);
      const shared = FE.canShareTables(col.faces);
      state.A = { fileName, collection: col, faces: col.faces, faceIndex: idx, face: col.faces[idx], shared };
      state.plans.clear();
      state.undo = [];
      state.selection.clear();
      state.multi = false;
      state.truncToast = false;
      try {
        await kvSet('A', { name: fileName, buffer: buf, faceIndex: idx, savedAt: Date.now() });
        state.savedOk = true;
      } catch (err) {
        console.warn('本机存档不可用（下次需重新导入）', err);
        state.savedOk = false;
      }
      afterAFont();
      if (state.savedOk === false) $('#aHint').textContent = '当前环境无法把字体存到本机，下次打开需要重新导入一次。';
      toast(`已载入 ${fileName} · ${col.totalFaces} 个字面`);
    } finally {
      state.busy = false;
      loading(false);
    }
  }

  function afterAFont() {
    const A = state.A;
    $('#aName').textContent = A.face.familyName;
    $('#aName').classList.remove('dim');
    $('#aFile').textContent = A.fileName;
    $('#aFormat').textContent = A.collection.format + (A.face.isOTF ? ' · CFF' : ' · TrueType');
    $('#aUpem').textContent = A.face.upem;
    $('#aFaces').textContent = A.collection.totalFaces + ' 个';
    $('#aChars').textContent = A.face.charCount.toLocaleString();
    $('#aGlyphs').textContent = A.face.numGlyphs.toLocaleString();
    const sharedEl = $('#aShared');
    if (A.collection.totalFaces > 1) {
      sharedEl.innerHTML = A.shared
        ? '<span class="badge">共享轮廓</span>'
        : '<span class="badge warn">各自独立</span>';
    } else {
      sharedEl.textContent = '单字面';
    }
    $('#aHint').textContent = A.shared && A.collection.totalFaces > 1
      ? `合集 ${A.collection.totalFaces} 个字面共用同一套轮廓，改动对全部字面同时生效；导出可打包回 .ttc。`
      : `当前字面 ${A.face.familyName} ${A.face.subfamilyName}，已记在本机，下次无需再导入。`;
    $('#aFaceField').hidden = A.collection.totalFaces <= 1;
    faceSelectFill($('#aFaceSelect'), A.collection, A.faceIndex);
    $('#chipA').classList.add('on');
    $('#chipA').lastElementChild.textContent = 'A · ' + A.fileName;
    $('#chipA').firstElementChild.classList.add('on');
    $('#btnExport').disabled = false;
    $('#btnWipe').disabled = false;
    $('#onboard').classList.add('hide');
    $('#sLine').value = plan().lineGap === null ? (A.face.lineGap || 0) : plan().lineGap;
    syncOutputs();
    syncCenterBtn();
    const osNote = $('#oneShotNote');
    if (osNote) osNote.textContent = `A 已就位（${A.fileName}）${state.B ? '，B 也选好了，可以直接一键出成品。' : '。接着只上传 B 字体，剩下的交给它。'}`;
    updateCollCard();
    renderGrid();
    updateCounts();
  }

  function updateCollCard() {
    const card = $('#cardColl');
    if (!state.A || state.A.collection.totalFaces <= 1) { card.hidden = true; return; }
    card.hidden = false;
    const A = state.A;
    $('#collTitle').textContent = `${A.collection.totalFaces} 个字面 · ${A.collection.format}`;
    $('#collInfo').textContent = A.shared
      ? '各字面共享 glyf/loca/hmtx 同一套轮廓表：一次改动即覆盖合集内全部字面，导出打包回 .ttc 时逐字面保留各自的 name 与字重。'
      : '各字面轮廓相互独立：合集操作会逐个字面写入同一份字形，耗时随字面数增长。';
    $$('[data-coll]').forEach(b => { b.disabled = !state.B; });
    $('#btnCollWipe').disabled = false;
  }

  function afterBFont() {
    if (!state.B) {
      $('#bLoaded').hidden = true;
      $('#bEmptyHint').hidden = false;
      $('#chipB').classList.remove('on');
      $('#chipB').lastElementChild.textContent = 'B · 未载入';
      $('#chipB').firstElementChild.classList.remove('on');
      $('#tabCountB').textContent = '0';
      $$('[data-coll]').forEach(b => { b.disabled = true; });
      $$('.bulk-grid [id^=btnRepl]').forEach(b => { b.disabled = true; });
      if (state.tab === 'B') state.tab = 'A';
      return;
    }
    const B = state.B;
    $('#bLoaded').hidden = false;
    $('#bEmptyHint').hidden = true;
    $('#bName').textContent = B.face.familyName;
    $('#bFormat').textContent = B.collection.format + (B.face.isOTF ? ' · CFF' : ' · TrueType');
    $('#bFaces').textContent = B.collection.totalFaces + ' 个';
    $('#bChars').textContent = B.face.charCount.toLocaleString();
    $('#bFaceField').hidden = B.collection.totalFaces <= 1;
    faceSelectFill($('#bFaceSelect'), B.collection, B.faceIndex);
    $('#chipB').classList.add('on');
    $('#chipB').lastElementChild.textContent = 'B · ' + B.fileName;
    $('#chipB').firstElementChild.classList.add('on');
    $('#tabCountB').textContent = B.face.charCount.toLocaleString();
    $$('[data-coll]').forEach(b => { b.disabled = false; });
    syncWriteInfo();
    updateCollCard();
    syncSelectionUI();
    const note = $('#oneShotNote');
    if (note) note.textContent = `已就绪：B 有 ${B.face.charCount.toLocaleString()} 个字符。点下面的按钮，清空 A 全部字符后整批灌入并直接导出。`;
    if (state.oneShotPendingAt && Date.now() - state.oneShotPendingAt < 90000) { state.oneShotPendingAt = 0; setTimeout(runOneShot, 60); }
  }

  async function loadBFont(file) {
    loading(true, '读取 B 字体…');
    try {
      const buf = await file.arrayBuffer();
      await loadBFromBuffer(buf, file.name);
    } catch (e) {
      toast('B 字体解析失败：' + e.message, true);
      loading(false);
    }
  }

  async function loadBFromBuffer(buf, fileName) {
    try {
      const col = FE.parse(new Uint8Array(buf));
      if (!col.faces.length) throw new Error('没有可用的字面');
      state.B = { fileName, collection: col, faces: col.faces, faceIndex: 0, face: col.faces[0] };
      afterBFont();
      if (state.tab === 'B') renderGrid();
      toast(`B 字体：${col.faces[0].familyName} · ${col.totalFaces} 个字面`);
    } finally { loading(false); }
  }

  function switchAFace(idx) {
    if (!state.A) return;
    state.A.faceIndex = idx;
    state.A.face = state.A.faces[idx];
    state.selection.clear();
    plan();
    $('#aName').textContent = state.A.face.familyName;
    $('#aChars').textContent = state.A.face.charCount.toLocaleString();
    $('#aGlyphs').textContent = state.A.face.numGlyphs.toLocaleString();
    $('#sLine').value = plan().lineGap === null ? (state.A.face.lineGap || 0) : plan().lineGap;
    syncOutputs();
    renderGrid();
    updateCounts();
    clearTimeout(switchAFace._t);
    switchAFace._t = setTimeout(() => {
      try {
        kvSet('A', { name: state.A.fileName, buffer: state.A.collection.bytes.buffer, faceIndex: idx, savedAt: Date.now() }).catch(() => {});
      } catch (e) { /* ignore */ }
    }, 400);
  }

  function switchBFace(idx) {
    if (!state.B) return;
    state.B.faceIndex = idx;
    state.B.face = state.B.faces[idx];
    state.selection.clear();
    afterBFont();
    if (state.tab === 'B') renderGrid();
  }

  function updateCounts() {
    $('#tabCountA').textContent = state.A ? state.A.face.charCount.toLocaleString() : '0';
    $('#tabCountB').textContent = state.B ? state.B.face.charCount.toLocaleString() : '0';
  }

  /* ----------------------------- 字符操作 ----------------------------- */
  function applyOne(p, aFace, bFace, cp, mode) {
    const bgid = bFace.gidOf(cp);
    if (!bgid) return 0;
    const s = aFace.upem / bFace.upem;
    const bg = bFace.getGlyph(bgid);
    let contours = bg.contours.map(c => c.map(pt => ({ x: pt.x * s, y: pt.y * s, on: pt.on })));
    const bAdv = Math.round((bg.advance || bFace.advanceOf(bgid)) * s);
    const agid = aFace.gidOf(cp);
    if (agid) {
      if (mode === 'copy') {
        const aAdv = aFace.advanceOf(agid);
        const bb = FE.contourBBox(contours);
        if (bb) {
          const dx = Math.round((aAdv - (bb.xMax - bb.xMin)) / 2 - bb.xMin);
          contours = contours.map(c => c.map(pt => ({ x: pt.x + dx, y: pt.y, on: pt.on })));
        }
        p.overrides.set(cp, { contours, advance: aAdv });
      } else {
        p.overrides.set(cp, { contours, advance: bAdv });
      }
      p.deletions.delete(cp);
      p.appended.delete(cp);
    } else {
      p.appended.set(cp, { contours, advance: bAdv });
      p.deletions.delete(cp);
    }
    return 1;
  }

  function copyFromB(mode) {
    if (!state.B || !state.A || !state.selection.size) {
      if (!state.selection.size) toast('先选几个字符');
      return;
    }
    pushUndo();
    const p = plan(), aFace = state.A.face, bFace = state.B.face;
    let done = 0, skipped = 0;
    for (const cp of state.selection) {
      if (applyOne(p, aFace, bFace, cp, mode)) done++;
      else skipped++;
    }
    repaintVisible();
    syncSelectionUI();
    if (state.tab === 'A') renderGrid();
    toast(`${mode === 'copy' ? '复制' : '替换'}完成：${done} 个字符${skipped ? `，跳过 ${skipped} 个（B 无此字符）` : ''}`);
  }

  /** 全部字符：把 B 的整套字形灌进 A（单字面或整个合集） */
  async function bulkFromB(mode, scope, includeNew) {
    if (!state.A || !state.B || state.busy) return;
    // 共享轮廓的合集：物理上只有一套表，处理一次就覆盖全部字面
    const shared = state.A.shared;
    const aFaces = scope === 'collection' && !shared ? state.A.faces : [state.A.face];
    const faceIdx = scope === 'collection' && !shared ? state.A.faces.map((_, i) => i) : [state.A.faceIndex];
    if (!shared && aFaces.length > 20) {
      toast('该合集各字面轮廓独立，一次灌入 ' + aFaces.length + ' 面会非常吃内存；建议先单字面导出', true);
      return;
    }
    pushUndo();
    state.busy = true;
    const bFace = state.B.face;
    const bChars = charsOf(bFace);
    let done = 0, skipped = 0, added = 0;
    loading(true, '批量灌入字形…');
    try {
      for (let fi = 0; fi < aFaces.length; fi++) {
        const aFace = aFaces[fi];
        const p = planFor(faceIdx[fi]);
        for (let k = 0; k < bChars.length; k++) {
          const cp = bChars[k];
          const agid = aFace.gidOf(cp);
          if (!agid && !includeNew) { skipped++; continue; }
          if (applyOne(p, aFace, bFace, cp, mode)) {
            done++;
            if (!agid) added++;
          }
          if (k % 600 === 0) {
            const pct = Math.round((k / bChars.length) * 100);
            $('#loadText').textContent = `批量灌入字形… ${aFaces.length > 1 ? `字面 ${fi + 1}/${aFaces.length}` : ''} ${pct}%`;
            if (k % 1800 === 0) bFace._glyphCache.clear();
            await idle();
          }
        }
      }
      bFace._glyphCache.clear();
      if (state.A.face._glyphCache) state.A.face._glyphCache.clear();
      if (state.tab === 'A' && added) renderGrid();
      else repaintVisible();
      syncSelectionUI();
      updateCollCard();
      const scopeText = scope === 'collection' ? `合集 ${state.A.collection.totalFaces} 个字面` : 'A 字体';
      toast(`${mode === 'copy' ? '复制' : '替换'}到${scopeText}完成：${done} 个字符${added ? `（新增 ${added}）` : ''}${skipped ? `，跳过 ${skipped}` : ''}`);
    } catch (e) {
      console.error(e);
      toast('批量操作失败：' + e.message, true);
    } finally {
      state.busy = false;
      loading(false);
    }
  }

  /* ----------------------------- 一键成品 ----------------------------- */
  function oneShot() {
    if (state.busy) return;
    if (!state.A) {
      $('#onboard').classList.remove('hide');
      $('#onboardNote').textContent = '点「选择 PingFang.ttc」一次，之后会自动记住';
      toast('先让 A 字体就位：选一次 PingFang.ttc');
      return;
    }
    if (!state.B) {
      state.oneShotPendingAt = Date.now();
      $('#oneShotNote').textContent = '等你在 B 卡片里选字体…选完会自动开始清空 + 灌入';
      toast('先选 B 字体，选完就自动开始');
      $('#fileB').click();
      return;
    }
    runOneShot();
  }

  async function runOneShot() {
    if (!state.A || !state.B || state.busy) return;
    const scope = state.A.collection.totalFaces > 1 ? 'collection' : 'face';
    $('#btnOneShot').disabled = true;
    try {
      loading(true, '清空 A 的全部字符…');
      wipeAll(scope);                     // 连同样式、颜色一起清掉
      await idle();
      state.bulkMode = 'copy';            // 只换字形，宽度仍按 A
      $$('#bulkMode button').forEach(b => b.classList.toggle('on', b.dataset.bulkmode === 'copy'));
      await bulkFromB('copy', scope, true);
      if (state.A) {
        toast('已灌完：B 的全部字符已复制进 A，接下来选导出');
        openExport();
      }
    } catch (e) {
      console.error(e);
      toast('一键替换失败：' + e.message, true);
    } finally {
      $('#btnOneShot').disabled = false;
      loading(false);
    }
  }

  function clearGlyphs() {
    if (!state.A || !state.selection.size) return;
    pushUndo();
    const p = plan();
    for (const cp of state.selection) {
      if (p.appended.has(cp)) { p.appended.delete(cp); continue; }
      if (state.A.face.gidOf(cp)) p.deletions.add(cp);
      p.overrides.delete(cp);
    }
    repaintVisible();
    syncSelectionUI();
    toast(`已清空 ${state.selection.size} 个字符的字形`);
  }

  function restoreGlyphs() {
    if (!state.A || !state.selection.size) return;
    pushUndo();
    const p = plan();
    for (const cp of state.selection) {
      p.overrides.delete(cp);
      p.deletions.delete(cp);
      p.appended.delete(cp);
      p.styles.delete(cp);
      p.colors.delete(cp);
    }
    repaintVisible();
    syncSelectionUI();
    if (state.selection.size === 1) loadStyleIntoPanel([...state.selection][0]);
    toast('已恢复原字形');
  }

  function clearAllReplacements() {
    if (!state.A || !state.B) return;
    pushUndo();
    const p = plan(), bFace = state.B.face;
    let n = 0;
    for (const cp of charsOf(bFace)) {
      if (p.overrides.delete(cp)) n++;
      if (p.appended.delete(cp)) n++;
      p.deletions.delete(cp);
    }
    repaintVisible();
    if (state.tab === 'A') renderGrid();
    syncSelectionUI();
    toast(`已清除 ${n} 处来自 B 的字形`);
  }

  function wipeAll(kind) {
    if (!state.A) return;
    pushUndo();
    if (kind === 'collection' && !state.A.shared) {
      state.A.faces.forEach((f, i) => {
        const p = planFor(i);
        p.overrides.clear(); p.appended.clear(); p.styles.clear(); p.colors.clear();
        p.baseStyle = null; p.baseColor = null; p.centerAll = false;
        p.deletions = new Set(charsOf(f));
      });
    } else {
      const p = plan();
      p.overrides.clear();
      p.appended.clear();
      p.styles.clear();
      p.colors.clear();
      p.baseStyle = null; p.baseColor = null; p.centerAll = false;
      p.deletions = new Set(charsOf(state.A.face));
    }
    state.selection.clear();
    state.multi = false;
    repaintVisible();
    renderGrid();
    if (state.A.face._glyphCache) state.A.face._glyphCache.clear();
    toast(kind === 'collection' ? '合集内所有字面的字符已清空（可撤销）' : 'A 字体的全部字符已被清空（可撤销）');
  }

  function resetAllEdits() {
    if (!state.A) return;
    pushUndo();
    state.plans.set(planKey(), newPlan());
    state.selection.clear();
    state.centerAll = false;
    state.draftColor = null;
    syncPanelsFromPlan();
    repaintVisible();
    syncSelectionUI();
    toast('已撤销当前字面的全部编辑');
  }

  function undo() {
    const u = state.undo.pop();
    if (!u) { toast('没有可撤销的操作'); return; }
    restoreSnap(u);
    syncPanelsFromPlan();
    renderGrid();
    updateCounts();
    updateUndoBtn();
    toast('已撤销上一步');
  }

  /* ----------------------------- 导出 ----------------------------- */
  function openExport() {
    if (!state.A) return;
    const face = state.A.face;
    const base = face.psName.replace(/^\./, '').replace(/[^\w\-.]/g, '') || 'font';
    const multi = state.A.collection.totalFaces > 1;
    state.expKind = multi && state.A.shared ? 'ttc' : 'ttf';
    $('#expKind').hidden = !multi;
    $$('#expKind button').forEach(b => b.classList.toggle('on', b.dataset.kind === state.expKind));
    syncExportInfo();
    const orig = state.A.fileName || (face.psName + '.ttf');
    const stem = orig.replace(/\.(ttf|ttc|otc|otf|woff2?)$/i, '');
    $('#expName').value = stem + (state.expKind === 'ttc' ? '.ttc' : '.ttf');
    $('#expBar').style.width = '0%';
    $('#btnExpGo').disabled = false;
    showModal('#modalExport');
  }

  function syncExportInfo() {
    const A = state.A, face = A.face;
    const ttc = state.expKind === 'ttc';
    if (ttc) {
      $('#expFormat').textContent = 'TrueType Collection (.ttc) · ' + A.collection.totalFaces + ' 个字面';
      $('#expFamily').textContent = A.collection.faces.length + ' 个字面 · 名称逐个保留';
      $('#expCounts').textContent = `${face.charCount.toLocaleString()} 字符 · ${face.numGlyphs.toLocaleString()} 字形 × ${A.collection.totalFaces} 字面`;
      $('#exportNote').textContent = '逐字面保留原始 name / OS/2 与字重，共享一份重建后的 glyf；每个字面写入各自的 checkSumAdjustment。未改字符按原始字节复制。文件名沿用原文件 ' + A.fileName + '。';
    } else {
      $('#expFormat').textContent = face.isOTF ? 'TrueType (.ttf) · 由 CFF 轮廓转换' : 'TrueType (.ttf) · 与原文件一致';
      $('#expFamily').textContent = face.familyName + ' / ' + face.subfamilyName;
      $('#expCounts').textContent = `${face.charCount.toLocaleString()} 字符 · ${face.numGlyphs.toLocaleString()} 字形`;
      $('#exportNote').textContent = face.isOTF
        ? 'name、OS/2、字重等表原样保留；CFF 轮廓会转换为 TrueType 轮廓写入（容器仍改名 .ttf），字符名称与字面信息不变。'
        : 'name、OS/2、GSUB、字重等表原样保留；未改动字符按原始字节写入，只重写被改动字符的 glyf 轮廓与宽度。文件名沿用原文件 ' + A.fileName + '。';
    }
    $('#expEdited').textContent = editedCount().toLocaleString() + ' 个';
    const nm = $('#expName').value || '';
    if (nm) $('#expName').value = nm.replace(/\.(ttf|ttc|otf)$/i, ttc ? '.ttc' : '.ttf');
  }

  function buildPayload() {
    const face = state.A.face;
    const p = plan();
    const mapped = {
      overrides: new Map(), empties: new Set(), appended: [], styles: new Map(), colors: new Map(),
      lineGap: p.lineGap
    };
    for (const [cp, o] of p.overrides) {
      const gid = face.gidOf(cp);
      if (gid) mapped.overrides.set(gid, o);
    }
    for (const cp of p.deletions) {
      const gid = face.gidOf(cp);
      if (gid) mapped.empties.add(gid);
    }
    for (const [cp, a] of p.appended) {
      mapped.appended.push({ cp, contours: a.contours, advance: a.advance });
    }
    // 全字面统一样式：按 gid 直接落到每个字形，TTC 各字面一起生效
    if (p.baseStyle) mapped.globalStyle = Object.assign({ dirty: true }, p.baseStyle);
    if (p.baseColor) {
      const rgb = hexToRgb(p.baseColor);
      if (rgb) mapped.globalColor = rgb;
    }
    for (const [cp, st] of p.styles) mapped.styles.set(cp, Object.assign({ dirty: true }, st));
    for (const [cp, hexv] of p.colors) {
      const rgb = hexToRgb(hexv);
      if (rgb) mapped.colors.set(cp, rgb);
    }
    return mapped;
  }

  function doExport() {
    if (!state.A) return;
    const face = state.A.face;
    const kind = state.expKind;
    const name = ($('#expName').value || 'font').replace(/[\/\\:*?"<>|]/g, '_');
    $('#btnExpGo').disabled = true;
    $('#expBar').style.width = '8%';
    loading(true, kind === 'ttc' ? '重建合集，逐字面写入…' : (face.isOTF ? '转换 CFF 轮廓并重建…' : '重建 glyf / hmtx / cmap…'));
    setTimeout(() => {
      try {
        const payload = buildPayload();
        let bytes, ext;
        if (kind === 'ttc') {
          const res = FE.buildCollection(state.A.faces, payload, progress => {
            $('#expBar').style.width = (8 + progress * 88) + '%';
          });
          bytes = res.bytes;
          ext = '.ttc';
        } else {
          const res = FE.buildFont(face, payload, progress => {
            $('#expBar').style.width = (8 + progress * 88) + '%';
          });
          bytes = res.bytes;
          ext = '.ttf';
        }
        $('#expBar').style.width = '100%';
        const blob = new Blob([bytes], { type: 'font/ttf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name.replace(/\.(ttf|ttc|otf)$/i, '') + ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast(`已导出 ${a.download} · ${fmtSize(bytes.length)}`);
        setTimeout(() => hideModal('#modalExport'), 500);
      } catch (e) {
        console.error(e);
        toast('导出失败：' + e.message, true);
      } finally {
        loading(false);
        $('#btnExpGo').disabled = false;
      }
    }, 80);
  }

  /* ----------------------------- 写字符 ----------------------------- */
  function parseWrite() {
    const txt = $('#writeInput').value || '';
    const out = [];
    const seen = new Set();
    for (const ch of Array.from(txt)) {
      if (ch === '\n' || ch === '\r' || ch === '\t' || ch === ' ') continue;
      const cp = ch.codePointAt(0);
      if (seen.has(cp)) continue;
      seen.add(cp);
      out.push(cp);
    }
    return out;
  }

  function syncWriteInfo() {
    const cps = parseWrite();
    $('#writeCount').textContent = cps.length + ' 字';
    const aFace = state.A && state.A.face;
    const bFace = state.B && state.B.face;
    if (!cps.length) { $('#writeInfo').textContent = '—'; return; }
    const inA = aFace ? cps.filter(cp => aFace.gidOf(cp)).length : 0;
    const inB = bFace ? cps.filter(cp => bFace.gidOf(cp)).length : 0;
    $('#writeInfo').textContent = `A 有 ${inA} · B 有 ${inB}`;
  }

  function selectWritten(quiet) {
    const cps = parseWrite();
    if (!cps.length) { if (!quiet) toast('先在框里写几个字'); return; }
    const face = currentFace();
    if (!face) { if (!quiet) toast('先载入字体'); return; }
    const ok = [];
    for (const cp of cps) if (face.gidOf(cp)) ok.push(cp);
    state.multi = true;
    setSelection(ok);
    repaintVisible();
    syncWriteInfo();
    if (!quiet) {
      toast(`已选中写的 ${ok.length} 个字${ok.length < cps.length ? `（另有 ${cps.length - ok.length} 个当前字体没有）` : ''}`);
    }
  }

  /* ----------------------------- 弹窗 ----------------------------- */
  function showModal(sel) { $(sel).classList.add('show'); }
  function hideModal(sel) { $(sel).classList.remove('show'); }

  /* ----------------------------- 事件绑定 ----------------------------- */
  function bind() {
    $('#fileA').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) loadAFont(f);
    });
    $('#fileB').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) loadBFont(f);
    });
    $('#btnBImport').addEventListener('click', () => $('#fileB').click());
    $('#btnBootPick').addEventListener('click', () => $('#fileA').click());
    $('#btnSwapA').addEventListener('click', () => {
      const name = state.A ? state.A.name : '';
      const txt = $('#swapText');
      if (txt) txt.textContent = (!name || /^pingfang/i.test(name))
        ? '原 A 字体系统已经被设计为 PingFang.ttc 字体文件，你确认要换掉 A 字体的文件吗？'
        : '当前 A 字体为 ' + name + '，你确认要换掉 A 字体的文件吗？';
      showModal('#modalSwap');
    });
    $('#btnSwapB').addEventListener('click', () => $('#fileB').click());
    $('#btnWipe').addEventListener('click', () => {
      if (!state.A) return;
      $('#wipeTitle').textContent = '删除 A 字体里面的全部字符？';
      $('#wipeText').textContent = '所有字形轮廓将被清空（宽度归零），字体名称与表结构保留。此操作可撤销。';
      $('#btnWipeConfirm').textContent = '确认清空';
      $('#btnWipeConfirm').dataset.kind = 'single';
      showModal('#modalWipe');
    });
    $('#btnCollWipe').addEventListener('click', () => {
      if (!state.A) return;
      const n = state.A.collection.totalFaces;
      const shared = state.A.shared;
      $('#wipeTitle').textContent = `清空合集内 ${n} 个字面的全部字符？`;
      $('#wipeText').textContent = shared
        ? '合集共用同一套轮廓，清空一次即覆盖全部字面；字体名称、字重与表结构保留。此操作可撤销。'
        : `将逐个清空 ${n} 个字面的字符（宽度归零），耗时较长。此操作可撤销。`;
      $('#btnWipeConfirm').textContent = '确认清空合集';
      $('#btnWipeConfirm').dataset.kind = 'collection';
      showModal('#modalWipe');
    });
    $('#btnSwapCancel').addEventListener('click', () => hideModal('#modalSwap'));
    $('#btnSwapConfirm').addEventListener('click', () => { hideModal('#modalSwap'); $('#fileA').click(); });
    $('#btnWipeCancel').addEventListener('click', () => hideModal('#modalWipe'));
    $('#btnWipeConfirm').addEventListener('click', e => {
      const kind = e.currentTarget.dataset.kind || 'single';
      hideModal('#modalWipe');
      wipeAll(kind);
    });
    $('#btnExport').addEventListener('click', openExport);
    $('#btnExpCancel').addEventListener('click', () => hideModal('#modalExport'));
    $('#btnExpGo').addEventListener('click', doExport);
    $('#expName').addEventListener('change', syncExportInfo);

    // 替换 B 面板
    $('#btnReplSel').addEventListener('click', () => copyFromB(state.bulkMode));
    $('#btnReplAll').addEventListener('click', () => bulkFromB(state.bulkMode, 'single', false));
    $('#btnReplEvery').addEventListener('click', () => bulkFromB(state.bulkMode, 'single', true));
    $('#btnReplClear').addEventListener('click', clearAllReplacements);
    $$('#bulkMode button').forEach(b => b.addEventListener('click', () => {
      state.bulkMode = b.dataset.bulkmode;
      $$('#bulkMode button').forEach(x => x.classList.toggle('on', x === b));
      $('#bulkStat').textContent = state.bulkMode === 'copy'
        ? '复制：字形与宽度都取 B，按 A 的字符宽度重新居中。'
        : '替换：字形与宽度都按 B 落地，A 的原有宽度不再保留。';
    }));

    // 合集
    $$('[data-coll]').forEach(b => b.addEventListener('click', () => {
      bulkFromB(b.dataset.coll, 'collection', true);
    }));

    // 写字符
    let wt = null;
    $('#writeInput').addEventListener('input', () => {
      syncWriteInfo();
      clearTimeout(wt);
      wt = setTimeout(() => selectWritten(true), 320);
    });
    $('#btnWriteSel').addEventListener('click', () => selectWritten(false));

    // 整页拖放
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => {
      e.preventDefault();
    }));
    document.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      if (!state.A) loadAFont(f);
      else if (e.target.closest('#cardB')) loadBFont(f);
      else loadAFont(f);
    });

    $('#aFaceSelect').addEventListener('change', e => switchAFace(+e.target.value));
    $('#bFaceSelect').addEventListener('change', e => switchBFace(+e.target.value));

    $$('.tab').forEach(t => t.addEventListener('click', () => {
      const tab = t.dataset.tab;
      if (tab === 'B' && !state.B) { $('#fileB').click(); return; }
      state.tab = tab;
      $$('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
      state.selection.clear();
      state.multi = false;
      state.anchor = null;
      state.rangeArm = false;
      renderGrid();
      updateCounts();
    }));

    $$('.pill').forEach(p => p.addEventListener('click', () => {
      state.filter = p.dataset.filter;
      $$('.pill').forEach(x => x.classList.toggle('active', x.dataset.filter === state.filter));
      state.anchor = null;
      state.rangeArm = false;
      renderGrid();
    }));

    let st = null;
    $('#search').addEventListener('input', e => {
      clearTimeout(st);
      st = setTimeout(() => { state.query = e.target.value; renderGrid(); }, 160);
    });

    bindGrid();

    let scT = 0;
    $('#gridWrap').addEventListener('scroll', () => {
      if (scT) return;
      scT = setTimeout(() => { scT = 0; paintVisibleNow(); }, 24);
    });
    window.addEventListener('resize', () => { metrics = null; renderWindow(true); });

    $('#btnSelAll').addEventListener('click', selectAllInList);
    $('#btnSelEvery').addEventListener('click', selectEveryChar);
    $('#btnSelNone').addEventListener('click', clearSelection);

    $$('[data-act]').forEach(b => b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'deselect') { clearSelection(); return; }
      if (act === 'copyToA') copyFromB('copy');
      else if (act === 'replaceA') copyFromB('replace');
      else if (act === 'clearGlyph') clearGlyphs();
      else if (act === 'restore') restoreGlyphs();
    }));

    // 改一下就整面生效，不用再点按钮
    ['#sScale', '#sWeight', '#sTrack', '#sShade', '#sDy', '#sLine'].forEach(id => {
      const el = $(id);
      el.addEventListener('pointerdown', () => pushUndo());
      el.addEventListener('keydown', () => pushUndo());
      el.addEventListener('input', () => { syncOutputs(); liveApplyStyle(); });
    });

    // 旁边的数字框：边敲边生效，不用等回车、不用等失焦
    for (const [sid, nid] of NUM_PAIRS) {
      const s = $('#' + sid), n = $('#' + nid);
      n.addEventListener('focus', () => pushUndo());
      const applyLive = () => {
        const raw = parseFloat(n.value);
        if (!isFinite(raw) || n.value === '' || n.value === '-') return;
        s.value = clamp(raw, +s.min, +s.max);
        liveApplyStyle();
      };
      const commit = () => {
        const raw = parseFloat(n.value);
        if (!isFinite(raw) || n.value === '') { syncOutputs(); return; }
        const v = clamp(raw, +s.min, +s.max);
        s.value = v;
        n.value = v;
        liveApplyStyle();
      };
      n.addEventListener('input', applyLive);
      n.addEventListener('change', commit);
      n.addEventListener('keydown', e => { if (e.key === 'Enter') { commit(); n.blur(); } });
    }

    const sw = $('#swatches');
    COLOR_SWATCHES.forEach(c => {
      const el = document.createElement('div');
      el.className = 'sw';
      el.dataset.color = c;
      el.style.background = c;
      el.title = c;
      el.addEventListener('click', () => { pushUndo(); state.draftColor = c; syncSwatches(); liveApplyStyle(); });
      sw.appendChild(el);
    });
    const none = document.createElement('div');
    none.className = 'sw none';
    none.dataset.color = '';
    none.title = '无色（默认）';
    none.addEventListener('click', () => { pushUndo(); state.draftColor = null; syncSwatches(); liveApplyStyle(); });
    sw.appendChild(none);
    let cpT = 0;
    $('#colorPick').addEventListener('input', e => {
      state.draftColor = e.target.value;
      syncSwatches();
      clearTimeout(cpT);
      cpT = setTimeout(liveApplyStyle, 60);
    });
    $('#colorPick').addEventListener('pointerdown', () => pushUndo());
    $('#colorHex').addEventListener('change', e => {
      const v = e.target.value.trim();
      if (/^#?[0-9a-f]{6}$/i.test(v)) {
        pushUndo();
        state.draftColor = '#' + v.replace('#', '').toLowerCase();
        syncSwatches(); liveApplyStyle();
      }
    });

    $('#btnCenter').addEventListener('click', () => {
      pushUndo();
      state.centerAll = !state.centerAll;
      syncCenterBtn();
      liveApplyStyle();
      toast(state.centerAll ? '字形已居中' : '已取消字形居中');
    });

    $('#btnOneShot').addEventListener('click', oneShot);
    $('#btnUndo').addEventListener('click', undo);
    $('#btnResetAll').addEventListener('click', resetAllEdits);

    document.addEventListener('keydown', e => {
      const inField = e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); $('#search').focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField) {
        e.preventDefault(); undo();
      }
      if (e.key === 'Escape') {
        if ($('#modalSwap').classList.contains('show')) hideModal('#modalSwap');
        else if ($('#modalExport').classList.contains('show')) hideModal('#modalExport');
        else if ($('#modalWipe').classList.contains('show')) hideModal('#modalWipe');
        else if (state.selection.size) clearSelection();
      }
    });

    updateUndoBtn();
    drawPreview();
    syncWriteInfo();

    // 导出类型切换
    $$('#expKind button').forEach(b => b.addEventListener('click', () => {
      state.expKind = b.dataset.kind;
      $$('#expKind button').forEach(x => x.classList.toggle('on', x === b));
      syncExportInfo();
    }));

    let rz = null;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => { repaintVisible(); drawPreview(); }, 200);
    });
  }

  function bindGrid() {
    const wrap = $('#gridWrap');
    let press = null;

    const startRing = cell => {
      cell.classList.add('pressing');
      cell.style.setProperty('--p', '0%');
      press.raf = requestAnimationFrame(function tick() {
        if (!press || !press.el) return;
        const p = Math.min(100, ((performance.now() - press.t0) / 400) * 100);
        press.el.style.setProperty('--p', p + '%');
        if (p < 100) press.raf = requestAnimationFrame(tick);
      });
    };
    const clearPress = () => {
      if (!press) return;
      clearTimeout(press.timer);
      cancelAnimationFrame(press.raf);
      if (press.el) { press.el.classList.remove('pressing'); press.el.style.setProperty('--p', '0%'); }
    };

    wrap.addEventListener('pointerdown', e => {
      if (state.busy) return;
      const cell = e.target.closest('.cell');
      if (!cell) {
        clearSelection();
        return;
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const cp = +cell.dataset.cp;
      clearPress();
      press = { cp, el: cell, t0: performance.now(), long: false, moved: false, x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey };
      startRing(cell);
      press.timer = setTimeout(() => {
        if (!press) return;
        press.long = true;
        state.multi = true;
        state.anchor = press.cp;      // 长按的那个字符就是锚点
        state.rangeArm = true;
        addSel(press.cp);
        cell.classList.remove('pressing');
        if (navigator.vibrate) navigator.vibrate(12);
        toast('锚点：' + String.fromCodePoint(press.cp) + ' · 再点另一个字符即连选');
      }, 400);
      if (e.shiftKey) {
        clearTimeout(press.timer);
        press.long = true;
        state.multi = true;
        if (state.anchor == null) state.anchor = cp;
        press.range = true;
      }
    });

    wrap.addEventListener('pointerover', e => {
      if (!press || !press.long || !state.multi) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      const cp = +cell.dataset.cp;
      if (!state.selection.has(cp)) addSel(cp);
    });

    window.addEventListener('pointerup', () => {
      if (!press) return;
      const p = press;
      press = null;
      clearPress();

      if (p.range) {                        // Shift + 点击
        const from = state.anchor == null ? p.cp : state.anchor;
        const to = p.cp;
        chooseRange(from, to, true);
        return;
      }
      if (!p.long && !p.moved) {
        if (p.ctrl) { state.multi = true; toggleSel(p.cp); return; }
        if (state.rangeArm && state.anchor === p.cp) return;   // 点在锚点自身上，不做变动
        if (state.rangeArm && state.anchor != null && state.anchor !== p.cp) {
          chooseRange(state.anchor, p.cp, false);   // 长按锚点后点终点 → 连选
          return;
        }
        state.multi = state.multi && state.selection.size > 0;
        if (state.multi && state.selection.size > 0) toggleSel(p.cp);
        else { state.selection.clear(); state.selection.add(p.cp); syncSelectionUI(); }
      } else {
        syncSelectionUI();
      }
    });
    window.addEventListener('pointercancel', () => { if (press) { clearPress(); press = null; } });
    window.addEventListener('blur', () => { if (press) { clearPress(); press = null; } });
  }

  /* ----------------------------- 启动 ----------------------------- */
  /* 手机/窗口高度锁在真实可见区域，页面不再被拉成一长条 */
  function fitAppHeight() {
    const vv = window.visualViewport;
    if (vv && vv.scale > 1.02) return;
    let h = Math.round((vv && vv.height) || window.innerHeight || 0);
    const shortSide = Math.min(window.screen.width || 9999, window.screen.height || 9999);
    const touch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (touch && shortSide <= 620) h = Math.min(h, 790);
    if (h > 240) document.documentElement.style.setProperty('--appvh', h + 'px');
  }

  async function boot() {
    fitAppHeight();
    bind();
    try {
      const saved = await kvGet('A');
      if (saved && saved.buffer) {
        $('#onboardNote').textContent = '已找到本机保存的字体：' + saved.name;
        loading(true, '载入已保存的系统字体…');
        const bytes = new Uint8Array(saved.buffer);
        const col = FE.parse(bytes);
        if (col.faces.length) {
          const idx = clamp(saved.faceIndex || 0, 0, col.faces.length - 1);
          state.A = {
            fileName: saved.name, collection: col, faces: col.faces, faceIndex: idx,
            face: col.faces[idx], shared: FE.canShareTables(col.faces)
          };
          afterAFont();
          loading(false);
          return;
        }
      }
    } catch (e) {
      console.warn(e);
    }
    loading(false);
    $('#onboard').classList.remove('hide');
    $('#aName').textContent = '尚未就位';
    $('#aName').classList.add('dim');
  }

  /* ----------------------------- 开发者接口 ----------------------------- */
  window.GlyphAtelier = {
    get state() { return state; },
    loadABytes: (buf, name) => loadAFromBuffer(buf, name || 'font'),
    loadBBytes: (buf, name) => loadBFromBuffer(buf, name || 'font'),
    paintWindow: () => repaintVisible(),
    bulk: (mode, scope, includeNew) => bulkFromB(mode, scope, includeNew),
    selectAll: () => selectAllInList(),
    selectEvery: () => selectEveryChar(),
    write: t => { $('#writeInput').value = t; selectWritten(true); syncWriteInfo(); },
    exportBytes: (kind) => {
      const payload = buildPayload();
      return kind === 'ttc' ? FE.buildCollection(state.A.faces, payload) : FE.buildFont(state.A.face, payload);
    }
  };

  window.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('resize', fitAppHeight);
  window.addEventListener('orientationchange', () => setTimeout(fitAppHeight, 260));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitAppHeight);
})();
