#!/usr/bin/env node
'use strict';
/*
 * The extension, end to end, in real headless Chrome.
 *
 *   node tests/browser/run.js              the working copy
 *   node tests/browser/run.js --original   the code at the first commit
 *   node tests/browser/run.js --only=name  checks whose name contains `name`
 *
 * Each check loads the extension unpacked, opens tests/browser/viewer.html,
 * clicks the toolbar icon (a real click: it opens the real popup and grants
 * activeTab), presses the popup's own buttons, and reads the PDF that lands in
 * the downloads folder. See driver.js.
 *
 * `--original` extracts the first commit into .cache/ and runs the same
 * checks against it. Every check named "regression:" is expected to fail
 * there and every other check to pass, and the run says so if either is not
 * true: a regression check that passes against the original is testing
 * nothing.
 *
 * It exits 0 and prints SKIP if no Chrome is found. It takes a couple of
 * minutes: three checks capture more than 64 MiB of page images on purpose.
 */
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { findChrome } = require('./cdp');
const { Session, sleep } = require('./driver');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE = path.join(ROOT, '.cache');
const ORIGINAL = process.argv.includes('--original');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

// Six 1500 x 2000 pages of random pixels: about 79 MB as data URLs, past
// Chrome's 64 MiB limit on a single extension message.
const HUGE = 'pages=6&w=1500&h=2000&noise=1';

function extractOriginal() {
  const dir = path.join(CACHE, 'original');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const tar = execFileSync('git', ['archive', '--format=tar', first], { cwd: ROOT, maxBuffer: 1 << 28 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const heights = (pdf) => pdf.pages.map((p) => p.h);

async function captureAndWait(s, query, scale = 1, timeoutMs = 120000) {
  await s.openViewer(query);
  await s.openPopup();
  await s.capture(scale);
  return s.waitForStage(['done', 'error'], timeoutMs);
}

const checks = [];
const check = (name, fn, { ownBrowser = false } = {}) => checks.push({ name, fn, ownBrowser });

check('captures every page, in order, at the requested zoom', async (s) => {
  const sc = await captureAndWait(s, 'pages=5', 1);
  assert(sc.stage === 'done', `stage ${sc.stage}: ${sc.log.slice(-2).join(' | ')}`);
  assert(sc.filename === 'Fixture Viewer - 1x', `suggested name ${JSON.stringify(sc.filename)}`);
  const { pdf } = await s.save();
  assert(pdf, 'no file was downloaded');
  assert(JSON.stringify(heights(pdf)) === '[501,502,503,504,505]', `page heights ${heights(pdf)}`);
  assert(pdf.pages.every((p) => p.w === 400), `page widths ${pdf.pages.map((p) => p.w)}`);
  const [d] = await s.downloadList();
  assert(d && d.name === 'Fixture Viewer - 1x.pdf', `downloaded as ${JSON.stringify(d)}`);
});

check('a 2x capture renders at 200% and puts the viewer back afterwards', async (s) => {
  const sc = await captureAndWait(s, 'pages=3', 2);
  assert(sc.stage === 'done', `stage ${sc.stage}`);
  assert(sc.filename === 'Fixture Viewer - 2x', `suggested name ${JSON.stringify(sc.filename)}`);
  const { pdf } = await s.save();
  assert(pdf && pdf.pages.every((p) => p.w === 800), `page widths ${pdf && pdf.pages.map((p) => p.w)}`);
  const zoom = await s.page.eval('window.viewer.zoomHistory.at(-1)');
  assert(zoom === 60, `viewer left at ${zoom}%`);
});

check('a finished capture is still there after the worker has gone idle', async (s) => {
  await captureAndWait(s, 'pages=3', 1);
  await s.closePopup();
  // An idle MV3 worker is stopped after about 30 s. Nothing here attaches to
  // it, which would keep it alive.
  const running = async () => (await s.browser.targets()).some((t) => t.type === 'service_worker' && t.url.startsWith(s.origin));
  for (let k = 0; k < 24 && (await running()); k++) await sleep(5000);
  assert(!(await running()), 'the worker never went idle; this check needs it stopped');
  await s.openPopup();
  const sc = await s.screen();
  assert(sc.stage === 'done' && sc.saveVisible, `reopened popup shows ${sc.stage}`);
  const { pdf } = await s.save();
  assert(pdf && pdf.pages.length === 3, `PDF has ${pdf && pdf.pages.length} pages`);
});

check('regression: a capture over 64 MiB reaches the open popup', async (s) => {
  const sc = await captureAndWait(s, HUGE, 1, 30000).catch((e) => ({ stage: `none (${e.message})`, log: [] }));
  assert(sc.stage === 'done', `popup stage ${sc.stage}`);
  assert(sc.saveVisible, 'no Save button');
});

check('regression: a capture over 64 MiB can still be saved after reopening the popup', async (s) => {
  const sc = await captureAndWait(s, HUGE, 1, 60000).catch(() => null);
  // Whatever the open popup showed, a user who closes it and comes back
  // must find the capture there.
  await s.openPopup();
  const again = await s.screen();
  assert(again.stage === 'done' && again.saveVisible, `reopened popup: ${again.stage}, save ${again.saveVisible} (first popup: ${sc && sc.stage})`);
  const { pdf } = await s.save(undefined, 240000);
  assert(pdf, 'no file was downloaded');
  assert(JSON.stringify(heights(pdf)) === '[2001,2002,2003,2004,2005,2006]', `page heights ${heights(pdf)}`);
});

check('regression: chrome.storage holds the capture state, not the page images', async (s) => {
  await captureAndWait(s, HUGE, 1, 60000).catch(() => null);
  await (await s.extensionPage()).waitFor(`chrome.storage.local.get(null).then((d) => d.pdfCapturerState && d.pdfCapturerState.status === 'done')`, 30000);
  const bytes = JSON.stringify(await s.storage()).length;
  assert(bytes < 1 << 20, `chrome.storage.local holds ${(bytes / 1048576).toFixed(1)} MB`);
});

check('regression: a capture survives the service worker being stopped part-way', async (s) => {
  await s.openViewer('pages=12&delay=300');
  await s.openPopup();
  await s.capture(1);
  await s.popup.waitFor(`/^0[3-9] \\//.test(document.getElementById('counter').textContent)`, 30000);
  const sw = (await s.browser.targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(s.origin));
  await s.browser.send('Target.closeTarget', { targetId: sw.targetId });
  await s.page.waitFor(`document.querySelectorAll('.pdf-page canvas').length > 0 && window.viewer.zoomHistory.at(-1) === 60`, 60000);
  await sleep(1500);
  await s.openPopup();
  const sc = await s.screen();
  assert(sc.stage === 'done' && sc.saveVisible, `after the page finished, the popup shows ${sc.stage} "${sc.counter}"`);
  const { pdf } = await s.save();
  // Every page as an image: a placeholder standing in for a page the worker
  // was storing when it was stopped is a lost page, not a captured one.
  assert(pdf && pdf.pages.length === 12, `PDF has ${pdf && pdf.pages.length} pages`);
  assert(pdf.images.length === 12 && !/could not be captured/.test(pdf.text), `PDF has ${pdf.images.length} page images for 12 pages`);
});

check('regression: quitting Chrome mid-capture does not leave the extension stuck', async (s, ext) => {
  const profileDir = mkdtempSync(path.join(CACHE, 'keep-'));
  let t = await Session.open({ extensionDir: ext, profileRoot: CACHE, profileDir });
  try {
    await t.openViewer('pages=20&delay=400');
    await t.openPopup();
    await t.capture(1);
    await t.popup.waitFor(`/^0[2-9] \\//.test(document.getElementById('counter').textContent)`, 30000);
    await t.close();
    t = await Session.open({ extensionDir: ext, profileRoot: CACHE, profileDir });
    await t.openViewer('pages=3');
    await t.openPopup();
    const sc = await t.screen();
    assert(!sc.captureDisabled && sc.stage !== 'scanning', `after restarting, the popup shows ${sc.stage} "${sc.counter}" with Capture ${sc.captureDisabled ? 'disabled' : 'enabled'}`);
    await t.capture(1);
    const done = await t.waitForStage(['done', 'error'], 30000).catch(() => null);
    assert(done && done.stage === 'done', `a new capture ended ${done && done.stage}`);
  } finally {
    await t.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}, { ownBrowser: true });

check('regression: pages that fail to render are marked in the PDF, not dropped', async (s) => {
  const sc = await captureAndWait(s, 'pages=5&fail=2,4', 1, 60000);
  assert(sc.stage === 'done', `stage ${sc.stage}`);
  const { pdf } = await s.save();
  assert(pdf, 'no file was downloaded');
  assert(pdf.pages.length === 5, `PDF has ${pdf.pages.length} pages for a 5-page document`);
  assert(pdf.images.length === 3, `PDF has ${pdf.images.length} images`);
  assert(/Page 2 could not be captured/.test(pdf.text) && /Page 4 could not be captured/.test(pdf.text), 'no placeholder text for pages 2 and 4');
});

check('regression: a zoom ladder with no rung at the target does not oscillate', async (s) => {
  const sc = await captureAndWait(s, 'pages=2&steps=60,100,150,300', 2, 60000);
  assert(sc.stage === 'done', `stage ${sc.stage}`);
  const history = await s.page.eval('window.viewer.zoomHistory');
  assert(history.length <= 8, `${history.length - 1} zoom changes: ${history.join(' ')}`);
  assert(history.at(-1) === 60, `viewer left at ${history.at(-1)}%`);
});

check('regression: the suggested name gives the zoom actually reached', async (s) => {
  const sc = await captureAndWait(s, 'pages=2&steps=60,100,150,300', 2, 60000);
  // Asked for 200%; the ladder has 150 and 300.
  const { pdf } = await s.save();
  const reached = pdf && pdf.pages[0].w / 4;
  assert(sc.filename === `Fixture Viewer - ${reached / 100}x`, `suggested ${JSON.stringify(sc.filename)} for pages captured at ${reached}%`);
});

check('regression: a download Chrome refuses keeps the capture', async (s) => {
  const sc = await captureAndWait(s, 'pages=3', 1);
  assert(sc.stage === 'done', `stage ${sc.stage}`);
  const refused = await s.save('CON', 8000);
  assert(!refused.file, 'Chrome accepted CON.pdf; this check needs a name it refuses');
  const after = await s.screen();
  assert(!after.log.some((l) => /saved as "CON\.pdf"/.test(l)), `the log says ${JSON.stringify(after.log.at(-1))}`);
  assert(after.saveVisible && !after.saveDisabled, 'the Save button is gone');
  const { pdf } = await s.save('fine');
  assert(pdf && pdf.pages.length === 3, 'a second save with a valid name did not produce the PDF');
});

check('regression: leaving the page mid-capture is reported at once', async (s) => {
  // Page 3 never renders, so once page 2 is reported the page spends 3 s
  // waiting for a canvas with no message in flight. Leaving then is the case
  // that matters: Chrome keeps a page with an open extension message channel
  // out of the back/forward cache, so leaving mid-message fails fast anyway,
  // and a check that left at a random moment passed against the original
  // about one run in three.
  await s.openViewer('pages=20&fail=3&delay=50');
  await s.openPopup();
  await s.capture(1);
  await s.popup.waitFor(`/^02 \\//.test(document.getElementById('counter').textContent)`, 30000);
  await sleep(1000);
  await s.page.send('Page.navigate', { url: 'about:blank' });
  // In the cache the page is frozen rather than killed, and the injection
  // does not fail until it is evicted. The user has left; say so now.
  const sc = await s.waitForStage(['error', 'idle', 'done'], 5000).catch(() => null);
  assert(sc && sc.stage === 'error' && !sc.captureDisabled, `5 s after leaving, the popup shows ${sc ? sc.stage : 'scanning'}`);
});

async function main() {
  if (!findChrome()) {
    console.log('SKIP: no Chrome found (set CHROME to its path)');
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  const ext = ORIGINAL ? extractOriginal() : ROOT;
  console.log(`extension: ${ORIGINAL ? 'first commit' : 'working copy'} (${ext})\n`);

  const selected = checks.filter((c) => !ONLY || c.name.includes(ONLY));
  const results = [];
  let shared = null;
  for (const c of selected) {
    const t0 = Date.now();
    let error = null;
    try {
      if (c.ownBrowser) {
        await c.fn(null, ext);
      } else {
        // A fresh browser per check: one check's leftovers are not the next one's input.
        shared = await Session.open({ extensionDir: ext, profileRoot: CACHE });
        await c.fn(shared, ext);
      }
    } catch (e) {
      error = e.message.split('\n')[0];
    } finally {
      if (shared) await shared.close().catch(() => {});
      shared = null;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ name: c.name, ok: !error });
    console.log(`${error ? 'FAIL' : 'ok  '}  ${c.name}  (${secs}s)${error ? `\n        ${error}` : ''}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed`);
  for (const d of readdirSync(CACHE).filter((d) => d.startsWith('pdfcap-'))) {
    rmSync(path.join(CACHE, d), { recursive: true, force: true });
  }

  if (!ORIGINAL) {
    process.exitCode = failed.length ? 1 : 0;
    return;
  }
  const wrong = results.filter((r) => r.ok === r.name.startsWith('regression:'));
  if (wrong.length) {
    console.log('\nagainst the original, these did not do what their name says:');
    for (const r of wrong) console.log(`  ${r.ok ? 'passed' : 'failed'}: ${r.name}`);
    process.exitCode = 1;
  } else {
    const n = results.filter((r) => r.name.startsWith('regression:')).length;
    console.log(`\noriginal: all ${n} regression checks fail and every other check passes, as expected`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
