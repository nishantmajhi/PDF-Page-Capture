'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, originalSource, settle } = require('./harness');

const MINUTE = 60 * 1000;
const SELECTORS = { parentSelector: '.pdf-viewer', zoomInSelector: 'a', zoomOutSelector: 'b', zoomValSelector: 'c' };

// What version 1.0 left in storage when a capture was cut short: there is no
// timestamp and no run id, and capturedPages is null until the very end.
const V1_STUCK = {
  pdfCapturerState: {
    status: 'capturing',
    captureScale: 1,
    targetPercent: 100,
    progress: 2,
    total: 20,
    logs: [{ text: 'page 2 captured', level: 'ok' }],
    capturedPages: null,
    filenameSuggestion: null,
    errorMessage: null,
  },
};

function running(overrides = {}) {
  return {
    pdfCapturerState: {
      status: 'capturing',
      captureId: 'run-1',
      captureScale: 1,
      targetPercent: 100,
      achievedPercent: null,
      progress: 3,
      total: 10,
      logs: [],
      tabTitle: 'Notes · Someone',
      filenameSuggestion: null,
      errorMessage: null,
      lastActivity: Date.now(),
      ...overrides,
    },
  };
}

/* Start a capture and hand back its run id once the page has been injected. */
async function start(bg, scale = 1) {
  await bg.send({ type: 'start-capture', captureScale: scale, zoomSelectors: SELECTORS });
  await settle();
  const call = bg.calls.executeScript.at(-1);
  return call.args[0];
}

test('regression: a browser restart ends a capture the last session left running', async () => {
  const bg = loadBackground({ stored: running() });
  bg.chrome.runtime.onStartup.fire();
  await settle();
  assert.equal(bg.stored().status, 'error');
  assert.match(bg.stored().errorMessage, /browser was closed/);
});

test('regression: original — a restart left the capture running for good', async () => {
  const bg = loadBackground({ source: originalSource('background.js'), stored: V1_STUCK });
  bg.chrome.runtime.onStartup.fire();
  await settle();
  const reply = await bg.send({ type: 'get-state' });
  assert.equal(reply.status, 'capturing');
  await bg.send({ type: 'start-capture', captureScale: 1, zoomSelectors: SELECTORS });
  await settle();
  assert.equal(bg.calls.executeScript.length, 0, 'the original started a new capture');
});

test('regression: an update or reload of the extension ends a running capture', async () => {
  const bg = loadBackground({ stored: running() });
  bg.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  assert.equal(bg.stored().status, 'error');
});

test('regression: a capture nothing has heard from in over a minute is reported as interrupted', async () => {
  const bg = loadBackground({ stored: running({ lastActivity: Date.now() - 2 * MINUTE }) });
  const reply = await bg.send({ type: 'get-state' });
  assert.equal(reply.status, 'error');
  assert.match(reply.errorMessage, /interrupted/);
});

test('regression: a capture version 1.0 left stuck is released on upgrade', async () => {
  const bg = loadBackground({ stored: V1_STUCK });
  const reply = await bg.send({ type: 'get-state' });
  assert.equal(reply.status, 'error');
  assert.equal('capturedPages' in reply, false);
  await bg.send({ type: 'start-capture', captureScale: 1, zoomSelectors: SELECTORS });
  await settle();
  assert.equal(bg.calls.executeScript.length, 1, 'a new capture did not start');
});

test('a capture that is still reporting is left alone', async () => {
  const bg = loadBackground({ stored: running({ lastActivity: Date.now() - 20 * 1000 }) });
  await settle();
  const reply = await bg.send({ type: 'get-state' });
  assert.equal(reply.status, 'capturing');
  await bg.send({ type: 'start-capture', captureScale: 2, zoomSelectors: SELECTORS });
  await settle();
  assert.equal(bg.calls.executeScript.length, 0, 'a second capture started on top of the first');
});

// Not a regression: in Chrome the storage read wins this race in practice
// (checked: a popup reopened after the worker idled out shows the capture).
// The handlers wait for it anyway, since nothing guarantees the order.
test('the message that wakes the worker is handled against the stored state', async () => {
  // storage is slow to answer; the page's message arrives first
  const bg = loadBackground({ stored: running({ progress: 3 }), storageDelay: 30 });
  const reply = await bg.send({ type: 'pdf-capture-page', captureId: 'run-1', page: 4, total: 10, ok: true, dataUrl: 'data:,4', width: 10, height: 14 });
  assert.deepEqual(reply, { ok: true });
  assert.equal(bg.state().progress, 4);
  assert.equal(bg.state().captureId, 'run-1');
  assert.equal(bg.pageStore.rows.get(4).dataUrl, 'data:,4');
});

test('a whole capture: pages are stored apart from the state, and the popup hears counts only', async () => {
  const bg = loadBackground();
  await settle();
  const id = await start(bg, 2);
  await bg.send({ type: 'pdf-capture-zoom', captureId: id, target: 200, ok: true, original: 60, current: 200 });
  for (let p = 1; p <= 3; p++) {
    const ok = p !== 2;
    const reply = await bg.send({ type: 'pdf-capture-page', captureId: id, page: p, total: 3, ok, ...(ok ? { dataUrl: `data:,${p}`, width: 800, height: 1000 + p } : {}) });
    assert.deepEqual(reply, { ok: true });
  }
  await bg.send({ type: 'pdf-capture-complete', captureId: id, results: [{ page: 1, ok: true }, { page: 2, ok: false }, { page: 3, ok: true }] });
  await settle();

  const s = bg.stored();
  assert.equal(s.status, 'done');
  assert.equal(s.progress, 2);
  assert.equal(s.total, 3);
  assert.equal(s.filenameSuggestion, 'Fixture - 2x');
  assert.deepEqual(s.logs.slice(-2).map((l) => l.text), ['done — 2 of 3 pages captured', 'skipped: 2']);
  assert.equal(JSON.stringify(bg.storage).includes('data:,'), false, 'page images reached chrome.storage');
  assert.equal(JSON.stringify(bg.calls.toPopup).includes('data:,'), false, 'page images were sent to the popup');
  assert.deepEqual([...bg.pageStore.rows.keys()], [1, 2, 3]);
  assert.equal(bg.calls.toPopup.filter((m) => m.type === 'pdf-capture-progress').length, 3);
  assert.equal(bg.calls.toPopup.at(-1).type, 'pdf-capture-finished');
});

test('the suggested name gives the zoom reached, or none when the zoom display was not found', async () => {
  const bg = loadBackground();
  await settle();
  let id = await start(bg, 2);
  await bg.send({ type: 'pdf-capture-zoom', captureId: id, target: 200, ok: false, original: 60, current: 300 });
  await bg.send({ type: 'pdf-capture-page', captureId: id, page: 1, total: 1, ok: true, dataUrl: 'data:,', width: 1, height: 1 });
  await bg.send({ type: 'pdf-capture-complete', captureId: id, results: [{ page: 1, ok: true }] });
  assert.equal(bg.stored().filenameSuggestion, 'Fixture - 3x');

  id = await start(bg, 2);
  await bg.send({ type: 'pdf-capture-zoom', captureId: id, target: 200, ok: false, original: null, current: null, error: 'zoom value element not found' });
  await bg.send({ type: 'pdf-capture-page', captureId: id, page: 1, total: 1, ok: true, dataUrl: 'data:,', width: 1, height: 1 });
  await bg.send({ type: 'pdf-capture-complete', captureId: id, results: [{ page: 1, ok: true }] });
  assert.equal(bg.stored().filenameSuggestion, 'Fixture');
});

test('messages from a run that is no longer current are refused, and tell the page to stop', async () => {
  const bg = loadBackground();
  await settle();
  const id = await start(bg);
  const reply = await bg.send({ type: 'pdf-capture-page', captureId: 'some-older-run', page: 9, total: 9, ok: true, dataUrl: 'data:,', width: 1, height: 1 });
  assert.deepEqual(reply, { stop: true });
  assert.equal(bg.state().progress, 0);
  assert.equal(bg.pageStore.rows.size, 0);

  await bg.send({ type: 'clear-state' });
  assert.deepEqual(await bg.send({ type: 'pdf-capture-page', captureId: id, page: 1, total: 1, ok: true }), { stop: true });
});

test('a page that cannot be stored fails the capture and stops the page', async () => {
  const bg = loadBackground();
  await settle();
  const id = await start(bg);
  bg.pageStore.failNextPut = new Error('QuotaExceededError');
  const reply = await bg.send({ type: 'pdf-capture-page', captureId: id, page: 1, total: 4, ok: true, dataUrl: 'data:,', width: 1, height: 1 });
  assert.deepEqual(reply, { stop: true });
  assert.equal(bg.stored().status, 'error');
  assert.match(bg.stored().errorMessage, /could not store page 1: QuotaExceededError/);
});

test('every page failing is an error, as before', async () => {
  const bg = loadBackground();
  await settle();
  const id = await start(bg);
  await bg.send({ type: 'pdf-capture-page', captureId: id, page: 1, total: 1, ok: false });
  await bg.send({ type: 'pdf-capture-complete', captureId: id, results: [{ page: 1, ok: false }] });
  assert.equal(bg.stored().status, 'error');
  assert.equal(bg.stored().errorMessage, 'no pages rendered successfully — try again');
});

test('the page reporting failure, the injection failing, and the page saying nothing are all errors', async () => {
  let bg = loadBackground();
  await settle();
  let id = await start(bg);
  await bg.send({ type: 'pdf-capture-failed', captureId: id, error: 'the page was closed or navigated away during the capture' });
  assert.equal(bg.stored().status, 'error');
  assert.match(bg.stored().errorMessage, /navigated away/);

  bg = loadBackground();
  await settle();
  bg.setExecuteScript(() => Promise.reject(new Error('Cannot access contents of the page.')));
  await start(bg);
  assert.equal(bg.stored().errorMessage, 'Cannot access contents of the page.');

  bg = loadBackground();
  await settle();
  bg.setExecuteScript(() => Promise.resolve([{ result: undefined }]));
  await start(bg);
  assert.equal(bg.stored().errorMessage, 'no result returned from the page');
});

test('the injected function is passed its run id, and captureScale becomes the target percent', async () => {
  const bg = loadBackground();
  await settle();
  const id = await start(bg, 0.5);
  const call = bg.calls.executeScript[0];
  assert.equal(call.target.tabId, 7);
  assert.equal(typeof id, 'string');
  assert.deepEqual(call.args.slice(1), [50, SELECTORS]);
  assert.equal(bg.state().captureId, id);
});

test('clear-state empties the page store', async () => {
  const bg = loadBackground();
  await settle();
  const id = await start(bg);
  await bg.send({ type: 'pdf-capture-page', captureId: id, page: 1, total: 1, ok: true, dataUrl: 'data:,', width: 1, height: 1 });
  await bg.send({ type: 'pdf-capture-complete', captureId: id, results: [{ page: 1, ok: true }] });
  assert.equal(bg.pageStore.rows.size, 1);
  await bg.send({ type: 'clear-state' });
  assert.equal(bg.pageStore.rows.size, 0);
  assert.equal(bg.stored().status, 'idle');
});

test('messages the worker does not handle are left for the popup', async () => {
  const bg = loadBackground();
  await settle();
  const reply = await bg.send({ type: 'pdf-capture-progress', page: 1, total: 1, ok: true });
  assert.equal(reply, undefined);
});
