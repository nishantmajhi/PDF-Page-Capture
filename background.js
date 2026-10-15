// Background service worker — owns the actual capture run so it survives the
// popup closing (Chrome destroys all popup JS state the instant it loses
// focus). The popup becomes a thin UI that starts a capture and either
// watches it live (if kept open) or re-syncs from here when reopened.
// A toolbar badge + system notification give feedback even if the popup
// never reopens right away and even while the user is on another tab.
//
// The run is driven by messages from the page, not by the return value of
// executeScript: the worker can be stopped at any point in a long capture,
// and the next message from the page starts it again with its state read
// back from storage. Page images go straight into IndexedDB (PageStore, in
// common.js); the state object carries only counters and the log.

importScripts('common.js');

const { buildDefaultFilename, isStale, PageStore } = self.PdfCapturer;

const STORAGE_KEY = 'pdfCapturerState';
const BADGE_CAPTURING = '#b45309';
const BADGE_DONE = '#0d9488';
const BADGE_ERROR = '#dc2626';

function freshState() {
  return {
    status: 'idle', // idle | capturing | done | error
    captureId: null, // names the current run; messages from any other are refused
    captureScale: 1,
    targetPercent: null,
    achievedPercent: null, // the zoom the pages were actually captured at
    progress: 0,
    total: 0,
    logs: [], // { text, level }
    tabTitle: null,
    filenameSuggestion: null,
    errorMessage: null,
    lastActivity: null, // when the page last reported; see isStale
  };
}

let state = freshState();
let popupOpen = false;

// Rehydrate from storage when the service worker wakes up (it can be
// unloaded and recreated at any time between events). Every handler waits
// for this: the message that woke the worker must not be handled against
// a blank state and then overwritten by the stored one.
const ready = new Promise((resolve) => {
  chrome.storage.local.get([STORAGE_KEY], (data) => {
    const stored = data && data[STORAGE_KEY];
    if (stored) {
      // Version 1.0 kept the page images here, and its runs report nothing
      // this version listens for. Keep nothing but a dead run's outcome.
      if ('capturedPages' in stored) {
        state = stored.status === 'capturing' ? { ...freshState(), status: 'capturing' } : freshState();
        persist();
      } else {
        state = { ...freshState(), ...stored };
      }
    }
    reflectBadge();
    resolve();
  });
});

function persist() {
  chrome.storage.local.set({ [STORAGE_KEY]: state }, () => {
    if (chrome.runtime.lastError) {
      console.warn('PDF Page Capturer: could not persist state —', chrome.runtime.lastError.message);
    }
  });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function reflectBadge() {
  if (state.status === 'capturing') {
    setBadge(state.progress ? String(state.progress) : '…', BADGE_CAPTURING);
  } else if (state.status === 'done') {
    setBadge('✓', BADGE_DONE);
  } else if (state.status === 'error') {
    setBadge('!', BADGE_ERROR);
  } else {
    setBadge('', null);
  }
}

function notifyIfAway(message) {
  if (popupOpen) return; // user is already watching it happen
  const id = `pdf-capturer-${Date.now()}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'PDF Page Capturer',
    message,
    priority: 1,
  });
}

// To the popup, if one is open. Nothing here carries page images, so no
// message comes near Chrome's 64 MiB limit.
function tellPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // no popup listening right now — that's fine, it'll pull state on open
  });
}

function broadcastFinished() {
  tellPopup({ type: 'pdf-capture-finished', state });
}

function failCapture(message) {
  state.status = 'error';
  state.errorMessage = message;
  state.logs.push({ text: `error: ${message}`, level: 'error' });
  persist();
  setBadge('!', BADGE_ERROR);
  notifyIfAway(`Capture failed: ${message}`);
  broadcastFinished();
}

// A run still marked as capturing that no page will ever finish: the browser
// was closed, or the tab died along with the worker. Without this the popup
// showed "Scanning…" with Capture disabled for good, across restarts.
function expireIfStale() {
  if (isStale(state, Date.now())) {
    failCapture('the capture was interrupted before it finished — start it again');
  }
}

// Track whether the popup is currently open via a long-lived port, so we
// only fire a system notification when the user isn't already looking at
// the popup's own live progress.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupOpen = true;
  port.onDisconnect.addListener(() => {
    popupOpen = false;
  });
});

// A new browser session, or a new version of the extension: either way no
// page is still capturing for us. A script injected by the previous version
// lost its connection when this one was installed.
function abandonRun(message) {
  ready.then(() => {
    if (state.status === 'capturing') failCapture(message);
  });
}
chrome.runtime.onStartup.addListener(() => {
  abandonRun('the browser was closed before the capture finished — start it again');
});
chrome.runtime.onInstalled.addListener(() => {
  abandonRun('the extension was updated or reloaded during the capture — start it again');
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
  if (chrome.action.openPopup) {
    chrome.action.openPopup().catch(() => {
      // Some Chrome versions/contexts don't allow programmatic opening —
      // the badge is still there as a fallback signal.
    });
  }
});

// Runs INSIDE the target page via chrome.scripting.executeScript — fully
// self-contained, and reports to the extension via chrome.runtime messaging.
// Each page goes to the worker as it is captured, and the next is not
// started until the worker has stored it, so neither the page nor the
// worker ever holds the whole capture.
//
// Instead of the browser-level chrome.tabs.setZoom (which just stretches the
// existing canvas), this drives the viewer's OWN zoom in/out controls up to
// the target percentage, which makes PDF.js actually re-render each canvas
// at the higher resolution — noticeably sharper captures. All lookups are
// scoped inside the configurable parent container (falls back to the whole
// document if that selector doesn't match anything on the page).
async function capturePdfPagesInPage(captureId, targetPercent, selectors) {
  const { parentSelector, zoomInSelector, zoomOutSelector, zoomValSelector } = selectors;

  // The worker answers each message; { stop: true } means this run is no
  // longer the current one (a new capture began, or it was abandoned).
  let stopped = false;
  async function send(msg) {
    try {
      const reply = await chrome.runtime.sendMessage({ captureId, ...msg });
      if (reply && reply.stop) stopped = true;
    } catch (e) {
      stopped = true; // the extension was reloaded or removed
    }
  }

  // Leaving the page ends the run. In the back/forward cache this script is
  // frozen rather than killed, and the injection does not fail until the
  // page is evicted, which can take minutes; say so now instead.
  const onPageHide = () => {
    send({ type: 'pdf-capture-failed', error: 'the page was closed or navigated away during the capture' });
  };
  addEventListener('pagehide', onPageHide);

  const parent = (parentSelector && document.querySelector(parentSelector)) || document;
  const usedFallbackRoot = parentSelector && parent === document;

  function readZoomPercent() {
    const el = parent.querySelector(zoomValSelector);
    if (!el) return null;
    const m = el.textContent.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  async function setZoom(target) {
    const original = readZoomPercent();
    if (original === null) {
      return { ok: false, original: null, current: null, error: `zoom value element not found for selector "${zoomValSelector}"` };
    }
    if (original === target) {
      return { ok: true, original, current: original };
    }

    let current = original;
    let guard = 0;
    let lastDirection = 0;
    const maxClicks = 60; // generous ceiling; loop also stops if value stops moving

    while (current !== target && guard < maxClicks) {
      const goingUp = current < target;
      // Stepped past the target: the viewer has no setting at it. Stay on the
      // first one beyond it rather than bouncing between the two neighbours.
      if (lastDirection && (goingUp ? 1 : -1) !== lastDirection) break;
      lastDirection = goingUp ? 1 : -1;
      const btn = parent.querySelector(goingUp ? zoomInSelector : zoomOutSelector);
      if (!btn) {
        return {
          ok: false,
          original,
          current,
          error: `zoom ${goingUp ? 'in' : 'out'} button not found for selector "${goingUp ? zoomInSelector : zoomOutSelector}"`,
        };
      }
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const next = readZoomPercent();
      if (next === null || next === current) break; // stuck (hit a limit) — stop instead of looping forever
      current = next;
      guard++;
    }

    // Let the viewer finish re-rendering its canvases at the new resolution.
    await new Promise((r) => setTimeout(r, 500));
    return { ok: current === target, original, current };
  }

  try {
    const zoomResult = await setZoom(targetPercent);
    if (usedFallbackRoot) {
      zoomResult.parentFallback = `parent selector "${parentSelector}" not found — searched the whole page instead`;
    }
    await send({ type: 'pdf-capture-zoom', target: targetPercent, ...zoomResult });

    const pages = parent.querySelectorAll('.pdf-page');

    if (pages.length === 0) {
      if (zoomResult.original !== null) await setZoom(zoomResult.original);
      await send({ type: 'pdf-capture-failed', error: 'No elements with class "pdf-page" were found inside the parent container.' });
      return;
    }

    const results = [];
    let i = 0;
    for (const page of pages) {
      if (stopped) break;
      i++;
      page.scrollIntoView({ block: 'center' });

      let canvas = page.querySelector('canvas');
      let attempts = 0;
      const maxAttempts = 10;

      while ((!canvas || canvas.width <= 1) && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 300));
        canvas = page.querySelector('canvas');
        attempts++;
      }

      const ok = !!canvas && canvas.width > 1;
      results.push({ page: i, ok });
      await send({
        type: 'pdf-capture-page',
        page: i,
        total: pages.length,
        ok,
        ...(ok ? { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height } : {}),
      });

      await new Promise((r) => setTimeout(r, 250));
    }

    // Restore the viewer's zoom to whatever it was before capture started.
    if (zoomResult.original !== null) {
      await setZoom(zoomResult.original);
    }

    if (!stopped) await send({ type: 'pdf-capture-complete', results });
  } catch (e) {
    await send({ type: 'pdf-capture-failed', error: e.message || String(e) });
  } finally {
    removeEventListener('pagehide', onPageHide);
  }
}

async function startCapture(captureScale, zoomSelectors) {
  expireIfStale();
  if (state.status === 'capturing') return; // already running, ignore duplicate triggers

  const captureId = crypto.randomUUID();
  state = {
    ...freshState(),
    status: 'capturing',
    captureId,
    captureScale,
    targetPercent: captureScale * 100,
    lastActivity: Date.now(),
    logs: [{ text: `setting viewer zoom to ${captureScale * 100}% via viewer controls…`, level: null }, { text: 'starting scan…', level: null }],
  };
  persist();
  setBadge('…', BADGE_CAPTURING);

  try {
    await PageStore.clear();
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      throw new Error('could not find the active tab');
    }
    state.tabTitle = activeTab.title;
    persist();

    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: capturePdfPagesInPage,
      args: [captureId, state.targetPercent, zoomSelectors],
    });
    // The page has reported its outcome by now, by message. If it has not,
    // it stopped without saying why.
    if (state.captureId === captureId && state.status === 'capturing') {
      throw new Error('no result returned from the page');
    }
  } catch (err) {
    if (state.captureId === captureId && state.status === 'capturing') failCapture(err.message);
  }
}

// From the page: each one is about the run named by msg.captureId.
const pageHandlers = {
  'pdf-capture-zoom'(msg) {
    if (msg.parentFallback) state.logs.push({ text: msg.parentFallback, level: 'warn' });
    if (msg.ok) {
      state.logs.push({ text: `viewer zoom set to ${msg.target}%`, level: 'ok' });
    } else if (msg.error) {
      state.logs.push({ text: `zoom warning: ${msg.error}${msg.current != null ? ` (stuck at ${msg.current}%)` : ''}`, level: 'warn' });
    } else if (msg.current != null) {
      state.logs.push({ text: `viewer zoom reached ${msg.current}% (target was ${msg.target}%)`, level: 'warn' });
    }
    state.achievedPercent = msg.current;
    persist();
  },

  async 'pdf-capture-page'(msg) {
    try {
      await PageStore.put({
        captureId: msg.captureId,
        page: msg.page,
        ok: msg.ok,
        dataUrl: msg.dataUrl || null,
        width: msg.width || 0,
        height: msg.height || 0,
      });
    } catch (err) {
      failCapture(`could not store page ${msg.page}: ${err.message}`);
      return { stop: true };
    }
    state.progress = msg.page;
    state.total = msg.total;
    state.logs.push({
      text: msg.ok ? `page ${msg.page} captured` : `page ${msg.page} skipped (render timeout)`,
      level: msg.ok ? 'ok' : 'warn',
    });
    persist();
    setBadge(String(msg.page), BADGE_CAPTURING);
    tellPopup({ type: 'pdf-capture-progress', page: msg.page, total: msg.total, ok: msg.ok });
  },

  'pdf-capture-complete'(msg) {
    const ok = msg.results.filter((r) => r.ok);
    const failed = msg.results.filter((r) => !r.ok);

    if (ok.length === 0) {
      failCapture('no pages rendered successfully — try again');
      return;
    }

    state.status = 'done';
    state.total = msg.results.length;
    state.progress = ok.length;
    state.filenameSuggestion = buildDefaultFilename(state.tabTitle, state.achievedPercent);
    state.logs.push({ text: `done — ${ok.length} of ${msg.results.length} pages captured`, level: 'ok' });
    if (failed.length > 0) {
      state.logs.push({ text: `skipped: ${failed.map((f) => f.page).join(', ')}`, level: 'warn' });
    }
    persist();
    setBadge('✓', BADGE_DONE);
    notifyIfAway(`Captured ${ok.length}/${msg.results.length} pages — click the toolbar icon to save your PDF.`);
    broadcastFinished();
  },

  'pdf-capture-failed'(msg) {
    failCapture(msg.error);
  },
};

async function handlePageMessage(msg) {
  if (msg.captureId !== state.captureId || state.status !== 'capturing') return { stop: true };
  state.lastActivity = Date.now();
  const reply = await pageHandlers[msg.type](msg);
  return reply || { ok: true };
}

// From the popup.
const popupHandlers = {
  'start-capture'(msg) {
    startCapture(msg.captureScale, msg.zoomSelectors);
    return { ok: true };
  },

  'get-state'() {
    expireIfStale();
    return state;
  },

  async 'clear-state'() {
    state = freshState();
    persist();
    setBadge('', null);
    await PageStore.clear();
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  const handle = pageHandlers[type] ? () => handlePageMessage(msg) : popupHandlers[type] && (() => popupHandlers[type](msg));
  if (!handle) return false; // someone else's message, e.g. this worker's own progress to the popup

  ready
    .then(handle)
    .then(sendResponse, (err) => {
      console.warn('PDF Page Capturer:', err);
      sendResponse({ error: err.message });
    });
  return true;
});
