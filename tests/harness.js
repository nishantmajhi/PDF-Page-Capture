'use strict';
/*
 * Loads the real background.js into a node:vm context with just enough of the
 * chrome namespace to drive it: storage, runtime messaging and events, tabs,
 * scripting, action and notifications. Every call it makes is recorded.
 *
 * PageStore (common.js) is swapped for an in-memory one as common.js is
 * imported, because Node has no IndexedDB; the real one is exercised by the
 * browser suite in tests/browser/.
 *
 * Storage answers asynchronously, as Chrome's does, and `storageDelay` holds
 * the first read back so a test can deliver a message before the worker has
 * read its state back. That ordering is exactly what a stopped worker sees
 * when a page's message starts it again.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

// Values made inside the vm have its own Object.prototype, which
// assert.deepStrictEqual counts as a difference. Tests get plain copies.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
    fire: (...args) => listeners.map((fn) => fn(...args)),
  };
}

// Storage answers on a timer and messages on setImmediate, and Node does not
// fix the order between the two, so a settled worker has been through both.
const tick = () => new Promise((r) => setTimeout(() => setImmediate(r), 0));
async function settle(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

function memoryPageStore() {
  const rows = new Map();
  return {
    rows,
    failNextPut: null,
    async put(record) {
      if (this.failNextPut) {
        const e = this.failNextPut;
        this.failNextPut = null;
        throw e;
      }
      rows.set(record.page, { ...record });
    },
    async clear() {
      rows.clear();
    },
    async all(captureId) {
      return [...rows.values()].filter((r) => r.captureId === captureId).sort((a, b) => a.page - b.page);
    },
  };
}

/*
 * source: the text of background.js to load (the working copy by default).
 * stored: what chrome.storage.local holds when the worker starts.
 */
function loadBackground({ source, stored = {}, storageDelay = 0, tabTitle = 'Fixture · Author' } = {}) {
  const storage = JSON.parse(JSON.stringify(stored));
  const calls = { badge: [], notifications: [], toPopup: [], executeScript: [] };
  const pageStore = memoryPageStore();
  let firstRead = true;

  let executeScript = () => new Promise(() => {}); // a page run that never returns
  const runtime = {
    lastError: undefined,
    onMessage: event(),
    onConnect: event(),
    onStartup: event(),
    onInstalled: event(),
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage(msg) {
      calls.toPopup.push(JSON.parse(JSON.stringify(msg)));
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    },
  };

  const chrome = {
    runtime,
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const k of [].concat(keys)) if (k in storage) out[k] = JSON.parse(JSON.stringify(storage[k]));
          const delay = firstRead ? storageDelay : 0;
          firstRead = false;
          setTimeout(() => cb(out), delay);
        },
        set(obj, cb) {
          Object.assign(storage, JSON.parse(JSON.stringify(obj)));
          setImmediate(() => cb && cb());
        },
      },
    },
    action: {
      setBadgeText: ({ text }) => calls.badge.push(text),
      setBadgeBackgroundColor: () => {},
      openPopup: () => Promise.resolve(),
    },
    notifications: {
      create: (id, opts) => calls.notifications.push(opts.message),
      clear: () => {},
      onClicked: event(),
    },
    tabs: {
      query: async () => [{ id: 7, title: tabTitle }],
    },
    scripting: {
      executeScript: (opts) => {
        calls.executeScript.push({ target: plain(opts.target), args: plain(opts.args), func: opts.func });
        return executeScript(opts);
      },
    },
  };

  const context = vm.createContext({
    chrome,
    console: { log() {}, warn() {}, error() {} },
    crypto: { randomUUID: () => crypto.randomUUID() },
    setTimeout,
    clearTimeout,
    setImmediate,
    Promise,
    Date,
  });
  context.self = context;
  context.importScripts = (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), context, { filename: f });
      if (f === 'common.js') context.PdfCapturer.PageStore = pageStore;
    }
  };
  // ORIGINAL=1 runs every test against the first commit's background.js.
  const defaultSource = process.env.ORIGINAL ? originalSource('background.js') : fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  vm.runInContext(source ?? defaultSource, context, { filename: 'background.js' });

  // Deliver a message the way Chrome does; resolves with the reply, or
  // undefined if no listener claimed the message.
  function send(msg, sender = {}) {
    return new Promise((resolve) => {
      let claimed = false;
      for (const fn of runtime.onMessage.listeners) {
        const r = fn(JSON.parse(JSON.stringify(msg)), sender, (reply) => resolve(plain(reply)));
        if (r === true) claimed = true;
      }
      if (!claimed) setImmediate(() => resolve(undefined));
    });
  }

  return {
    chrome,
    calls,
    storage,
    pageStore,
    send,
    stored: () => storage.pdfCapturerState,
    state: () => plain(vm.runInContext('state', context)),
    setExecuteScript: (fn) => {
      executeScript = fn;
    },
  };
}

function originalSource(file) {
  const { execFileSync } = require('node:child_process');
  const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return execFileSync('git', ['show', `${first}:${file}`], { cwd: ROOT, encoding: 'utf8' });
}

module.exports = { loadBackground, originalSource, settle };
