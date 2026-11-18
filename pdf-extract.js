// PDF -> text lines and pictures, using pdf.js.
// A PDF only knows where each piece of text sits on the page. This file turns those pieces into lines with
// positions, font sizes, bold/italic/superscript runs and writing direction, and captures the pictures as
// images. structure.js then rebuilds paragraphs, headings and chapters from these lines.
(function (global) {
  'use strict';

  const BASE = new URL('.', (document.currentScript && document.currentScript.src) || location.href).href;
  let pdfjsPromise = null;
  function loadPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(`${BASE}vendor/pdfjs/pdf.min.mjs`).then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = `${BASE}vendor/pdfjs/pdf.worker.min.mjs`;
        return lib;
      });
    }
    return pdfjsPromise;
  }

  const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
  const LTR_CHARS = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/g;
  const count = (s, re) => (s.match(re) || []).length;

  // ---------------------------------------------------------------------------------------------------------
  async function extractPdf(data, options) {
    const o = Object.assign({ imageScale: 2.5, keepImages: true, password: undefined, onProgress: () => {} }, options);
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
      data,
      password: o.password,
      isEvalSupported: false,
      cMapUrl: `${BASE}vendor/pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${BASE}vendor/pdfjs/standard_fonts/`,
    });
    const pdf = await task.promise;

    let info = {};
    try { info = (await pdf.getMetadata()).info || {}; } catch (_) { /* no metadata */ }

    const pages = [];
    try {
      for (let n = 1; n <= pdf.numPages; n++) {
        o.onProgress((n - 1) / pdf.numPages, `Reading page ${n} of ${pdf.numPages}`);
        o.pageLabel = { n, total: pdf.numPages };
        const page = await pdf.getPage(n);
        pages.push(await extractPage(pdfjs, page, o));
        page.cleanup();
      }
    } finally {
      if (o.ocrWorker) { try { (await o.ocrWorker).terminate(); } catch (_) { /* never started */ } }
    }

    const outline = await readOutline(pdf, pages);
    let cover = null;
    try {
      const first = await pdf.getPage(1);
      cover = await renderToDataUrl(first, 1.6, null, 0.9);
    } catch (_) { /* no cover */ }
    o.onProgress(1, 'Done');
    const result = {
      title: (info.Title || '').trim(),
      author: (info.Author || '').trim(),
      language: (info.Language || '').trim(),
      numPages: pdf.numPages,
      pages,
      outline,
      cover,
    };
    await pdf.destroy();
    return result;
  }

  // ---------------------------------------------------------------------------------------------------------
  async function extractPage(pdfjs, page, o) {
    const opList = await page.getOperatorList(); // also loads the fonts, so their names (Bold/Italic) are known
    const tc = await page.getTextContent({ disableNormalization: false });

    // Read the page in the orientation that makes most of its text horizontal. That is usually the page's own
    // rotation, but some PDFs rotate the page without rotating the text (or scan sideways).
    let vp = page.getViewport({ scale: 1 });
    let best = -1;
    for (const rot of [page.rotate, 0, 90, 180, 270]) {
      const v = page.getViewport({ scale: 1, rotation: rot });
      let score = 0;
      for (const it of tc.items) {
        if (!it.str || !it.transform) continue;
        const m = pdfjs.Util.transform(v.transform, it.transform);
        if (m[0] > 0 && Math.abs(m[1]) < m[0] * 0.2) score += it.str.length;
      }
      if (score > best) { best = score; vp = v; }
    }
    const rotation = vp.rotation;

    const fontCache = new Map();
    const fontInfo = (name) => {
      if (fontCache.has(name)) return fontCache.get(name);
      let f = null;
      try { f = page.commonObjs.get(name); } catch (_) { /* not loaded */ }
      const style = (tc.styles && tc.styles[name]) || {};
      const fullName = `${(f && f.name) || ''} ${style.fontFamily || ''}`;
      const res = {
        bold: !!(f && (f.bold || f.black)) || /bold|black|heavy|semibold|demi|\bw[6-9]\b/i.test(fullName),
        italic: !!(f && f.italic) || /italic|oblique|\bit\b/i.test(fullName),
        mono: /mono|courier|consol/i.test(fullName),
      };
      fontCache.set(name, res);
      return res;
    };

    // 1. text pieces in page coordinates (top-left origin, CSS-like)
    const pieces = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      // measured after the page's own rotation, so landscape / rotated pages read normally
      const [a, b, c, d, x, y] = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
      if (Math.abs(b) > Math.abs(a) * 0.2) continue; // rotated text (margin notes, watermarks)
      const width = it.width;
      if (!it.str && !it.hasEOL) continue;
      pieces.push({ text: it.str, x, base: y, w: width, size, dir: it.dir, font: fontInfo(it.fontName), eol: it.hasEOL });
    }

    // 2. lines: pieces that share a baseline, in content-stream order (which follows columns in most PDFs)
    const lines = [];
    let cur = null;
    for (const p of pieces) {
      if (!p.text.trim()) {
        if (cur && p.text) cur.pieces.push(p);
        continue;
      }
      const sameLine = cur &&
        Math.abs(p.base - cur.base) < Math.max(p.size, cur.size) * 0.55 &&
        p.x < cur.right + cur.size * 3 && p.x + p.w > cur.left - cur.size * 3;
      if (!sameLine) {
        cur = { pieces: [], base: p.base, size: p.size, left: p.x, right: p.x + p.w };
        lines.push(cur);
      }
      cur.pieces.push(p);
      cur.left = Math.min(cur.left, p.x);
      cur.right = Math.max(cur.right, p.x + p.w);
      if (p.size > cur.size * 1.05 && p.text.trim().length > 1) { cur.size = p.size; cur.base = p.base; }
    }

    const outLines = [];
    for (const l of lines) {
      const text = l.pieces.map((p) => p.text).join('');
      const rtl = count(text, RTL_CHARS) > count(text, LTR_CHARS);
      const words = l.pieces.filter((p) => p.text.trim());
      words.sort((p, q) => (rtl ? (q.x + q.w) - (p.x + p.w) : p.x - q.x));
      // body size of the line = size covering most characters
      const sizes = new Map();
      for (const p of words) { const k = Math.round(p.size * 2) / 2; sizes.set(k, (sizes.get(k) || 0) + p.text.length); }
      const lineSize = [...sizes.entries()].sort((x, y) => y[1] - x[1])[0][0];
      const mainBase = (words.find((p) => Math.abs(p.size - lineSize) < 0.6) || words[0]).base;

      const runs = [];
      let prev = null;
      for (const p of words) {
        let t = p.text;
        if (prev) {
          const gap = rtl ? prev.x - (p.x + p.w) : p.x - (prev.x + prev.w);
          if (gap > Math.min(p.size, prev.size) * 0.18 && !/\s$/.test(prev.text) && !/^\s/.test(t)) runs[runs.length - 1].text += ' ';
        }
        const sup = p.size < lineSize * 0.85 && p.base < mainBase - lineSize * 0.15;
        const sub = p.size < lineSize * 0.85 && p.base > mainBase + lineSize * 0.1;
        const style = { b: p.font.bold, i: p.font.italic, m: p.font.mono, sup, sub };
        const last = runs[runs.length - 1];
        if (last && last.b === style.b && last.i === style.i && last.m === style.m && last.sup === style.sup && last.sub === style.sub) last.text += t;
        else runs.push(Object.assign({ text: t }, style));
        prev = p;
      }
      runs.forEach((r) => { r.text = r.text.replace(/\s+/g, ' '); });
      if (runs.length) { runs[0].text = runs[0].text.replace(/^\s+/, ''); runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, ''); }
      const lineText = runs.map((r) => r.text).join('');
      if (!lineText) continue;
      outLines.push({
        runs,
        text: lineText,
        size: lineSize,
        base: mainBase,
        top: mainBase - lineSize * 0.8,
        bottom: mainBase + lineSize * 0.25,
        left: l.left,
        right: l.right,
        rtl,
      });
    }

    // 3. pictures: follow the drawing operations to find where each image is painted
    const images = [];
    const textChars = outLines.reduce((s, l) => s + l.text.length, 0);
    const OPS = pdfjs.OPS;
    const Util = pdfjs.Util;
    let ctm = vp.transform.slice();
    const stack = [];
    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || ctm;
      else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0]) ctm = Util.transform(ctm, args[0]); }
      else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObject) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([px, py]) => Util.applyTransform([px, py], ctm));
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const box = {
          left: Math.max(0, Math.min(...xs)), right: Math.min(vp.width, Math.max(...xs)),
          top: Math.max(0, Math.min(...ys)), bottom: Math.min(vp.height, Math.max(...ys)),
        };
        if (box.right - box.left < 16 || box.bottom - box.top < 16) continue; // bullets, rules, specks
        images.push(box);
      }
    }

    // merge overlapping boxes (pictures made of tiles)
    const merged = [];
    for (const b of images.sort((p, q) => p.top - q.top)) {
      const m = merged.find((x) => b.left < x.right + 2 && b.right > x.left - 2 && b.top < x.bottom + 2 && b.bottom > x.top - 2);
      if (m) { m.left = Math.min(m.left, b.left); m.right = Math.max(m.right, b.right); m.top = Math.min(m.top, b.top); m.bottom = Math.max(m.bottom, b.bottom); } else merged.push(Object.assign({}, b));
    }

    const pageArea = vp.width * vp.height;
    const scanned = textChars < 20;
    let pics = merged.filter((b) => {
      const area = (b.right - b.left) * (b.bottom - b.top);
      // a picture covering the whole page behind real text is a background (or a scan with a text layer)
      return scanned || area < pageArea * 0.8;
    });
    if (!o.keepImages) pics = [];

    // Text recognition (OCR): scanned pages (or every page) are read from their picture.
    const ocrMode = (o.ocr && o.ocr.mode) || 'off';
    if (ocrMode === 'all' || (ocrMode === 'auto' && scanned)) {
      const res = await ocrPage(page, rotation, vp, o);
      if (res && (res.lines.length || ocrMode === 'all')) {
        return {
          width: vp.width, height: vp.height, rotation, lines: res.lines,
          images: o.keepImages ? res.images : [], scanned: false, ocr: true, ocrConfidence: res.confidence,
        };
      }
    }

    if (scanned && (pics.length || textChars === 0)) {
      // a page without text (a scan or a full-page illustration): keep the whole page as one picture
      pics = [{ left: 0, top: 0, right: vp.width, bottom: vp.height, fullPage: true }];
    }

    if (pics.length) {
      const canvas = await renderPage(page, o.imageScale, rotation);
      for (const b of pics) {
        b.src = cropToDataUrl(canvas, b, o.imageScale);
        b.width = Math.round((b.right - b.left) * o.imageScale);
        b.height = Math.round((b.bottom - b.top) * o.imageScale);
      }
      canvas.width = canvas.height = 0;
    }

    return { width: vp.width, height: vp.height, rotation, lines: outLines, images: pics, scanned };
  }

  // ---------------------------------------------------------------------------------------------------------
  // OCR with Tesseract.js (bundled in vendor/tesseract; language models are downloaded once, then cached).
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(el);
    });
  }

  async function getOcrWorker(o) {
    if (!o.ocrWorker) {
      o.ocrWorker = (async () => {
        if (!global.Tesseract) await loadScript(`${BASE}vendor/tesseract/tesseract.min.js`);
        const langs = (o.ocr.langs || 'eng').split('+').filter(Boolean);
        // Tesseract.js never settles createWorker() when a language model fails to load; it only calls
        // errorHandler. Turn that into a rejection so the app can tell the reader instead of waiting forever.
        let failed;
        const failure = new Promise((_, reject) => { failed = reject; });
        const describe = (e) => {
          const msg = String((e && e.message) || e || 'unknown error');
          return /fetch|network|404|traineddata/i.test(msg)
            ? `Could not download the text recognition model for ${langs.join(' + ')}. Check the internet connection (it is needed once per language).`
            : `Text recognition failed: ${msg}`;
        };
        return Promise.race([failure, global.Tesseract.createWorker(langs, 1 /* LSTM */, {
          errorHandler: (e) => failed(new Error(describe(e))),
          workerPath: `${BASE}vendor/tesseract/worker.min.js`,
          corePath: `${BASE}vendor/tesseract/`,
          ...(o.ocr.langPath ? { langPath: o.ocr.langPath } : {}), // default: jsDelivr, cached in the browser
          logger: (m) => {
            const pl = o.pageLabel || { n: 1, total: 1 };
            if (/recogniz/.test(m.status)) {
              o.onProgress((pl.n - 1 + m.progress) / pl.total, `Recognising text on page ${pl.n} of ${pl.total}`);
            } else if (/load|initializ/.test(m.status)) {
              o.onProgress((pl.n - 1) / pl.total, `Loading text recognition (${langs.join(', ')})… first time only`);
            }
          },
        })]);
      })();
      // a failed start must not stay cached
      o.ocrWorker.catch(() => { o.ocrWorker = null; });
    }
    return o.ocrWorker;
  }

  const OCR_PICTURE_BLOCKS = new Set([9, 10, 11]); // Tesseract PT_FLOWING_IMAGE, PT_HEADING_IMAGE, PT_PULLOUT_IMAGE

  async function ocrPage(page, rotation, vp, o) {
    // about 300 dpi, capped so huge pages stay within memory
    const scale = Math.min(300 / 72, 4200 / Math.max(vp.width, vp.height));
    const canvas = await renderPage(page, scale, rotation);
    try {
      const worker = await getOcrWorker(o);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      const raw = [];
      const images = [];
      for (const block of data.blocks || []) {
        if (OCR_PICTURE_BLOCKS.has(block.blocktype)) {
          const b = { left: block.bbox.x0 / scale, top: block.bbox.y0 / scale, right: block.bbox.x1 / scale, bottom: block.bbox.y1 / scale };
          if (b.right - b.left > 30 && b.bottom - b.top > 30) {
            b.src = cropToDataUrl(canvas, b, scale);
            b.width = Math.round((b.right - b.left) * Math.min(scale, o.imageScale));
            b.height = Math.round((b.bottom - b.top) * Math.min(scale, o.imageScale));
            images.push(b);
          }
          continue;
        }
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            const words = (line.words || []).filter((w) => w.text && w.text.trim())
              .map((w) => ({ text: w.text.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim(), x0: w.bbox.x0, x1: w.bbox.x1, y0: w.bbox.y0, y1: w.bbox.y1, conf: w.confidence }));
            if (!words.length) continue;
            const bb = line.bbox;
            raw.push({
              words,
              rowH: (line.rowAttributes && line.rowAttributes.rowHeight) || (bb.y1 - bb.y0),
              base: line.baseline ? (line.baseline.y0 + line.baseline.y1) / 2 : bb.y1,
              y0: bb.y0,
              y1: bb.y1,
            });
          }
        }
      }

      const ordered = splitColumns(raw);
      const lines = [];
      let confSum = 0;
      let confChars = 0;
      for (const seg of ordered) {
        const text = seg.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ');
        const conf = seg.words.reduce((sum, w) => sum + w.conf * w.text.length, 0) / Math.max(1, text.length);
        // specks and smudges come back as low-confidence lines without real words
        if ((conf < 45 && !/\p{L}{2}/u.test(text)) || conf < 25) continue;
        confSum += conf * text.length;
        confChars += text.length;
        const left = Math.min(...seg.words.map((w) => w.x0));
        const right = Math.max(...seg.words.map((w) => w.x1));
        lines.push({
          runs: [{ text, b: false, i: false, m: false, sup: false, sub: false }],
          text,
          size: Math.round((seg.rowH / scale) * 2) / 2,
          base: seg.base / scale,
          top: Math.min(...seg.words.map((w) => w.y0)) / scale,
          bottom: Math.max(...seg.words.map((w) => w.y1)) / scale,
          left: left / scale,
          right: right / scale,
          rtl: count(text, RTL_CHARS) > count(text, LTR_CHARS),
          ocr: true,
        });
      }
      // pictures: Tesseract does not report them, so look for large inked areas that are not text
      if (o.keepImages) {
        const textBoxes = lines.filter((l) => /\p{L}{2}/u.test(l.text)).map((l) => l);
        for (const b of detectPictures(canvas, scale, textBoxes)) {
          b.src = cropToDataUrl(canvas, b, scale);
          b.width = Math.round((b.right - b.left) * Math.min(scale, o.imageScale));
          b.height = Math.round((b.bottom - b.top) * Math.min(scale, o.imageScale));
          images.push(b);
        }
      }
      // text "recognised" inside a picture is noise
      const inPicture = (l) => images.some((b) => {
        const cx = (l.left + l.right) / 2;
        const cy = (l.top + l.bottom) / 2;
        return cx > b.left && cx < b.right && cy > b.top && cy < b.bottom;
      });
      return { lines: lines.filter((l) => !inPicture(l)), images, confidence: confChars ? confSum / confChars : 0 };
    } finally {
      canvas.width = canvas.height = 0;
    }
  }

  // Tesseract often reads narrow-gutter columns as one wide line. Find gutters (word gaps that recur at the
  // same x on many lines), split the lines there, and put the pieces back in reading order: within each run
  // of split lines, the whole first column, then the next. Full-width lines stay where they are.
  function splitColumns(raw) {
    if (raw.length < 4) return raw;
    const rtlPage = raw.reduce((n, l) => n + count(l.words.map((w) => w.text).join(''), RTL_CHARS), 0) >
      raw.reduce((n, l) => n + count(l.words.map((w) => w.text).join(''), LTR_CHARS), 0);
    const rowH = [...raw.map((l) => l.rowH)].sort((a, b) => a - b)[Math.floor(raw.length / 2)] || 20;
    const bin = rowH * 0.5;
    const votes = new Map();
    for (const l of raw) {
      const ws = [...l.words].sort((a, b) => a.x0 - b.x0);
      const seen = new Set();
      for (let i = 1; i < ws.length; i++) {
        const gap = ws[i].x0 - ws[i - 1].x1;
        if (gap < rowH * 0.9) continue;
        const k = Math.round((ws[i - 1].x1 + ws[i].x0) / 2 / bin);
        if (!seen.has(k)) { seen.add(k); votes.set(k, (votes.get(k) || 0) + 1); }
      }
    }
    const need = Math.min(Math.max(3, raw.length * 0.2), 4); // a few lines of columns are enough
    const gutters = [];
    for (const [k, v] of [...votes.entries()].sort((a, b) => a[0] - b[0])) {
      const n = v + (votes.get(k - 1) || 0) + (votes.get(k + 1) || 0);
      if (n >= need && !gutters.some((g) => Math.abs(g / bin - k) <= 2)) gutters.push(k * bin);
    }
    if (!gutters.length) return raw;

    const colOf = (x) => { let c = 0; for (const g of gutters) if (x > g) c++; return rtlPage ? gutters.length - c : c; };
    // split every line at the gutters it has a real gap at
    const rows = raw.map((l) => {
      const ws = [...l.words].sort((a, b) => a.x0 - b.x0);
      const pieces = [[ws[0]]];
      for (let i = 1; i < ws.length; i++) {
        const gap = ws[i].x0 - ws[i - 1].x1;
        // the gap must contain the gutter (a short last word leaves a wide gap that is still a gutter)
        if (gap > rowH * 0.6 && gutters.some((g) => ws[i - 1].x1 < g + bin && ws[i].x0 > g - bin)) pieces.push([]);
        pieces[pieces.length - 1].push(ws[i]);
      }
      const segs = pieces.map((p) => {
        const set = new Set(p);
        return Object.assign({}, l, { words: l.words.filter((w) => set.has(w)) }); // keep the reading (logical) word order
      });
      const x0 = ws[0].x0;
      const x1 = ws[ws.length - 1].x1;
      const full = segs.length === 1 && gutters.some((g) => x0 < g - rowH && x1 > g + rowH);
      return { segs, full };
    });

    // real columns carry text on every side; a table of contents ("Title ...... 12") does not
    const widths = new Map();
    for (const r of rows) {
      if (r.full || r.segs.length < 2) continue;
      for (const seg of r.segs) {
        const xs = seg.words.map((w) => (w.x0 + w.x1) / 2);
        const c = colOf(xs.reduce((a, b) => a + b, 0) / xs.length);
        if (!widths.has(c)) widths.set(c, []);
        widths.get(c).push(Math.max(...seg.words.map((w) => w.x1)) - Math.min(...seg.words.map((w) => w.x0)));
      }
    }
    if (widths.size < 2 || [...widths.values()].some((ws) => ws.sort((a, b) => a - b)[Math.floor(ws.length / 2)] < rowH * 8)) return raw;

    const out = [];
    let zone = [];
    const flushZone = () => {
      const byCol = new Map();
      for (const seg of zone) {
        const xs = seg.words.map((w) => (w.x0 + w.x1) / 2);
        const c = colOf(xs.reduce((a, b) => a + b, 0) / xs.length);
        if (!byCol.has(c)) byCol.set(c, []);
        byCol.get(c).push(seg);
      }
      for (const c of [...byCol.keys()].sort((a, b) => a - b)) out.push(...byCol.get(c));
      zone = [];
    };
    for (const r of rows) {
      if (r.full) { flushZone(); out.push(...r.segs); } else zone.push(...r.segs);
    }
    flushZone();
    return out;
  }

  // Finds pictures on a scanned page: cells (about 4 pt square) with enough ink that are not covered by text
  // lines are grouped into regions; large, dense regions are pictures. Returns boxes in page units.
  function detectPictures(canvas, scale, textLines) {
    const W = canvas.width;
    const H = canvas.height;
    const cell = Math.max(4, Math.round(scale * 4));
    const gw = Math.ceil(W / cell);
    const gh = Math.ceil(H / cell);
    const img = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    // paper brightness: a bright percentile of a pixel sample (handles yellowed or grey scans)
    const sample = [];
    for (let i = 0; i < img.length; i += 4 * 97) sample.push((img[i] * 299 + img[i + 1] * 587 + img[i + 2] * 114) / 1000);
    sample.sort((a, b) => a - b);
    const paper = sample[Math.floor(sample.length * 0.9)] || 255;
    const inkBelow = paper - 35;

    const covered = new Uint8Array(gw * gh);
    const pad = 2 * scale;
    for (const l of textLines) {
      const x0 = Math.max(0, Math.floor((l.left * scale - pad) / cell));
      const x1 = Math.min(gw - 1, Math.floor((l.right * scale + pad) / cell));
      const y0 = Math.max(0, Math.floor((l.top * scale - pad) / cell));
      const y1 = Math.min(gh - 1, Math.floor((l.bottom * scale + pad) / cell));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) covered[y * gw + x] = 1;
    }
    const ink = new Uint8Array(gw * gh);
    const step = Math.max(1, Math.floor(cell / 4)); // sample 4x4 pixels per cell
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        if (covered[gy * gw + gx]) continue;
        let n = 0;
        let dark = 0;
        for (let y = gy * cell; y < Math.min(H, (gy + 1) * cell); y += step) {
          for (let x = gx * cell; x < Math.min(W, (gx + 1) * cell); x += step) {
            const i = (y * W + x) * 4;
            n++;
            if ((img[i] * 299 + img[i + 1] * 587 + img[i + 2] * 114) / 1000 < inkBelow) dark++;
          }
        }
        if (n && dark / n > 0.12) ink[gy * gw + gx] = 1;
      }
    }
    // connected regions (8-neighbour, bridging 1-cell gaps)
    const seen = new Uint8Array(gw * gh);
    const boxes = [];
    for (let start = 0; start < ink.length; start++) {
      if (!ink[start] || seen[start]) continue;
      const stack = [start];
      seen[start] = 1;
      let x0 = gw;
      let y0 = gh;
      let x1 = 0;
      let y1 = 0;
      let cells = 0;
      while (stack.length) {
        const c = stack.pop();
        const cx = c % gw;
        const cy = (c - cx) / gw;
        cells++;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
            const ni = ny * gw + nx;
            if (ink[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
          }
        }
      }
      const w = (x1 - x0 + 1) * cell / scale;
      const h = (y1 - y0 + 1) * cell / scale;
      const density = cells / ((x1 - x0 + 1) * (y1 - y0 + 1));
      if (w >= 40 && h >= 30 && w * h >= 2500 && density >= 0.35) {
        boxes.push({
          left: Math.max(0, (x0 * cell) / scale),
          top: Math.max(0, (y0 * cell) / scale),
          right: Math.min(W, (x1 + 1) * cell) / scale,
          bottom: Math.min(H, (y1 + 1) * cell) / scale,
        });
      }
    }
    return boxes;
  }

  async function renderPage(page, scale, rotation) {
    const vp = page.getViewport(rotation === undefined ? { scale } : { scale, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas;
  }

  function cropToDataUrl(canvas, b, scale) {
    const sx = Math.floor(b.left * scale);
    const sy = Math.floor(b.top * scale);
    const w = Math.max(1, Math.ceil((b.right - b.left) * scale));
    const h = Math.max(1, Math.ceil((b.bottom - b.top) * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(canvas, sx, sy, w, h, 0, 0, w, h);
    // photos compress far better as JPEG; small drawings stay sharp as PNG
    const url = w * h > 250000 ? c.toDataURL('image/jpeg', 0.92) : c.toDataURL('image/png');
    c.width = c.height = 0;
    return url;
  }

  async function renderToDataUrl(page, scale, box, quality) {
    const canvas = await renderPage(page, scale);
    const url = canvas.toDataURL('image/jpeg', quality);
    canvas.width = canvas.height = 0;
    return url;
  }

  // The PDF's bookmarks, resolved to page + vertical position.
  async function readOutline(pdf, pages) {
    let outline = null;
    try { outline = await pdf.getOutline(); } catch (_) { return []; }
    if (!outline) return [];
    const out = [];
    const walk = async (items, depth) => {
      for (const it of items) {
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            const pageIndex = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
            const pg = pages[pageIndex];
            let top = 0;
            if (pg && dest[1] && dest[1].name === 'XYZ' && typeof dest[3] === 'number') top = Math.max(0, pg.height - dest[3]);
            if (it.title && it.title.trim()) out.push({ title: it.title.replace(/\s+/g, ' ').trim(), depth, page: pageIndex, top });
          }
        } catch (_) { /* unresolvable bookmark */ }
        if (it.items && it.items.length) await walk(it.items, depth + 1);
      }
    };
    await walk(outline, 0);
    return out;
  }

  global.PdfExtract = { extractPdf, loadPdfjs };
})(typeof window !== 'undefined' ? window : globalThis);
