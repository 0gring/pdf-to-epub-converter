# PDF → EPUB

A high-quality PDF to EPUB converter that runs entirely in the browser, so the file never leaves your device.

**Use it online:** https://0gring.github.io/pdf-to-epub-converter/. Drop in a `.pdf`, check the live preview, and
press **Download EPUB**.

To run it locally, serve the folder over HTTP (pdf.js is an ES module, which browsers won't load from `file://`):

```sh
npx serve .        # or: python3 -m http.server
```

## What it does

A PDF stores lines of text at fixed positions. The converter rebuilds the book behind those positions, so the
EPUB has real reflowable text:

- **Paragraphs** are reassembled from lines. It uses first-line indents, short last lines, line spacing and font
  changes to tell where paragraphs end.
- **Multi-column pages:** each line is measured against its own column, so two-column text doesn't fall apart.
- **Words hyphenated at line ends** are re-joined ("thir‐ teen" → "thirteen").
- **Running headers, footers and page numbers** are removed, because the EPUB pages are different.
- **Headings and chapters** come from the PDF's bookmarks and from font sizes. They become a nested table of
  contents, and the book is split into one file per chapter.
- **Bold, italic, superscript and subscript** text keeps its styling, so footnote numbers stay superscript.
- **Pictures** are kept as sharp images, cropped from a high-resolution render of the page. Page 1 becomes the cover.
- **Right-to-left PDFs** (Hebrew, Arabic) come out in correct reading order, with RTL page progression.
- Rotated pages and password-protected PDFs work.
- **Scanned PDFs are read with OCR** (see below), so they also become real, reflowable text.

## Text recognition (OCR)

Scanned pages have no text layer, only a picture of the page. The converter reads them with
[Tesseract](https://github.com/tesseract-ocr/tesseract) (via Tesseract.js, running in the browser), at about 300 dpi:

- **Scanned pages only** (default) reads only pages without a text layer. **All pages** ignores the PDF's own text,
  which helps with PDFs whose text layer is garbled. **Off** keeps scanned pages as pictures.
- **Languages:** tick the languages the book uses: English, Hebrew, Arabic, Russian, Ukrainian, French, German,
  Spanish, Italian, Portuguese, Dutch, Polish, Turkish, Greek, Yiddish, Hindi, Chinese, Japanese and Korean. The
  default follows your browser's language. Each language model (1–15 MB) downloads once from jsDelivr and is then
  cached. The PDF itself never leaves your device.
- Recognised pages go through the same rebuilding as text PDFs: paragraphs, headings, chapters, header and footer
  removal, and re-joined hyphenation. **Columns** are detected even when the gutter is narrow, and Tesseract on its
  own would mix them. **Pictures** on scanned pages are found and cropped, and stray "text" read inside them is
  dropped.
- The app shows how many pages were read with OCR and the average confidence. Low confidence usually means the
  wrong languages are ticked or the scan is low resolution.
- OCR does not detect bold or italic, and the quality depends on the scan. 300 dpi scans work best.

## Inverted colours and reflowing zoom

- **Colours:** Original, **Inverted** (white text on black), dark grey, sepia, or your own text and background colours.
  Pictures keep their real colours unless you tick *Invert pictures too*.
- **Text zoom (50–400%):** the text reflows, so the lines re-wrap to the screen and the book spreads over more pages
  instead of being cropped. The preview keeps your place in the book while you zoom. Use the slider, `A−`/`A+`, the
  `+`/`−` keys, Ctrl/⌘ + scroll, a trackpad pinch, or a two-finger pinch on touch screens.
- The preview is paginated like an e-reader screen (phone, 6″/7″ e-reader, tablet, or paper sizes).
- With *Save colours, text size and font into the EPUB* ticked, the chosen theme, text size, font, line spacing and
  justification are written into the EPUB's stylesheet. Readers that apply their own themes (Kindle, Apple Books)
  may override the colours; their night mode does the same inversion.
- Keyboard: `←`/`→` turn pages, `I` toggles inverted colours.

## Command line

The same engine runs in headless Chromium:

```sh
npm install && npx playwright install chromium
node cli.mjs book.pdf -o book.epub --invert --text-size 120%
```

OCR options: `--ocr auto|all|off` and `--lang heb+eng`. For fully offline use, put `<lang>.traineddata.gz` files
in a folder and pass `--lang-dir <folder>`; they are available from the `@tesseract.js-data/<lang>` npm packages,
in the `4.0.0_best_int` folder.

Run `node cli.mjs --help` for every option.

## Files

| File | |
|---|---|
| `pdf-extract.js` | reads the PDF with pdf.js (lines with positions, sizes and styles; pictures; bookmarks), and runs OCR on scanned pages |
| `structure.js` | rebuilds paragraphs, headings and chapters, and removes headers and footers (no DOM, so it re-runs instantly) |
| `epub-build.js` | writes the EPUB 3 file (with an EPUB 2 NCX table of contents for older readers) |
| `reader.js` | the paginated EPUB preview (colour themes, reflowing zoom) |
| `app.js`, `index.html`, `style.css` | the web app |
| `cli.mjs`, `engine.html` | the command-line converter |
| `vendor/tesseract/` | [Tesseract.js](https://tesseract.projectnaptha.com/) 6.0.1 + core 6.0.0 (Apache-2.0) for OCR |
| `vendor/pdfjs/` | [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38 (Apache-2.0) |
| `vendor/jszip.min.js` | [JSZip](https://stuk.github.io/jszip/) 3.10.1 (MIT) |
| `.github/workflows/pages.yml` | publishes the app to GitHub Pages on every push to `main` |
