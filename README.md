# PDF Page Capturer

A Chrome extension that saves a PDF from a web viewer that shows the pages but
offers no download. It drives the viewer's own zoom buttons up to the
resolution you ask for, scrolls through every page, takes each rendered
canvas as an image, and builds a PDF from the images.

The result is a PDF of pictures of pages. Text in it cannot be selected or
searched.

## Intended use

It is for documents you are entitled to keep, such as your own course notes
or material whose terms allow a copy, on a site that does not happen to offer
a download button. Whether a particular site and document qualify is up to
you and that site's terms.

## Install

There is no build step.

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.

It runs in current Chrome and should run in any Chromium browser with
Manifest V3 support. It was tested in Chrome 154.

## Use

1. Open the document in the viewer and click the extension's toolbar icon.
2. Pick a **capture scale**: 0.5×, 1×, 2× or 3×. The extension zooms the
   viewer to that percentage (1× is 100%) using the viewer's own buttons, so
   the viewer re-renders each page at that size. This is sharper than
   browser zoom, which stretches what is already drawn.
3. Press **Capture pages**. You can close the popup; the capture carries on.
   The toolbar badge counts pages, and a notification says when it is done.
4. Open the popup again, check the file name and press **Save PDF**. The file
   goes to your downloads folder.

When the capture finishes, the viewer is put back to the zoom it had before.

What to expect along the way:

- **A page that does not render within about 3 seconds** is skipped, and the
  log says which. In the PDF, its place is kept by a page that reads "Page *n*
  could not be captured". The page numbering still matches the document.
- **If the viewer has no zoom step at exactly the scale you picked**, it stops
  at the first step past it. The log says so, and the suggested file name
  gives the zoom actually used, for example `Notes - 1.75x`.
- **If you leave the page, close the tab, quit the browser or reload the
  extension mid-capture**, the capture ends with an error, and you can start
  again. Nothing is left half-running.

## Settings: the viewer's selectors

The gear icon opens four CSS selectors, which tell the extension where things
are in the viewer's page:

| Setting | Default | Finds |
| --- | --- | --- |
| Parent container | `.pdf-viewer` | the element containing the viewer; the other three are looked up inside it, or in the whole page if it is not found |
| Zoom-in button | `.viewer-zoom-btn[title="Zoom in"]` | the button that zooms in one step |
| Zoom-out button | `.viewer-zoom-btn[title="Zoom out"]` | the button that zooms out one step |
| Zoom value display | `.viewer-zoom-val.mono` | the element showing the zoom, such as `60%`; the first number in its text is read |

Each change is saved when you leave the field, and **Reset to defaults** puts
them back.

The pages themselves are always found as elements with the class `pdf-page`,
each with a `<canvas>` inside. That is not a setting.

**If the site changes its markup** and capture stops working, the log will say
which selector found nothing. To find the new one, right-click the zoom-in
button, choose **Inspect**, and write a selector for the element that is
highlighted, using a class or attribute that only that element has. Do the
same for the other two, then check that the pages are still `.pdf-page`
elements holding canvases.

## How it works

- **`popup.html` / `popup.js`** is the interface. It starts a capture and
  shows its progress. On Save, it reads the page images and builds the PDF
  with jsPDF.
- **`background.js`** is the service worker. It runs the capture, so the
  capture survives the popup closing. It injects a function into the viewer's
  tab with `chrome.scripting.executeScript`. That function works the zoom,
  then sends each page to the worker as it is captured, and reports when it
  is done. The worker stores each page before the next one is taken.
- **`common.js`** is loaded by both. It has the file naming, the rule for when
  a silent capture counts as dead, the PDF page plan with its placeholders,
  and `PageStore`, which keeps page images in the extension's IndexedDB.
- **`lib/`** holds jsPDF 4.2.1. Its version, source and checksum are in
  `lib/README.md`.

Page images never go into `chrome.storage` or into a message carrying more
than one page. Chrome refuses any extension message over 64 MiB, so a design
that sent the whole capture in one message would fail on large documents.

The injected function cannot use anything from the worker's scope, because
Chrome serialises it into the page. Everything it needs arrives as an
argument. That is why the selectors are passed in rather than read from a
constant.

Permissions: `activeTab` and `scripting` to run in the tab you clicked on,
`downloads` to save, `storage` for the settings and the capture's progress,
and `notifications` for the "done" message.

## Tests

The tests need Node 22 or later and no packages:

```sh
node --test "tests/*.test.js"
```

This takes a few seconds. It covers the logic in `common.js` and the
service worker, which it loads into a `node:vm` context with a stand-in
`chrome` API (`tests/harness.js`). Set `ORIGINAL=1` to run the same tests
against the first commit's `background.js`.

```sh
node tests/browser/run.js
node tests/browser/run.js --original
```

This runs the extension end to end in real headless Chrome, which must be
installed (set `CHROME` to its path if it is somewhere unusual). It loads the
extension unpacked, opens a stand-in viewer (`tests/browser/viewer.html`),
clicks the toolbar icon, presses the popup's buttons and reads the PDF it
downloads. It takes about three minutes, because three of the checks
deliberately capture more than 64 MiB.

`--original` runs the same checks against the first commit. There, every
check named `regression:` must fail and every other check must pass, and the
run says so.

## Licence

Free for personal, non-commercial use. You may use, study and modify this
software for yourself, but you may not use it commercially, and you may not
share or publish it, in its original form or modified. See [LICENSE](LICENSE)
for the full terms.

jsPDF, in `lib/`, keeps its own MIT licence (`lib/LICENSE.jspdf`).
