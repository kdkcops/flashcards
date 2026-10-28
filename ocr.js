// 글자 인식: 이미지 → Tesseract.js(kor+eng), PDF → pdf.js 텍스트 추출 (텍스트 없으면 렌더링 후 OCR)
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const scripts = {};
function loadScript(src) {
  if (!scripts[src]) {
    scripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete scripts[src]; reject(new Error('라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하세요.')); };
      document.head.appendChild(s);
    });
  }
  return scripts[src];
}

const STATUS_KO = {
  'loading tesseract core': '인식 엔진 불러오는 중',
  'initializing tesseract': '인식 엔진 준비 중',
  'initialized tesseract': '인식 엔진 준비 완료',
  'loading language traineddata': '언어 데이터 불러오는 중',
  'loaded language traineddata': '언어 데이터 준비 완료',
  'initializing api': '인식 준비 중',
  'initialized api': '인식 준비 완료',
  'recognizing text': '글자 인식 중',
};

let workerPromise = null;
let logger = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL);
      const w = await Tesseract.createWorker(['kor', 'eng'], 1, {
        logger: (m) => logger && logger(STATUS_KO[m.status] || m.status, m.progress || 0),
      });
      await w.setParameters({ preserve_interword_spaces: '1' });
      return w;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// OCR 작업은 하나씩 순서대로 처리
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function cleanText(t) {
  return t
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function ocrImage(source, onProgress = () => {}) {
  return serial(async () => {
    logger = onProgress;
    try {
      onProgress('인식 엔진 불러오는 중', 0);
      const w = await getWorker();
      const { data } = await w.recognize(source);
      return cleanText(data.text);
    } finally {
      logger = null;
    }
  });
}

export async function loadPdf(blob) {
  await loadScript(PDFJS_URL);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjsLib.getDocument({ data }).promise;
}

export async function renderPage(pdf, pageNum, scale) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function textFromContent(content) {
  let out = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    out += item.str;
    out += item.hasEOL ? '\n' : (item.str && !/\s$/.test(item.str) ? ' ' : '');
  }
  return cleanText(out);
}

// 선택한 페이지들의 텍스트를 추출. 텍스트 레이어가 없으면(스캔본) 페이지를 이미지로 그려 OCR
export async function extractPdfText(pdf, pages, onProgress = () => {}) {
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    const n = pages[i];
    const prefix = pages.length > 1 ? `${i + 1}/${pages.length}쪽 · ` : '';
    onProgress(`${prefix}텍스트 추출 중`, i / pages.length);
    const page = await pdf.getPage(n);
    let text = textFromContent(await page.getTextContent());
    if (text.replace(/\s/g, '').length < 3) {
      onProgress(`${prefix}스캔 페이지 이미지 변환 중`, i / pages.length);
      const canvas = await renderPage(pdf, n, 2);
      text = await ocrImage(canvas, (s, p) => onProgress(`${prefix}${s}`, (i + p) / pages.length));
    }
    if (text) parts.push(text);
  }
  onProgress('완료', 1);
  return parts.join('\n\n');
}
