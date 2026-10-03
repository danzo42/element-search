// PaddleOCR（PP-OCRv3 英数字）を onnxruntime-web で端末内実行する。
// 1) 検出モデルで文字の並び（行）の位置を探す  2) 認識モデルで各行を読む（CTC貪欲デコード）
// 画像・読み取り結果は端末の外へ送らない。
(() => {
  'use strict';
  const BASE = new URL('vendor/ocr/', document.currentScript ? document.currentScript.src : location.href).href;
  const DET_MEAN = [0.485, 0.456, 0.406], DET_STD = [0.229, 0.224, 0.225];
  let loading = null, ortRef = null, det = null, rec = null, dict = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('文字認識の部品を読み込めませんでした（初回はインターネット接続が必要です）'));
      document.head.appendChild(s);
    });
  }

  async function load(onStatus) {
    if (loading) return loading;
    loading = (async () => {
      const say = onStatus || (() => {});
      say('文字認識エンジンを読み込んでいます…（初回のみ・約20MB）');
      if (!window.ort) await loadScript(BASE + 'ort.min.js');
      ortRef = window.ort;
      ortRef.env.wasm.wasmPaths = BASE;
      ortRef.env.wasm.numThreads = 1;        // GitHub Pagesでは複数スレッドが使えないため1本で動かす
      ortRef.env.wasm.proxy = false;
      const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      say('文字検出モデルを準備しています…');
      det = await ortRef.InferenceSession.create(BASE + 'det.onnx', opt);
      say('文字認識モデルを準備しています…');
      rec = await ortRef.InferenceSession.create(BASE + 'rec.onnx', opt);
      const txt = await (await fetch(BASE + 'en_dict.txt')).text();
      dict = txt.split('\n').map((s) => s.replace(/\r$/, '')).filter((s, i, a) => s.length > 0 || i < a.length - 1);
      if (dict[dict.length - 1] === '') dict.pop();
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }

  // ---------- 検出 ----------
  function toCanvas(src) {
    if (src instanceof HTMLCanvasElement) return src;
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  async function detect(canvas) {
    // 長辺を約960pxにそろえる（小さい切り出しは拡大）。32の倍数にする
    const maxSide = Math.max(canvas.width, canvas.height);
    const ratio = Math.min(2.5, 960 / maxSide);
    const rw = Math.max(32, Math.round(canvas.width * ratio / 32) * 32);
    const rh = Math.max(32, Math.round(canvas.height * ratio / 32) * 32);
    const c = document.createElement('canvas'); c.width = rw; c.height = rh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.drawImage(canvas, 0, 0, rw, rh);
    const d = x.getImageData(0, 0, rw, rh).data;
    const n = rw * rh, data = new Float32Array(3 * n);
    // PaddleOCRの検出は B,G,R の順で、画像平均・標準偏差で正規化する
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      data[j] = (d[i + 2] / 255 - DET_MEAN[0]) / DET_STD[0];
      data[n + j] = (d[i + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
      data[2 * n + j] = (d[i] / 255 - DET_MEAN[2]) / DET_STD[2];
    }
    const out = await det.run({ [det.inputNames[0]]: new ortRef.Tensor('float32', data, [1, 3, rh, rw]) });
    const prob = out[det.outputNames[0]].data;   // [1,1,rh,rw]
    return { prob, rw, rh, sx: canvas.width / rw, sy: canvas.height / rh };
  }

  // 確率マップ → 連結領域ごとの外接矩形（少し広げる）
  function boxesFrom({ prob, rw, rh, sx, sy }) {
    const TH = 0.3, BOX_TH = 0.55, UNCLIP = 1.8;
    const lab = new Int32Array(rw * rh);
    const stack = new Int32Array(rw * rh);
    const boxes = [];
    let id = 0;
    for (let y0 = 0; y0 < rh; y0++) {
      for (let x0 = 0; x0 < rw; x0++) {
        const p0 = y0 * rw + x0;
        if (lab[p0] || prob[p0] <= TH) continue;
        id++;
        let sp = 0, minx = x0, maxx = x0, miny = y0, maxy = y0, sum = 0, cnt = 0;
        stack[sp++] = p0; lab[p0] = id;
        while (sp) {
          const p = stack[--sp]; const px = p % rw, py = (p - px) / rw;
          sum += prob[p]; cnt++;
          if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py;
          if (px > 0 && !lab[p - 1] && prob[p - 1] > TH) { lab[p - 1] = id; stack[sp++] = p - 1; }
          if (px < rw - 1 && !lab[p + 1] && prob[p + 1] > TH) { lab[p + 1] = id; stack[sp++] = p + 1; }
          if (py > 0 && !lab[p - rw] && prob[p - rw] > TH) { lab[p - rw] = id; stack[sp++] = p - rw; }
          if (py < rh - 1 && !lab[p + rw] && prob[p + rw] > TH) { lab[p + rw] = id; stack[sp++] = p + rw; }
        }
        const w = maxx - minx + 1, h = maxy - miny + 1;
        if (cnt < 12 || Math.min(w, h) < 3 || sum / cnt < BOX_TH) continue;
        // 検出の出力は文字の実体より細いので、DBNetの慣例（unclip）で外側へ広げる
        const dist = (w * h * UNCLIP) / (2 * (w + h));
        boxes.push({
          x0: Math.max(0, (minx - dist) * sx), y0: Math.max(0, (miny - dist) * sy),
          x1: Math.min(rw * sx, (maxx + dist) * sx), y1: Math.min(rh * sy, (maxy + dist) * sy), score: sum / cnt,
        });
      }
    }
    return boxes;
  }

  // 近い高さの箱を同じ行にまとめ、行ごとに左から右へ並べる
  function groupLines(boxes) {
    const bs = boxes.slice().sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    bs.forEach((b) => {
      const cy = (b.y0 + b.y1) / 2, h = b.y1 - b.y0;
      const ln = lines.find((l) => Math.abs(l.cy - cy) < Math.max(l.h, h) * 0.5);
      if (ln) { ln.items.push(b); ln.cy = (ln.cy * (ln.items.length - 1) + cy) / ln.items.length; ln.h = Math.max(ln.h, h); }
      else lines.push({ cy, h, items: [b] });
    });
    lines.forEach((l) => l.items.sort((a, b) => a.x0 - b.x0));
    return lines;
  }

  // ---------- 認識 ----------
  async function recognizeBox(canvas, b) {
    const bw = Math.max(1, Math.round(b.x1 - b.x0)), bh = Math.max(1, Math.round(b.y1 - b.y0));
    const H = 48;
    const W = Math.max(16, Math.min(1600, Math.round(H * bw / bh)));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    x.drawImage(canvas, b.x0, b.y0, bw, bh, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    const n = W * H, data = new Float32Array(3 * n);
    for (let i = 0, j = 0; j < n; i += 4, j++) {   // B,G,R の順・(x/255-0.5)/0.5
      data[j] = (d[i + 2] / 255 - 0.5) / 0.5;
      data[n + j] = (d[i + 1] / 255 - 0.5) / 0.5;
      data[2 * n + j] = (d[i] / 255 - 0.5) / 0.5;
    }
    const out = await rec.run({ [rec.inputNames[0]]: new ortRef.Tensor('float32', data, [1, 3, H, W]) });
    const o = out[rec.outputNames[0]];
    const T = o.dims[1], C = o.dims[2], v = o.data;
    const useSpace = C === dict.length + 2;
    let text = '', last = 0, sum = 0, cnt = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bv = -1;
      for (let k = 0; k < C; k++) { const q = v[t * C + k]; if (q > bv) { bv = q; best = k; } }
      if (best !== 0 && best !== last) {
        const ch = best - 1 < dict.length ? dict[best - 1] : (useSpace ? ' ' : '');
        text += ch; sum += bv; cnt++;
      }
      last = best;
    }
    return { text, score: cnt ? sum / cnt : 0 };
  }

  // 画像（canvas/ImageBitmap/img）から文字行を読む。戻り値: [{text, score, box}]（上から下・左から右の順）
  async function recognize(src) {
    await load();
    const canvas = toCanvas(src);
    const d = await detect(canvas);
    const boxes = boxesFrom(d);
    const lines = groupLines(boxes);
    const results = [];
    for (const ln of lines) {
      const parts = [];
      for (const b of ln.items) {
        const r = await recognizeBox(canvas, b);
        if (r.text.trim()) parts.push({ ...r, box: b });
      }
      if (parts.length) results.push({
        text: parts.map((p) => p.text).join(' '),
        score: parts.reduce((s, p) => s + p.score, 0) / parts.length,
        box: ln.items[0], parts,
      });
    }
    return results;
  }

  window.PaddleOCR = { load, recognize, _detect: detect, _boxesFrom: boxesFrom };
})();
