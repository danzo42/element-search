(() => {
  'use strict';

  const DATA = window.ELEMENT_DATA;
  const COLS = [
    { key: 'oil', label: 'オイル', idx: 5 },
    { key: 'air', label: 'エア', idx: 6 },
    { key: 'fuel', label: '燃料', idx: 7 },
    { key: 'hyd', label: '作動油', idx: 8 },
  ];
  const PAGE_SIZE = 60;

  const $ = (id) => document.getElementById(id);
  const qEl = $('q'), resultsEl = $('results'), statusEl = $('status'), moreEl = $('more'), catsEl = $('cats');

  // ---------- 正規化 ----------
  // 全角英数・記号を半角にし、大文字化する
  function toHalf(s) {
    return String(s)
      .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[ー－―‐−]/g, '-')
      .replace(/　/g, ' ')
      .toUpperCase();
  }
  const normModel = (s) => toHalf(s).replace(/[^0-9A-Z]/g, '');
  const normPart = (s) => toHalf(s).replace(/[^0-9A-Z]/g, '');

  // ---------- 品番の切り出し ----------
  // 「150KC=527K」のように区分記号(C=, T= など)が品番に続く箇所へ空白を入れる
  const LABEL_SPLIT = /([0-9A-Z)])(HST|CV|TM|WS|C|S|T|H|P|M|R)=/g;
  // 「195NS,T=」「527KT,S=」のように S,T= / T,S= が品番に続く箇所
  const PAIR_SPLIT = /([0-9][0-9A-Z]*[0-9A-Z])([ST])([,、])([ST])=/g;
  const PART_RE = /[0-9A-Z][0-9A-Z.\-]*(?:\([A-Z]\))?/g;
  // 純正品番（原本では淡色表示・検証中）の形
  const OEM_RE = /^(?:YM\d|HD\d|\d{2,4}[A-Z]?-\d{2}-\d{4,5}|\d{3}-\d{3}-\d{4}|[0-9A-Z]{3}-\d{2}-\d{5}|\d{6}-\d{5}|\d{10}$)/;

  // セル文字列を [{text, key, search}] の断片に分ける。key があれば品番として検索できる
  function splitCell(cell) {
    const s = String(cell || '').replace(PAIR_SPLIT, '$1 $2$3$4=').replace(LABEL_SPLIT, '$1 $2=');
    const out = [];
    let last = 0, m;
    PART_RE.lastIndex = 0;
    while ((m = PART_RE.exec(s))) {
      const raw = m[0];
      const before = s[m.index - 1] || '';
      const after = s[m.index + raw.length] || '';
      const tok = raw.replace(/[.\-]+$/, '');
      const isPart =
        /\d/.test(tok) &&
        !/[#~×xX]/.test(before) &&   // シリアル・数量（#1001~, ×2）
        !/[~=…?]/.test(after) &&     // 範囲・区分ラベル（D80=）・欠け・判読不確実
        !/[぀-ヿ]/.test(after) &&
        !/^[GW]\d{3}$/.test(tok) &&  // メッシュ・ゲージ表記（W058, G135）
        tok.length >= 2;
      if (!isPart) continue;
      if (m.index > last) out.push({ text: s.slice(last, m.index) });
      // 「836P(W)」は 836P と 836PW のどちらの検索でも見つかるようにする
      const opt = tok.match(/^(.*)\(([A-Z])\)$/);
      const search = opt ? [opt[1], opt[1] + opt[2]] : [tok];
      out.push({ text: tok, key: tok, search, oem: OEM_RE.test(search[0]) });
      last = m.index + tok.length;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    return out;
  }

  // ---------- 行データの準備 ----------
  function aliasModel(model) {
    // 「D20·21A-7」→「D21A-7」のように・で並記された型式の別表記を作る
    const alias = model.replace(/([A-Z]+)(\d+)·(\d+)/g, '$1$3');
    const noParen = model.replace(/\([^)]*\)/g, '');
    return [model, alias, noParen].map(normModel).join('|');
  }

  const rows = DATA.rows.map((r, i) => {
    const cells = COLS.map((c) => splitCell(r[c.idx]));
    const keys = cells.map((frags) => frags.filter((f) => f.key).map((f) => f.key));
    return {
      i, page: r[0], cat: r[1], model: r[2], engine: r[3], serial: r[4],
      raw: COLS.map((c) => r[c.idx]), note: r[9], ditto: r[10] || '',
      cells, keys,
      modelKey: aliasModel(r[2]) + '|' + normModel(r[3]),
      partKeys: cells.flat().filter((f) => f.key).flatMap((f) => f.search).map(normPart),
    };
  });

  // 品番 → 件数（品番一覧用）
  const partIndex = COLS.map(() => new Map());
  rows.forEach((row) => row.keys.forEach((ks, ci) => {
    new Set(ks).forEach((k) => {
      const cur = partIndex[ci].get(k) || { count: 0, oem: OEM_RE.test(k) };
      cur.count++; partIndex[ci].set(k, cur);
    });
  }));

  const catCounts = new Map();
  rows.forEach((r) => catCounts.set(r.cat, (catCounts.get(r.cat) || 0) + 1));

  // ---------- 状態 ----------
  const state = { mode: 'model', q: '', cat: '', shown: PAGE_SIZE };
  try {
    const saved = JSON.parse(localStorage.getItem('ele-state') || '{}');
    if (saved.mode === 'part' || saved.mode === 'model') state.mode = saved.mode;
  } catch (e) { /* 保存できない環境でも動く */ }

  function saveState() {
    try { localStorage.setItem('ele-state', JSON.stringify({ mode: state.mode })); } catch (e) { /* noop */ }
  }

  // ---------- 検索 ----------
  function search() {
    const cat = state.cat;
    const base = cat ? rows.filter((r) => r.cat === cat) : rows;
    if (state.mode === 'model') {
      const q = normModel(state.q);
      if (!q) return cat ? base : null;
      return base.filter((r) => r.modelKey.includes(q));
    }
    const q = normPart(state.q);
    if (!q) return null;
    const exact = [], prefix = [];
    base.forEach((r) => {
      if (r.partKeys.some((k) => k === q)) exact.push(r);
      else if (r.partKeys.some((k) => k.startsWith(q))) prefix.push(r);
    });
    return exact.concat(prefix);
  }

  // ---------- 描画 ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function highlight(text, q) {
    if (!q) return esc(text);
    // 型式の一致箇所を、記号を無視して強調する
    const chars = [...text];
    const map = [];
    let norm = '';
    chars.forEach((ch, idx) => {
      const n = normModel(ch);
      for (const c of n) { norm += c; map.push(idx); }
    });
    const at = norm.indexOf(q);
    if (at < 0) return esc(text);
    const from = map[at], to = map[at + q.length - 1];
    return esc(chars.slice(0, from).join('')) + '<mark>' + esc(chars.slice(from, to + 1).join('')) + '</mark>' + esc(chars.slice(to + 1).join(''));
  }

  function renderCell(frags, qPart) {
    if (!frags.length || frags.every((f) => !f.text.trim())) return '<span class="val none">記載なし</span>';
    return '<span class="val">' + frags.map((f) => {
      if (!f.key) return esc(f.text);
      const hit = qPart && f.search.map(normPart).some((nk) => nk === qPart || nk.startsWith(qPart));
      const cls = 'pn' + (f.oem ? ' oem' : '') + (hit ? ' hit' : '');
      const title = f.oem ? ' title="純正品番（原本で淡色表示・検証中）"' : '';
      return `<button class="${cls}" data-pn="${esc(f.key)}"${title}>${esc(f.text)}</button>`;
    }).join('') + '</span>';
  }

  function renderRow(r) {
    const qModel = state.mode === 'model' ? normModel(state.q) : '';
    const qPart = state.mode === 'part' ? normPart(state.q) : '';
    const meta = [];
    if (r.engine) meta.push(`エンジン <b>${esc(r.engine)}</b>`);
    if (r.serial) meta.push(`シリアル <b>${esc(r.serial)}</b>`);
    meta.push(esc(r.cat));
    const elems = COLS.map((c, ci) => {
      const ditto = r.ditto.includes(String(ci)) ? '<span class="ditto">（原本「〃」）</span>' : '';
      return `<div class="elem"><span class="lbl ${c.key}">${c.label}</span><div>${renderCell(r.cells[ci], qPart)}${ditto}</div></div>`;
    }).join('');
    let note = '';
    if (r.note) {
      const warn = /確認|判読|欠け|不確実|検証中/.test(r.note);
      note = `<div class="note${warn ? ' warn' : ''}">${esc(r.note)}</div>`;
    }
    return `<article class="card">
      <div class="card-head"><div class="model">${highlight(r.model, qModel)}</div><div class="page">カタログ P.${r.page}</div></div>
      <div class="meta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
      <div class="elems">${elems}</div>${note}
    </article>`;
  }

  function renderPartIndex() {
    const html = COLS.map((c, ci) => {
      const list = [...partIndex[ci].entries()]
        .filter(([, v]) => !v.oem)
        .sort((a, b) => a[0].localeCompare(b[0], 'ja', { numeric: true }));
      const btns = list.map(([k, v]) => `<button class="pn" data-pn="${esc(k)}">${esc(k)}<small>${v.count}</small></button>`).join('');
      return `<section><h2><span class="lbl ${c.key}">${c.label}</span>${list.length} 品番</h2><div class="pn-grid">${btns}</div></section>`;
    }).join('');
    resultsEl.innerHTML = `<div class="pn-index">${html}</div>`;
    statusEl.textContent = '品番をタップすると、その品番を使う型式を表示します（数字は該当行数）';
    moreEl.hidden = true;
  }

  function renderHome() {
    resultsEl.innerHTML = `<div class="empty">
      型式（例: <b>PC200</b>、<b>D31</b>、<b>WA100</b>）やエンジン型式を入力するか、<br>上の機種区分をタップしてください。<br><br>
      全 ${rows.length.toLocaleString()} 行 / ${catCounts.size} 区分</div>`;
    statusEl.textContent = '';
    moreEl.hidden = true;
  }

  let lastList = [];
  function render(resetPaging = true) {
    if (resetPaging) state.shown = PAGE_SIZE;
    const list = search();
    if (list === null) {
      if (state.mode === 'part') renderPartIndex(); else renderHome();
      return;
    }
    lastList = list;
    if (!list.length) {
      resultsEl.innerHTML = '<div class="empty">該当するデータがありません。<br>入力を短くするか、もう一方の検索方法を試してください。</div>';
      statusEl.textContent = '0 件';
      moreEl.hidden = true;
      return;
    }
    const slice = list.slice(0, state.shown);
    resultsEl.innerHTML = slice.map(renderRow).join('');
    const label = state.mode === 'part' ? `品番「${toHalf(state.q)}」を含む型式` : '該当';
    statusEl.textContent = `${label} ${list.length} 件${state.cat ? `（${state.cat}）` : ''}`;
    moreEl.hidden = list.length <= state.shown;
    moreEl.textContent = `さらに表示（残り ${list.length - state.shown} 件）`;
  }

  function renderCats() {
    const cats = [['', 'すべて', rows.length], ...[...catCounts.entries()].map(([k, v]) => [k, k, v])];
    catsEl.innerHTML = cats.map(([k, label, n]) =>
      `<button class="cat${state.cat === k ? ' active' : ''}" data-cat="${esc(k)}">${esc(label)}<small>${n}</small></button>`).join('');
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    qEl.placeholder = mode === 'model' ? '例: PC200 / D31 / SAA6D107' : '例: 207N-6 / 150K / 3750KF';
    saveState();
  }

  // ---------- イベント ----------
  let timer = 0;
  qEl.addEventListener('input', () => {
    state.q = qEl.value;
    $('clear').hidden = !qEl.value;
    clearTimeout(timer);
    timer = setTimeout(() => render(), 120);
  });
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') qEl.blur(); });
  $('clear').addEventListener('click', () => { qEl.value = ''; state.q = ''; $('clear').hidden = true; render(); qEl.focus(); });
  document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
    if (state.mode === b.dataset.mode) return;
    setMode(b.dataset.mode); qEl.value = ''; state.q = ''; $('clear').hidden = true; render();
  }));
  catsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.cat'); if (!b) return;
    state.cat = b.dataset.cat; renderCats(); render();
  });
  resultsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.pn'); if (!b) return;
    setMode('part');
    qEl.value = b.dataset.pn; state.q = b.dataset.pn; $('clear').hidden = false;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  moreEl.addEventListener('click', () => { state.shown += PAGE_SIZE; render(false); });

  // ---------- PWA ----------
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e; $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => {});
    deferredPrompt = null; $('installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let hintDismissed = false;
  try { hintDismissed = localStorage.getItem('ele-ios-hint') === '1'; } catch (e) { /* noop */ }
  if (isIOS && !standalone && !hintDismissed) $('iosHint').hidden = false;
  $('iosHintClose').addEventListener('click', () => {
    $('iosHint').hidden = true;
    try { localStorage.setItem('ele-ios-hint', '1'); } catch (e) { /* noop */ }
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // 既に旧版が動いていた場合だけ、新版に切り替わった時点で読み直す（初回インストール時は読み直さない）
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  $('dataInfo').textContent = `データ: ${rows.length.toLocaleString()} 行（${DATA.source}／作成 ${DATA.built}）`;
  setMode(state.mode);
  renderCats();
  render();
})();
