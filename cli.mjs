#!/usr/bin/env node
// Command line PDF -> EPUB converter. Runs the same engine as the web app inside headless Chromium.
//
//   npm install playwright && npx playwright install chromium
//   node cli.mjs book.pdf -o book.epub --theme invert --text-size 120%
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HELP = `Usage: node cli.mjs <book.pdf | book.epub> [options]

A PDF is converted into an EPUB. An existing EPUB is enhanced: pages that are pictures of text are read with
OCR and become real text, and the appearance options below (and --title/--author) are written into the book.

  -o, --out <file.epub>     output file (default: next to the PDF)
  --title <text>            book title (default: from the PDF)
  --author <text>           author (default: from the PDF)
  --password <text>         password for a protected PDF

Appearance saved into the EPUB:
  --theme <name>            original | invert | dark | sepia | custom                      [original]
  --invert                  same as --theme invert (white text on black)
  --fg <color> --bg <color> text and background colour (implies --theme custom)
  --invert-images           invert pictures too
  --text-size <n>           default text size, e.g. 1.2 or 120%                             [100%]
  --font <name>             book | serif | sans | readable | mono                           [book]
  --line-height <n>         e.g. 1.7
  --justify                 justify paragraphs

Text recognition (OCR) for scanned PDFs:
  --ocr <mode>              auto (scanned pages only) | all (every page) | off             [auto]
  --lang <codes>            OCR languages joined by +, e.g. eng, heb, heb+eng, fra, ara    [eng]
  --lang-dir <dir>          offline: folder with <lang>.traineddata.gz files (default: download)

Conversion:
  --keep-headers            keep running page headers, footers and page numbers
  --no-join-hyphens         keep words hyphenated at line ends split
  --no-headings             do not detect headings / chapters from font sizes
  --no-outline              ignore the PDF's bookmarks
  --no-images               leave pictures out
  --no-cover                no cover image
`;

function parseArgs(argv) {
  const conv = {};
  const look = {};
  const meta = {};
  const ocr = { mode: 'auto', langs: 'eng' };
  let input = null;
  let out = null;
  let includeCover = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '-o': case '--out': out = next(); break;
      case '--title': meta.title = next(); break;
      case '--author': meta.author = next(); break;
      case '--password': meta.password = next(); break;
      case '--theme': look.theme = next(); break;
      case '--invert': look.theme = 'invert'; break;
      case '--fg': look.fg = next(); look.theme = 'custom'; break;
      case '--bg': look.bg = next(); look.theme = 'custom'; break;
      case '--invert-images': look.invertImages = true; break;
      case '--text-size': case '--zoom': { const v = next(); look.zoom = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v); break; }
      case '--font': look.font = next(); break;
      case '--line-height': look.lineHeight = parseFloat(next()); break;
      case '--justify': look.justify = true; break;
      case '--ocr': ocr.mode = next(); break;
      case '--lang': case '--langs': ocr.langs = next(); break;
      case '--lang-dir': ocr.langDir = path.resolve(next()); break;
      case '--keep-headers': conv.removeHeadersFooters = false; break;
      case '--no-join-hyphens': conv.joinHyphens = false; break;
      case '--no-headings': conv.detectHeadings = false; break;
      case '--no-outline': conv.useOutline = false; break;
      case '--no-images': conv.keepImages = false; break;
      case '--no-cover': includeCover = false; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
        input = a;
    }
  }
  if (!input) { console.log(HELP); process.exit(1); }
  const isEpub = /\.epub$/i.test(input);
  return { input, isEpub, out: out || (isEpub ? input.replace(/\.epub$/i, '-enhanced.epub') : `${input.replace(/\.pdf$/i, '')}.epub`), conv, look, meta, includeCover, ocr };
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const id of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright']) {
    try { return require(id); } catch (_) { /* try next */ }
  }
  try { return createRequire(path.join(process.cwd(), 'x.js'))('playwright'); } catch (_) { /* fall through */ }
  console.error('Playwright is needed:  npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const { chromium } = await loadPlaywright();
const here = path.dirname(fileURLToPath(import.meta.url));
const pdf = await readFile(args.input);
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  // pdf.js is an ES module, which browsers will not load from file:// URLs, so the engine is served from memory
  await page.route('http://pdf-to-epub.local/**', async (route) => {
    const urlPath = decodeURIComponent(new URL(route.request().url()).pathname);
    if (urlPath.startsWith('/langdata/') && args.ocr.langDir) { // --lang-dir: offline OCR language files
      const lang = path.join(args.ocr.langDir, path.basename(urlPath));
      return existsSync(lang) ? route.fulfill({ body: await readFile(lang) }) : route.fulfill({ status: 404 });
    }
    const file = path.join(here, urlPath);
    if (!file.startsWith(here) || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile(file), contentType: MIME[path.extname(file)] || 'application/octet-stream' });
  });
  let lastLine = '';
  await page.exposeFunction('cliProgress', (msg) => {
    if (msg !== lastLine && process.stderr.isTTY) process.stderr.write(`\r\x1b[K${msg}`);
    lastLine = msg;
  });
  if (args.ocr.langDir) args.ocr.langPath = 'http://pdf-to-epub.local/langdata';
  await page.goto('http://pdf-to-epub.local/engine.html');
  const result = await page.evaluate(async ({ b64, a }) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const toB64 = (bytes) => {
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    if (a.isEpub) {
      const an = await window.EpubEnhance.openEpub(data);
      const pages = a.ocr.mode === 'off' ? [] : await window.EpubEnhance.ocrEpub(an, {
        ocr: a.ocr, onProgress: (f, msg) => window.cliProgress(`${msg} (${Math.round(f * 100)}%)`),
      });
      const title = a.meta.title || an.title;
      const r = await window.EpubEnhance.buildEnhanced(an, pages, a.conv, a.look, { title, author: a.meta.author || an.author });
      const conf = pages.length ? Math.round(pages.reduce((x, p) => x + p.ocrConfidence, 0) / pages.length) : null;
      return { epub: toB64(r.epub), enhance: r.stats, title, sections: an.docs.length, scans: an.candidates.auto.length, ocrPages: pages.length, conf };
    }
    const doc = await window.PdfExtract.extractPdf(data, {
      password: a.meta.password,
      ocr: a.ocr,
      onProgress: (f, msg) => window.cliProgress(`${msg} (${Math.round(f * 100)}%)`),
    });
    const book = window.PdfStructure.buildBook(doc, a.conv);
    if (a.meta.title) book.title = a.meta.title;
    else if (!doc.title && book.title === 'Untitled') book.title = a.fileTitle;
    if (a.meta.author) book.author = a.meta.author;
    const bytes = await window.EpubBuild.buildEpub(book, a.look, { includeCover: a.includeCover });
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { epub: btoa(s), stats: book.stats, chapters: book.chapters.length, title: book.title };
  }, { b64: pdf.toString('base64'), a: { ...args, fileTitle: path.basename(args.input).replace(/\.pdf$/i, '') } });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  const out = Buffer.from(result.epub, 'base64');
  await writeFile(args.out, out);
  if (result.enhance) {
    const e = result.enhance;
    console.log(`Saved ${args.out} (${(out.length / 1024).toFixed(0)} KB): "${result.title}", ${result.sections} sections, ` +
      `${result.scans} page picture(s) of text` + (e.replaced ? ` -> ${e.replaced} turned into ${e.paragraphs} paragraphs, ${e.headings} headings, ${e.pictures} illustrations` : ''));
    if (result.ocrPages) console.log(`OCR: ${result.ocrPages} page(s) recognised, average confidence ${result.conf}%.`);
    else if (result.scans && args.ocr.mode === 'off') console.log('Note: OCR is off, so pages that are pictures of text stay pictures (use --ocr auto).');
  } else {
    const s = result.stats;
    console.log(`Saved ${args.out} (${(out.length / 1024).toFixed(0)} KB): "${result.title}", ${s.pages} pages -> ` +
      `${result.chapters} chapters, ${s.headings} headings, ${s.paragraphs} paragraphs, ${s.images} pictures`);
    if (s.ocrPages) console.log(`OCR: ${s.ocrPages} page(s) recognised, average confidence ${s.ocrConfidence}%.`);
    if (s.scannedPages) console.log(`Note: ${s.scannedPages} page(s) have no text layer (scanned) and were kept as pictures (use --ocr auto).`);
  }
} catch (err) {
  console.error(`\n${String(err.message || err).split('\n')[0].replace(/^page\.evaluate: (Error: )?/, '')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
