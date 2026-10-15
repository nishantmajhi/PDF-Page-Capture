'use strict';
/*
 * Drives the extension the way a person does, in real Chrome:
 *
 *   open the viewer -> click the toolbar icon -> pick a scale -> Capture
 *   -> wait -> Save PDF -> read the file that lands in the downloads folder
 *
 * Every step goes through the real popup's own buttons. Nothing is called
 * inside the extension directly, so a check passes only if a user doing the
 * same thing would have got the same result.
 */
const { createServer } = require('node:http');
const { readFileSync, readdirSync, mkdtempSync, rmSync, statSync } = require('node:fs');
const path = require('node:path');
const { Browser, sleep } = require('./cdp');

const FIXTURES = __dirname;

function serveFixtures() {
  const server = createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname) || 'viewer.html';
    try {
      const body = readFileSync(path.join(FIXTURES, name));
      res.writeHead(200, { 'content-type': name.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/*
 * What a saved PDF contains, read from its bytes. jsPDF writes page objects in
 * page order with a plain-text MediaBox, in points. Its legacy "px" unit is
 * 4/3 of a point, so a MediaBox unit is 0.75 of a canvas pixel. The viewer
 * fixture makes page i exactly i pixels taller than the base, so the heights
 * identify the pages.
 */
function readPdf(file) {
  const text = readFileSync(file, 'latin1');
  const boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => ({
    w: Math.round(Number(m[1]) * 0.75),
    h: Math.round(Number(m[2]) * 0.75),
  }));
  const images = [...text.matchAll(/\/Subtype \/Image[\s\S]*?\/Width (\d+)[\s\S]*?\/Height (\d+)/g)].map((m) => ({
    w: Number(m[1]),
    h: Number(m[2]),
  }));
  return { bytes: statSync(file).size, pages: boxes, images, text };
}

class Session {
  static async open({ extensionDir, profileRoot, profileDir }) {
    const downloads = mkdtempSync(path.join(profileRoot, 'pdfcap-dl-'));
    const browser = await Browser.launch({ profileRoot, profileDir, downloadDir: downloads });
    if (!browser) return null;
    const s = new Session(browser);
    s.downloads = downloads;
    // If anything below fails, Chrome is already running, and its pipes would
    // keep this process alive for good. Close it before giving up.
    try {
      s.server = await serveFixtures();
      s.extensionId = (await browser.send('Extensions.loadUnpacked', { path: extensionDir })).id;
      const tab = (await browser.targets('tab'))[0];
      s.tabId = tab.targetId;
      const page = (await browser.targets('page')).find((t) => t.url === 'about:blank');
      s.page = await browser.attach(page.targetId);
      await s.page.send('Page.enable');
      await s.page.send('Runtime.enable');
    } catch (e) {
      await s.close().catch(() => {});
      throw e;
    }
    return s;
  }

  constructor(browser) {
    this.browser = browser;
  }

  get origin() {
    return `chrome-extension://${this.extensionId}`;
  }

  async worker() {
    const t = await this.browser.waitForTarget((t) => t.type === 'service_worker' && t.url.startsWith(this.origin));
    return this.browser.attach(t.targetId);
  }

  async openViewer(query = '') {
    const url = `http://127.0.0.1:${this.server.address().port}/viewer.html?${query}`;
    await this.page.send('Page.navigate', { url });
    await this.page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && !!window.viewer`);
  }

  /* A real toolbar click: opens the real popup and grants activeTab. */
  async openPopup() {
    const stale = new Set(await this.closePopup());
    await this.browser.send('Extensions.triggerAction', { id: this.extensionId, targetId: this.tabId });
    const t = await this.browser.waitForTarget(
      (t) => t.type === 'page' && t.url === `${this.origin}/popup.html` && !stale.has(t.targetId),
    );
    this.popup = await this.browser.attach(t.targetId);
    await this.popup.send('Runtime.enable');
    await this.popup.waitFor(`document.readyState === 'complete'`);
    // Let the popup's get-state round trip land before anything reads the screen.
    await sleep(300);
    return this.popup;
  }

  async closePopup() {
    const open = (await this.browser.targets('page')).filter((t) => t.url === `${this.origin}/popup.html`);
    for (const t of open) {
      try {
        await this.browser.send('Target.closeTarget', { targetId: t.targetId });
      } catch {
        /* already closed */
      }
    }
    this.popup = null;
    if (open.length) await sleep(200);
    return open.map((t) => t.targetId);
  }

  /* What is on the popup's screen right now. */
  screen() {
    return this.popup.eval(`({
      counter: document.getElementById('counter').textContent,
      stage: document.getElementById('scanStage').dataset.state,
      captureDisabled: document.getElementById('captureBtn').disabled,
      captureLabel: document.getElementById('captureBtnLabel').textContent,
      saveVisible: document.getElementById('filenameStep').classList.contains('visible'),
      saveDisabled: document.getElementById('saveBtn').disabled,
      filename: document.getElementById('filenameInput').value,
      log: [...document.querySelectorAll('#logPanel .log-line')].map((l) => l.textContent),
    })`);
  }

  async capture(scale = 1) {
    await this.popup.eval(`document.querySelector('.scale-option[data-scale="${scale}"]').click()`);
    await this.popup.eval(`document.getElementById('captureBtn').click()`);
  }

  async waitForStage(stages, timeoutMs = 120000) {
    const list = JSON.stringify([].concat(stages));
    await this.popup.waitFor(`${list}.includes(document.getElementById('scanStage').dataset.state)`, timeoutMs, 200);
    return this.screen();
  }

  /* Press Save PDF and wait for either a file on disk or the button to come back. */
  async save(filename, timeoutMs = 120000) {
    const before = new Set(readdirSync(this.downloads));
    if (filename !== undefined) {
      await this.popup.eval(`document.getElementById('filenameInput').value = ${JSON.stringify(filename)}`);
    }
    await this.popup.eval(`document.getElementById('saveBtn').click()`);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      // In progress, Chrome names a download *.crdownload or *.tmp on Windows
      // and .com.google.Chrome.XXXXXX on Linux.
      const fresh = readdirSync(this.downloads).filter((f) => !before.has(f) && !/\.(crdownload|tmp)$|^\./.test(f));
      if (fresh.length) {
        await sleep(300);
        return { file: fresh[0], pdf: readPdf(path.join(this.downloads, fresh[0])) };
      }
      const sc = await this.screen().catch(() => null);
      // A refused or failed save is final; a started one is only final once
      // Chrome has renamed its .tmp file, which for a large PDF takes a while.
      if (sc && !sc.saveDisabled && /^error/.test(sc.log.at(-1) || '')) {
        return { file: null, screen: sc };
      }
      await sleep(200);
    }
    return { file: null, screen: await this.screen().catch(() => null) };
  }

  /*
   * chrome.storage and chrome.downloads, read from the popup. Not from the
   * worker: an idle worker shuts down after about 30 seconds, and attaching to
   * one would also keep it alive, which is not what a user's worker gets.
   */
  async extensionPage() {
    return this.popup || this.openPopup();
  }

  async storage() {
    return (await this.extensionPage()).eval(`chrome.storage.local.get(null)`);
  }

  async downloadList() {
    return (await this.extensionPage()).eval(
      `chrome.downloads.search({ orderBy: ['-startTime'] }).then((a) => a.map((d) => ({ name: d.filename.split(/[\\\\/]/).pop(), state: d.state, error: d.error || null })))`,
    );
  }

  async close() {
    try {
      this.server.close();
    } catch {
      /* fine */
    }
    await this.browser.close();
    rmSync(this.downloads, { recursive: true, force: true });
  }
}

module.exports = { Session, readPdf, sleep };
