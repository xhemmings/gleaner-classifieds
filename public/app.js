'use strict';

/* ── Constants ── */
const API_URL   = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 16384;

/* ── State ── */
let pdfFile     = null;
let pdfBase64   = null;
let pdfDoc      = null;   // PDF.js document object
let totalPages  = 0;
let selectedPages = new Set(); // 1-indexed
let allRecords  = [];
let running     = false;
let abortCtrl   = null;
const activeCats = new Set(['Vacancies', 'Real Estate', 'Vehicles', 'Notices']);

function getActiveRecords() {
  return allRecords.filter(r => activeCats.has(r.cat));
}

/* ── DOM refs ── */
const apiKeyEl      = document.getElementById('api-key');
const modelEl       = document.getElementById('model-select');
const runTemplateEl = document.getElementById('run-template');
const dropZone      = document.getElementById('drop-zone');
const fileInput     = document.getElementById('file-input');
const fileInfo      = document.getElementById('file-info');
const fileNameEl    = document.getElementById('file-name');
const fileSizeEl    = document.getElementById('file-size');
const filePagesEl   = document.getElementById('file-pages-count');
const removeFile    = document.getElementById('remove-file');
const runBtn        = document.getElementById('run-btn');
const stopBtn       = document.getElementById('stop-btn');
const resetBtn      = document.getElementById('reset-btn');
const statusBar     = document.getElementById('status-bar');
const passList      = document.getElementById('pass-list');
const statsRow      = document.getElementById('stats-row');
const outputSec     = document.getElementById('output-section');
const emptyState    = document.getElementById('empty-state');
const previewTbody  = document.getElementById('preview-tbody');
const jsonPreview   = document.getElementById('json-preview');
const downloadBtn   = document.getElementById('download-btn');
const copyBtn       = document.getElementById('copy-btn');
const pagePanel     = document.getElementById('page-panel');
const pageGallery   = document.getElementById('page-gallery');
const pageRangeInput = document.getElementById('page-range-input');
const applyRangeBtn  = document.getElementById('apply-range-btn');
const selectAllBtn   = document.getElementById('select-all-btn');
const selectNoneBtn  = document.getElementById('select-none-btn');
const selCountEl     = document.getElementById('page-selection-count');

/* ── Restore API key ── */
const savedKey = sessionStorage.getItem('gleaner_api_key');
if (savedKey) apiKeyEl.value = savedKey;
apiKeyEl.addEventListener('input', () => sessionStorage.setItem('gleaner_api_key', apiKeyEl.value.trim()));

/* ── Load JSON (previously downloaded) ── */
function loadJSONFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      /* Fix common PDF-extraction encoding corruption: â (0xE2) → — (em dash) */
      const text = e.target.result.replace(/â/g, '\u2014');
      const data = JSON.parse(text);
      const records = data.records || data;
      if (!Array.isArray(records) || !records.length) throw new Error('No records found in file');
      allRecords = records.map((r, i) => ({ ...r, id: r.id || (i + 1) }));
      if (typeof repairPrices === 'function') repairPrices(allRecords);
      activeCats.clear();
      ['Vacancies','Real Estate','Vehicles','Notices'].forEach(c => activeCats.add(c));
      document.querySelectorAll('.stat-toggle').forEach(b => b.classList.add('active'));
      updateStats(allRecords);
      renderOutput(getActiveRecords());
      setStatus(`Loaded ${allRecords.length} records from ${file.name}`, 'success');
    } catch (err) {
      setStatus('Failed to load JSON: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}
document.getElementById('load-json-drop').addEventListener('change', e => {
  loadJSONFile(e.target.files[0]);
  e.target.value = '';
});
const loadJsonBtnInput = document.getElementById('load-json-input');
if (loadJsonBtnInput) {
  loadJsonBtnInput.addEventListener('change', e => {
    loadJSONFile(e.target.files[0]);
    e.target.value = '';
  });
}

/* ── File handling ── */
fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  loadFile(e.dataTransfer.files[0]);
});
removeFile.addEventListener('click', clearFile);

async function loadFile(file) {
  if (!file || file.type !== 'application/pdf') {
    setStatus('Only PDF files are supported.', 'error');
    return;
  }
  pdfFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  dropZone.style.display = 'none';
  fileInfo.classList.add('visible');

  const edEl = document.getElementById('meta-edition');
  if (!edEl.value) edEl.value = guessDate(file.name);

  setStatus('Reading PDF pages…', 'active', true);

  try {
    // Only preload base64 when PDF.js is unavailable (fallback path).
    // When PDF.js is present we render selected pages to JPEG at extraction time
    // so we never send the whole PDF over the wire.
    if (!window.pdfjsLib) pdfBase64 = await fileToBase64(file);
    await renderPageGallery(file);
    setStatus(`PDF loaded — ${totalPages} page${totalPages !== 1 ? 's' : ''}. Select pages then click Run Extraction.`, '');
  } catch (e) {
    setStatus('Failed to read PDF: ' + e.message, 'error');
  }
  updateRunBtn();
}

function clearFile() {
  pdfFile = null; pdfBase64 = null; pdfDoc = null;
  totalPages = 0; selectedPages.clear();
  fileInput.value = '';
  fileInfo.classList.remove('visible');
  dropZone.style.display = '';
  pagePanel.style.display = 'none';
  pageGallery.innerHTML = '';
  filePagesEl.textContent = '';
  updateRunBtn();
  setStatus('Ready — upload a PDF and click Run Extraction.', '');
}

/* ── Page gallery rendering ── */
async function renderPageGallery(file) {
  if (!window.pdfjsLib) {
    pagePanel.style.display = 'none';
    return;
  }

  const arrayBuffer = await file.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  totalPages = pdfDoc.numPages;

  filePagesEl.textContent = totalPages + ' pages';
  pageGallery.innerHTML = '';

  // Select all pages by default
  selectedPages.clear();
  for (let i = 1; i <= totalPages; i++) selectedPages.add(i);

  pagePanel.style.display = '';
  updateSelCount();

  // Render thumbnails lazily
  for (let i = 1; i <= totalPages; i++) {
    const thumb = createThumbSkeleton(i);
    pageGallery.appendChild(thumb);
    // Render asynchronously so UI isn't blocked
    renderThumb(i, thumb);
  }
}

function createThumbSkeleton(pageNum) {
  const div = document.createElement('div');
  div.className = 'page-thumb selected';
  div.dataset.page = pageNum;
  div.innerHTML = `
    <div class="page-thumb-loading">…</div>
    <div class="page-thumb-overlay">
      <div class="page-thumb-check">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="2,6 5,9 10,3"/>
        </svg>
      </div>
    </div>
    <div class="page-thumb-num">pg ${pageNum}</div>`;
  div.addEventListener('click', () => togglePage(pageNum, div));
  return div;
}

async function renderThumb(pageNum, thumbEl) {
  try {
    const page    = await pdfDoc.getPage(pageNum);
    const scale   = 0.3;
    const viewport = page.getViewport({ scale });
    const canvas  = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    // Replace the loading placeholder
    thumbEl.querySelector('.page-thumb-loading')?.replaceWith(canvas);
  } catch {
    const el = thumbEl.querySelector('.page-thumb-loading');
    if (el) { el.textContent = 'err'; el.style.color = 'var(--error)'; }
  }
}

/* ── Render selected pages to JPEG for API submission ── */
async function renderPagesToImages(pageNums) {
  const sorted = [...pageNums].sort((a, b) => a - b);
  const images = [];
  for (const pageNum of sorted) {
    const page     = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0 }); // 144dpi — sufficient for newspaper text
    const canvas   = document.createElement('canvas');
    canvas.width   = viewport.width;
    canvas.height  = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const dataUrl  = canvas.toDataURL('image/jpeg', 0.88);
    images.push(dataUrl.split(',')[1]);
  }
  return images; // array of base64 JPEG strings, one per selected page
}

function togglePage(pageNum, el) {
  if (selectedPages.has(pageNum)) {
    selectedPages.delete(pageNum);
    el.classList.remove('selected');
  } else {
    selectedPages.add(pageNum);
    el.classList.add('selected');
  }
  updateSelCount();
  updateRunBtn();
}

function updateSelCount() {
  const total = totalPages;
  const sel   = selectedPages.size;
  selCountEl.textContent = sel === total
    ? `All ${total} pages selected`
    : `${sel} of ${total} pages selected`;
}

/* ── Page selection buttons ── */
selectAllBtn.addEventListener('click', () => {
  for (let i = 1; i <= totalPages; i++) selectedPages.add(i);
  pageGallery.querySelectorAll('.page-thumb').forEach(el => el.classList.add('selected'));
  updateSelCount();
  updateRunBtn();
});

selectNoneBtn.addEventListener('click', () => {
  selectedPages.clear();
  pageGallery.querySelectorAll('.page-thumb').forEach(el => el.classList.remove('selected'));
  updateSelCount();
  updateRunBtn();
});

applyRangeBtn.addEventListener('click', () => applyRange(pageRangeInput.value));
pageRangeInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyRange(pageRangeInput.value); });

function applyRange(rangeStr) {
  if (!rangeStr.trim()) return;
  const parsed = parsePageRange(rangeStr, totalPages);
  if (!parsed.length) {
    setStatus('Invalid page range format. Use e.g. "1-3, 5, 7-10"', 'error');
    return;
  }
  selectedPages.clear();
  parsed.forEach(p => selectedPages.add(p));
  pageGallery.querySelectorAll('.page-thumb').forEach(el => {
    const p = parseInt(el.dataset.page);
    el.classList.toggle('selected', selectedPages.has(p));
  });
  updateSelCount();
  updateRunBtn();
  setStatus(`Selected pages: ${rangeStr.trim()}`, '');
}

function parsePageRange(str, max) {
  const pages = [];
  const parts = str.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const rangeMatch = trimmed.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]);
      const to   = Math.min(parseInt(rangeMatch[2]), max);
      if (isNaN(from) || isNaN(to) || from < 1 || from > to) return [];
      for (let i = from; i <= to; i++) pages.push(i);
    } else {
      const n = parseInt(trimmed);
      if (isNaN(n) || n < 1 || n > max) return [];
      pages.push(n);
    }
  }
  return [...new Set(pages)].sort((a, b) => a - b);
}

/* ── Run button state ── */
function updateRunBtn() {
  runBtn.disabled = !pdfFile || !apiKeyEl.value.trim() || running
    || (totalPages > 0 && selectedPages.size === 0);
}
apiKeyEl.addEventListener('input', updateRunBtn);

/* ── Reset ── */
resetBtn.addEventListener('click', () => {
  if (running) return;
  clearFile();
  allRecords = [];
  activeCats.clear();
  ['Vacancies','Real Estate','Vehicles','Notices'].forEach(c => activeCats.add(c));
  document.querySelectorAll('.stat-toggle').forEach(b => b.classList.add('active'));
  passList.innerHTML = '';
  statsRow.style.display = 'none';
  outputSec.style.display = 'none';
  emptyState.style.display = '';
  buildPassSlots(runTemplateEl.value);
});

/* ── Tabs ── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

/* ── Pass slots ── */
const TEMPLATE_SLOTS = {
  quick: [
    { key: 'scan',    label: 'Page Scan',         sub: 'One extraction pass per page — no resweep' },
  ],
  adversarial: [
    { key: 'scan',    label: 'Page Scan',         sub: 'One extraction pass per page' },
    { key: 'check',   label: 'Adversarial Check', sub: 'Second-pass per page — find edge-case ads' },
  ],
  heavy: [
    { key: 'scan',    label: 'Page Scan',         sub: 'One extraction pass per page' },
    { key: 'contact', label: 'Contact Sweep',     sub: 'Targeted per-page — missing contacts only', optional: true },
  ],
};

function buildPassSlots(mode) {
  passList.innerHTML = '';
  const slots = TEMPLATE_SLOTS[mode] || TEMPLATE_SLOTS.heavy;
  slots.forEach(s => passList.appendChild(makeSlotEl(s)));
}

function makeSlotEl(slot) {
  const el = document.createElement('div');
  el.className = 'pass-item' + (slot.optional ? ' optional' : '');
  el.id = `pass-${slot.key}`;
  el.innerHTML = `
    <div class="pass-dot">·</div>
    <div class="pass-body">
      <div class="pass-title">${slot.label}</div>
      <div class="pass-sub">${slot.sub}</div>
      <div class="pass-meta" id="pass-meta-${slot.key}">Waiting…</div>
      <div class="pass-log" id="pass-log-${slot.key}" style="display:none"></div>
    </div>`;
  return el;
}

buildPassSlots('heavy');
document.querySelectorAll('.wf-tile').forEach(tile => {
  tile.addEventListener('click', () => {
    if (running) return;
    document.querySelectorAll('.wf-tile').forEach(t => t.classList.remove('active'));
    tile.classList.add('active');
    runTemplateEl.value = tile.dataset.mode;
    buildPassSlots(tile.dataset.mode);
  });
});

/* ── Stop button ── */
stopBtn.addEventListener('click', () => {
  if (abortCtrl) abortCtrl.abort();
  stopBtn.style.display = 'none';
  running = false;
  updateRunBtn();
  setStatus('Extraction stopped by user.', 'error');
});

/* ── Main run ── */
runBtn.addEventListener('click', async () => {
  if (running || !pdfFile) return;
  const apiKey = apiKeyEl.value.trim();
  if (!apiKey) { setStatus('Enter your Anthropic API key first.', 'error'); return; }
  if (totalPages > 0 && selectedPages.size === 0) {
    setStatus('Select at least one page to extract from.', 'error');
    return;
  }

  running   = true;
  abortCtrl = new AbortController();
  runBtn.style.display  = 'none';
  stopBtn.style.display = '';
  updateRunBtn();
  allRecords = [];

  const mode = runTemplateEl.value;
  buildPassSlots(mode);

  // Render only the selected pages to JPEG images (or fall back to full PDF)
  let media;
  const isImages = !!pdfDoc;
  try {
    if (isImages) {
      setStatus(`Rendering ${selectedPages.size} page${selectedPages.size !== 1 ? 's' : ''} for upload…`, 'active', true);
      media = await renderPagesToImages(selectedPages);
    } else {
      setStatus('Preparing PDF…', 'active', true);
      if (!pdfBase64) pdfBase64 = await fileToBase64(pdfFile);
      media = pdfBase64;
    }
  } catch (e) {
    setStatus('Failed to prepare pages: ' + e.message, 'error');
    running = false; abortCtrl = null;
    runBtn.style.display = ''; stopBtn.style.display = 'none';
    updateRunBtn();
    return;
  }

  try {
    if      (mode === 'quick')       await runTemplateQuick(apiKey, media);
    else if (mode === 'adversarial') await runTemplateAdversarial(apiKey, media);
    else                             await runTemplatePageByPage(apiKey, media);
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('Extraction failed: ' + e.message, 'error');
  } finally {
    running = false;
    abortCtrl = null;
    runBtn.style.display  = '';
    stopBtn.style.display = 'none';
    updateRunBtn();
  }
});

/* ── Quick Scan: single extraction pass, page by page ── */
async function runTemplateQuick(apiKey, media) {
  if (!Array.isArray(media) || media.length === 0) {
    setStatus('Quick Scan requires image rendering. Reload the PDF and try again.', 'error');
    return;
  }
  const model     = modelEl.value;
  const pages     = [...selectedPages].sort((a, b) => a - b);
  const pageCount = media.length;

  setPassState('scan', 'running', `0 / ${pageCount} pages — 0 records`);

  for (let i = 0; i < pageCount; i++) {
    if (abortCtrl.signal.aborted) break;
    const pageNum  = pages[i];
    const scope    = `\n\nNote: This image is page ${pageNum} of the newspaper.`;
    setPassState('scan', 'running', `Page ${i + 1} / ${pageCount}  (pg ${pageNum}) — ${allRecords.length} records so far`);
    let raw = '';
    try {
      raw = await callClaude([media[i]], buildPromptGridTagged(scope), apiKey, model);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      appendPassLog('scan', `pg ${pageNum}: ERROR — ${e.message}`);
      continue;
    }
    const parsed = safeParseRecords(raw);
    parsed.forEach(r => { r._page = pageNum; });
    const before = allRecords.length;
    allRecords   = mergeDedup(allRecords, parsed);
    appendPassLog('scan', `pg ${pageNum}: +${allRecords.length - before} (${allRecords.length} total)`);
    updateStats(allRecords);
    renderOutput(getActiveRecords());
  }

  if (!abortCtrl.signal.aborted) {
    setPassState('scan', 'done', `${pageCount} pages — ${allRecords.length} records extracted`);
    setStatus(`Quick Scan complete — ${allRecords.length} listings from ${pageCount} pages.`, 'success');
  }
}

/* ── Quick Adversarial: extract then audit each page for missed ads ── */
async function runTemplateAdversarial(apiKey, media) {
  if (!Array.isArray(media) || media.length === 0) {
    setStatus('Quick Adversarial requires image rendering. Reload the PDF and try again.', 'error');
    return;
  }
  const model     = modelEl.value;
  const pages     = [...selectedPages].sort((a, b) => a - b);
  const pageCount = media.length;

  // Pass 1 — standard extraction
  setPassState('scan', 'running', `0 / ${pageCount} pages — 0 records`);
  for (let i = 0; i < pageCount; i++) {
    if (abortCtrl.signal.aborted) break;
    const pageNum = pages[i];
    const scope   = `\n\nNote: This image is page ${pageNum} of the newspaper.`;
    setPassState('scan', 'running', `Page ${i + 1} / ${pageCount}  (pg ${pageNum}) — ${allRecords.length} records so far`);
    let raw = '';
    try {
      raw = await callClaude([media[i]], buildPromptGridTagged(scope), apiKey, model);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      appendPassLog('scan', `pg ${pageNum}: ERROR — ${e.message}`);
      continue;
    }
    const parsed = safeParseRecords(raw);
    parsed.forEach(r => { r._page = pageNum; });
    const before = allRecords.length;
    allRecords   = mergeDedup(allRecords, parsed);
    appendPassLog('scan', `pg ${pageNum}: +${allRecords.length - before} (${allRecords.length} total)`);
    updateStats(allRecords);
    renderOutput(getActiveRecords());
  }
  if (abortCtrl.signal.aborted) return;
  setPassState('scan', 'done', `${pageCount} pages — ${allRecords.length} records from Pass 1`);

  // Pass 2 — adversarial audit per page
  let newTotal = 0;
  setPassState('check', 'running', `Auditing ${pageCount} pages for missed ads…`);
  for (let i = 0; i < pageCount; i++) {
    if (abortCtrl.signal.aborted) break;
    const pageNum    = pages[i];
    const scope      = `\n\nNote: This image is page ${pageNum} of the newspaper.`;
    const pageRecs   = allRecords.filter(r => r._page === pageNum);
    setPassState('check', 'running', `Auditing page ${i + 1} / ${pageCount}  (pg ${pageNum})`);
    let raw = '';
    try {
      raw = await callClaude([media[i]], buildPromptPageAdversarial(pageRecs, scope), apiKey, model);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      appendPassLog('check', `pg ${pageNum}: ERROR — ${e.message}`);
      continue;
    }
    const parsed = safeParseRecords(raw);
    parsed.forEach(r => { r._page = pageNum; });
    const before = allRecords.length;
    allRecords   = mergeDedup(allRecords, parsed);
    const added  = allRecords.length - before;
    newTotal    += added;
    appendPassLog('check', `pg ${pageNum}: +${added} new (${allRecords.length} total)`);
    updateStats(allRecords);
    renderOutput(getActiveRecords());
  }

  if (!abortCtrl.signal.aborted) {
    setPassState('check', 'done', `${newTotal} additional listings found across ${pageCount} pages`);
    setStatus(`Quick Adversarial complete — ${allRecords.length} listings from ${pageCount} pages.`, 'success');
  }
}

/* ── Deep Scan: page-by-page extraction + contact resweep ── */
async function runTemplatePageByPage(apiKey, media) {  // "heavy" mode
  if (!Array.isArray(media) || media.length === 0) {
    setStatus('Page-by-page mode requires image rendering. Reload the PDF and try again.', 'error');
    return;
  }

  const model     = modelEl.value;
  const pages     = [...selectedPages].sort((a, b) => a - b); // same order as media[]
  const pageCount = media.length;

  setPassState('scan', 'running', `0 / ${pageCount} pages — 0 records`);

  for (let i = 0; i < pageCount; i++) {
    if (abortCtrl.signal.aborted) break;

    const pageNum   = pages[i];
    const pageScope = `\n\nNote: This image is page ${pageNum} of the newspaper.`;

    setPassState('scan', 'running', `Page ${i + 1} / ${pageCount}  (pg ${pageNum}) — ${allRecords.length} records so far`);

    let raw = '';
    try {
      raw = await callClaude([media[i]], buildPromptGridTagged(pageScope), apiKey, model);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      appendPassLog('scan', `pg ${pageNum}: ERROR — ${e.message}`);
      continue;
    }

    if (raw.includes('[TRUNCATED]')) {
      appendPassLog('scan', `pg ${pageNum}: ⚠ output truncated — increase MAX_TOKENS or split pages`);
      raw = raw.replace('[TRUNCATED]', '');
    }

    const parsed = safeParseRecords(raw);
    // Tag each record with the source page so we can target contact resweeps
    parsed.forEach(r => { r._page = pageNum; });

    const before = allRecords.length;
    allRecords   = mergeDedup(allRecords, parsed);
    const added  = allRecords.length - before;
    appendPassLog('scan', `pg ${pageNum}: +${added} (${allRecords.length} total)`);

    updateStats(allRecords);
    renderOutput(getActiveRecords());
  }

  if (abortCtrl.signal.aborted) return;
  setPassState('scan', 'done', `${pageCount} pages — ${allRecords.length} records extracted`);

  // ── Contact resweep: group flagged records by source page, one call per page ──
  const flagged = getFlaggedRecords(allRecords);
  if (flagged.length === 0 || abortCtrl.signal.aborted) {
    setPassState('contact', 'skipped', 'All contacts found — nothing to resweep');
    setStatus(`Deep Scan complete — ${allRecords.length} listings from ${pageCount} pages.`, 'success');
    return;
  }

  setPassState('contact', 'running', `${flagged.length} listings missing contact — scanning…`);

  // Build a map: pageNum → flagged records on that page
  const byPage = {};
  flagged.forEach(f => {
    const rec = allRecords.find(r => r.title === f.title && r.grid_id === f.grid_id);
    const pg  = rec?._page;
    if (pg) { (byPage[pg] || (byPage[pg] = [])).push(f); }
  });

  let resolved = 0;
  for (const [pgStr, pageFlagged] of Object.entries(byPage)) {
    if (abortCtrl.signal.aborted) break;
    const pageNum = parseInt(pgStr);
    const pageIdx = pages.indexOf(pageNum);
    if (pageIdx === -1) continue;

    const scope = `\n\nNote: This image is page ${pageNum} of the newspaper.`;
    let raw = '';
    try {
      raw = await callClaude([media[pageIdx]], buildPromptTargetedResweep(pageFlagged, scope), apiKey, 'claude-sonnet-4-6');
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      appendPassLog('contact', `pg ${pageNum}: ERROR — ${e.message}`);
      continue;
    }
    const patches = safeParsePatches(raw);
    allRecords    = applyContactPatches(allRecords, patches);
    resolved     += patches.length;
    appendPassLog('contact', `pg ${pageNum}: ${patches.length} contacts resolved`);
    updateStats(allRecords);
    renderOutput(getActiveRecords());
  }

  setPassState('contact', 'done', `${resolved} contacts resolved across flagged pages`);
  setStatus(`Deep Scan complete — ${allRecords.length} listings from ${pageCount} pages.`, 'success');
}

/* ── Build page scope string ── */
function buildPageScope(isImages = false) {
  if (!totalPages) return '';
  const pages = [...selectedPages].sort((a, b) => a - b);
  if (isImages) {
    // We're sending images of exactly these pages — tell Claude which pages they are
    return pages.length === totalPages
      ? ''
      : `\n\nNote: The images provided are pages ${pages.join(', ')} of the newspaper.`;
  }
  // PDF fallback — must instruct Claude which pages to read
  if (selectedPages.size === totalPages) return '';
  return `\n\nIMPORTANT: Only extract listings from the following pages: ${pages.join(', ')}. Ignore all other pages.`;
}

/* ── Claude API call ──
   media: array of base64 JPEG strings (preferred) OR single base64 PDF string (fallback) */
async function callClaude(media, prompt, apiKey, model) {
  const isImages = Array.isArray(media);
  const mediaBlocks = isImages
    ? media.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }))
    : [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media } }];

  const headers = {
    'x-api-key':   apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (!isImages) headers['anthropic-beta'] = 'pdfs-2024-09-25';

  const res = await fetch(API_URL, {
    method: 'POST',
    signal: abortCtrl?.signal,
    headers,
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [...mediaBlocks, { type: 'text', text: prompt }]
      }]
    })
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const err = await res.json(); msg = err.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') {
    console.warn('[callClaude] Response truncated at max_tokens — output may be incomplete.');
  }
  return (data.content?.[0]?.text || '') + (data.stop_reason === 'max_tokens' ? '\n[TRUNCATED]' : '');
}

/* ── Prompts ── */
function buildPromptPass1(pageScope) {
  return `You are extracting every classified advertisement from this Sunday Gleaner newspaper PDF.

## Page layout
The Gleaner classifieds section is a broadsheet newspaper. Each page has 4–6 narrow vertical columns.
Reading order: read each column fully top-to-bottom before moving to the next column to the right.
Section headers (e.g. "VACANCIES", "TO LET", "FOR SALE", "VEHICLES FOR SALE", "NOTICES") appear as bold or ALL-CAPS banners — they may span one column or the full page width. A section header marks where that category begins; subsequent ads below it belong to that section until the next header.
Ads come in two formats:
  1. Line classifieds — small text-only blocks, often packed tightly, separated by a thin rule or blank line. Each block is one ad.
  2. Display ads — bordered boxes (sometimes with images or large bold text). Treat each box as one ad.
Multiple sections may share a single page — e.g. Vacancies in the top half, Vehicles in the bottom half. Watch for section transitions mid-column.
Do not skip ads at column edges, gutters, or page margins — small ads often appear in these tight spaces.${pageScope}

## Output format
Return ONLY a raw JSON array (no markdown code fences, no explanation). Each object must have exactly these fields:
${SCHEMA_WITH_GRID.replace(/,\n  "grid_id": "c2r4"/, '')}

## Category and type rules
${CAT_TYPE_RULES}

## Section name hints (as they appear in the paper)
- Vacancies: "VACANCIES", "SITUATIONS VACANT", "HELP WANTED", "SITUATIONS WANTED"
- Real Estate: "TO LET", "FOR SALE", "REAL ESTATE", "LAND FOR SALE", "COMMERCIAL SPACE"
- Vehicles: "VEHICLES FOR SALE", "MOTOR VEHICLES", "CARS FOR SALE"
- Notices: "NOTICES", "LEGAL NOTICES", "PUBLIC NOTICES", "IN MEMORIAM", "LOST & FOUND"

Return only the JSON array. Start with [ and end with ].`;
}

function buildPromptResweep(existing, pageScope) {
  const summary = existing.map(r => `  - [${r.cat}/${r.type}] "${r.title}" | ${contactStr(r.contact)}`).join('\n');
  return `I have already extracted ${existing.length} listings from this classified newspaper PDF. Here is a summary of what was found:

${summary}

Now re-read the document carefully using the layout rules below and find any listings I MISSED.

## Layout reminder
- 4–6 narrow vertical columns per page; read each column fully top-to-bottom before moving right
- Section headers (bold / ALL-CAPS banners) mark category boundaries — check every section header on every page for uncaptured ads beneath it
- Line classifieds: tightly packed text blocks separated by thin rules — one block = one ad; check you haven't merged two ads into one or skipped a small ad between two larger ones
- Display ads: bordered boxes — treat each box as a separate ad even if it contains multiple sub-listings
- Multiple sections can share one page; check for section transitions mid-column
- Margins, gutters, and column edges often hide small ads${pageScope}

## What to look for
- Small or densely packed line ads overlooked in earlier passes
- Ads at page margins, column edges, or in the gutter between columns
- Listings under section headers not yet represented in the extracted set
- Ads that span a column break (the text continues at the top of the next column)
- Repeated section blocks (e.g. a second page of vehicles or a second real estate section)
- Display box ads that may have been skipped if surrounded by line classifieds

Return ONLY the NEW missed listings as a raw JSON array (no markdown, no explanation) using exactly the same schema:
{ "cat", "type", "title", "loc", "parish", "price_text", "price_jmd", "notes", "contact" }

Category/type rules (same as before):
- Vacancies: "Job" or "General"
- Real Estate: "Rental" | "Sale" | "Commercial" | "Land"
- Vehicles: "SUV" | "Car" | "Pickup/Van" | "Bus" | "Motorcycle" | "Truck"
- Notices: "Legal" | "General"

If you find nothing new, return exactly: []
Start with [ and end with ].`;
}

/* ── Grid cell instruction block (shared) ── */
const GRID_INSTRUCTION = `
## Grid cell tagging
Each page is a grid. Number columns c1 (leftmost) through cN (rightmost).
Divide each column into row zones of approximately 10 text lines each, numbered r1 from the top downward.
For every record, set grid_id to the cell where the ad's title line appears — e.g. "c2r4".
If the ad spans two zones, use the zone where the title/header line starts.`;

const SCHEMA_WITH_GRID = `{
  "cat": "Vacancies" | "Real Estate" | "Vehicles" | "Notices",
  "type": see allowed values per category below,
  "title": "concise title (vehicle: make/model/year; job: role; property: size/location or developer name)",
  "loc": "location exactly as stated in the ad, or empty string if not stated",
  "parish": "Jamaican parish (Kingston, St. Andrew, St. Catherine, St. James, Manchester, St. Ann, St. Mary, St. Thomas, St. Elizabeth, Clarendon, Portland, Westmoreland, Hanover, Trelawny, Various)",
  "price_text": "lowest/from price as written, or range like '$65M–$72M', or — if not stated",
  "price_jmd": lowest integer JMD price in the ad (for filtering); null if not determinable,
  "notes": "full ad description excluding item variants already captured in items array",
  "contact": "phone number(s) or email as written, or — if not stated",
  "items": null or array of variant objects when the ad lists multiple distinct units/options each with its own price — see multi-item rule below,
  "grid_id": "c2r4"
}
Each item in the items array must be:
  { "desc": "brief unit description e.g. '2 bed 2.5 bath 1650 sqft'", "price_text": "price as written or —", "price_jmd": integer or null }`;

const CAT_TYPE_RULES = `- cat "Vacancies": type must be "Job" (employer seeking worker) or "General" (worker seeking job / miscellaneous employment)
- cat "Real Estate": type must be one of:
    "Rental"           — residential property to let (apartment, house, room)
    "Sale"             — residential property for sale
    "Commercial Rental"— office, shop, warehouse, business space, or any non-residential space for rent or lease
    "Land"             — land for sale (residential or commercial)
  IMPORTANT: "Rental" is for residential letting only. Commercial/business/office/industrial space for rent = "Commercial Rental".
- cat "Vehicles": type must be "SUV", "Car", "Pickup/Van", "Bus", "Motorcycle", or "Truck" — classify by vehicle body style
- cat "Notices": type must be "Legal" (statutory/court/legal notices) or "General" (announcements, lost & found, services, etc.)

## Multi-item ads
Some advertisers pay for one ad block but list multiple units or variants, each with its own price or description (e.g. "2 bed $65M / 3 bed $72M / penthouse $85M"). This is intentional — do NOT split them into separate records. Instead:
- Set "items" to an array, one entry per variant: { "desc": "...", "price_text": "...", "price_jmd": int|null }
- Set top-level "price_jmd" to the lowest non-null price across all items (so filtering works)
- Set top-level "price_text" to a range e.g. "$65M – $85M" or "from $65M"
- "notes" should describe the development/building overall; individual unit details go in items
- Use items only when the ad explicitly lists multiple units/options with distinct pricing. A single property with one price does NOT need an items array.

## Critical rules — read carefully
- ONE listing = ONE JSON object. If two separate ads appear next to each other (each with its own price, contact, or distinct property/item), output them as two separate objects. Never merge multiple ads into one record.
- Section headings and regional headings are NOT ads. Do NOT output them as records. They only exist to tell you the category and parish for the ads that follow. A line is a heading if: it is short (1–5 words), ALL-CAPS or bold, has no price and no phone number, and matches a category name, parish name, or region. Skip it entirely.
- If you are uncertain whether a short ALL-CAPS line is a heading or an ad title — if it has no contact and no price details, treat it as a heading and skip it.`;

const LAYOUT_BLOCK = `## Page layout
The Gleaner classifieds section is a broadsheet newspaper. Each page has 4–6 narrow vertical columns.
Reading order: read each column fully top-to-bottom before moving to the next column to the right.
Section headers (e.g. "VACANCIES", "TO LET", "FOR SALE", "VEHICLES FOR SALE", "NOTICES") appear as bold or ALL-CAPS banners — they may span one column or the full page width. A section header marks where that category begins; subsequent ads below it belong to that section until the next header.
Ads come in two formats:
  1. Line classifieds — small text-only blocks, often packed tightly, separated by a thin rule or blank line. Each block is one ad.
  2. Display ads — bordered boxes (sometimes with images or large bold text). Treat each box as one ad.
Multiple sections may share a single page — e.g. Vacancies in the top half, Vehicles in the bottom half. Watch for section transitions mid-column.
Do not skip ads at column edges, gutters, or page margins — small ads often appear in these tight spaces.

## Regional sub-headings (parish dividers within a section)
Within a classified section the Gleaner uses short bold or ALL-CAPS lines to group listings by parish or region — for example:
  KINGSTON
  ST. ANDREW
  WESTMORELAND
  MONTEGO BAY
These lines are NOT ads. Identifying signs:
  - Very short (1–4 words), bold or ALL-CAPS, no price or phone number
  - Matches a Jamaican parish name, major town, or region (Kingston, St. Andrew, St. Catherine, St. James, Manchester, St. Ann, St. Mary, St. Thomas, St. Elizabeth, Clarendon, Portland, Westmoreland, Hanover, Trelawny, Montego Bay, Mandeville, Ocho Rios, Spanish Town, etc.)
  - Immediately followed by a group of listings
When you encounter a regional sub-heading, set parish = that region for every listing that follows in the same column until the next heading or section break.
Do NOT extract the heading line itself as a classified record.`;

function buildPromptGridTagged(pageScope) {
  return `You are extracting every classified advertisement from this Sunday Gleaner newspaper PDF.

${LAYOUT_BLOCK}${pageScope}
${GRID_INSTRUCTION}

## Output format
Return ONLY a raw JSON array (no markdown code fences, no explanation). Each object must have exactly these fields:
${SCHEMA_WITH_GRID}

## Category and type rules
${CAT_TYPE_RULES}

## Section name hints (as they appear in the paper)
- Vacancies: "VACANCIES", "SITUATIONS VACANT", "HELP WANTED", "SITUATIONS WANTED"
- Real Estate: "TO LET", "FOR SALE", "REAL ESTATE", "LAND FOR SALE", "COMMERCIAL SPACE"
- Vehicles: "VEHICLES FOR SALE", "MOTOR VEHICLES", "CARS FOR SALE"
- Notices: "NOTICES", "LEGAL NOTICES", "PUBLIC NOTICES", "IN MEMORIAM", "LOST & FOUND"

Return only the JSON array. Start with [ and end with ].`;
}

function buildPromptPageAdversarial(pageRecords, pageScope) {
  const found = pageRecords.length
    ? pageRecords.map(r => `  [${r.grid_id || '?'}] "${r.title}" (${r.cat})`).join('\n')
    : '  (none found yet)';
  return `You are a second-pass auditor reviewing one page of the Sunday Gleaner classifieds section. A first extractor already ran on this page and found the following listings:

${found}

Your job is to find anything they missed. Pay special attention to:
1. **Display box ads** — bordered or boxed ads with logos or large bold headers, surrounded by dense line classifieds.
2. **Multi-column bleeding ads** — text flowing from one column into the adjacent gutter or next column.
3. **Section-boundary ads** — the last 2–3 ads before a section header change and the first 2–3 after.
4. **Margin and gutter ads** — small ads squeezed into page margins or very narrow gutters.
5. **Line classifieds without a bold header** — ads starting with a phone number or location with no title.
6. **Ads containing only a phone number** — just a number and a one-line description.

Do NOT re-extract listings already in the list above.

${LAYOUT_BLOCK}${pageScope}
${GRID_INSTRUCTION}

## Output format
Return ONLY a raw JSON array of newly found listings (no markdown, no explanation). If nothing was missed, return exactly: []
Each object must have exactly these fields:
${SCHEMA_WITH_GRID}

## Category and type rules
${CAT_TYPE_RULES}

Start with [ and end with ].`;
}

function buildPromptAdversarial(pageScope) {
  return `You are an adversarial auditor reviewing a Sunday Gleaner newspaper PDF for classified ads that a first-pass extractor is likely to have missed.

Your focus is on what gets overlooked — not the obvious ads in the clear centre of a column, but the ones at the edges:

## What to prioritise
1. **Display box ads** — bordered or boxed ads, sometimes with logos or large bold headers. These are often skipped when surrounded by dense line classifieds.
2. **Multi-column bleeding ads** — ads whose text flows from one column into the adjacent gutter or the start of the next column.
3. **Section-boundary ads** — the last 2–3 ads before a section header change, and the first 2–3 after. These get mis-attributed or dropped.
4. **Margin and gutter ads** — small ads squeezed into page margins, between the last column and the paper edge, or in very narrow gutters between columns.
5. **Line classifieds without a bold header** — some ads start with a phone number or location with no title header. These look like stray text and are often missed.
6. **Ads containing only a phone number** — some listings are just a number and a one-line description. Capture them.
7. **Repeat section pages** — a second or third page of Vacancies, Vehicles, etc. Scan every page.

${LAYOUT_BLOCK}${pageScope}
${GRID_INSTRUCTION}

## Output format
Return ONLY a raw JSON array (no markdown code fences, no explanation). Each object must have exactly these fields:
${SCHEMA_WITH_GRID}

## Category and type rules
${CAT_TYPE_RULES}

Return only the JSON array. Start with [ and end with ].`;
}

function buildPromptTargetedResweep(flaggedRecords, pageScope) {
  const list = flaggedRecords.map(r => `  [${r.grid_id || '?'}] "${r.title}"`).join('\n');
  return `These classified ads were captured from a Sunday Gleaner PDF but their contact information (phone number or email) was not found. The contact may appear on the line immediately after the ad body, in a nearby column, or in a small text block adjacent to the ad.

Flagged listings needing contact lookup:
${list}

For each listing, locate it in the PDF using its grid cell ID (column cN, row zone rM) and find the contact.${pageScope}

Return ONLY a JSON array of patches — one object per resolved listing. Do NOT include full records.
Schema: [{ "grid_id": "c2r4", "contact": "876-555-1234" }]

Rules:
- If you find the contact, include it.
- If a listing genuinely has no contact published, omit it from the array.
- If nothing is found for any listing, return exactly: []

Start with [ and end with ].`;
}

function buildPromptResweepGrid(existing, flaggedRecords, pageScope) {
  const summary = existing.map(r => `  - [${r.grid_id || '?'}][${r.cat}/${r.type}] "${r.title}" | ${contactStr(r.contact)}`).join('\n');
  const flagList = flaggedRecords.length
    ? '\n\n## Flagged cells — also find contact info for these\n' +
      flaggedRecords.map(r => `  [${r.grid_id || '?'}] "${r.title}"`).join('\n')
    : '';
  return `I have already extracted ${existing.length} listings from this classified newspaper PDF. Here is what was found (with grid cell IDs):

${summary}
${flagList}

Now re-read the document and do two things:
1. Find any listings that are MISSING from the list above
2. For the flagged cells listed above, find the missing contact information

## Layout reminder
- 4–6 narrow vertical columns per page; read each column fully top-to-bottom before moving right
- Section headers (bold / ALL-CAPS banners) mark category boundaries
- Line classifieds: one block = one ad; check for merged or skipped ads between larger ones
- Display ads: bordered boxes — treat each box as a separate ad
- Check for section transitions mid-column and repeated section pages
- Margins, gutters, and column edges hide small ads${pageScope}
${GRID_INSTRUCTION}

Return ALL new missed listings (full records) as a raw JSON array. For flagged contact lookups, return them as full records too with corrected contact fields.

Schema for ALL returned records:
${SCHEMA_WITH_GRID}

Category/type rules:
${CAT_TYPE_RULES}

If you find nothing new, return exactly: []
Start with [ and end with ].`;
}

function buildPromptFinalAdversarial(flaggedRecords, pageScope) {
  const list = flaggedRecords.map(r => `  [${r.grid_id || '?'}] "${r.title}"`).join('\n');
  return `Final adversarial pass on a Sunday Gleaner classified PDF.

These listings were captured but still have no contact information after two earlier passes:
${list}

Your tasks:
1. Locate each flagged listing using its grid cell ID and look for the contact in: the line directly after the ad body, an adjacent column, a footnote or small-print block, or a shared contact line at the end of a group of ads.
2. Identify whether any of these are genuinely no-contact ads (e.g. "Applications in writing only", statutory notices, in memoriam) vs. cases where the contact was simply not captured.
3. Also scan for any completely new ads not yet in the system — focus on display boxes, section boundaries, and repeated section pages.${pageScope}
${GRID_INSTRUCTION}

Return a JSON array of full records for:
- Flagged listings with corrected contact info
- Any brand-new listings found

Schema:
${SCHEMA_WITH_GRID}

Category/type rules:
${CAT_TYPE_RULES}

If nothing new, return exactly: []
Start with [ and end with ].`;
}

/* ── Parse Claude's response robustly ── */
function safeParseRecords(raw) {
  try { return normalise(JSON.parse(raw)); } catch {}

  let cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return normalise(JSON.parse(cleaned)); } catch {}

  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try { return normalise(JSON.parse(cleaned.slice(start, end + 1))); } catch {}
  }

  const objs = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    try { objs.push(JSON.parse(m[0])); } catch {}
  }
  if (objs.length) return normalise(objs);

  console.warn('Could not parse Claude response:', raw.slice(0, 500));
  return [];
}

const VALID_TYPES = {
  'Vacancies':    ['Job', 'General'],
  'Real Estate':  ['Rental', 'Sale', 'Commercial Rental', 'Land'],
  'Vehicles':     ['SUV', 'Car', 'Pickup/Van', 'Bus', 'Motorcycle', 'Truck'],
  'Notices':      ['Legal', 'General'],
};

/* ── Phone number normalization ── */
// Returns { phones: ["876-XXX-XXXX", ...], emails: ["x@y.com", ...] }
// Accepts a raw Claude string or an already-structured contact object (idempotent).
function cleanContact(raw) {
  if (!raw) return { phones: [], emails: [] };
  // Already structured — return as-is
  if (typeof raw === 'object') return raw;

  const emails = (raw.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || []);
  const scrubbed = raw.replace(/[.()\-\s]+/g, ' ');
  const phones = [];
  const assumed = [];
  const seen = new Set();

  const fullRe = /(?:\+?1\s)?876\s(\d{3})\s(\d{4})/g;
  let m;
  while ((m = fullRe.exec(scrubbed)) !== null) {
    const n = '876-' + m[1] + '-' + m[2];
    if (!seen.has(n)) { seen.add(n); phones.push(n); assumed.push(false); }
  }
  const spacedRe = /\b(\d{3})\s(\d{4})\b/g;
  while ((m = spacedRe.exec(scrubbed)) !== null) {
    const n = '876-' + m[1] + '-' + m[2];
    if (!seen.has(n)) { seen.add(n); phones.push(n); assumed.push(true); }
  }
  const bare7Re = /\b(\d{3})(\d{4})\b/g;
  while ((m = bare7Re.exec(scrubbed)) !== null) {
    const n = '876-' + m[1] + '-' + m[2];
    if (!seen.has(n)) { seen.add(n); phones.push(n); assumed.push(true); }
  }

  return { phones, emails, assumed };
}

// Plain string for summaries/dedup keys
function contactStr(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return [...(c.phones || []), ...(c.emails || [])].join(' / ');
}

// True if contact object has no useful data
function contactEmpty(c) {
  if (!c) return true;
  if (typeof c === 'string') return !c || c === '—';
  return (c.phones || []).length === 0 && (c.emails || []).length === 0;
}

/* Canonical names + common aliases for parish detection in ad text */
const PARISH_ALIASES = [
  { canonical: 'Kingston',      match: ['kingston','kgn','half way tree','new kingston','liguanea','mona','barbican','cherry gardens','constant spring','havendale','hope road','trench town','whitfield town','august town','papine'] },
  { canonical: 'St. Andrew',    match: ['st. andrew','st andrew','saint andrew','stony hill','irish town','red hills','meadowbrook','norbrook','jacks hill','smokey vale','lawrence tavern','gordon town'] },
  { canonical: 'St. Catherine', match: ['st. catherine','st catherine','saint catherine','spanish town','portmore','old harbour','linstead','bog walk','ewarton','greater portmore','waterford','bridgeport','naggo head','gregory park','caymanas','braeton'] },
  { canonical: 'St. Thomas',    match: ['st. thomas','st thomas','saint thomas','morant bay','bath','yallahs','white horses','seaforth'] },
  { canonical: 'Portland',      match: ['portland','port antonio','buff bay','long bay','hope bay','moore town','manchioneal'] },
  { canonical: 'St. Mary',      match: ['st. mary','st mary','saint mary','port maria','oracabessa','highgate','gayle','richmond','castleton'] },
  { canonical: 'St. Ann',       match: ['st. ann','st ann','saint ann','ocho rios','browns town','st. ann\'s bay','st ann\'s bay','discovery bay','runaway bay','priory','moneague'] },
  { canonical: 'Trelawny',      match: ['trelawny','falmouth','duncans','ulster spring','clark\'s town','wait-a-bit'] },
  { canonical: 'St. James',     match: ['st. james','st james','saint james','montego bay','mobay','mo-bay','rose hall','ironshore','reading','anchovy','cambridge'] },
  { canonical: 'Hanover',       match: ['hanover','lucea','green island','sandy bay','hopewell','tryall','dias'] },
  { canonical: 'Westmoreland',  match: ['westmoreland','savanna-la-mar','savanna la mar','sav-la-mar','sav la mar','negril','whitehouse','frome','petersfield','bluefields','darliston','grange hill'] },
  { canonical: 'St. Elizabeth', match: ['st. elizabeth','st elizabeth','saint elizabeth','black river','santa cruz','malvern','treasure beach','balaclava','southfield','lacovia','pedro plains'] },
  { canonical: 'Manchester',    match: ['manchester','mandeville','christiana','porus','spalding','mile gully','spur tree','williamsfield'] },
  { canonical: 'Clarendon',     match: ['clarendon','may pen','lionel town','chapelton','frankfield','smithville','hayes','kellits','toll gate'] },
];

function normalise(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(r => {
    const cat  = ['Vacancies','Real Estate','Vehicles','Notices'].includes(r.cat) ? r.cat : 'Notices';
    const allowed = VALID_TYPES[cat] || [];
    const type = allowed.includes(r.type) ? r.type : (allowed[0] || 'General');
    let parish = r.parish || '';
    if (!parish) {
      const hay = ((r.title || '') + ' ' + (r.notes || '') + ' ' + (r.loc || '')).toLowerCase();
      const match = PARISH_ALIASES.find(p => p.match.some(alias => hay.includes(alias)));
      parish = match ? match.canonical : '';
    }
    // Normalise items array if present
    let items = null;
    if (Array.isArray(r.items) && r.items.length > 0) {
      items = r.items.map(it => ({
        desc:       it.desc       || it.description || '',
        price_text: it.price_text || '—',
        price_jmd:  typeof it.price_jmd === 'number' ? it.price_jmd : null,
      })).filter(it => it.desc);
      if (items.length === 0) items = null;
    }

    // If items exist, derive top-level price from the lowest item price
    const itemPrices = items ? items.map(it => it.price_jmd).filter(p => p !== null) : [];
    const derivedPrice = itemPrices.length > 0 ? Math.min(...itemPrices) : null;

    return {
      cat,
      type,
      title:      r.title      || '(untitled)',
      loc:        r.loc        || '',
      parish,
      price_text: r.price_text || '—',
      price_jmd:  items ? derivedPrice : (typeof r.price_jmd === 'number' ? r.price_jmd : null),
      notes:      r.notes      || '',
      contact:    cleanContact(r.contact || ''),
      ...(items ? { items } : {}),
      grid_id:    typeof r.grid_id === 'string' ? r.grid_id : '',
    };
  });
}

/* ── Deduplication ── */
function mergeDedup(existing, incoming) {
  const key  = r => norm(r.title) + '|' + norm(contactStr(r.contact));
  const seen = new Set(existing.map(key));
  const fresh = incoming.filter(r => {
    const k = key(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return [...existing, ...fresh];
}
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);

/* ── Patch / flag helpers ── */
function getFlaggedRecords(records) {
  return records
    .filter(r => contactEmpty(r.contact))
    .map(r => ({ title: r.title, grid_id: r.grid_id }));
}

function applyContactPatches(records, patches) {
  const map = {};
  patches.forEach(p => { if (p.grid_id) map[p.grid_id] = p.contact; });
  return records.map(r =>
    (r.grid_id && map[r.grid_id] && contactEmpty(r.contact))
      ? { ...r, contact: cleanContact(map[r.grid_id]) }
      : r
  );
}

function safeParsePatches(raw) {
  const tryParse = str => {
    try { const a = JSON.parse(str); return Array.isArray(a) ? a : null; } catch { return null; }
  };
  return tryParse(raw)
    || tryParse(raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim())
    || (() => {
         const s = raw.indexOf('['), e = raw.lastIndexOf(']');
         return (s !== -1 && e > s) ? tryParse(raw.slice(s, e + 1)) : null;
       })()
    || [];
}

/* ── Render output ── */
function renderOutput(records) {
  if (typeof repairPrices === 'function') repairPrices(allRecords);
  emptyState.style.display  = 'none';
  statsRow.style.display    = '';
  outputSec.style.display   = '';

  previewTbody.innerHTML = records.map((r, i) => `
    <tr>
      <td style="color:var(--muted)">${i + 1}</td>
      <td>${esc(r.cat)}</td>
      <td><span class="tbadge tbadge-${r.type.replace(/\//g,'-')}">${esc(r.type)}</span></td>
      <td>${esc(r.title)}</td>
      <td style="white-space:nowrap;color:var(--muted)">${esc(r.parish)}</td>
      <td class="price">${esc(r.price_jmd != null ? r.price_jmd.toLocaleString() : (r.price_text || '—'))}${r.price_neg ? ' <span class="neg-badge">neg</span>' : ''}</td>
      <td class="notes">${esc(r.notes.slice(0, 90))}${r.notes.length > 90 ? '…' : ''}</td>
      <td style="color:var(--muted);white-space:nowrap">${esc(contactStr(r.contact))}</td>
    </tr>`).join('');

  const outputObj = buildOutputJSON(records);
  const pretty    = JSON.stringify(outputObj, null, 2);
  jsonPreview.innerHTML = syntaxHighlight(pretty);
  document.getElementById('json-lines-label').textContent =
    `${pretty.split('\n').length} lines · ${records.length} records · ${formatBytes(new Blob([pretty]).size)}`;
}

function buildOutputJSON(records) {
  const src   = document.getElementById('meta-source').value  || 'Sunday Gleaner';
  const ed    = document.getElementById('meta-edition').value || '';
  const pages = document.getElementById('meta-pages').value   || '';
  return {
    meta: {
      source:        src,
      edition:       ed,
      pages:         pages,
      sections:      [...new Set(records.map(r => r.cat))],
      extracted_at:   new Date().toISOString(),
      total_records:  records.length,
    },
    records: records.map((r, i) => { const { grid_id, _page, ...rest } = r; return { id: i + 1, ...rest }; })
  };
}

/* ── Stats ── */
function updateStats(records) {
  document.getElementById('stat-jobs').textContent     = records.filter(r => r.cat === 'Vacancies').length;
  document.getElementById('stat-re').textContent       = records.filter(r => r.cat === 'Real Estate').length;
  document.getElementById('stat-vehicles').textContent = records.filter(r => r.cat === 'Vehicles').length;
  document.getElementById('stat-notices').textContent  = records.filter(r => r.cat === 'Notices').length;
  document.getElementById('stat-total').textContent    = getActiveRecords().length;
}

/* ── Category toggle clicks ── */
document.querySelectorAll('.stat-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const cat = btn.dataset.cat;
    if (activeCats.has(cat)) activeCats.delete(cat);
    else                     activeCats.add(cat);
    btn.classList.toggle('active', activeCats.has(cat));
    updateStats(allRecords);
    if (allRecords.length) renderOutput(getActiveRecords());
  });
});

/* ── Save to Viewer ── */
const saveBtn = document.getElementById('save-btn');
saveBtn.addEventListener('click', () => {
  if (!allRecords.length) return;
  const obj = buildOutputJSON(getActiveRecords());
  saveBtn.disabled = true;
  try {
    localStorage.setItem('gleaner_classifieds', JSON.stringify(obj));
    const count = getActiveRecords().length;
    saveBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="2,8 6,12 14,4"/></svg> Saved — ${count} records`;
    setTimeout(() => {
      saveBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2v8"/><polyline points="5,7 8,10 11,7"/><rect x="2" y="11" width="12" height="3" rx="1"/></svg> Save to Viewer`;
      saveBtn.disabled = false;
    }, 3000);
  } catch (e) {
    saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2L14.5 13.5H1.5Z"/><line x1="8" y1="7" x2="8" y2="10"/><circle cx="8" cy="12.5" r="0.5" fill="currentColor"/></svg> ${esc(e.message)}`;
    saveBtn.disabled = false;
  }
});

/* ── Download ── */
downloadBtn.addEventListener('click', () => {
  if (!allRecords.length) return;
  const obj  = buildOutputJSON(getActiveRecords());
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const ed   = (document.getElementById('meta-edition').value || 'classifieds').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  triggerDownload(blob, `gleaner_${ed}.json`);
});

copyBtn.addEventListener('click', () => {
  const text = JSON.stringify(buildOutputJSON(getActiveRecords()), null, 2);
  navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = '✓ Copied';
    setTimeout(() => copyBtn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M5 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"/></svg> Copy`, 1800);
  });
});

/* ── UI helpers ── */
function setStatus(msg, type = '', spinner = false) {
  statusBar.className = 'status-bar' + (type ? ' ' + type : '');
  statusBar.innerHTML = (spinner ? '<div class="spinner"></div>' : '') + `<span>${esc(msg)}</span>`;
}

function setPassState(key, state, meta) {
  const el     = document.getElementById(`pass-${key}`);
  const metaEl = document.getElementById(`pass-meta-${key}`);
  if (!el) return;
  const optional = el.classList.contains('optional');
  el.className = `pass-item ${state}` + (optional && state === 'waiting' ? ' optional' : '');
  if (state !== 'waiting') el.classList.remove('optional');
  const dot = el.querySelector('.pass-dot');
  dot.textContent = state === 'done' ? '✓' : state === 'error' ? '✕' : state === 'skipped' ? '—' : '·';
  if (metaEl) metaEl.textContent = meta || '';
}

function appendPassLog(key, text) {
  const logEl = document.getElementById(`pass-log-${key}`);
  if (!logEl) return;
  logEl.style.display = '';
  logEl.textContent = text;
}

function syntaxHighlight(json) {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, m => {
      if (/^"/.test(m)) return /:$/.test(m) ? `<span class="jk">${m}</span>` : `<span class="js">${m}</span>`;
      if (/null/.test(m)) return `<span class="jn">${m}</span>`;
      return `<span class="ji">${m}</span>`;
    });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = e => res(e.target.result.split(',')[1]);
    r.onerror = () => rej(new Error('FileReader error'));
    r.readAsDataURL(file);
  });
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function guessDate(filename) {
  const m = filename.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return '';
  const d = new Date(m[1], m[2] - 1, m[3]);
  return d.toLocaleDateString('en-JM', { year: 'numeric', month: 'long', day: 'numeric' });
}
