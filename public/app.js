(() => {
  'use strict';

  const DATA = window.ELEMENT_DATA;
  const MAKERS = DATA.makers;
  const MAKER_BY_ID = Object.fromEntries(MAKERS.map((m) => [m.id, m]));
  // 列の定義。idx は DATA.rows の位置（0 メーカー,1 ページ,2 区分,3 型式,4 エンジン,5 シリアル,6 オイル,7 エア,8 燃料,9 作動油,10 ST,11 TM,12 備考,13 〃列,14 status）
  const ALL_COLS = [
    { key: 'oil', label: 'オイル', idx: 6 },
    { key: 'air', label: 'エア', idx: 7 },
    { key: 'fuel', label: '燃料', idx: 8 },
    { key: 'hyd', label: '作動油', idx: 9 },
    { key: 'st', label: 'ST', idx: 10 },
    { key: 'tm', label: 'TM', idx: 11 },
  ];
  const PAGE_SIZE = 60;
  const UNKNOWN = '???';

  const $ = (id) => document.getElementById(id);
  const qEl = $('q'), resultsEl = $('results'), statusEl = $('status'), moreEl = $('more'), catsEl = $('cats'), makersEl = $('makers');

  // ---------- 正規化 ----------
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
  const LABEL_SPLIT = /([0-9A-Z)])(HST|CV|TM|WS|C|S|T|H|P|M|R)=/g;
  const PAIR_SPLIT = /([0-9][0-9A-Z]*[0-9A-Z])([ST])([,、])([ST])=/g;
  const PART_RE = /[0-9A-Z][0-9A-Z.\-]*(?:\([A-Z]\))?/g;
  // 純正品番（原本では淡色表示・検証中）の形
  const OEM_RE = /^(?:YM\d|HD\d|\d{2,4}[A-Z]?-\d{2}-\d{4,5}|\d{3}-\d{3}-\d{4}|[0-9A-Z]{3}-\d{2}-\d{5}|\d{6}-\d{5}|\d{7}|\d{9,10}$)/;

  // セル文字列を [{text, key, search, oem, unknown}] の断片に分ける
  function splitCell(cell) {
    const raw0 = String(cell || '');
    const s = raw0.replace(PAIR_SPLIT, '$1 $2$3$4=').replace(LABEL_SPLIT, '$1 $2=');
    const out = [];
    let last = 0, m;
    PART_RE.lastIndex = 0;
    // ??? はそのまま「読めなかった箇所」として表示する（品番としては扱わない）
    const unknownSpans = [];
    for (let at = s.indexOf(UNKNOWN); at >= 0; at = s.indexOf(UNKNOWN, at + 3)) unknownSpans.push(at);
    const isUnknownAt = (i) => unknownSpans.some((u) => i >= u && i < u + 3);
    while ((m = PART_RE.exec(s))) {
      const raw = m[0];
      if (isUnknownAt(m.index)) continue;
      const before = s[m.index - 1] || '';
      const after = s[m.index + raw.length] || '';
      const tok = raw.replace(/[.\-]+$/, '');
      const isPart =
        /\d/.test(tok) &&
        !/[#~×xX]/.test(before) &&
        !/[~=…?]/.test(after) &&
        !/[぀-ヿ]/.test(after) &&
        !/^[GW]\d{3}$/.test(tok) &&
        tok.length >= 2;
      if (!isPart) continue;
      if (m.index > last) out.push({ text: s.slice(last, m.index) });
      const opt = tok.match(/^(.*)\(([A-Z])\)$/);
      const search = opt ? [opt[1], opt[1] + opt[2]] : [tok];
      out.push({ text: tok, key: tok, search, oem: OEM_RE.test(search[0]) });
      last = m.index + tok.length;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    // ??? を強調表示用の断片に分け直す
    return out.flatMap((f) => {
      if (f.key || !f.text.includes(UNKNOWN)) return [f];
      return f.text.split(UNKNOWN).flatMap((t, i, arr) => {
        const parts = [];
        if (t) parts.push({ text: t });
        if (i < arr.length - 1) parts.push({ text: UNKNOWN, unknown: true });
        return parts;
      });
    });
  }

  // ---------- 行データの準備 ----------
  function aliasModel(model) {
    const alias = model.replace(/([A-Z]+)(\d+)·(\d+)/g, '$1$3');
    const noParen = model.replace(/\([^)]*\)/g, '');
    return [model, alias, noParen].map(normModel).join('|');
  }

  const rows = DATA.rows.map((r, i) => {
    const mk = MAKER_BY_ID[r[0]];
    const cols = ALL_COLS.filter((c) => mk.cols.includes(c.key)).map((c) => ({
      ...c, label: (mk.labels && mk.labels[c.key]) || c.label,
    }));
    const cells = cols.map((c) => splitCell(r[c.idx]));
    const unknownCount = cols.reduce((n, c) => n + (String(r[c.idx]).includes(UNKNOWN) ? 1 : 0), 0);
    return {
      i, maker: r[0], makerName: mk.name, page: r[1], cat: r[2], model: r[3], engine: r[4], serial: r[5],
      note: r[12], ditto: r[13] || '', status: r[14], unknownCount,
      cols, cells,
      modelKey: aliasModel(r[3]) + '|' + normModel(r[4]),
      partKeys: cells.flat().filter((f) => f.key).flatMap((f) => f.search).map(normPart),
    };
  });

  // 品番 → 件数（品番一覧用）
  const partIndex = new Map(ALL_COLS.map((c) => [c.key, new Map()]));
  rows.forEach((row) => row.cols.forEach((c, ci) => {
    const map = partIndex.get(c.key);
    new Set(row.cells[ci].filter((f) => f.key).map((f) => f.key)).forEach((k) => {
      const cur = map.get(k) || { count: 0, oem: OEM_RE.test(k) };
      cur.count++; map.set(k, cur);
    });
  }));

  const makerCounts = new Map();
  rows.forEach((r) => makerCounts.set(r.maker, (makerCounts.get(r.maker) || 0) + 1));

  // ---------- 状態 ----------
  const state = { mode: 'model', q: '', maker: '', cat: '', shown: PAGE_SIZE };
  try {
    const saved = JSON.parse(localStorage.getItem('ele-state') || '{}');
    if (saved.mode === 'part' || saved.mode === 'model') state.mode = saved.mode;
    if (saved.maker !== undefined && (saved.maker === '' || MAKER_BY_ID[saved.maker])) state.maker = saved.maker;
  } catch (e) { /* 保存できない環境でも動く */ }
  function saveState() {
    try { localStorage.setItem('ele-state', JSON.stringify({ mode: state.mode, maker: state.maker })); } catch (e) { /* noop */ }
  }

  const baseRows = () => rows.filter((r) => (!state.maker || r.maker === state.maker) && (!state.cat || r.cat === state.cat));

  // ---------- 検索 ----------
  function search() {
    const base = baseRows();
    if (state.mode === 'model') {
      const q = normModel(state.q);
      if (!q) return (state.cat || state.maker) ? base : null;
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
      if (f.unknown) return '<span class="unk" title="原本で読み取れなかった箇所">???</span>';
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
    const elems = r.cols.map((c, ci) => {
      const ditto = ci < 4 && r.ditto.includes(String(ci)) ? '<span class="ditto">（原本「〃」）</span>' : '';
      return `<div class="elem"><span class="lbl ${c.key}">${esc(c.label)}</span><div>${renderCell(r.cells[ci], qPart)}${ditto}</div></div>`;
    }).join('');
    const flags = [];
    if (r.status !== 'checked') flags.push('<span class="tag unv" title="2回読みによる確認が済んでいない行です">未確認</span>');
    if (r.unknownCount) flags.push(`<span class="tag unk-tag" title="原本で読み取れなかった箇所があります">読取不可 ${r.unknownCount}</span>`);
    let note = '';
    if (r.note) {
      const warn = /確認|判読|欠け|不確実|検証中/.test(r.note);
      note = `<div class="note${warn ? ' warn' : ''}">${esc(r.note)}</div>`;
    }
    return `<article class="card ${r.status === 'checked' ? 'is-checked' : 'is-unverified'} mk-${r.maker}">
      <div class="card-head"><div class="model">${highlight(r.model, qModel)}</div><div class="page"><span class="mk">${esc(r.makerName)}</span> P.${r.page}</div></div>
      <div class="meta">${meta.map((m) => `<span>${m}</span>`).join('')}${flags.join('')}</div>
      <div class="elems">${elems}</div>${note}
    </article>`;
  }

  function renderPartIndex() {
    const html = ALL_COLS.map((c) => {
      const list = [...partIndex.get(c.key).entries()]
        .filter(([k, v]) => !v.oem)
        .sort((a, b) => a[0].localeCompare(b[0], 'ja', { numeric: true }));
      // メーカー絞り込み時は、そのメーカーに存在する品番だけを出す
      const shown = state.maker
        ? list.filter(([k]) => rows.some((r) => r.maker === state.maker && r.partKeys.includes(normPart(k))))
        : list;
      if (!shown.length) return '';
      const btns = shown.map(([k, v]) => `<button class="pn" data-pn="${esc(k)}">${esc(k)}<small>${v.count}</small></button>`).join('');
      return `<section><h2><span class="lbl ${c.key}">${esc(c.label)}</span>${shown.length} 品番</h2><div class="pn-grid">${btns}</div></section>`;
    }).join('');
    resultsEl.innerHTML = `<div class="pn-index">${html}</div>`;
    statusEl.textContent = '品番をタップすると、その品番を使う型式を表示します（数字は該当行数）。STはCATの「ステアリング」／日立・住友建機の「サクション」／北越工業の「コンプエア」、TMはCATの「TM・パイロット」／日立・住友建機の「ドレン・パイロット」／北越工業の「コンプオイル」です';
    moreEl.hidden = true;
  }

  function renderHome() {
    const base = baseRows();
    resultsEl.innerHTML = `<div class="empty">
      型式（例: <b>PC200</b>、<b>D31</b>、<b>320</b>、<b>EX200</b>）やエンジン型式を入力するか、<br>上のメーカー・機種区分をタップしてください。<br><br>
      ${state.maker ? esc(MAKER_BY_ID[state.maker].name) + '：' : '全メーカー：'}${base.length.toLocaleString()} 行</div>`;
    statusEl.textContent = '';
    moreEl.hidden = true;
  }

  function render(resetPaging = true) {
    if (resetPaging) state.shown = PAGE_SIZE;
    const list = search();
    if (list === null) {
      if (state.mode === 'part') renderPartIndex(); else renderHome();
      return;
    }
    if (!list.length) {
      resultsEl.innerHTML = '<div class="empty">該当するデータがありません。<br>入力を短くするか、もう一方の検索方法・別のメーカーを試してください。</div>';
      statusEl.textContent = '0 件';
      moreEl.hidden = true;
      return;
    }
    const slice = list.slice(0, state.shown);
    resultsEl.innerHTML = slice.map(renderRow).join('');
    const label = state.mode === 'part' ? `品番「${toHalf(state.q)}」を含む型式` : '該当';
    const scope = [state.maker ? MAKER_BY_ID[state.maker].name : '', state.cat].filter(Boolean).join(' / ');
    statusEl.textContent = `${label} ${list.length} 件${scope ? `（${scope}）` : ''}`;
    moreEl.hidden = list.length <= state.shown;
    moreEl.textContent = `さらに表示（残り ${list.length - state.shown} 件）`;
  }

  function renderMakers() {
    const items = [['', 'すべて', rows.length], ...MAKERS.map((m) => [m.id, m.name, makerCounts.get(m.id) || 0])];
    makersEl.innerHTML = items.map(([id, name, n]) =>
      `<button class="maker${state.maker === id ? ' active' : ''}" data-maker="${esc(id)}">${esc(name)}<small>${n.toLocaleString()}</small></button>`).join('');
  }

  function renderCats() {
    const counts = new Map();
    rows.filter((r) => !state.maker || r.maker === state.maker).forEach((r) => counts.set(r.cat, (counts.get(r.cat) || 0) + 1));
    if (state.cat && !counts.has(state.cat)) state.cat = '';
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const cats = [['', 'すべて', total], ...[...counts.entries()].map(([k, v]) => [k, k, v])];
    catsEl.innerHTML = cats.map(([k, label, n]) =>
      `<button class="cat${state.cat === k ? ' active' : ''}" data-cat="${esc(k)}">${esc(label)}<small>${n}</small></button>`).join('');
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.mode').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    qEl.placeholder = mode === 'model' ? '例: PC200 / 320 / EX200 / SAA6D107' : '例: 207N-6 / 150K / 3750KF';
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
  makersEl.addEventListener('click', (e) => {
    const b = e.target.closest('.maker'); if (!b) return;
    state.maker = b.dataset.maker; state.cat = ''; saveState(); renderMakers(); renderCats(); render();
  });
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
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const checkedN = rows.filter((r) => r.status === 'checked').length;
  $('dataInfo').textContent = `データ: ${rows.length.toLocaleString()} 行（確認済み ${checkedN.toLocaleString()} 行／未確認 ${(rows.length - checkedN).toLocaleString()} 行）・作成 ${DATA.built}`;
  setMode(state.mode);
  renderMakers();
  renderCats();
  render();
})();
