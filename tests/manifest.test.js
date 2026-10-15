'use strict';
// The wiring between files, which no single-file test sees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('regression: no unlimitedStorage — page images are in IndexedDB, not chrome.storage', () => {
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});

test('the permissions are the five the code uses', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'downloads', 'notifications', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
});

test('every file the manifest names exists', () => {
  const files = [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('the popup loads jsPDF and common.js before popup.js, and each exists', () => {
  const scripts = [...read('popup.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['lib/jspdf.umd.min.js', 'common.js', 'popup.js']);
  for (const s of scripts) assert.ok(fs.existsSync(path.join(ROOT, s)), s);
});

test('the worker imports common.js, the only script it loads', () => {
  const imports = [...read('background.js').matchAll(/importScripts\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["'common.js'"]);
});

test('the vendored jsPDF is the version lib/README.md records', () => {
  const header = read('lib/jspdf.umd.min.js').slice(0, 400);
  const version = header.match(/Version (\d+\.\d+\.\d+)/)[1];
  assert.match(read('lib/README.md'), new RegExp(`\\b${version.replace(/\./g, '\\.')}\\b`));
});
