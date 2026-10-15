'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { STALE_AFTER_MS, buildDefaultFilename, pdfFilename, isStale, planPdfPages } = require('../common');

// A stored page record, as PageStore keeps them.
const rec = (page, ok, width = 400, height = 500 + page) => ({ captureId: 'x', page, ok, width: ok ? width : 0, height: ok ? height : 0, dataUrl: ok ? `data:${page}` : null });

test('buildDefaultFilename keeps the title before " · " and tags the zoom reached', () => {
  assert.equal(buildDefaultFilename('Introduction to Operating System · Someone', 200), 'Introduction to Operating System - 2x');
  assert.equal(buildDefaultFilename('Notes · A · B', 50), 'Notes - 0.5x');
  assert.equal(buildDefaultFilename('Notes', 175), 'Notes - 1.75x');
  assert.equal(buildDefaultFilename('a/b:c*d?', 100), 'a_b_c_d_ - 1x');
});

test('buildDefaultFilename falls back to "captured", and drops the tag when the zoom is unknown', () => {
  assert.equal(buildDefaultFilename('', 100), 'captured - 1x');
  assert.equal(buildDefaultFilename(null, 100), 'captured - 1x');
  assert.equal(buildDefaultFilename(' · rest', 100), 'captured - 1x');
  assert.equal(buildDefaultFilename('Notes · X', null), 'Notes');
  assert.equal(buildDefaultFilename('Notes', undefined), 'Notes');
});

test('pdfFilename trims, replaces the characters Windows forbids, and adds .pdf once', () => {
  assert.equal(pdfFilename('  report  '), 'report.pdf');
  assert.equal(pdfFilename('report.PDF'), 'report.PDF');
  assert.equal(pdfFilename('a<b>c|d'), 'a_b_c_d.pdf');
  assert.equal(pdfFilename(''), 'captured.pdf');
  assert.equal(pdfFilename('   '), 'captured.pdf');
  assert.equal(pdfFilename(undefined), 'captured.pdf');
});

test('isStale: only a capture that has gone quiet for over a minute', () => {
  const now = 1_000_000;
  assert.equal(isStale({ status: 'capturing', lastActivity: now - STALE_AFTER_MS - 1 }, now), true);
  assert.equal(isStale({ status: 'capturing', lastActivity: now - STALE_AFTER_MS }, now), false);
  assert.equal(isStale({ status: 'capturing', lastActivity: now - 1000 }, now), false);
  for (const status of ['idle', 'done', 'error']) {
    assert.equal(isStale({ status, lastActivity: 0 }, now), false, status);
  }
  assert.equal(isStale(null, now), false);
});

test('isStale: a capturing state with no timestamp is one version 1.0 left behind', () => {
  assert.equal(isStale({ status: 'capturing', capturedPages: null }, Date.now()), true);
});

test('the stale limit is well past the longest silence a live capture has', () => {
  // 60 zoom clicks 200 ms apart and a 500 ms settle, before the first page
  const zoomWalk = 60 * 200 + 500;
  assert.ok(STALE_AFTER_MS >= 4 * zoomWalk);
});


test('planPdfPages: every page in order, images where they rendered', () => {
  const plan = planPdfPages([rec(2, true), rec(1, true), rec(3, true)], 3);
  assert.deepEqual(plan.map((p) => [p.kind, p.page, p.height, p.dataUrl]), [
    ['image', 1, 501, 'data:1'],
    ['image', 2, 502, 'data:2'],
    ['image', 3, 503, 'data:3'],
  ]);
});

test('planPdfPages: a page that failed keeps its place, sized like its nearest neighbour', () => {
  const plan = planPdfPages([rec(1, true), rec(2, false), rec(3, true, 800, 900), rec(4, false), rec(5, false)], 5);
  assert.deepEqual(plan.map((p) => [p.kind, p.page, p.width, p.height]), [
    ['image', 1, 400, 501],
    ['placeholder', 2, 400, 501],
    ['image', 3, 800, 900],
    ['placeholder', 4, 800, 900],
    ['placeholder', 5, 800, 900],
  ]);
});

test('planPdfPages: leading failures borrow the size of the first captured page', () => {
  const plan = planPdfPages([rec(1, false), rec(2, false), rec(3, true)], 3);
  assert.deepEqual(plan.map((p) => [p.kind, p.width, p.height]), [
    ['placeholder', 400, 503],
    ['placeholder', 400, 503],
    ['image', 400, 503],
  ]);
});

test('planPdfPages: a page with no record at all is a placeholder too', () => {
  const plan = planPdfPages([rec(1, true), rec(3, true)], 4);
  assert.deepEqual(plan.map((p) => p.kind), ['image', 'placeholder', 'image', 'placeholder']);
});

test('planPdfPages: nothing captured means nothing to build', () => {
  assert.deepEqual(planPdfPages([], 3), []);
  assert.deepEqual(planPdfPages([rec(1, false)], 1), []);
  assert.deepEqual(planPdfPages(undefined, 0), []);
});

test('planPdfPages: a zero-sized canvas does not count as captured', () => {
  const plan = planPdfPages([{ page: 1, ok: true, width: 0, height: 0 }, rec(2, true)], 2);
  assert.deepEqual(plan.map((p) => p.kind), ['placeholder', 'image']);
});
