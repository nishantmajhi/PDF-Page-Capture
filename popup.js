const captureBtn = document.getElementById('captureBtn');
const captureBtnLabel = document.getElementById('captureBtnLabel');
const scanStage = document.getElementById('scanStage');
const counterEl = document.getElementById('counter');
const logPanel = document.getElementById('logPanel');
const filenameStep = document.getElementById('filenameStep');
const filenameInput = document.getElementById('filenameInput');
const saveBtn = document.getElementById('saveBtn');
const scaleRow = document.getElementById('scaleRow');
const scaleHint = document.getElementById('scaleHint');
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const gearBtn = document.getElementById('gearBtn');
const backBtn = document.getElementById('backBtn');
const parentInput = document.getElementById('parentInput');
const zoomInInput = document.getElementById('zoomInInput');
const zoomOutInput = document.getElementById('zoomOutInput');
const zoomValInput = document.getElementById('zoomValInput');
const resetSelectorsBtn = document.getElementById('resetSelectorsBtn');
const selectorSaved = document.getElementById('selectorSaved');

const { pdfFilename, planPdfPages, PageStore } = window.PdfCapturer;

// The finished capture, synced from background. The page images themselves
// are read from PageStore only when Save is pressed.
let capturedPages = null; // { captureId, total } once capture finishes
let captureScale = 1;

// Tell the background worker this popup is open — it uses this to decide
// whether to fire a system notification (no point notifying someone who's
// already looking at the live progress in the popup).
chrome.runtime.connect({ name: 'popup' });

// Defaults match the viewer's current markup:
//   <div class="pdf-viewer"> ... </div>
//   <button class="viewer-zoom-btn" title="Zoom in">
//   <button class="viewer-zoom-btn" title="Zoom out">
//   <span class="viewer-zoom-val mono">60%</span>
// All four are plain CSS selectors, so any combination of class/attribute
// works. zoomIn/zoomOut/zoomVal are looked up INSIDE the parent container
// first (falling back to the whole document if the parent isn't found).
// If the page's classes change, update the fields in Settings — the change
// is saved to chrome.storage and used from then on, no extension update needed.
const DEFAULT_ZOOM_SELECTORS = {
  parentSelector: '.pdf-viewer',
  zoomInSelector: '.viewer-zoom-btn[title="Zoom in"]',
  zoomOutSelector: '.viewer-zoom-btn[title="Zoom out"]',
  zoomValSelector: '.viewer-zoom-val.mono',
};
const ZOOM_SELECTORS_STORAGE_KEY = 'pdfCapturerZoomSelectors';

function getZoomSelectorsFromInputs() {
  return {
    parentSelector: parentInput.value.trim() || DEFAULT_ZOOM_SELECTORS.parentSelector,
    zoomInSelector: zoomInInput.value.trim() || DEFAULT_ZOOM_SELECTORS.zoomInSelector,
    zoomOutSelector: zoomOutInput.value.trim() || DEFAULT_ZOOM_SELECTORS.zoomOutSelector,
    zoomValSelector: zoomValInput.value.trim() || DEFAULT_ZOOM_SELECTORS.zoomValSelector,
  };
}

function applyZoomSelectorsToInputs(selectors) {
  parentInput.value = selectors.parentSelector;
  zoomInInput.value = selectors.zoomInSelector;
  zoomOutInput.value = selectors.zoomOutSelector;
  zoomValInput.value = selectors.zoomValSelector;
}

function flashSaved() {
  selectorSaved.classList.add('show');
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => selectorSaved.classList.remove('show'), 1200);
}

function saveZoomSelectors() {
  const selectors = getZoomSelectorsFromInputs();
  chrome.storage.local.set({ [ZOOM_SELECTORS_STORAGE_KEY]: selectors }, flashSaved);
}

chrome.storage.local.get([ZOOM_SELECTORS_STORAGE_KEY], (data) => {
  applyZoomSelectorsToInputs({ ...DEFAULT_ZOOM_SELECTORS, ...(data[ZOOM_SELECTORS_STORAGE_KEY] || {}) });
});

[parentInput, zoomInInput, zoomOutInput, zoomValInput].forEach((input) => {
  input.addEventListener('change', saveZoomSelectors);
});

resetSelectorsBtn.addEventListener('click', () => {
  applyZoomSelectorsToInputs(DEFAULT_ZOOM_SELECTORS);
  saveZoomSelectors();
});

function showSettings() {
  mainView.hidden = true;
  settingsView.hidden = false;
}

function showMain() {
  settingsView.hidden = true;
  mainView.hidden = false;
}

gearBtn.addEventListener('click', showSettings);
backBtn.addEventListener('click', showMain);

const SCALE_HINTS = {
  0.5: 'Smallest file, fastest scan',
  1: 'Standard resolution',
  2: 'Sharper text, ~4× file size',
  3: 'Maximum sharpness, larger file & slower scan',
};

function setScaleUI(scale) {
  captureScale = scale;
  [...scaleRow.children].forEach((c) => c.classList.toggle('active', Number(c.dataset.scale) === scale));
  scaleHint.textContent = SCALE_HINTS[scale];
}

scaleRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.scale-option');
  if (!btn || captureBtn.disabled) return;
  setScaleUI(Number(btn.dataset.scale));
});

function setStage(s) {
  scanStage.dataset.state = s;
}

function setCounter(text) {
  counterEl.textContent = text;
}

function log(text, level) {
  const line = document.createElement('span');
  line.className = 'log-line' + (level ? ` log-${level}` : '');
  line.textContent = text;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function clearLog() {
  logPanel.innerHTML = '';
}

// The actual capture now runs in background.js so it survives the popup
// losing focus/closing (Chrome tears down all popup JS state instantly when
// that happens). This popup only ever: (1) asks background for the current
// state on open, so it can resume mid-capture or show a finished result,
// and (2) listens for live progress/completion messages while it happens
// to be open. A toolbar badge + notification cover the "popup is closed"
// and "user is on another tab" cases.
function renderFromState(state) {
  if (!state) return;

  if (typeof state.captureScale === 'number') {
    setScaleUI(state.captureScale);
  }

  clearLog();
  (state.logs || []).forEach((l) => log(l.text, l.level));

  if (state.status === 'capturing') {
    captureBtn.disabled = true;
    scaleRow.classList.add('disabled');
    captureBtnLabel.textContent = 'Scanning…';
    filenameStep.classList.remove('visible');
    capturedPages = null;
    setStage('scanning');
    setCounter(state.total ? `${String(state.progress).padStart(2, '0')} / ${state.total}` : '00 / 00');
  } else if (state.status === 'done') {
    captureBtn.disabled = false;
    scaleRow.classList.remove('disabled');
    captureBtnLabel.textContent = 'Capture pages';
    capturedPages = { captureId: state.captureId, total: state.total };
    setStage('done');
    setCounter(`${state.progress} / ${state.total}`);
    filenameInput.value = state.filenameSuggestion || 'captured';
    filenameStep.classList.add('visible');
  } else if (state.status === 'error') {
    captureBtn.disabled = false;
    scaleRow.classList.remove('disabled');
    captureBtnLabel.textContent = 'Capture pages';
    capturedPages = null;
    filenameStep.classList.remove('visible');
    setStage('error');
    setCounter('ERROR');
  } else {
    captureBtn.disabled = false;
    scaleRow.classList.remove('disabled');
    captureBtnLabel.textContent = 'Capture pages';
    capturedPages = null;
    filenameStep.classList.remove('visible');
    setStage('idle');
    setCounter('READY');
  }
}

// Sync with whatever background is doing right now (mid-capture, just
// finished, or idle) the moment the popup opens.
chrome.runtime.sendMessage({ type: 'get-state' }, (state) => {
  if (chrome.runtime.lastError) return; // background not ready yet — fine, next event will sync
  renderFromState(state);
});

// Live updates while the popup happens to be open.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'pdf-capture-zoom') {
    if (msg.parentFallback) log(msg.parentFallback, 'warn');
    if (msg.ok) {
      log(`viewer zoom set to ${msg.target}%`, 'ok');
    } else if (msg.error) {
      log(`zoom warning: ${msg.error}${msg.current != null ? ` (stuck at ${msg.current}%)` : ''}`, 'warn');
    } else if (msg.current != null) {
      log(`viewer zoom reached ${msg.current}% (target was ${msg.target}%)`, 'warn');
    }
    return;
  }

  if (msg?.type === 'pdf-capture-progress') {
    setCounter(`${String(msg.page).padStart(2, '0')} / ${msg.total}`);
    if (msg.ok) {
      log(`page ${msg.page} captured`, 'ok');
    } else {
      log(`page ${msg.page} skipped (render timeout)`, 'warn');
    }
    return;
  }

  if (msg?.type === 'pdf-capture-finished') {
    renderFromState(msg.state);
    if (msg.state?.status === 'done') {
      filenameInput.focus();
      filenameInput.select();
    }
  }
});

captureBtn.addEventListener('click', () => {
  captureBtn.disabled = true;
  scaleRow.classList.add('disabled');
  captureBtnLabel.textContent = 'Scanning…';
  filenameStep.classList.remove('visible');
  capturedPages = null;
  clearLog();
  setStage('scanning');
  setCounter('00 / 00');

  chrome.runtime.sendMessage({
    type: 'start-capture',
    captureScale,
    zoomSelectors: getZoomSelectorsFromInputs(),
  });
});

saveBtn.addEventListener('click', runSave);

filenameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!saveBtn.disabled) runSave();
  }
});

function runSave() {
  if (!capturedPages) {
    log('nothing captured yet', 'warn');
    return;
  }

  saveBtn.disabled = true;
  filenameInput.disabled = true;
  saveBtn.textContent = 'Saving…';

  // jsPDF's addImage/output work is synchronous and CPU-heavy enough to block
  // the main thread for a noticeable stretch. Setting `disabled` above only
  // queues a DOM mutation — the browser won't actually paint it until the
  // thread is free. Yield across two animation frames so the grey/disabled
  // state is guaranteed to paint BEFORE the heavy synchronous work starts.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      buildAndSavePdf();
    });
  });
}

function saveFinished() {
  saveBtn.disabled = false;
  filenameInput.disabled = false;
  saveBtn.textContent = 'Save PDF';
}

async function buildAndSavePdf() {
  const name = pdfFilename(filenameInput.value);

  try {
    const { jsPDF } = window.jspdf;
    const plan = planPdfPages(await PageStore.all(capturedPages.captureId), capturedPages.total);
    if (plan.length === 0) throw new Error('the captured pages are no longer stored — capture again');

    // Size each page to its own canvas's exact pixel dimensions — no shared
    // scale factor carried between pages, so nothing can compound or shrink.
    const first = plan[0];
    const doc = new jsPDF({
      unit: 'px',
      format: [first.width, first.height],
      orientation: first.width > first.height ? 'landscape' : 'portrait',
    });

    plan.forEach((p, idx) => {
      if (idx > 0) {
        doc.addPage([p.width, p.height], p.width > p.height ? 'landscape' : 'portrait');
      }
      if (p.kind === 'image') {
        doc.addImage(p.dataUrl, 'PNG', 0, 0, p.width, p.height);
      } else {
        // A page that never rendered keeps its place, and says so.
        doc.setFontSize(Math.max(12, Math.round(p.width / 30)));
        doc.text(`Page ${p.page} could not be captured`, p.width / 2, p.height / 2, { align: 'center' });
      }
    });

    const blob = doc.output('blob');
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({ url, filename: name, saveAs: false }, (downloadId) => {
      // Chrome refuses some names outright (CON, NUL and the other reserved
      // device names, on every platform). Then there is no download, and the
      // capture must survive for another try under a different name.
      if (chrome.runtime.lastError || downloadId === undefined) {
        URL.revokeObjectURL(url);
        log(`error saving PDF: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : 'the download did not start'}`, 'error');
        saveFinished();
        return;
      }
      revokeWhenDone(downloadId, url);
      log(`saved as "${name}"`, 'ok');
      saveFinished();
      capturedPages = null;
      filenameStep.classList.remove('visible');
      setStage('idle');
      setCounter('READY');
      chrome.runtime.sendMessage({ type: 'clear-state' });
    });
  } catch (err) {
    log(`error building PDF: ${err.message}`, 'error');
    saveFinished();
  }
}

// The callback above runs when the download starts, which need not be after
// the blob has been read, so the URL goes once the download has finished or
// failed.
function revokeWhenDone(downloadId, url) {
  const listener = (delta) => {
    if (delta.id !== downloadId || !delta.state || delta.state.current === 'in_progress') return;
    URL.revokeObjectURL(url);
    chrome.downloads.onChanged.removeListener(listener);
  };
  chrome.downloads.onChanged.addListener(listener);
}
