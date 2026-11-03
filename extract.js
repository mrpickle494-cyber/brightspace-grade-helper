// Pulls the text out of a downloaded file: PDFs with pdf.js, Word files with
// mammoth, code and plain text directly. Anything else is reported as unreadable.

import { extensionOf } from './analyze.js';

const TEXT_TYPES = [
  '.txt', '.csv', '.tsv', '.md', '.py', '.r', '.rmd', '.qmd', '.java', '.c', '.cpp', '.h', '.js', '.ts',
  '.sql', '.m', '.sas', '.do', '.jl', '.sh', '.css', '.json', '.tex', '.xml', '.yaml', '.yml',
];
const MAX_TEXT = 200_000; // characters; plenty for a skim
const MAX_PDF_PAGES = 60;

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

// mammoth is an old-style script that sets window.mammoth, so it's loaded with a <script> tag.
let mammothLoading = null;
function loadMammoth() {
  mammothLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./vendor/mammoth.browser.min.js', import.meta.url).href;
    script.onload = () => resolve(window.mammoth);
    script.onerror = () => {
      mammothLoading = null;
      reject(new Error("Couldn't load the Word reader"));
    };
    document.head.append(script);
  });
  return mammothLoading;
}

async function pdfText(buffer) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES); i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join(''));
  }
  return { text: pages.join('\n'), pages: pdf.numPages };
}

const htmlText = (html) => new DOMParser().parseFromString(html, 'text/html').body?.textContent ?? '';

// Jupyter notebooks are JSON; keep the cell contents.
function notebookText(raw) {
  const nb = JSON.parse(raw);
  return (nb.cells ?? []).map((c) => [].concat(c.source ?? []).join('')).join('\n\n');
}

// Returns { text, pages } or { text: null, readError }.
export async function extractText(fileName, buffer) {
  const ext = extensionOf(fileName);
  try {
    let result;
    if (ext === '.pdf') {
      result = await pdfText(buffer);
    } else if (ext === '.docx') {
      const mammoth = await loadMammoth();
      result = { text: (await mammoth.extractRawText({ arrayBuffer: buffer })).value };
    } else if (ext === '.ipynb') {
      result = { text: notebookText(new TextDecoder().decode(buffer)) };
    } else if (ext === '.html' || ext === '.htm') {
      result = { text: htmlText(new TextDecoder().decode(buffer)) };
    } else if (TEXT_TYPES.includes(ext)) {
      result = { text: new TextDecoder().decode(buffer) };
    } else {
      return { text: null, readError: `Couldn't read this file type (${ext || 'no extension'})` };
    }
    return { pages: null, ...result, text: result.text.slice(0, MAX_TEXT) };
  } catch (err) {
    return { text: null, readError: `Couldn't read this file (${err.message})` };
  }
}
