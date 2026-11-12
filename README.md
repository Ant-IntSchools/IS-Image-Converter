# WebP Converter

A static website that converts images to WebP in the browser. Nothing is uploaded: images are read, cropped, resized and encoded on your own device.

## Features

- Drop, choose or paste images, one at a time or many at once.
- Upload a `.zip`: every image inside it is added. Folders are flattened, and `__MACOSX` and hidden files are skipped.
- **Lossy** mode with a quality setting from 0 to 100.
- **Lossless** mode with a compression level from 0 to 9 (the same presets as `cwebp -z`).
- Resize by percentage, width, height, fit inside a box, or exact size. You can choose not to enlarge smaller images.
- Crop each image, with free or fixed aspect ratios (1:1, 4:3, 3:2, 16:9, 9:16).
- Rename images in bulk, in the style of Bulk Rename Utility. Renaming doesn't re-encode anything. The steps are applied in this order:
  1. **Name:** keep the original name, replace it with new text, or remove it.
  2. **Matching:** find and replace, as plain text or as a regular expression. A regular expression can use `$1`, `$2`… in the replacement, and matching can be case-sensitive or not.
  3. **Prefix and suffix:** text added before or after the name.
  4. **Sequence:** a number with a start value, step, number of digits, separator, and position (before or after the name).

  Characters that aren't allowed in file names are removed, and duplicate names get `-1`, `-2` added.
- Download images one at a time, or all of them as a zip.
- Your settings are remembered in this browser.

## How it works

| Part | Where |
| --- | --- |
| Decoding, cropping and resizing | `createImageBitmap` + `OffscreenCanvas` in a Web Worker ([js/worker.js](js/worker.js)) |
| WebP encoding | libwebp compiled to WebAssembly ([jSquash](https://github.com/jamsinclair/jSquash)), in up to 4 workers at once |
| Cropping UI | [Cropper.js](https://github.com/fengyuanchen/cropperjs) |
| Reading and writing zips | [JSZip](https://stuk.github.io/jszip/) |

All libraries are stored in [vendor/](vendor/), so the site makes no requests to other servers. The page's Content Security Policy (`connect-src 'self'`) stops it from sending data anywhere else.

The browser's own `canvas.toBlob('image/webp')` isn't used. It can't do true lossless encoding, and Safari doesn't support it.

The input formats you can use depend on what your browser can decode. JPEG, PNG, GIF (first frame only), BMP, WebP and AVIF work everywhere. HEIC and TIFF work in Safari only. Semi-transparent pixels can shift very slightly in lossless mode, because the canvas stores colour and transparency together.

## Styling and font

The colours, spacing, radii and type scale come from the Staff Planner design system. The layout is dark only.

The page uses **Gelion** when it's installed on the visitor's device, and the system sans-serif otherwise. Gelion is a commercial font, so its files are not in this repo. If you have a web licence for it, add the `.woff2` files to a `fonts/` folder and include them in the `@font-face` rules at the top of [css/styles.css](css/styles.css), alongside the existing `local()` sources.

## Run locally

The site uses ES modules and Web Workers, so you need to serve it over HTTP. Opening `index.html` directly as a file won't work.

```sh
npx serve .
# or
python -m http.server 8000
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*. Pick your branch (for example `main`) and the `/ (root)` folder.
4. The site will be live at `https://<user>.github.io/<repo>/` within a minute or two.

There is no build step. The empty `.nojekyll` file tells GitHub Pages to serve the files exactly as they are.

## Updating the vendored libraries

```sh
npm install @jsquash/webp jszip cropperjs
```

Then copy the files into `vendor/` again. In `vendor/jsquash-webp/encode.js`, change `from 'wasm-feature-detect'` to `from '../wasm-feature-detect/index.js'`, because browsers can't resolve bare module names without a bundler.

## Licences

Each library's licence is included next to it in `vendor/`. They are: jSquash and libwebp (Apache-2.0 / BSD), JSZip (MIT or GPLv3), Cropper.js (MIT) and wasm-feature-detect (Apache-2.0).
