// Enhance an existing EPUB: pages that are pictures of text (scanned books, image-only EPUBs) are read with OCR
// and replaced by real, reflowable text; the chosen appearance (colours, text size, font, spacing) and the title
// and author are written into the book. Everything else in the EPUB is kept as it is.
/* global JSZip, PdfExtract, PdfStructure, EpubBuild */
(function (global) {
  'use strict';

  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const XLINK_NS = 'http://www.w3.org/1999/xlink';
  const RASTER = /^image\/(jpeg|png|gif|webp|bmp)$/;
  const EXT_TYPE = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const PREFIX = 'p2e-'; // ids and files this tool adds

  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const hasScheme = (u) => /^[a-z][a-z0-9+.-]*:/i.test(u);
  function resolvePath(baseDir, rel) {
    let r = rel.split('#')[0].split('?')[0];
    try { r = decodeURIComponent(r); } catch (_) { /* keep */ }
    const out = [];
    for (const part of (r.startsWith('/') ? r.slice(1) : baseDir + r).split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  }
  // relative href from a directory ('a/b/') to a file path ('a/c/x.css') -> '../c/x.css'
  function relHref(fromDir, toPath) {
    const from = fromDir.split('/').filter(Boolean);
    const to = toPath.split('/');
    let i = 0;
    while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
    return '../'.repeat(from.length - i) + to.slice(i).map(encodeURIComponent).join('/');
  }
  const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byTag = (doc, tag) => Array.from(doc.getElementsByTagNameNS('*', tag));

  // ---------------------------------------------------------------------------------------------------------
  async function openEpub(data) {
    const zip = await JSZip.loadAsync(data);
    const lower = new Map(Object.keys(zip.files).map((k) => [k.toLowerCase(), k]));
    const realPath = (p) => (zip.file(p) ? p : lower.get(p.toLowerCase()) || null);
    const readText = async (p) => { const r = realPath(p); return r ? zip.file(r).async('string') : null; };

    let opfPath = null;
    const container = await readText('META-INF/container.xml');
    if (container) { const rf = byTag(parseXml(container), 'rootfile')[0]; opfPath = rf && rf.getAttribute('full-path'); }
    if (!opfPath || !realPath(opfPath)) opfPath = Object.keys(zip.files).find((k) => /\.opf$/i.test(k));
    if (!opfPath) throw new Error('This file is not a valid EPUB (no package document found).');
    opfPath = realPath(opfPath);
    const opfText = await readText(opfPath);
    const opf = parseXml(opfText);
    const opfDir = dirOf(opfPath);

    const manifest = new Map();
    const byPath = new Map();
    for (const el of byTag(opf, 'item')) {
      const href = el.getAttribute('href') || '';
      const item = {
        id: el.getAttribute('id'), href, path: realPath(resolvePath(opfDir, href)) || resolvePath(opfDir, href),
        type: (el.getAttribute('media-type') || '').toLowerCase(), props: el.getAttribute('properties') || '',
      };
      manifest.set(item.id, item);
      byPath.set(item.path, item);
    }
    const meta = (tag) => { const e = byTag(opf, tag)[0]; return e ? e.textContent.trim() : ''; };
    let coverPath = null;
    const coverItem = [...manifest.values()].find((it) => /\bcover-image\b/.test(it.props));
    if (coverItem) coverPath = coverItem.path;
    else {
      const m = byTag(opf, 'meta').find((e) => e.getAttribute('name') === 'cover');
      const it = m && manifest.get(m.getAttribute('content'));
      if (it) coverPath = it.path;
    }
    const layoutMeta = byTag(opf, 'meta').find((e) => e.getAttribute('property') === 'rendition:layout');
    const docs = [];
    for (const ref of byTag(opf, 'itemref')) {
      const it = manifest.get(ref.getAttribute('idref'));
      if (!it || !/html|xml/.test(it.type) || !zip.file(it.path)) continue;
      docs.push({ item: it, path: it.path, text: await readText(it.path) });
    }
    const an = {
      zip, opfPath, opfDir, opfText, manifest, byPath, docs, coverPath,
      title: meta('title'), author: byTag(opf, 'creator').map((e) => e.textContent.trim()).filter(Boolean).join(', '),
      language: meta('language'),
      fixedLayout: !!(layoutMeta && layoutMeta.textContent.trim() === 'pre-paginated'),
    };
    an.candidates = { auto: findScans(an, 'auto'), all: findScans(an, 'all') };
    return an;
  }

  // Parses one content document; returns { doc, body, xml } (falls back to the HTML parser for broken XHTML).
  function parseDoc(text) {
    let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    let xml = true;
    if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagNameNS(XHTML_NS, 'body')[0]) {
      doc = new DOMParser().parseFromString(text, 'text/html');
      xml = false;
    }
    const body = doc.getElementsByTagNameNS(XHTML_NS, 'body')[0] || doc.body;
    return { doc, body, xml };
  }

  function imagesIn(body) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.localName === 'img') out.push({ el: c, href: c.getAttribute('src') });
        else if (c.localName === 'image') out.push({ el: c, href: c.getAttributeNS(XLINK_NS, 'href') || c.getAttribute('href') });
        else walk(c);
      }
    };
    walk(body);
    return out.filter((x) => x.href && !hasScheme(x.href));
  }

  // Pictures that should be read with OCR. auto: documents that are essentially a picture of a page (little
  // or no real text); all: every picture in the book. The cover is never touched.
  function findScans(an, mode) {
    const out = [];
    an.docs.forEach((d, di) => {
      const { body } = parseDoc(d.text);
      if (!body) return;
      const imgs = imagesIn(body);
      if (!imgs.length) return;
      const textLen = (body.textContent || '').replace(/\s+/g, '').length;
      const pageLike = textLen < 40 + 40 * imgs.length;
      if (mode === 'auto' && !pageLike) return;
      imgs.forEach((im, index) => {
        const path = resolvePath(dirOf(d.path), im.href);
        if (path === an.coverPath || !an.zip.file(path)) return;
        const item = an.byPath.get(path);
        const type = (item && item.type) || EXT_TYPE[path.split('.').pop().toLowerCase()] || '';
        if (!RASTER.test(type)) return;
        out.push({ doc: di, index, path, type, pageLike });
      });
    });
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------
  // OCR of the candidate pictures. Returns pages shaped like PDF pages (see pdf-extract.js).
  async function ocrEpub(an, options) {
    const o = { ocr: options.ocr, onProgress: options.onProgress || (() => {}), imageScale: 2.5, keepImages: true };
    const cands = an.candidates[options.ocr.mode === 'all' ? 'all' : 'auto'];
    const pages = [];
    try {
      for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        o.pageLabel = { n: i + 1, total: cands.length };
        o.onProgress(i / cands.length, `Reading picture ${i + 1} of ${cands.length}`);
        const bytes = await an.zip.file(c.path).async('uint8array');
        let bmp;
        try { bmp = await createImageBitmap(new Blob([bytes], { type: c.type })); } catch (_) { continue; }
        // too small to be a page of text
        if (Math.max(bmp.width, bmp.height) < 600 || Math.min(bmp.width, bmp.height) < 250) { bmp.close(); continue; }
        // OCR works best at about 300 dpi: enlarge small scans (up to 3x), never beyond ~3300 px
        const f = Math.max(1, Math.min(3, 3300 / Math.max(bmp.width, bmp.height)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * f);
        canvas.height = Math.round(bmp.height * f);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        // page units: the long side of the picture is treated as a page of 842 units (A4 height in points)
        const scale = Math.max(canvas.width, canvas.height) / 842;
        try {
          const res = await PdfExtract.ocrCanvas(canvas, scale, o);
          const textChars = res.lines.reduce((n, l) => n + l.text.length, 0);
          // a photo or drawing with (almost) no text stays a picture
          if (textChars >= 20) {
            pages.push({ width: canvas.width / scale, height: canvas.height / scale, lines: res.lines, images: res.images, ocr: true, ocrConfidence: res.confidence, cand: c });
          }
        } finally {
          canvas.width = canvas.height = 0;
        }
      }
    } finally {
      await PdfExtract.endOcr(o);
    }
    o.onProgress(1, 'Done');
    return pages;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Writes the enhanced EPUB.
  //   ocrPages: from ocrEpub (may be empty); conv: structure.js options; appearance: epub-build.js appearance
  //   (empty = keep the book's look); meta: { title, author }.
  async function buildEnhanced(an, ocrPages, conv, appearance, meta, opts) {
    const options = Object.assign({ type: 'uint8array' }, opts);
    const changed = new Map(); // path -> new content (string or bytes)
    const added = []; // { path, type, bytes|text, id }
    let addedNo = 0;
    const stats = { replaced: 0, paragraphs: 0, headings: 0, pictures: 0 };

    // OCR text -> blocks, grouped by the picture (page) they came from
    let book = null;
    const blocksByPage = new Map();
    if (ocrPages.length) {
      book = PdfStructure.buildBook({
        pages: ocrPages, outline: [], numPages: ocrPages.length, title: '', author: '', language: an.language,
      }, Object.assign({}, conv, { useOutline: false, splitChapters: false }));
      for (const b of book.chapters.flatMap((c) => c.blocks)) {
        if (!blocksByPage.has(b.page)) blocksByPage.set(b.page, []);
        blocksByPage.get(b.page).push(b);
        if (b.type === 'p') stats.paragraphs++;
        else if (b.type === 'h') stats.headings++;
        else if (b.type === 'img') stats.pictures++;
      }
    }

    const cssPath = `${an.opfDir}${PREFIX}appearance.css`;
    const ocrCssPath = `${an.opfDir}${PREFIX}ocr-text.css`;
    const appearanceText = `/* Added by PDF to EPUB: the chosen appearance */\n${EpubBuild.appearanceCss(appearance || {}, true)}`;
    added.push({ id: `${PREFIX}appearance`, path: cssPath, type: 'text/css', text: appearanceText });
    if (ocrPages.length) added.push({ id: `${PREFIX}ocr-text`, path: ocrCssPath, type: 'text/css', text: `/* Added by PDF to EPUB: text recognised from page pictures */\n${EpubBuild.BASE_CSS}` });

    const headingState = { hid: 0 };
    let anyPageReplaced = false;
    an.docs.forEach((d, di) => {
      const { doc, body, xml } = parseDoc(d.text);
      if (!body) return;
      const head = doc.getElementsByTagNameNS(XHTML_NS, 'head')[0] || doc.head;
      const dir = dirOf(d.path);
      const imgs = imagesIn(body);
      let replacedHere = 0;
      let pageLikeDoc = false;

      ocrPages.forEach((pg, pi) => {
        if (pg.cand.doc !== di) return;
        const im = imgs[pg.cand.index];
        if (!im) return;
        const blocks = blocksByPage.get(pi) || [];
        const xhtml = EpubBuild.blocksToXhtml(blocks, {
          rtl: book.rtl,
          state: headingState,
          idPrefix: `${PREFIX}h`,
          addImage: (src) => {
            const { type, bytes } = EpubBuild.dataUrlToBytes(src);
            const name = `${PREFIX}ocr-${String(++addedNo).padStart(4, '0')}.${type === 'image/png' ? 'png' : 'jpg'}`;
            added.push({ id: `${PREFIX}img${addedNo}`, path: dir + name, type, bytes });
            return name;
          },
        });
        const frag = new DOMParser().parseFromString(
          `<div xmlns="${XHTML_NS}" class="${PREFIX}ocr-page"${book.rtl ? ' dir="rtl"' : ''}>${xhtml}</div>`, 'application/xhtml+xml');
        if (frag.getElementsByTagName('parsererror').length) return;
        // replace the picture together with wrappers that hold nothing else (div > svg > image, p > img, ...)
        let target = im.el.localName === 'image' && im.el.parentNode && im.el.parentNode.localName === 'svg' ? im.el.parentNode : im.el;
        while (target.parentNode && target.parentNode !== body && target.parentNode.children.length === 1 &&
          !Array.from(target.parentNode.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) {
          target = target.parentNode;
        }
        target.parentNode.replaceChild(doc.importNode(frag.documentElement, true), target);
        replacedHere++;
        if (pg.cand.pageLike) pageLikeDoc = true;
      });

      if (replacedHere) {
        stats.replaced += replacedHere;
        if (pageLikeDoc) {
          // the page was laid out around a picture (fixed size, absolute positions): drop that layout
          anyPageReplaced = true;
          for (const el of Array.from(head.children)) {
            const isSheet = el.localName === 'link' && /stylesheet/i.test(el.getAttribute('rel') || '');
            if (isSheet || el.localName === 'style' || (el.localName === 'meta' && el.getAttribute('name') === 'viewport')) el.remove();
          }
          body.removeAttribute('style');
          for (const el of body.querySelectorAll('[style]')) if (!el.closest(`.${PREFIX}ocr-page`)) el.removeAttribute('style');
        }
        if (book.rtl && !body.getAttribute('dir')) body.setAttribute('dir', 'rtl');
        addLink(doc, head, relHref(dir, ocrCssPath));
      }
      addLink(doc, head, relHref(dir, cssPath));
      let out = new XMLSerializer().serializeToString(xml ? doc : doc.documentElement);
      if (!/^<\?xml/.test(out)) out = `<?xml version="1.0" encoding="UTF-8"?>\n${xml ? '' : '<!DOCTYPE html>\n'}${out}`;
      changed.set(d.path, out);
    });

    // package document: new files, title/author, modified date, fixed layout -> reflowable
    const opf = parseXml(an.opfText);
    const manifestEl = byTag(opf, 'manifest')[0];
    const OPF_NS = manifestEl.namespaceURI;
    const usedIds = new Set(byTag(opf, 'item').map((e) => e.getAttribute('id')));
    for (const a of added) {
      let id = a.id;
      while (usedIds.has(id)) id += '_';
      usedIds.add(id);
      const it = opf.createElementNS(OPF_NS, 'item');
      it.setAttribute('id', id);
      it.setAttribute('href', relHref(an.opfDir, a.path).replace(/^\.\//, ''));
      it.setAttribute('media-type', a.type);
      manifestEl.appendChild(it);
      manifestEl.appendChild(opf.createTextNode('\n'));
    }
    const metadata = byTag(opf, 'metadata')[0];
    const DC = 'http://purl.org/dc/elements/1.1/';
    const setDc = (tag, value) => {
      if (value === undefined || value === null) return;
      const els = byTag(opf, tag);
      if (!value) return;
      if (els.length) {
        els[0].textContent = value;
        for (const extra of els.slice(1)) if (tag === 'creator') extra.remove();
      } else {
        const el = opf.createElementNS(DC, `dc:${tag}`);
        el.textContent = value;
        metadata.appendChild(el);
      }
    };
    setDc('title', meta && meta.title);
    setDc('creator', meta && meta.author);
    const modified = byTag(opf, 'meta').find((e) => e.getAttribute('property') === 'dcterms:modified');
    if (modified) modified.textContent = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    if (anyPageReplaced && an.fixedLayout) {
      // text now flows, so the book can no longer be a fixed-layout (pre-paginated) one
      for (const m of byTag(opf, 'meta')) {
        const prop = m.getAttribute('property') || '';
        if (prop === 'rendition:layout') m.textContent = 'reflowable';
        else if (prop === 'rendition:spread' || prop === 'rendition:viewport') m.remove();
      }
      for (const ref of byTag(opf, 'itemref')) {
        const props = (ref.getAttribute('properties') || '').split(/\s+/).filter((x) => x && !/^rendition:|^page-spread-/.test(x)).join(' ');
        if (props) ref.setAttribute('properties', props); else ref.removeAttribute('properties');
      }
    }
    let opfOut = new XMLSerializer().serializeToString(opf);
    if (!/^<\?xml/.test(opfOut)) opfOut = `<?xml version="1.0" encoding="UTF-8"?>\n${opfOut}`;
    changed.set(an.opfPath, opfOut);

    // write: mimetype first and uncompressed, then every original file (changed ones replaced), then new files
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    for (const [name, entry] of Object.entries(an.zip.files)) {
      if (name === 'mimetype') continue;
      if (entry.dir) { zip.folder(name); continue; }
      if (changed.has(name)) zip.file(name, changed.get(name));
      else zip.file(name, await entry.async('uint8array'));
    }
    for (const a of added) zip.file(a.path, a.text !== undefined ? a.text : a.bytes);
    const result = await zip.generateAsync({ type: options.type, mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    return { epub: result, stats, rtl: book ? book.rtl : null };
  }

  function addLink(doc, head, href) {
    if (!head) return;
    const link = doc.createElementNS(XHTML_NS, 'link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('type', 'text/css');
    link.setAttribute('href', href);
    head.appendChild(link);
  }

  global.EpubEnhance = { openEpub, ocrEpub, buildEnhanced };
})(typeof window !== 'undefined' ? window : globalThis);
