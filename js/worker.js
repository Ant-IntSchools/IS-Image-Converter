// Decodes, crops, resizes and encodes one image at a time, off the main thread.
import encode from '../vendor/jsquash-webp/encode.js';
import { targetSize } from './resize.js';

// The same presets cwebp uses for `-z 0..9`: [method, quality].
const LOSSLESS_PRESETS = [
  [0, 0], [1, 20], [2, 25], [3, 30], [3, 50],
  [4, 50], [4, 75], [4, 90], [5, 90], [6, 100],
];

function encodeOptions(s) {
  if (s.lossless) {
    const level = Math.min(9, Math.max(0, Math.round(s.level)));
    const [method, quality] = LOSSLESS_PRESETS[level];
    return { lossless: 1, method, quality, exact: 0 };
  }
  return { lossless: 0, quality: s.quality, method: 4, use_sharp_yuv: 1 };
}

function clampCrop(crop, w, h) {
  if (!crop) return { x: 0, y: 0, width: w, height: h };
  const x = Math.min(Math.max(0, Math.round(crop.x)), w - 1);
  const y = Math.min(Math.max(0, Math.round(crop.y)), h - 1);
  const width = Math.min(Math.max(1, Math.round(crop.width)), w - x);
  const height = Math.min(Math.max(1, Math.round(crop.height)), h - y);
  return { x, y, width, height };
}

function context(canvas, opts) {
  const ctx = canvas.getContext('2d', opts);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

// Draws the crop region at the target size. Large reductions are done in
// halving steps, which looks noticeably better than one big jump.
function render(bitmap, crop, tw, th) {
  let source = bitmap;
  let { x: sx, y: sy, width: sw, height: sh } = crop;

  while (sw / 2 >= tw && sh / 2 >= th) {
    const w = Math.max(tw, Math.round(sw / 2));
    const h = Math.max(th, Math.round(sh / 2));
    const step = new OffscreenCanvas(w, h);
    context(step).drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
    source = step; sx = 0; sy = 0; sw = w; sh = h;
  }

  const out = new OffscreenCanvas(tw, th);
  const ctx = context(out, { willReadFrequently: true });
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, tw, th);
  return ctx.getImageData(0, 0, tw, th);
}

self.onmessage = async ({ data }) => {
  const { file, crop, settings } = data;
  let bitmap;
  try {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error("Your browser can't read this file format.");
    }
    const srcWidth = bitmap.width;
    const srcHeight = bitmap.height;
    const region = clampCrop(crop, srcWidth, srcHeight);
    const { width, height } = targetSize(region.width, region.height, settings.resize);
    const imageData = render(bitmap, region, width, height);
    bitmap.close();
    bitmap = null;

    const buffer = await encode(imageData, encodeOptions(settings));
    self.postMessage({ ok: true, buffer, width, height, srcWidth, srcHeight }, [buffer]);
  } catch (err) {
    bitmap?.close();
    self.postMessage({ ok: false, error: err?.message || String(err) });
  }
};
