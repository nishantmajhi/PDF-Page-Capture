'use strict';
/*
 * Chrome over the DevTools protocol, on a pipe rather than a port.
 *
 * A pipe is what makes the extension testable at all: `Extensions.loadUnpacked`
 * and `Extensions.triggerAction` are refused unless Chrome was started with
 * `--remote-debugging-pipe --enable-unsafe-extension-debugging`. With them, the
 * extension is installed exactly as "Load unpacked" would install it, and
 * `triggerAction` is a real toolbar click: it opens the real popup and grants
 * `activeTab` on the tab, which is the permission the capture runs under.
 *
 * Messages on the pipe are JSON, each terminated by a NUL byte. Chrome reads
 * from our fd 3 and writes to our fd 4.
 */
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((c) => existsSync(c)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Browser {
  static async launch({ profileRoot = os.tmpdir(), profileDir, downloadDir } = {}) {
    const chrome = findChrome();
    if (!chrome) return null;
    // A caller-supplied profile is kept on close, so a test can restart Chrome on it.
    const profile = profileDir || mkdtempSync(path.join(profileRoot, 'pdfcap-profile-'));
    // The download folder is set the way a user sets it, in Preferences.
    // CDP's Browser.setDownloadBehavior would also do, but it saves every file
    // under a GUID, which hides the name the extension asked for.
    // On a restart the file is Chrome's own, so merge rather than replace.
    if (downloadDir) {
      const prefs = path.join(profile, 'Default', 'Preferences');
      mkdirSync(path.dirname(prefs), { recursive: true });
      let current = {};
      try {
        current = JSON.parse(readFileSync(prefs, 'utf8'));
      } catch {
        /* a new profile */
      }
      current.download = { ...current.download, default_directory: downloadDir, prompt_for_download: false };
      writeFileSync(prefs, JSON.stringify(current));
    }
    const proc = spawn(chrome, [
      '--headless=new',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DownloadBubble,DownloadBubbleV2',
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    proc.stderr.resume();
    return new Browser(proc, profile, !profileDir);
  }

  constructor(proc, profile, ownsProfile) {
    this.proc = proc;
    this.profile = profile;
    this.ownsProfile = ownsProfile;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.exited = new Promise((r) => proc.on('exit', r));
    let buf = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) !== -1) {
        const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
        buf = buf.subarray(i + 1);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, method } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
          else resolve(msg.result);
        } else {
          for (const l of this.listeners) l(msg);
        }
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.proc.stdio[3].write(JSON.stringify(msg) + '\0');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async targets(type) {
    const filter = type ? [{ type }] : undefined;
    const { targetInfos } = await this.send('Target.getTargets', filter ? { filter } : {});
    return type ? targetInfos.filter((t) => t.type === type) : targetInfos;
  }

  /* Poll for a target whose url matches; a page or worker appears asynchronously. */
  async waitForTarget(pred, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const all = [...(await this.targets()), ...(await this.targets('tab'))];
      const t = all.find(pred);
      if (t) return t;
      await sleep(100);
    }
    throw new Error('target did not appear');
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(this, sessionId);
  }

  async close() {
    try {
      await Promise.race([this.send('Browser.close'), sleep(2000)]);
    } catch {
      /* already gone */
    }
    await Promise.race([this.exited, sleep(5000)]);
    if (this.proc.exitCode === null) this.proc.kill();
    if (!this.ownsProfile) return;
    for (let k = 0; k < 40; k++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(250);
      }
    }
  }
}

class Session {
  constructor(browser, id) {
    this.browser = browser;
    this.id = id;
  }

  send(method, params) {
    return this.browser.send(method, params, this.id);
  }

  /* Evaluate an expression and return its value; rejections become errors. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  }

  /* Poll an expression until it is truthy. */
  async waitFor(expression, timeoutMs = 30000, interval = 100) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await this.eval(expression);
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(`timed out waiting for: ${expression}`);
  }
}

module.exports = { Browser, findChrome, sleep };
