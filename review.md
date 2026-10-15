# Code Review — PDF Page Capturer

Reviewed 2026-09-04 against the working tree. Scope: `manifest.json`, `background.js`, `popup.js`,
`lib/jspdf.umd.min.js` (presence only), `popup.html`.

**Updated 2026-10-01 after the fixes on branch `cleanup/2026-10-01` (unpushed).** The author
chose to keep the project. The original review is below, unchanged except for the checklist at
the end.

## Corrections to the review below

All three of its P1s were checked by running the extension in real Chrome
(`tests/browser/`). One was overstated, one was understated, and one was right but
understated the effect.

1. **P1 #2 is overstated.** It says `persist()` on every progress message serialises the
   capture, and that "once `capturedPages` is populated the cost compounds". It never is
   populated during a capture. `capturedPages` is `null` for the whole run and is filled once,
   at the end, after the last progress message. Each per-page `persist()` wrote counters and the
   log, a few kilobytes. The expensive writes were the single one at the end and the messages.
   The per-message `persist()` is kept on purpose: it is what lets a restarted worker pick the
   run up again.
2. **P1 #3 is understated, and its remedy was not needed.** It says the worker "usually
   survives", and that if it dies the badge is "stuck on a stale count". In fact the whole
   extension was stuck, permanently, with Capture disabled, and restarting Chrome did not clear
   it. Nor does it need eviction: quitting Chrome mid-capture does it. The remedy it proposes, an
   alarms keepalive or an offscreen document, would not have helped with a quit browser. The fix
   is completion by message, plus expiring dead runs. Fixes 2 and 3 below.
3. **P1 #1 was right, and worse than it says.** "It will not scale" understates it. The concrete
   failure is Chrome's 64 MiB limit on an extension message. A capture past it finishes in the
   worker and can never be saved.

## What was fixed

| # | Finding | Where it came from | State |
|---|---|---|---|
| 1 | A capture over 64 MiB could not reach the popup and could not be saved | review P1 #1, effect understated | **Fixed** |
| 2 | A worker stopped mid-capture lost the result; the popup showed "Scanning" for good | review P1 #3, understated | **Fixed** |
| 3 | Quitting Chrome mid-capture left the extension stuck, across restarts | not in the review | **Fixed** |
| 4 | Leaving the page mid-capture left "Scanning" up for 30 s or more | not in the review | **Fixed** |
| 5 | Failed pages silently dropped from the PDF | review P2 | **Fixed** — placeholder pages |
| 6 | Zoom walk oscillated for 60 clicks when the viewer had no step at the target | not in the review (it saw the stop, not the bounce) | **Fixed** |
| 7 | File name gave the requested scale, not the zoom reached | review P3 | **Fixed** |
| 8 | A download Chrome refused was logged as "saved", and the capture discarded | not in the review | **Fixed** |
| 9 | Blob URL never revoked | review P3 | **Fixed** |
| 10 | `unlimitedStorage` | review P1 #1 | **Removed** |
| 11 | `persist()` on every message | review P1 #2 | **Kept**, see correction 1 |
| 12 | No README; jsPDF unrecorded | review P2/P3 | **Done** |

In more detail:

1. **Over 64 MiB.** Six 1500×2000 pages of noise come to 79 MB as data URLs. Against the
   original, the worker finished, and then `broadcastFinished` threw *"Message exceeded maximum
   allowed size of 64MiB"*. It throws synchronously, so the `.catch()` beside it never saw the
   error. The open popup stayed on "06 / 6 · Scanning". Reopened, it showed READY with no Save
   button, because the `get-state` reply was too big to send. Real documents get there: a
   40-page document at 3× on a high-DPI screen, or a few pages of scanned images. Now the page
   sends each image to the worker as it is captured and waits until the worker has stored it in
   IndexedDB. The popup reads the images from there on Save. State, storage and broadcasts carry
   counters only.
2. **Worker stopped mid-capture.** The result came back as `executeScript`'s return value, and a
   new worker has no way to receive it. The page carried on capturing, and its progress woke a
   new worker, which recorded it and then waited for a result that never came. Completion is now
   a message from the page, carrying a run id.
3. **Stuck for good.** `startCapture` refused to start while the stored status was `capturing`,
   and only the run that set it could clear it. Now it is cleared on `onStartup`, on
   `onInstalled` (an update or reload cuts the page's connection), and by staleness: a run silent
   for over a minute is reported as interrupted. A stored state with no timestamp was written by
   version 1.0 and counts as stale, so anyone stuck today is released by this update.
4. **Leaving the page.** Chrome put the page in the back/forward cache, which freezes the
   injected script, and `executeScript` did not fail until the page was evicted. The injected
   function now reports `pagehide`. See the notes below for why this could not be left to fix 1.
8. **Refused download.** Chrome refuses some names on every platform, `CON` and the other
   reserved device names among them. The callback never checked `runtime.lastError`. It logged
   `saved as "CON.pdf"` while no download existed, then cleared the capture.

Two changes alter what the user sees. Neither touches the interface:

- **The PDF itself:** a page that did not render is now a page reading "Page *n* could not be
  captured" instead of being left out.
- **The suggested file name** gives the zoom reached ("Notes - 3x" when 200% was not a step),
  or no tag if the zoom display was not found.

There are also new log lines in error paths that were silent or wrong before: the
interrupted-capture messages, the left-the-page message, and `error saving PDF: …`.

### Hardening, not a bug fix

The worker answered messages before it had read its state back from storage. In a Node harness
with slow storage, this made `get-state` reply "idle" for a finished capture. **In Chrome the
read wins**: a popup reopened after the worker idled out shows the capture, against the original
too (the browser suite has a check for it). The handlers wait for the read anyway, because
nothing guarantees the order. It is not counted above.

## Deliberately left alone

- **A setting for `saveAs`, and a warning before a very large capture.** Both are interface
  changes. With the 64 MiB failure fixed, a large capture is slow but no longer lost.
- **A licence for the project itself.** There is none, and choosing one is the author's call.
  The vendored jsPDF's MIT licence is now beside it in `lib/LICENSE.jspdf`.
- **The two `console.warn` calls.** Both are in genuine error paths, as the review said.

## Tests

- `node --test "tests/*.test.js"` — 34 tests, a few seconds. `tests/harness.js` loads the real
  `background.js` in `node:vm` with a stand-in `chrome`. With `ORIGINAL=1` the tests run against
  the first commit, and every `regression:` test fails there.
- `node tests/browser/run.js` — 13 checks in real headless Chrome, about three and a half
  minutes. With `--original`, the 10 named `regression:` fail and the other 3 pass, and the run
  asserts exactly that.

## Notes for whoever is next

- **An MV3 extension can be tested end to end in real Chrome with no dependency.** Start Chrome
  with `--remote-debugging-pipe --enable-unsafe-extension-debugging`, and two DevTools methods
  become available. `Extensions.loadUnpacked` installs the extension. `Extensions.triggerAction`
  is a real toolbar click: it opens the real popup and grants `activeTab`. It wants a *tab*
  target, which `Target.getTargets` lists only with `filter: [{type: 'tab'}]`.
  `tests/browser/cdp.js` is the pipe client, in about 150 lines.
- **Downloads:** set the folder in the profile's `Preferences`, not with
  `Browser.setDownloadBehavior`, which saves every file under a GUID. On a restart, merge into
  Chrome's own file rather than overwriting it.
- **An extension loaded over CDP does not survive a restart of Chrome.** A restart test
  therefore reloads it, which fires `onInstalled`, not `onStartup`. The Node harness fires
  `onStartup` itself.
- **Do not attach to the service worker to read storage.** Attaching keeps it alive, and an
  unattached idle worker stops after about 30 s. Read through the popup instead.
- **A fixture can have its own race, and a placeholder can hide it.** This pass first
  "found" two pages lost when the worker was stopped, and wrote a retry for it. The pages were
  never sent: the fixture's lazy renderer cancelled its own renders on each zoom step. Reading
  the stored rows and the log, rather than trusting the explanation, showed it. The retry was
  removed, and the check now counts images, not pages, because a placeholder had padded the
  count back to 12.
- **The back/forward cache decides whether leaving the page fails fast.** Chrome will not cache
  a page with an extension message channel open, so after fix 1 the outcome depended on whether
  the page was waiting on a reply at the moment it was left. The check passed six times running,
  then failed, and against the original it passed one full run in three. `pagehide` makes
  the extension deterministic. The check is deterministic too, because it now leaves while the
  page waits on a render that never comes, with no message in flight.
- **The injected function cannot close over anything from the worker.** Everything it needs
  arrives in `args`, now including the run id.

## What this project is

An MV3 extension that drives a web PDF viewer's own zoom controls up to a target percentage, scrolls
through every `.pdf-page` element, grabs each rendered canvas as a PNG, and stitches the images into
a downloadable PDF with jsPDF.

## Verdict

The engineering here is thoughtful — the capture lives in the service worker specifically so it
survives the popup closing, progress is mirrored to a badge and a notification, the zoom is driven
through the viewer's real controls so PDF.js re-renders at higher resolution rather than upscaling a
blurry canvas, and the selectors are user-editable so a site markup change does not require an
extension update. Those are all decisions someone made after hitting the problem.

The weak point is that the entire capture — every page as a base64 PNG — is held in the service
worker's state object, written to `chrome.storage.local` and passed through message-passing. That is
what forces the `unlimitedStorage` permission and it will not scale.

One contextual note, stated once and not laboured: this tool exists to extract PDFs from a viewer
that does not offer a download button. Whether that is fine depends entirely on the material and the
site's terms, and only you know which site the default selectors point at. Worth a line in the
README so a future reader knows the intended use.

## Critical issues

**1. Whole captures live in extension state, storage, and messages.**
`state.capturedPages` holds `{dataUrl, width, height}` for every page. A 40-page document captured at
2x is roughly 100-200 MB of base64. That object is:

- written to `chrome.storage.local` by `persist()` (`background.js:39`),
- returned wholesale to the popup in the `get-state` response (`background.js:333`),
- broadcast again in `broadcastFinished()` (`background.js:80`).

Each of those is a full structured-clone or JSON serialisation of the entire capture. This is why
`unlimitedStorage` is in the manifest — the permission is papering over the design. Fix by storing
page images in IndexedDB (or as blobs) keyed by page number, and keeping only counters and status in
the state object. The popup then reads images directly from IndexedDB when the user clicks save.

**2. `persist()` is called on every single progress message.** Each page capture triggers a full
serialisation of state plus the ever-growing `logs` array. Once `capturedPages` is populated the cost
compounds. Persist status transitions only, and throttle log writes.

**3. The service worker can be evicted mid-capture.** `startCapture` awaits a single
`chrome.scripting.executeScript` that may run for minutes on a long document. MV3 workers are torn
down after roughly 30 seconds of inactivity; the progress messages from the injected function reset
that timer, so in practice it usually survives — but a slow page (the render-wait loop allows up to
3 seconds per page, and the inter-page delay is 250 ms) can leave gaps. If the worker dies, the
injected function keeps running in the page and its result is discarded silently, leaving the badge
stuck on a stale count. Add a `chrome.alarms` keepalive for the duration of a capture, or move the
run into an offscreen document.

## Correctness details

- **The zoom loop can leave the viewer at the wrong zoom.** `setZoom` gives up after 60 clicks or
  when the value stops moving, then the code proceeds to capture at whatever zoom it reached. The
  mismatch is logged as a warning, but the resulting PDF is silently lower resolution than requested
  and the filename still claims the requested scale (`buildDefaultFilename` uses the requested
  `captureScale`, not the achieved one). Name the file after what actually happened.
- **Restoring the original zoom is best-effort and can fail silently** for the same reason, leaving
  the user's viewer at 300% after a capture.
- **Failed pages are dropped, not flagged, in the output.** `startCapture` filters to `ok` pages and
  builds the PDF from those, so a 40-page document with 3 render timeouts produces a 37-page PDF with
  no gap markers. The log mentions the skipped page numbers, but the artifact itself is silently
  incomplete — which is the worst kind of failure for something you will read later and trust. Insert
  a placeholder page, or refuse to save until the user acknowledges.
- **The blob URL is never revoked.** `buildAndSavePdf` creates an object URL and hands it to the
  downloads API without a matching revoke. The popup closing cleans it up in practice, so this is
  minor, but revoke it in the download callback anyway.
- **`chrome.downloads.download` is called with `saveAs: false`**, so a large capture writes straight
  to the downloads folder with no confirmation. Reasonable default, worth a settings toggle.
- **No cap on capture size.** Nothing warns before capturing a 500-page document at 3x, which will
  exhaust memory in the page, the worker, and the popup in sequence.

## Vendored dependency

`lib/jspdf.umd.min.js` is committed with no recorded version, no source URL, no upstream license
text, and no integrity note. jsPDF is MIT-licensed so vendoring is fine, but a future reader cannot
tell what version they are running or whether it has known issues. Add a short `lib/README.md`
recording the version and the download URL, and include the upstream license file.

## Cleanup

- Two `console.warn` calls remain (`background.js:46`, and the notification-open fallback). Both are
  in genuine error paths and are fine to keep.
- The comment at `background.js:107` uses a real page title containing your own name as its example.
  Harmless in a private repo; swap it for a generic example if you ever publish.
- No `README.md` at all, no `LICENSE`. For a tool whose default selectors are site-specific, the
  missing README is a real gap — a future you will not remember what `.viewer-zoom-val.mono` refers
  to. Document the target viewer, the four selectors, and how to re-derive them.

## Action checklist

State as of 2026-10-01:

- [x] **P1** Move captured page images out of state and storage into IndexedDB; drop
      `unlimitedStorage`.
- [ ] ~~**P1** Stop calling `persist()` on every progress message.~~ Not done, on purpose: the
      writes were small, and they are what a restarted worker resumes from. See correction 1.
- [x] **P2** ~~Add an alarms keepalive (or offscreen document)~~ so long captures cannot be
      orphaned. Done by completing on a message from the page and expiring dead runs, not by a
      keepalive. See correction 2.
- [x] **P2** Mark or refuse silently-dropped failed pages instead of shipping a short PDF.
      Marked, with placeholder pages.
- [x] **P2** Write a README: which viewer this targets, what the selectors mean, intended use.
      The site is not named, because nothing in the repository names it.
- [x] **P3** Name the output file after the achieved zoom, not the requested one.
- [x] **P3** Record the jsPDF version and license; revoke the blob URL. ~~Add a page-count
      warning~~ — left alone, because it is an interface change.

## Notes for a future session

No build step; load unpacked. No tests (as of 2026-09-04; see "Tests" at the top). The interesting code is
`capturePdfPagesInPage`, which is serialised into the target page by `chrome.scripting.executeScript`
— remember that it cannot close over anything from the worker scope, so every value it needs must
arrive through `args`. That constraint is why the selectors are threaded through as a parameter;
do not "simplify" it by referencing an outer constant.

## Licence, 2026-10-02

The author chose one licence for all of their projects: free for personal,
non-commercial use, modifiable for the user's own use, and not to be
distributed, original or modified. No standard licence says that, so `LICENSE`
is a short custom text, the same in every project apart from the year and what
it excludes. The README's licence section says the same. Anything above that
calls the licence an open question, or calls the project MIT, is superseded.

## CI, 2026-10-02

`.github/workflows/ci.yml` runs the 34 node checks on `ubuntu-latest`, with
full history, which `tests/harness.js` reads (a one-commit clone fails them,
checked). Nothing has been pushed, so it has not run on GitHub yet; the job
was run from a fresh clone on Ubuntu 24.04 and passed 34.

**Fixed on the way, test code only:** the browser driver watched the download
folder for the saved PDF and skipped `*.crdownload` and `*.tmp`, Chrome's
in-progress names on Windows. On Linux Chrome writes
`.com.google.Chrome.XXXXXX`, which the driver picked up and then lost to a
rename (`ENOENT`), failing two checks. Dotfiles are now skipped too.

**The browser suite is not in CI, and why.** It passed 13 of 13 in this
working tree, as it did in its own pass. No full run elsewhere did:

- Ubuntu 24.04, in a 4 GB VM: 12 of 13, with "leaving the page mid-capture is
reported at once" (which allows 5 s) failing; then a run that hung for good
after Chrome died under it. (A third was spoiled by the checking harness
itself and is not counted.) Chrome crashed eight times in that VM across all
the browser suites, so the VM is suspect. Run alone, that check passed three
times out of three. - A fresh clone on D:, on Windows, with the same Node and
Chrome: 12, 11, 12 and 11 of 13 in four runs. "quitting Chrome mid-capture
does not leave the extension stuck" passed its assertions each time and then
failed in its `finally`, deleting the kept profile with `EPERM`. Something
still holds the profile; retrying the delete for 10 s (as `cdp.js` does for
the profiles it owns) did not free it, so the change was not kept. The
leaving-the-page check failed too, in two of the four.

Both checks pass alone in the same clone. Until the suite passes outside this
working tree, a CI job for it would fail for reasons not yet understood, so it
is left to be run by hand. Starting points: what still has the kept profile
open after `t.close()` (a crashpad handler, say), and whether 5 s is enough
for the leaving-the-page check on a loaded machine.
