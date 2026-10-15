// Shared by the service worker (importScripts) and the popup (<script>), and
// required directly by the tests. The decisions in here touch neither
// chrome.* nor the DOM; PageStore needs IndexedDB, which both extension
// contexts have, and only touches it when called.

(function (root) {
  // How long a capture may go without a message from the page before it is
  // treated as dead. The longest legitimate silence is the zoom walk at the
  // start: up to 60 clicks 200 ms apart and a 500 ms settle, about 12.5 s.
  // A page waits at most 3 s for its canvas.
  const STALE_AFTER_MS = 60 * 1000;

  // Page titles often look like "Introduction to Operating System · Author".
  // Keep only the part before the first " · " separator, then tag with the
  // zoom the pages were actually captured at, which is not always the one
  // asked for. Unknown (the zoom display was not found) means no tag.
  function buildDefaultFilename(rawTitle, achievedPercent) {
    const base = (rawTitle || 'captured').split(' · ')[0].trim();
    const safeBase = base.replace(/[\\/:*?"<>|]/g, '_') || 'captured';
    return achievedPercent == null ? safeBase : `${safeBase} - ${achievedPercent / 100}x`;
  }

  function pdfFilename(input) {
    let name = (input || '').trim() || 'captured';
    name = name.replace(/[\\/:*?"<>|]/g, '_');
    if (!name.toLowerCase().endsWith('.pdf')) {
      name += '.pdf';
    }
    return name;
  }

  // A capture still marked as running that nothing has heard from in a while.
  // A state with no timestamp at all was written by version 1.0, which could
  // leave 'capturing' behind for good; that is stale too.
  function isStale(state, now) {
    if (!state || state.status !== 'capturing') return false;
    return typeof state.lastActivity !== 'number' || now - state.lastActivity > STALE_AFTER_MS;
  }

  // One entry per page of the original document, in order. A page that did
  // not render becomes a placeholder the size of its nearest captured
  // neighbour, so the PDF keeps the document's page numbering and says where
  // the gaps are rather than silently closing them up.
  function planPdfPages(records, total) {
    const byPage = new Map();
    for (const r of records || []) {
      if (r && r.ok && r.width > 0 && r.height > 0) byPage.set(r.page, r);
    }
    const count = Math.max(total || 0, ...[...byPage.keys()], 0);
    const plan = [];
    for (let page = 1; page <= count; page++) {
      const r = byPage.get(page);
      if (r) {
        plan.push({ kind: 'image', page, width: r.width, height: r.height, dataUrl: r.dataUrl });
        continue;
      }
      let near = null;
      for (let d = 1; d < count && !near; d++) {
        near = byPage.get(page - d) || byPage.get(page + d) || null;
      }
      if (!near) return [];
      plan.push({ kind: 'placeholder', page, width: near.width, height: near.height });
    }
    return plan;
  }

  // Page images live in IndexedDB, keyed by page number, one capture at a
  // time. They used to ride in the worker's state object, which went whole
  // into chrome.storage and into every message; Chrome refuses a message over
  // 64 MiB, so a large capture finished in the worker and could never reach
  // the popup to be saved.
  const DB_NAME = 'pdfCapturer';
  const STORE = 'pages';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'page' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      });
    } finally {
      db.close();
    }
  }

  const PageStore = {
    put: (record) => withStore('readwrite', (s) => s.put(record)),
    clear: () => withStore('readwrite', (s) => s.clear()),
    async all(captureId) {
      const rows = (await withStore('readonly', (s) => s.getAll())) || [];
      return rows.filter((r) => r.captureId === captureId).sort((a, b) => a.page - b.page);
    },
  };

  const api = { STALE_AFTER_MS, buildDefaultFilename, pdfFilename, isStale, planPdfPages, PageStore };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PdfCapturer = api;
})(typeof self !== 'undefined' ? self : this);
