// 銘板カメラ検索: 撮影した銘板の写真を端末内でOCR（Tesseract.js）し、近い型式をカタログから探す。
// 写真・読み取り結果は端末の外へ送らない。OCRは「読めた文字」を候補として出すだけで、最終確認は利用者が行う。
(() => {
  'use strict';
  const App = window.PeacockApp;
  const camBtn = document.getElementById('camBtn');
  const fileEl = document.getElementById('camFile');
  const panel = document.getElementById('camPanel');
  if (!App || !camBtn || !fileEl || !panel) return;

  const esc = App.esc;
  const TESS_DIR = new URL('vendor/tesseract/', location.href).href;
  const MAX_HITS = 15;
  const MIN_SIM = 0.68;     // これ未満は候補にしない
  const BRAND_BONUS = 0.08;  // 写真にメーカー名が写っていたときの加点

  // ---------- 文字の取り違え（OCRの癖）を軽いコストにする ----------
  const CONFUSE = new Set();
  ['O0', 'Q0', 'D0', 'I1', 'L1', 'S5', 'S6', 'G6', 'B8', 'Z2', 'U0', 'V7', 'C0', 'G0'].forEach((p) => { CONFUSE.add(p); CONFUSE.add(p[1] + p[0]); });
  const FOLD = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', Z: '2', B: '8', G: '6' };
  const fold = (s) => s.replace(/[OQDILSZBG]/g, (c) => FOLD[c]);
  const subCost = (a, b) => (a === b ? 0 : CONFUSE.has(a + b) ? 0.35 : 1);

  // p（短い側）を t のどこか一部分に当てはめたときの最小コスト（Sellers法）
  function approxSub(p, t) {
    const m = p.length, n = t.length;
    let prev = new Float32Array(n + 1), cur = new Float32Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const a = prev[j] + 1, b = cur[j - 1] + 1, c = prev[j - 1] + subCost(p[i - 1], t[j - 1]);
        cur[j] = a < b ? (a < c ? a : c) : (b < c ? b : c);
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    let best = Infinity;
    for (let j = 0; j <= n; j++) if (prev[j] < best) best = prev[j];
    return best;
  }
  const digitsOf = (s) => s.replace(/\D/g, '');

  // 読み取り文字 t と カタログの型式キー p の近さ（0〜1）
  function similarity(t, p) {
    const m = p.length, n = t.length, mx = Math.max(m, n);
    const dp = digitsOf(p), dt = digitsOf(t);
    // 数字（機種番号）は取り違えを許さない：1か所までの違いだけ認め、違う分は点を引く
    let pen = 1;
    if (dp && dt) {
      const dcost = dp.length <= dt.length ? approxSub(dp, dt) : approxSub(dt, dp);
      if (dcost > 1) return 0;
      if (dp !== dt) pen = 0.93;
    }
    // カタログの型式が読み取り文字の中にどれだけ見つかるか。OCRは前後にゴミを付けやすいので、余分な文字の減点は軽くする
    const s1 = Math.max(0, (m - approxSub(p, t)) / m - Math.min(0.2, Math.max(0, n - m) * 0.04));
    const s2 = (n - approxSub(t, p)) / mx;   // 読み取り文字がカタログ側に含まれる（読みが短い）
    return Math.max(s1, s2) * pen;
  }

  // ---------- カタログの型式キー（「PC200-8,-10」「FL140,160」のような併記を展開） ----------
  function expandModel(model) {
    const s = String(model).replace(/\s+/g, '');
    const parts = s.split(/[,、・/]/).filter(Boolean);
    const out = new Set();
    const add = (p) => {
      const m = p.match(/^(.*?)\(([^)]*)\)(.*)$/);   // 括弧は「付けた形」「外した形」の両方
      if (m) { add(m[1] + m[3]); add(m[1] + m[2] + m[3]); } else out.add(App.normModel(p));
    };
    const first = parts[0] || '';
    add(first);
    const lastDash = first.lastIndexOf('-');
    const base = lastDash > 0 ? first.slice(0, lastDash) : first.replace(/\d+[A-Z]*(?:\([^)]*\))?$/i, '');
    const stem = first.replace(/\d+[A-Z]*(?:\([^)]*\))?$/i, '');
    parts.slice(1).forEach((p) => {
      if (/^-/.test(p)) add(base + p);
      else if (/^\d/.test(p)) add(stem + p);
      else add(p);
    });
    return [...out].filter((k) => k.length >= 3);
  }

  let index = null;   // { keys:[{k, rows:[row index]}] }
  function buildIndex() {
    if (index) return index;
    const keyMap = new Map();
    const put = (k, ri) => { if (!keyMap.has(k)) keyMap.set(k, new Set()); keyMap.get(k).add(ri); };
    App.rows.forEach((r, ri) => { expandModel(r.model).forEach((k) => put(k, ri)); });
    const keys = [...keyMap.entries()].map(([k, set]) => ({ k, rows: [...set] }));
    index = { keys };
    return index;
  }

  // ---------- メーカー名（銘板に印字されている英字） ----------
  const BRANDS = [
    ['komatsu', /KOMATSU|KOMAT5U/], ['cat', /CATERPILLAR|\bCAT\b/], ['hitachi', /HITACHI|H[1I]TACH[1I]/],
    ['sumitomo', /SUMITOMO|SUM[1I]TOMO/], ['kobelco', /KOBELCO|KOBE[L1I]CO|KOBELC/], ['kubota', /KUBOTA/],
    ['yanmar', /YANMAR/], ['denyo', /DENYO|DEN YO/], ['hokuetsu', /HOKUETSU|AIRMAN/],
    ['shindaiwa', /SHINDAIWA/], ['nipponsharyo', /NIPPON\s*SHARYO|NIPPON/], ['kawasaki', /KAWASAKI/],
    ['sakai', /SAKAI/], ['hanta', /HANTA/], ['furukawa', /FURUKAWA/], ['morooka', /MOROOKA/],
    ['tadano', /TADANO/], ['kato', /\bKATO\b/], ['maeda', /MAEDA/], ['hanix', /HANIX/], ['ihi', /\bIHI\b/],
    ['aichi', /AICHI/], ['tcm', /\bTCM\b/],
  ];
  function detectBrands(text) {
    const t = text.toUpperCase();
    return BRANDS.filter(([, re]) => re.test(t)).map(([id]) => id);
  }

  // ---------- OCR文字列 → 型式の候補（トークン） ----------
  function tokensFrom(text) {
    const raw = text.toUpperCase().split(/[\s|,;:()[\]{}"'`~=_*+]+/).filter(Boolean);
    const out = new Map();   // 正規化した文字列 → 表示用の元の文字列
    const addTok = (s, show) => {
      // 先頭に付いた数字（OCRのゴミや隣の文字）は外す。型式は文字から始まる
      const k = App.normModel(s).replace(/^\d+(?=[A-Z])/, '');
      if (k.length < 5 || k.length > 16) return;   // 短い断片はゴミが多いので使わない
      if (!/^[A-Z]/.test(k) || !/\d/.test(k) || (k.match(/[A-Z]/g) || []).length < 2) return;
      if (!out.has(k)) out.set(k, show || s);
    };
    raw.forEach((s, i) => {
      addTok(s);
      // 銘板の型式は「DCA 25USIB」のように空白で分かれることがあるので、隣の語との結合も候補にする
      if (raw[i + 1] && s.length >= 2 && raw[i + 1].length >= 2 && (s + raw[i + 1]).length >= 7) addTok(s + raw[i + 1], s + ' ' + raw[i + 1]);
    });
    return out;
  }

  function matchTokens(tokens, brands) {
    const { keys } = buildIndex();
    const best = new Map();   // row index → {score, sim, tok}
    const tokScore = new Map();
    tokens.forEach((show, t) => {
      // 型式キーは数千件なので、絞り込まず全件と比べる（取りこぼし防止）
      keys.forEach((e) => {
        if (e.k.length < 5 || !/\d/.test(e.k) || !/[A-Z]/.test(e.k)) return;   // 「7300」のような数字だけ・短い型式は誤爆が多いので対象外
        const s = similarity(t, e.k);
        if (s < (t.length < 6 ? 0.85 : MIN_SIM)) return;   // 短い読み取りほど厳しく
        e.rows.forEach((ri) => {
          const sc = s + (brands.includes(App.rows[ri].maker) ? BRAND_BONUS : 0);
          const cur = best.get(ri);
          if (!cur || sc > cur.score) best.set(ri, { score: sc, sim: s, tok: show });
          if (sc > (tokScore.get(t) || 0)) tokScore.set(t, sc);
        });
      });
    });
    const hits = [...best.entries()].map(([ri, v]) => ({ ri, ...v }))
      .sort((a, b) => b.score - a.score || a.ri - b.ri).slice(0, MAX_HITS);
    return { hits, tokScore };
  }

  // ---------- 画像の前処理 ----------
  function grayCanvas(src, sx, sy, sw, sh, maxEdge, mode) {
    const s = Math.min(2, maxEdge / Math.max(sw, sh));   // 小さい切り出しは最大2倍まで拡大して読む
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h);
    const px = d.data, n = w * h, g = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (mode === 'local') {
      // 明るさのムラを引いて、文字の凹凸だけを強調する（淡色・刻印の銘板向け）
      const bg = blurApprox(g, w, h, 24);
      for (let j = 0; j < n; j++) g[j] = (g[j] - bg[j]) * 8 + 200;
    } else {
      const hist = new Uint32Array(256);
      for (let j = 0; j < n; j++) hist[Math.max(0, Math.min(255, g[j] | 0))]++;
      let lo = 0, hi = 255, acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
      const gain = 255 / Math.max(20, hi - lo);
      for (let j = 0; j < n; j++) g[j] = (g[j] - lo) * gain;
    }
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const v = g[j] < 0 ? 0 : g[j] > 255 ? 255 : g[j];
      px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    return c;
  }
  // 縮小→拡大でぼかした画像（Safariでも使える方法）
  function blurApprox(g, w, h, f) {
    const sc = document.createElement('canvas'); sc.width = w; sc.height = h;
    const sx = sc.getContext('2d', { willReadFrequently: true });
    const id = sx.createImageData(w, h);
    for (let i = 0; i < g.length; i++) { const v = Math.max(0, Math.min(255, g[i])); id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    sx.putImageData(id, 0, 0);
    const sm = document.createElement('canvas'); sm.width = Math.max(2, Math.round(w / f)); sm.height = Math.max(2, Math.round(h / f));
    const smx = sm.getContext('2d'); smx.imageSmoothingQuality = 'high'; smx.drawImage(sc, 0, 0, sm.width, sm.height);
    const big = document.createElement('canvas'); big.width = w; big.height = h;
    const bx = big.getContext('2d', { willReadFrequently: true }); bx.imageSmoothingQuality = 'high'; bx.drawImage(sm, 0, 0, w, h);
    const bd = bx.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = bd[i * 4];
    return out;
  }

  // ---------- Tesseract（初回だけ読み込む。オフラインでも使えるよう端末にキャッシュされる） ----------
  let workerPromise = null;
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('OCRの部品を読み込めませんでした（初回はインターネット接続が必要です）'));
      document.head.appendChild(s);
    });
  }
  function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (!window.Tesseract) await loadScript(TESS_DIR + 'tesseract.min.js');
        const w = await window.Tesseract.createWorker('eng', 1, {
          workerPath: TESS_DIR + 'worker.min.js', corePath: TESS_DIR, langPath: TESS_DIR, gzip: true, workerBlobURL: false,
        });
        await w.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./ ' });
        return w;
      })().catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  // ---------- 画面 ----------
  let run = 0;   // 新しい撮影が始まったら古い処理を打ち切る
  const state = { tokens: new Map(), brands: [] };

  function openPanel() { panel.hidden = false; }
  function closePanel() { run++; panel.hidden = true; }

  function shell(thumbUrl) {
    panel.innerHTML = `
      <div class="cam-head"><b>銘板から型式を探す</b><button type="button" class="cam-x" id="camClose">閉じる</button></div>
      ${thumbUrl ? `<img class="cam-thumb" alt="撮影した写真" src="${thumbUrl}">` : ''}
      <p class="cam-status" id="camStatus"></p>
      <div class="cam-edit">
        <input id="camText" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="読み取った型式（直せます）">
        <button type="button" id="camGo">この文字で探す</button>
      </div>
      <div class="cam-chips" id="camChips"></div>
      <div id="camResults"></div>
      <p class="cam-note">写真は端末の中だけで処理され、外部には送りません。刻印・汚れ・反射のある銘板は読み間違えます。候補は必ず銘板の型式と見比べ、発注前に原本カタログで確認してください。うまく読めないときは、型式の部分に近づけて撮り直すか、上の欄に型式を打ち直してください。</p>`;
    panel.querySelector('#camClose').addEventListener('click', closePanel);
    panel.querySelector('#camGo').addEventListener('click', () => {
      const t = panel.querySelector('#camText').value;
      state.tokens = tokensFrom(t);
      const one = App.normModel(t);   // 手入力は区切りのない1語も候補にする
      if (one.length >= 3 && !state.tokens.has(one)) state.tokens.set(one, t.trim());
      showHits(true);
    });
    panel.querySelector('#camText').addEventListener('keydown', (e) => { if (e.key === 'Enter') panel.querySelector('#camGo').click(); });
    panel.querySelector('#camChips').addEventListener('click', (e) => {
      const b = e.target.closest('.chip-tok'); if (!b) return;
      panel.querySelector('#camText').value = b.dataset.t;
      panel.querySelector('#camGo').click();
    });
  }
  const setStatus = (t) => { const el = panel.querySelector('#camStatus'); if (el) el.textContent = t; };

  function showHits(keepText) {
    const { hits, tokScore } = matchTokens(state.tokens, state.brands);
    const textEl = panel.querySelector('#camText');
    const chips = [...state.tokens.entries()].sort((a, b) => (tokScore.get(b[0]) || 0) - (tokScore.get(a[0]) || 0)).slice(0, 8);
    if (!keepText && textEl && !textEl.value && chips.length) textEl.value = chips[0][1];
    panel.querySelector('#camChips').innerHTML = chips.length
      ? '<span class="cam-chips-l">読めた文字（タップで探し直し）</span>' + chips.map(([, show]) => `<button type="button" class="chip-tok" data-t="${esc(show)}">${esc(show)}</button>`).join('')
      : '';
    const brandNames = state.brands.map((id) => (App.MAKER_BY_ID[id] || {}).name).filter(Boolean);
    const head = brandNames.length ? `<p class="cam-brand">写真から読めたメーカー名: <b>${esc(brandNames.join('・'))}</b>（一致する候補を優先して表示）</p>` : '';
    const res = panel.querySelector('#camResults');
    if (!hits.length) {
      res.innerHTML = head + '<div class="empty">近い型式が見つかりませんでした。<br>型式の文字を直して「この文字で探す」を押すか、撮り直してください。</div>';
      return;
    }
    res.innerHTML = head + `<p class="cam-count">近い型式 ${hits.length} 件（一致度の高い順）</p>` + hits.map((h) => {
      const pct = Math.min(100, Math.round(h.sim * 100));
      const brandOk = state.brands.includes(App.rows[h.ri].maker);
      return `<div class="cam-hit"><div class="cam-score"><b>一致度 ${pct}%</b>${brandOk ? '<span class="cam-bm">メーカー一致</span>' : ''}<span class="cam-from">読み取り「${esc(h.tok)}」</span></div>${App.renderRow(App.rows[h.ri])}</div>`;
    }).join('');
  }

  // 写真ファイル（ギャラリーから選んだ写真）を読む
  async function handleFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const bmp = await (window.createImageBitmap ? createImageBitmap(file).catch(() => null) : null) || await new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('写真を開けませんでした')); im.src = url;
      });
      await recognizeImage(bmp, url, false);
    } catch (e) {
      run++; openPanel(); shell(url);
      setStatus('エラー: ' + (e && e.message ? e.message : e));
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  // 画像（ビットマップ/キャンバス）を読む。cropped=true は撮影ガイド枠の中だけを切り出した画像
  async function recognizeImage(bmp, url, cropped) {
    const my = ++run;
    openPanel();
    shell(url);
    state.tokens = new Map(); state.brands = [];
    panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    try {
      const W = bmp.width, H = bmp.height;
      setStatus('文字認識の準備をしています…（初回は部品の読み込みに少し時間がかかります）');
      const worker = await getWorker();
      if (my !== run) return;
      let allText = '';
      const absorb = (text) => {
        allText += '\n' + text;
        state.brands = detectBrands(allText);
        tokensFrom(text).forEach((show, k) => { if (!state.tokens.has(k)) state.tokens.set(k, show); });
        showHits(!!panel.querySelector('#camText').value);
      };
      let passes;
      if (cropped) {
        // ガイド枠の中は型式の1〜2行だけなので、1行読み(psm 7)・段落読み(6)・コントラスト強調を組み合わせて読む
        passes = [
          { label: '枠内（1行）', box: [0, 0, W, H], edge: 2000, mode: 'stretch', psm: '7' },
          { label: '枠内（段落）', box: [0, 0, W, H], edge: 2000, mode: 'stretch', psm: '6' },
          { label: '枠内（コントラスト強調・1行）', box: [0, 0, W, H], edge: 2000, mode: 'local', psm: '7' },
          { label: '枠内（コントラスト強調・段落）', box: [0, 0, W, H], edge: 2000, mode: 'local', psm: '6' },
          { label: '枠内（文字を探す）', box: [0, 0, W, H], edge: 2000, mode: 'stretch', psm: '11' },
        ];
      } else {
        passes = [
          { label: '全体', box: [0, 0, W, H], edge: 2000, mode: 'stretch', psm: '11' },
          { label: '全体（段落）', box: [0, 0, W, H], edge: 2000, mode: 'stretch', psm: '6' },
          { label: '全体（コントラスト強調）', box: [0, 0, W, H], edge: 2000, mode: 'local', psm: '11' },
        ];
        // 写真を重なりのある4分割にして、小さい文字も拡大して読む
        const tw = Math.round(W * 0.62), th = Math.round(H * 0.62);
        [[0, 0], [W - tw, 0], [0, H - th], [W - tw, H - th]].forEach(([x, y], i) => passes.push({ label: `部分${i + 1}/4`, box: [x, y, tw, th], edge: 2200, mode: 'stretch', psm: '11' }));
      }
      for (let i = 0; i < passes.length; i++) {
        if (my !== run) return;
        const p = passes[i];
        setStatus(`読み取り中 ${i + 1}/${passes.length}（${p.label}）…候補は読めた分から順に表示します`);
        await worker.setParameters({ tessedit_pageseg_mode: p.psm });
        const c = grayCanvas(bmp, p.box[0], p.box[1], p.box[2], p.box[3], p.edge, p.mode);
        const r = await worker.recognize(c);
        c.width = c.height = 0;
        if (my !== run) return;
        absorb(r.data.text || '');
      }
      setStatus(state.tokens.size ? '読み取り完了。読めた文字を直す・タップする、または候補から選んでください。' : '文字を読み取れませんでした。型式の部分を枠いっぱいに撮り直すか、上の欄に型式を入力してください。');
      if (bmp.close) bmp.close();
    } catch (e) {
      if (my === run) setStatus('エラー: ' + (e && e.message ? e.message : e));
    }
  }

  // ---------- ガイド枠つきの撮影画面 ----------
  // 画面いっぱいにカメラ映像を出し、中央の□に型式の文字を収めて撮る。□の中だけを切り出して読むので、
  // 周りの文字・汚れ・反射を拾いにくく、文字も大きく読める。
  let liveEl = null, liveStream = null, torchOn = false;
  function stopLive() {
    if (liveStream) liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null; torchOn = false;
    if (liveEl) { liveEl.remove(); liveEl = null; }
    document.body.classList.remove('cam-live-open');
  }
  const canLive = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  async function openLive() {
    if (liveEl) return;
    if (!canLive()) { fileEl.click(); return; }
    liveEl = document.createElement('div');
    liveEl.className = 'cam-live';
    liveEl.innerHTML = `
      <video class="cam-video" playsinline muted autoplay></video>
      <div class="cam-frame" id="camFrame"><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i></div>
      <p class="cam-hint">型式の文字を<b>□の中いっぱい</b>に収めてください<br><small>ピントが合うまで少し待ってから、シャッターを押します</small></p>
      <button type="button" class="cam-live-x" id="camLiveX" aria-label="閉じる">✕</button>
      <div class="cam-bar">
        <button type="button" class="cam-side" id="camPick">🖼<span>写真から選ぶ</span></button>
        <button type="button" class="cam-shot" id="camShot" aria-label="撮影"><i></i></button>
        <button type="button" class="cam-side" id="camLight" hidden>💡<span>ライト</span></button>
      </div>`;
    document.body.appendChild(liveEl);
    document.body.classList.add('cam-live-open');
    const video = liveEl.querySelector('video');
    liveEl.querySelector('#camLiveX').addEventListener('click', stopLive);
    liveEl.querySelector('#camPick').addEventListener('click', () => { stopLive(); fileEl.click(); });
    try {
      liveStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
      });
    } catch (e) {
      stopLive();
      // カメラの許可がない・使えない場合は、従来の写真選択に切り替える
      fileEl.click();
      return;
    }
    video.srcObject = liveStream;
    video.play().catch(() => {});
    const track = liveStream.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* 非対応でも可 */ }
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) {
        const lb = liveEl.querySelector('#camLight');
        lb.hidden = false;
        lb.addEventListener('click', async () => {
          torchOn = !torchOn;
          try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); lb.classList.toggle('on', torchOn); } catch (e) { torchOn = false; }
        });
      }
    } catch (e) { /* ライト非対応 */ }
    liveEl.querySelector('#camShot').addEventListener('click', () => shoot(video));
  }

  // □の位置を、カメラ映像（object-fit: cover）上の座標に直して、その部分だけを切り出す
  function shoot(video) {
    if (!video.videoWidth) return;
    const box = liveEl.getBoundingClientRect();
    const fr = liveEl.querySelector('#camFrame').getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.max(box.width / vw, box.height / vh);
    const offX = (vw * scale - box.width) / 2, offY = (vh * scale - box.height) / 2;
    const pad = 0.05;   // 文字が枠の縁にかかってもよいよう、枠より少し広めに取る
    let sx = (fr.left - box.left + offX) / scale - fr.width / scale * pad;
    let sy = (fr.top - box.top + offY) / scale - fr.height / scale * pad;
    let sw = fr.width / scale * (1 + pad * 2), sh = fr.height / scale * (1 + pad * 2);
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
    const c = document.createElement('canvas');
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.85);
    stopLive();
    recognizeImage(c, url, true);
  }

  // 📷ボタンは <label for="camFile"> なので、JSが動かなくても写真選択は開く。
  // カメラが使える環境では、写真選択ではなくガイド枠つきの撮影画面を開く。
  [camBtn, document.getElementById('camWide')].forEach((el) => {
    if (!el) return;
    el.addEventListener('click', (e) => { if (canLive()) { e.preventDefault(); openLive(); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (canLive()) openLive(); else fileEl.click(); } });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && liveEl) stopLive(); });
  fileEl.addEventListener('change', () => {
    const f = fileEl.files && fileEl.files[0];
    if (f) handleFile(f);
    fileEl.value = '';   // 同じ写真をもう一度選んでも反応するように
  });

  window.__camera = { similarity, expandModel, tokensFrom, matchTokens, detectBrands, handleFile, openLive, shoot };
})();
