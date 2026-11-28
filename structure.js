// Text lines from pdf-extract.js -> a reflowable book: paragraphs, headings, pictures and chapters.
// Pure data in, data out (no DOM), so it re-runs instantly when a conversion option changes.
(function (global) {
  'use strict';

  const DEFAULTS = {
    ocrCorrect: true,
    removeHeadersFooters: true,
    detectHeadings: true,
    joinHyphens: true,
    keepImages: true,
    useOutline: true,
    splitChapters: true,
  };

  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const norm = (s) => s.toLowerCase().replace(/[\d\s.,;:!?'"“”‘’()[\]\-–—_]+/g, '');
  const SENTENCE_END = /[.!?:;"”’»)\]…。！？]$/;
  const BULLET = /^([•●○◦▪▫■□‣⁃∙·*–—-]\s|\(?\d{1,3}[.)]\s|\(?[a-z][.)]\s|[ivx]{1,4}[.)]\s)/i;
  const CHAPTER_WORD = /^(פרק|חלק|ספר|שער|הקדמה|אחרית דבר|מבוא|chapter|part|book|prologue|epilogue|introduction|kapitel|teil|chapitre|partie|cap[ií]tulo|parte|capitolo|hoofdstuk|rozdzia[lł]|глава|часть|الفصل|الباب|فصل)(?=[\s:.\-–—]|$)/iu; // (\b only knows Latin letters)
  const PAGE_NUMBER = /^[\s\-–—|[\]()]*(page\s*)?([\divxlc]{1,6}|\d+\s*(of|\/)\s*\d+)[\s\-–—|[\]()]*$/i;

  function buildBook(doc, options) {
    const o = Object.assign({}, DEFAULTS, options);
    const pages = doc.pages;
    if (pages.some((p) => p.ocr || p.hiddenTextLayer)) correctOcr(pages, o.ocrCorrect);
    normalizeOcrSizes(pages);
    // how often each word occurs in the book (for joining words split at a line end)
    const wordFreq = new Map();
    for (const p of pages) {
      for (const l of p.lines) {
        for (const t of l.text.split(/\s+/)) {
          const w = t.replace(/[\u0591-\u05C7]/g, '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
          if (w) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
        }
      }
    }

    // ---- body text size (the size most characters use) --------------------------------------------------------
    const sizeChars = new Map();
    for (const p of pages) for (const l of p.lines) { const k = Math.round(l.size * 2) / 2; sizeChars.set(k, (sizeChars.get(k) || 0) + l.text.length); }
    const bodySize = sizeChars.size ? [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0][0] : 11;

    // ---- running headers / footers and page numbers -----------------------------------------------------------
    const drop = o.removeHeadersFooters ? findHeadersFooters(pages) : new Set();

    // ---- typical line spacing (relative to the font size) --------------------------------------------------------
    const gaps = [];
    for (const p of pages) {
      for (let i = 1; i < p.lines.length; i++) {
        const a = p.lines[i - 1];
        const b = p.lines[i];
        const g = b.base - a.base;
        if (g > 0 && g < a.size * 3 && Math.abs(a.size - b.size) < 0.6) gaps.push(g / a.size);
      }
    }
    const lineGap = median(gaps) || 1.2;

    // ---- outline (bookmarks) -> headings ------------------------------------------------------------------------
    const outlineMarks = new Map(); // line -> level
    const outlineInserts = []; // headings with no matching line
    if (o.useOutline && doc.outline && doc.outline.length) {
      for (const e of doc.outline) {
        const p = pages[e.page];
        if (!p) continue;
        const want = norm(e.title);
        const level = Math.min(6, e.depth + 1);
        const cand = p.lines.filter((l) => !drop.has(l) && l.bottom >= e.top - 4);
        const hit = cand.slice(0, 12).find((l) => {
          const t = norm(l.text);
          return t && want && (t.startsWith(want.slice(0, 24)) || want.startsWith(t));
        });
        if (hit && !outlineMarks.has(hit)) outlineMarks.set(hit, level);
        else if (!hit) outlineInserts.push({ page: e.page, top: e.top, title: e.title, level });
      }
    }
    const outlineDepth = outlineMarks.size ? Math.max(...outlineMarks.values()) : 0;

    // ---- heading levels from font sizes ---------------------------------------------------------------------------
    const headingSizes = [...sizeChars.keys()].filter((s) => s >= bodySize * 1.18).sort((a, b) => b - a);
    const sizeLevel = (s) => {
      const i = headingSizes.findIndex((h) => Math.abs(h - s) < 0.6);
      return i < 0 ? 0 : Math.min(6, outlineDepth + 1 + Math.min(i, 3));
    };

    // ---- walk every page: lines + pictures in reading order -> blocks ---------------------------------------------
    const blocks = [];
    let para = null; // { lines: [] }

    // ---- columns ------------------------------------------------------------------------------------------------
    // Positions are measured from where the writing starts: the left edge for left-to-right lines, the right
    // edge for right-to-left lines. Each page's columns are found from where its body lines start, and every
    // line is then judged against its own column (is it indented? does it stop short of the column's end?).
    const startOf = (l, w) => (l.rtl ? w - l.right : l.left);
    const endOf = (l, w) => (l.rtl ? w - l.left : l.right);
    const isBody = (l) => !drop.has(l) && Math.abs(l.size - bodySize) < 1;
    const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

    function findColumns(lines, w) {
      const body = lines.filter(isBody).sort((a, b) => startOf(a, w) - startOf(b, w));
      if (body.length < 4) return null;
      const clusters = [];
      for (const l of body) {
        const st = startOf(l, w);
        const c = clusters[clusters.length - 1];
        if (c && st < c.min + bodySize * 3) c.lines.push(l);
        else clusters.push({ min: st, lines: [l] });
      }
      const cols = clusters.filter((c) => c.lines.length >= Math.max(3, body.length * 0.12));
      if (!cols.length) return null;
      return cols.map((c, i) => {
        const next = cols[i + 1];
        // lines that run into the next column are full-width lines, not part of this column
        const own = c.lines.filter((l) => !next || endOf(l, w) < next.min - bodySize * 0.5);
        const starts = (own.length ? own : c.lines).map((l) => startOf(l, w));
        const ends = (own.length ? own : c.lines).map((l) => endOf(l, w));
        return { start: pct(starts, 0.25), end: pct(ends, 0.8) };
      });
    }

    const allBody = pages.flatMap((p) => p.lines.filter(isBody).map((l) => ({ st: startOf(l, p.width), en: endOf(l, p.width) })));
    const docColumn = allBody.length
      ? { start: pct(allBody.map((x) => x.st), 0.25), end: pct(allBody.map((x) => x.en), 0.8) }
      : { start: 0, end: pages[0] ? pages[0].width : 600 };
    const colOf = new Map();
    for (const p of pages) {
      const cols = findColumns(p.lines, p.width) || [docColumn];
      for (const l of p.lines) {
        const st = startOf(l, p.width);
        let col = cols[0];
        for (const c of cols) if (c.start <= st + bodySize) col = c;
        // a line that reaches past its column's end belongs to a full-width block
        if (endOf(l, p.width) > col.end + bodySize * 2) col = { start: col.start, end: Math.max(...cols.map((c) => c.end)) };
        colOf.set(l, { start: col.start, end: col.end, w: p.width });
      }
    }
    const geo = (l) => {
      const c = colOf.get(l);
      return { start: startOf(l, c.w), end: endOf(l, c.w), colStart: c.start, colEnd: c.end };
    };
    const isCentered = (l) => {
      const g = geo(l);
      return Math.abs((g.start + g.end) / 2 - (g.colStart + g.colEnd) / 2) < bodySize * 1.2 &&
        g.end - g.start < (g.colEnd - g.colStart) * 0.8 && g.start > g.colStart + bodySize;
    };

    const flush = () => { if (para) { blocks.push(finishParagraph(para)); para = null; } };

    function finishParagraph(pr) {
      const runs = [];
      pr.lines.forEach((l, i) => {
        const lr = l.runs.map((r) => Object.assign({}, r));
        if (i > 0) {
          const prev = runs[runs.length - 1];
          const first = lr[0];
          const lastWord = prev ? (prev.text.match(/(\S+)$/) || ['', ''])[1] : '';
          const startsHebrew = /^[\u05D0-\u05EA]/.test(first.text);
          if (o.joinHyphens && prev && startsHebrew && /[\u05D0-\u05EA][\u05BE\-\u2010]$/.test(prev.text)) {
            // Hebrew words joined by a maqaf (בית־הספר) split at the line end: keep the maqaf, no space
            prev.text = `${prev.text.slice(0, -1)}\u05BE`;
          } else if (o.joinHyphens && prev && startsHebrew && (pr.lines[i - 1].ocr || pr.lines[i - 1].ocrish) &&
              /[\u05D0-\u05EA]{2,}[ךד7]$/.test(lastWord) && (wordFreq.get(fixFinals(lastWord.slice(0, -1))) || 0) >= 2 && (wordFreq.get(lastWord) || 0) <= 1) {
            // OCR read a line-end maqaf as ך, ד or 7 (מכסה־ -> מכסהך, גס־ -> גסד): the word without it is a word of the book
            prev.text = `${prev.text.slice(0, -1)}\u05BE`;
          } else if (o.joinHyphens && prev && /\p{L}[-\u2010\u00AD]$/u.test(prev.text) && /^\p{Ll}/u.test(first.text)) {
            prev.text = prev.text.slice(0, -1); // re-join a word the PDF split at the line end
          } else if (prev && !/[\s­]$/.test(prev.text) && !/^\s/.test(first.text)) {
            prev.text += ' ';
          }
          if (prev && prev.text.endsWith('­')) prev.text = prev.text.slice(0, -1);
        }
        for (const r of lr) {
          const last = runs[runs.length - 1];
          if (last && last.b === r.b && last.i === r.i && last.m === r.m && last.sup === r.sup && last.sub === r.sub) last.text += r.text;
          else runs.push(r);
        }
      });
      const text = runs.map((r) => r.text).join('');
      const first = pr.lines[0];
      const rtl = pr.lines.filter((l) => l.rtl).length > pr.lines.length / 2;
      let level = pr.outlineLevel || 0;
      if (!level && o.detectHeadings && text.length < 220) {
        level = sizeLevel(first.size);
        // a long line that ends like a sentence is text, however big OCR measured it
        if (level && text.length > 40 && /[.,;:]["”״']?$/.test(text)) level = 0;
        // OCR sizes vary ~15% from line to line: an OCR'd line only a little bigger than the text is a heading
        // only if it also stands on its own as a short line (noise inside a paragraph does not)
        if (level && first.ocr && first.size < bodySize * 1.3 && !(pr.standalone && pr.lines.length <= 2 && text.length < 90)) level = 0;
        // a short centred line standing on its own that starts like a chapter title (OCR got its size wrong)
        if (!level && first.ocr && pr.lines.length === 1 && text.length < 70 && pr.standalone && pr.lines.every(isCentered) &&
            CHAPTER_WORD.test(text) && !/[.,;]["”״']?$/.test(text)) {
          level = Math.max(1, outlineDepth + 1);
        }
        // a short, all-bold line standing on its own, at body size or bigger
        if (!level && pr.lines.length <= 2 && text.length < 90 && first.size >= bodySize - 0.3 &&
            runs.every((r) => r.b || !r.text.trim()) && !/[.,;]$/.test(text) && pr.standalone) {
          level = Math.min(4, Math.max(2, outlineDepth + headingSizes.length + 1));
        }
      }
      const centered = pr.lines.length <= 3 && pr.lines.every(isCentered);
      if (level) return { type: 'h', level, runs: runs.map((r) => Object.assign(r, { b: false })), text, rtl, centered, size: first.size, fromOutline: !!pr.outlineLevel, page: pr.page };
      return { type: 'p', runs, text, rtl, centered, size: first.size / bodySize, page: pr.page, ocr: !!(first.ocr || first.ocrish) };
    }

    pages.forEach((p, pi) => {
      const items = [];
      for (const l of p.lines) if (!drop.has(l)) items.push({ kind: 'line', l, top: l.top });
      if (o.keepImages) for (const im of p.images) items.push({ kind: 'img', im, top: im.top });
      for (const ins of outlineInserts.filter((x) => x.page === pi)) items.push({ kind: 'outline', ins, top: ins.top - 0.5 });
      // Lines keep their stream order (it follows columns); pictures and missing bookmarks are slotted in
      // before the first line that sits below them.
      const lineItems = items.filter((x) => x.kind === 'line');
      const extras = items.filter((x) => x.kind !== 'line').sort((a, b) => a.top - b.top);
      const ordered = [];
      let ei = 0;
      for (const li of lineItems) {
        while (ei < extras.length && extras[ei].top <= li.top) ordered.push(extras[ei++]);
        ordered.push(li);
      }
      while (ei < extras.length) ordered.push(extras[ei++]);

      let prevLine = null;
      for (const it of ordered) {
        if (it.kind === 'img') {
          flush();
          blocks.push({ type: 'img', src: it.im.src, width: it.im.width, height: it.im.height, fullPage: !!it.im.fullPage, page: pi });
          prevLine = null;
          continue;
        }
        if (it.kind === 'outline') {
          flush();
          blocks.push({ type: 'h', level: it.ins.level, runs: [{ text: it.ins.title }], text: it.ins.title, fromOutline: true, page: pi });
          prevLine = null;
          continue;
        }
        const l = it.l;
        const a = para && para.lines[para.lines.length - 1];
        let brk = !para || outlineMarks.has(l) || para.outlineLevel;
        if (!brk) {
          const samePage = para.page === pi && prevLine;
          // OCR measures sizes loosely (±15%), so only a clear change counts there
          const sizeChange = Math.abs(l.size - a.size) > Math.max(0.6, a.size * (l.ocr && a.ocr ? 0.25 : 0.12));
          const styleChange = (a.runs.every((r) => r.b) !== l.runs.every((r) => r.b)) && (l.text.length < 120 || a.text.length < 120);
          const gap = samePage ? (l.base - a.base) / a.size : lineGap;
          const bigGap = samePage && (gap > lineGap * 1.45 || gap < -0.5);
          const wentUp = samePage && l.base < a.base - a.size * 0.5; // new column
          const gl = geo(l);
          const ga = geo(a);
          const indent = gl.start > gl.colStart + bodySize * 0.9;
          // The previous line ended early on purpose only if the next line's first word would have fitted in
          // the space left (otherwise it is just ragged-right text wrapping).
          const room = ga.colEnd - ga.end;
          const firstWord = (l.text.match(/^\S+/) || [''])[0];
          const wordWidth = (firstWord.length * 0.55 + 0.4) * l.size;
          const prevShort = room > bodySize * 2.5 && (room > wordWidth || room > (ga.colEnd - ga.colStart) * 0.4);
          const centered = isCentered(l);
          brk = sizeChange || styleChange || (bigGap && !wentUp) || BULLET.test(l.text) ||
            // a first-line indent starts a paragraph
            (indent && !centered && (SENTENCE_END.test(a.text) || prevShort)) ||
            // the previous line stopped well before the right edge: end of a paragraph (or a short verse line)
            prevShort;
        }
        if (brk) {
          flush();
          const nextIdx = ordered.indexOf(it) + 1;
          const next = ordered[nextIdx];
          const gapBefore = prevLine ? (l.base - prevLine.base) / prevLine.size : 99;
          const gapAfter = next && next.kind === 'line' ? (next.l.base - l.base) / l.size : 99;
          para = { lines: [l], page: pi, outlineLevel: outlineMarks.get(l) || 0, standalone: gapBefore > lineGap * 1.3 || gapAfter > lineGap * 1.3 };
        } else {
          para.lines.push(l);
        }
        prevLine = l;
      }
    });
    flush();

    // merge consecutive headings of the same level that are one title broken over lines
    const merged = [];
    for (const b of blocks) {
      const last = merged[merged.length - 1];
      if (b.type === 'h' && last && last.type === 'h' && last.level === b.level && !last.fromOutline && last.text.length + b.text.length < 160 && !b.fromOutline && Math.abs((last.size || 0) - (b.size || 0)) < 0.6) {
        last.runs.push({ text: ' ' }, ...b.runs);
        last.text += ` ${b.text}`;
      } else merged.push(b);
    }

    const book = splitChapters(merged, doc, o);
    book.headerDiag = drop.diag || null; // what the header/footer detector saw (diagnostic report)
    return book;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Running headers and footers. A line at the top or bottom edge of a page is dropped when
  //  - it is just a page number, or
  //  - it carries the page number (the number minus the page index is the same on many pages), or
  //  - similar text (fuzzy, so OCR misreadings still match) repeats at that edge on many pages, or on a few pages
  //    while standing apart from the text below/above it (chapter-title headers that change every chapter).
  const NIQQUD = /[֑-ׇ]/g;
  // letters OCR confuses map to one representative, so "הנא" and "הוא" give the same header key
  const LOOKALIKE = { 'נ': 'ו', 'ן': 'ו', 'ז': 'ו', 'י': 'ו', 'ג': 'ו', 'כ': 'ב', 'ך': 'ב', 'ר': 'ד', 'ת': 'ח', 'ה': 'ח', 'ם': 'ס', 'פ': 'ס', 'ף': 'ס', 'ט': 'מ', 'ץ': 'צ', 'ע': 'צ' };
  const headerKey = (t) => t.replace(NIQQUD, '').toLowerCase().replace(/[^\p{L}]/gu, '').replace(/./g, (c) => LOOKALIKE[c] || c);

  function similarity(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  function findHeadersFooters(pages) {
    const drop = new Set();
    const why = new Map(); // line -> reason (for the diagnostic report)
    const sizeChars = new Map();
    for (const p of pages) for (const l of p.lines) { const k = Math.round(l.size * 2) / 2; sizeChars.set(k, (sizeChars.get(k) || 0) + l.text.length); }
    const bodySize = sizeChars.size ? [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0][0] : 11;
    const isNoise = (l) => (l.text.match(/[\p{L}\p{N}]/gu) || []).length < 2 && !/\d/.test(l.text);
    const cands = [];
    pages.forEach((p, pi) => {
      const ls = [...p.lines].sort((a, b) => a.top - b.top);
      if (!ls.length) return;
      const add = (l, zone, neighbour) => {
        const gap = neighbour ? (zone === 'top' ? neighbour.top - l.bottom : l.top - neighbour.bottom) : 99;
        cands.push({
          l, pi, zone, key: headerKey(l.text).slice(0, 48),
          nums: (l.text.match(/\d{1,4}/g) || []).map(Number),
          short: l.text.length < 90,
          small: l.size <= bodySize * 1.1,
          apart: gap > Math.min(l.size, neighbour ? neighbour.size : l.size) * 0.9,
        });
      };
      // rows: lines that share a vertical band (a header is often read as several pieces: number, slash, title)
      const rows = [];
      for (const l of ls) {
        const r = rows[rows.length - 1];
        if (r && l.top < r.bottom - Math.min(l.bottom - l.top, r.bottom - r.top) * 0.4) { r.lines.push(l); r.bottom = Math.max(r.bottom, l.bottom); } else rows.push({ top: l.top, bottom: l.bottom, lines: [l] });
      }
      // specks at the page edges (a mark read as ' or |) are dropped and do not count as a row
      const edge = (r) => r.top < p.height * 0.18 || r.bottom > p.height * 0.82;
      const real = rows.filter((r) => {
        if (edge(r) && r.lines.every(isNoise)) { for (const l of r.lines) { drop.add(l); why.set(l, 'speck at the page edge'); } return false; }
        return true;
      });
      for (let i = 0; i < Math.min(2, real.length); i++) {
        if (real[i].top < p.height * 0.18) for (const l of real[i].lines) add(l, 'top', real[i + 1] && real[i + 1].lines[0]);
      }
      for (let i = real.length - 1; i >= Math.max(0, real.length - 2); i--) {
        if (real[i].bottom > p.height * 0.82) for (const l of real[i].lines) add(l, 'bottom', real[i - 1] && real[i - 1].lines[0]);
      }
    });

    // page numbers: printed number minus page index is constant across the book
    const offsets = new Map();
    for (const c of cands) for (const n of new Set(c.nums)) { const k = n - (c.pi + 1); offsets.set(k, (offsets.get(k) || 0) + 1); }
    const best = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0];
    // OCR misreads many page numbers, so a tenth of the pages agreeing is enough evidence
    const numbered = best && best[1] >= Math.max(3, pages.length * 0.1) ? best[0] : null;

    // fuzzy clusters of header/footer text, per edge (cheap checks first: exact key, length, shared letter pairs)
    const clusters = [];
    const exact = new Map();
    const pairs = (k) => { const set = new Set(); for (let i = 0; i + 1 < k.length; i++) set.add(k.slice(i, i + 2)); return set; };
    for (const c of cands) {
      if (c.key.length < 2) continue;
      let cl = exact.get(`${c.zone}|${c.key}`);
      if (!cl) {
        const cp = pairs(c.key);
        cl = clusters.find((x) => {
          if (x.zone !== c.zone || Math.abs(x.key.length - c.key.length) > Math.max(2, x.key.length * 0.3)) return false;
          let shared = 0;
          for (const pr of cp) if (x.pairs.has(pr)) shared++;
          if (shared < Math.min(cp.size, x.pairs.size) * 0.4) return false;
          return similarity(x.key, c.key) >= 0.75;
        });
        if (!cl) { cl = { zone: c.zone, key: c.key, pairs: cp, pages: new Set(), sample: c.l.text }; clusters.push(cl); }
        exact.set(`${c.zone}|${c.key}`, cl);
      }
      cl.pages.add(c.pi);
      c.cluster = cl;
    }
    const many = Math.max(3, pages.length * 0.25);
    for (const c of cands) {
      const reps = c.cluster ? c.cluster.pages.size : 0;
      let reason = null;
      if (PAGE_NUMBER.test(c.l.text)) reason = 'page number';
      else if (numbered !== null && c.short && c.nums.some((n) => n - (c.pi + 1) === numbered)) reason = 'carries the page number';
      else if (numbered !== null && c.short && c.small && c.apart && c.nums.length > 0) reason = 'short line with a (misread) page number';
      else if (pages.length >= 3 && reps >= many) reason = `repeats on ${reps} pages`;
      else if (reps >= 3 && c.short && c.apart) reason = `repeats on ${reps} pages, apart from the text`;
      if (reason) { drop.add(c.l); why.set(c.l, reason); }
      c.reason = reason;
      c.reps = reps;
    }
    drop.diag = {
      numbered, numberedVotes: best ? best[1] : 0, bodySize,
      clusters: clusters.filter((x) => x.pages.size >= 2).sort((a, b) => b.pages.size - a.pages.size).slice(0, 12)
        .map((x) => ({ zone: x.zone, pages: x.pages.size, sample: x.sample })),
      why, cands,
    };
    return drop;
  }


  // ---------------------------------------------------------------------------------------------------------
  // OCR measures text size from line heights, which drift from page to page on a poor scan. Scale each OCR'd
  // page so its body text has the book's body size; real headings stay bigger than the text of their page.
  function normalizeOcrSizes(pages) {
    const bodyOf = (lines) => {
      const m = new Map();
      for (const l of lines) { const k = Math.round(l.size * 2) / 2; m.set(k, (m.get(k) || 0) + l.text.length); }
      return m.size ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : 0;
    };
    // pages with little text (title pages, chapter openings with a few lines) have no reliable body size
    const ocrPages = pages.filter((p) => p.ocr && p.lines.length >= 8 && p.lines.reduce((n, l) => n + l.text.length, 0) >= 300);
    for (const p of pages) for (const l of p.lines) if (l.sizeOriginal !== undefined) l.size = l.sizeOriginal;
    for (const p of ocrPages) for (const l of p.lines) { if (l.sizeOriginal === undefined) l.sizeOriginal = l.size; l.size = l.sizeOriginal; }
    if (ocrPages.length < 2) return;
    const bodies = ocrPages.map((p) => bodyOf(p.lines)).filter(Boolean).sort((a, b) => a - b);
    const book = bodies[Math.floor(bodies.length / 2)];
    for (const p of ocrPages) {
      const pb = bodyOf(p.lines);
      if (!pb || !book) continue;
      const f = book / pb;
      if (Math.abs(f - 1) < 0.02) continue;
      for (const l of p.lines) l.size = Math.round(l.sizeOriginal * f * 2) / 2;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Book dictionary for OCR text. OCR confuses look-alike letters (ו/נ, ב/כ, ח/ת, ד/ר...) at random places, while
  // the correct spelling of a word appears many more times in the same book. A rarely seen word that becomes a
  // much more frequent word of the book by fixing one look-alike letter is corrected. Words that are common in
  // both spellings (אחד/אחר) are left alone, and confident readings need much stronger evidence.
  const HEB_PAIRS = ['ונ', 'וז', 'וי', 'ור', 'ון', 'וד', 'בכ', 'דר', 'חת', 'חה', 'הת', 'נג', 'זנ', 'סם', 'ספ', 'סט', 'טמ', 'עצ', 'כנ'];
  const LAT_PAIRS = [['rn', 'm'], ['cl', 'd'], ['vv', 'w'], ['li', 'h'], ['l', 'i'], ['e', 'c'], ['l', '1'], ['o', '0'], ['u', 'n'], ['h', 'b']];
  const FINAL = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
  const UNFINAL = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  const HEB_SWAP = new Map();
  for (const [a, b] of HEB_PAIRS) {
    if (!HEB_SWAP.has(a)) HEB_SWAP.set(a, new Set());
    if (!HEB_SWAP.has(b)) HEB_SWAP.set(b, new Set());
    HEB_SWAP.get(a).add(b);
    HEB_SWAP.get(b).add(a);
  }
  const fixFinals = (w) => w.replace(/[ךםןףץ](?=.)/g, (c) => UNFINAL[c]).replace(/[כמנפצ]$/, (c) => FINAL[c]);
  const splitToken = (t) => { const m = t.match(/^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su); return m ? [m[1], m[2], m[3]] : ['', t, '']; };

  function variants(w) {
    const out = new Set();
    if (/[א-ת]/.test(w)) {
      const base = w.replace(/[ךםןףץ]/g, (c) => UNFINAL[c]);
      for (let i = 0; i < base.length; i++) {
        for (const r of HEB_SWAP.get(base[i]) || []) out.add(fixFinals(base.slice(0, i) + r + base.slice(i + 1)));
      }
      // a quote mark read as extra י/ו in front of a word (״ -> יי), or a doubled letter (הווא)
      for (let i = 0; i + 1 < base.length; i++) if (base[i] === base[i + 1]) out.add(fixFinals(base.slice(0, i) + base.slice(i + 1)));
    } else if (/^[a-z0-9]+$/i.test(w)) {
      const lw = w.toLowerCase();
      for (const [a, b] of LAT_PAIRS) {
        for (const [x, y] of [[a, b], [b, a]]) {
          for (let i = lw.indexOf(x); i >= 0; i = lw.indexOf(x, i + 1)) out.add(lw.slice(0, i) + y + lw.slice(i + x.length));
        }
      }
    }
    out.delete(w);
    return out;
  }

  function correctOcr(pages, enabled) {
    const lines = pages.flatMap((p) => p.lines);
    const fixable = (l) => l.ocr || l.ocrish;
    for (const l of lines) {
      if (!fixable(l)) continue;
      if (l.ocrOriginal === undefined) l.ocrOriginal = l.text;
      if (l.text !== l.ocrOriginal) { // start from what OCR read, so switching the option off restores it
        l.text = l.ocrOriginal;
        l.runs = l.runsOriginal || [Object.assign({}, l.runs[0], { text: l.text })];
      }
      if (!l.runsOriginal) l.runsOriginal = l.runs;
    }
    if (!enabled) return;
    const keyOf = (w) => { const k = w.replace(NIQQUD, ''); return /[a-z]/i.test(k) && !/[א-ת]/.test(k) ? k.toLowerCase() : k; };
    const freq = new Map();
    const trusted = new Set(); // read with high confidence at least once (or from a real text layer): a real word
    for (const l of lines) {
      l.text.split(/\s+/).forEach((t, i) => {
        const k = keyOf(splitToken(t)[1]);
        if (k.length < 2) return;
        freq.set(k, (freq.get(k) || 0) + 1);
        if (!fixable(l) || (l.wconf && l.wconf[i] >= 92)) trusted.add(k);
      });
    }
    const fixes = new Map();
    // words of the book with one letter removed -> the words (to find a word OCR dropped a letter from)
    const byDeletion = new Map();
    for (const [w, c] of freq) {
      if (c < 8 || w.length < 4 || !/[\u05D0-\u05EA]/.test(w)) continue;
      for (let j = 0; j < w.length; j++) {
        const d = fixFinals(w.slice(0, j) + w.slice(j + 1));
        if (!byDeletion.has(d)) byDeletion.set(d, new Set());
        byDeletion.get(d).add(w);
      }
    }
    const insertions = (w) => byDeletion.get(w) || [];
    for (const l of lines) {
      if (!fixable(l)) continue;
      const tokens = l.text.split(' ');
      let changed = false;
      tokens.forEach((t, i) => {
        const [pre, word, post] = splitToken(t);
        const k = keyOf(word);
        if (k.length < 2 || trusted.has(k)) return;
        // a line's last word ending in ך/ד/7 may be a maqaf OCR misread: leave it to the line-end join
        if (i === tokens.length - 1 && /[\u05D0-\u05EA]{2,}[ךד7]$/.test(k) && (freq.get(fixFinals(k.slice(0, -1))) || 0) >= 2) return;
        const fk = freq.get(k) || 0;
        const conf = l.wconf && l.wconf[i] !== undefined ? l.wconf[i] : 70;
        let fix = fixes.get(k);
        if (fix === undefined) {
          fix = null;
          // near: one look-alike letter; far: two look-alike letters, or one letter missing / extra
          let best = null;
          const consider = (v, far) => {
            const c = freq.get(v) || 0;
            const ok = far ? c >= 8 && c >= 10 * fk && k.length >= 4 : c >= 3 && c >= 5 * fk;
            if (ok && (!best || c > best.count)) best = { to: v, count: c };
          };
          const near = variants(k);
          for (const v of near) consider(v, false);
          if (!best && /[\u05D0-\u05EA]/.test(k)) {
            if (k.length >= 5) for (const v1 of near) for (const v2 of variants(v1)) if (v2 !== k) consider(v2, true);
            if (k.length >= 5) for (let j = 0; j < k.length; j++) consider(fixFinals(k.slice(0, j) + k.slice(j + 1)), true);
            for (const v of insertions(k)) consider(v, true);
          }
          fix = best;
          fixes.set(k, fix);
        }
        if (fix && (conf < 90 || fix.count >= 20 * fk)) {
          let to = fix.to;
          if (/^[A-Z]/.test(word)) to = to[0].toUpperCase() + to.slice(1);
          tokens[i] = pre + to + post;
          changed = true;
        }
      });
      if (repairPunctuation(tokens, freq, keyOf)) changed = true;
      if (changed) {
        l.text = tokens.join(' ').replace(/\s+/g, ' ').trim();
        l.runs = [Object.assign({}, l.runs[0], { text: l.text })];
      }
    }
  }

  // Punctuation that OCR reads as Hebrew letters or digits (checked against the book's own words):
  //  - a maqaf inside a word read as a quote mark: גמדון"בית -> גמדון־בית (an abbreviation like צה"ל has one
  //    letter after the mark and is left alone)
  //  - an opening quote mark read as י or יי: יילא -> "לא
  //  - a question mark read as 3, 7 or ז standing after a word: אתה 3" -> אתה?"
  function repairPunctuation(tokens, freq, keyOf) {
    const f = (w) => freq.get(keyOf(w)) || 0;
    let changed = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      let m = t.match(/^([^\u05D0-\u05EA]*)([\u05D0-\u05EA]{2,})["״”']([\u05D0-\u05EA]{2,})([^\u05D0-\u05EA]*)$/);
      if (m && f(m[2]) >= 2 && f(m[3]) >= 2 && f(m[2] + m[3]) === 0) {
        tokens[i] = `${m[1]}${m[2]}\u05BE${m[3]}${m[4]}`;
        changed = true;
        continue;
      }
      m = t.match(/^(י{1,2})([\u05D0-\u05EA]{2,})([^\u05D0-\u05EA]*)$/);
      if (m && f(m[1] + m[2]) <= 1 && f(m[2]) >= 5 && f(m[2]) >= 5 * f(m[1] + m[2])) {
        tokens[i] = `"${m[2]}${m[3]}`;
        changed = true;
        continue;
      }
      m = t.match(/^[37ז](["״”']?[.,]?)$/);
      if (m && i > 0 && /[\u05D0-\u05EA]$/.test(tokens[i - 1]) && (m[1] || i === tokens.length - 1)) {
        tokens[i - 1] += `?${m[1]}`;
        tokens[i] = '';
        changed = true;
      }
    }
    return changed;
  }

  function splitChapters(blocks, doc, o) {
    const chapters = [];
    let cur = null;
    const headingLevels = blocks.filter((b) => b.type === 'h').map((b) => b.level);
    const top = headingLevels.length ? Math.min(...headingLevels) : 0;
    const newChapter = (title) => { cur = { title, blocks: [] }; chapters.push(cur); };
    let chars = 0;
    for (const b of blocks) {
      const starts = o.splitChapters && b.type === 'h' && b.level === top && cur && cur.blocks.some((x) => x.type !== 'h');
      const tooBig = o.splitChapters && cur && chars > 120000 && b.type !== 'h';
      if (!cur || starts || tooBig) { newChapter(b.type === 'h' ? b.text : (cur ? `${cur.title} (cont.)` : 'Start')); chars = 0; }
      cur.blocks.push(b);
      chars += (b.text || '').length;
    }
    if (!chapters.length) newChapter('Start');

    const allText = blocks.map((b) => b.text || '').join(' ');
    const rtlChars = (allText.match(/[֐-ࣿיִ-﷿ﹰ-﻿]/g) || []).length;
    const latin = (allText.match(/[A-Za-z]/g) || []).length;
    let lang = doc.language || '';
    if (!lang) {
      if (rtlChars > latin) lang = (allText.match(/[֐-׿]/g) || []).length >= rtlChars / 2 ? 'he' : 'ar';
      else lang = 'en';
    }
    const firstHeading = blocks.find((b) => b.type === 'h');
    return {
      title: doc.title || (firstHeading && firstHeading.text.slice(0, 120)) || 'Untitled',
      author: doc.author || '',
      language: lang,
      rtl: rtlChars > latin,
      chapters,
      cover: doc.cover,
      stats: {
        pages: doc.numPages,
        paragraphs: blocks.filter((b) => b.type === 'p').length,
        headings: blocks.filter((b) => b.type === 'h').length,
        images: blocks.filter((b) => b.type === 'img').length,
        scannedPages: doc.pages.filter((p) => p.scanned).length,
        hiddenTextPages: doc.pages.filter((p) => p.hiddenTextLayer).length,
        ocrPages: doc.pages.filter((p) => p.ocr).length,
        ocrConfidence: (() => {
          const ps = doc.pages.filter((p) => p.ocr && p.ocrConfidence);
          return ps.length ? Math.round(ps.reduce((a, p) => a + p.ocrConfidence, 0) / ps.length) : null;
        })(),
      },
    };
  }

  global.PdfStructure = { buildBook, DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
