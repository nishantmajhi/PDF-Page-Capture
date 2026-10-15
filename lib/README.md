# Vendored libraries

## `jspdf.umd.min.js` — jsPDF 4.2.1

Builds the PDF in the popup. MIT licence; the upstream text is in
[`LICENSE.jspdf`](LICENSE.jspdf).

- Source: `https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js`
- SHA-256: `e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54`

Checked on 2026-10-01. The committed file is byte-identical to that URL, 4.2.1
was the latest release, and npm's advisory database listed nothing against it.

To update, replace the file from the same URL with the new version number,
then update the version and hash here. `tests/manifest.test.js` checks that
the version in this file matches the one in the library's own header.
