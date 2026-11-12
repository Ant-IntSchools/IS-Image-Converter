// Shared by the page (to preview output dimensions) and the worker (to render).

export const MAX_DIM = 16383; // largest width/height a WebP image can have

const clampDim = (n) => Math.min(MAX_DIM, Math.max(1, Math.round(n)));
const positive = (n) => Number.isFinite(n) && n > 0;

/**
 * Work out the output size for a source of w × h pixels.
 * @param {number} w
 * @param {number} h
 * @param {{mode: string, percent: number, width: number, height: number, noUpscale: boolean}} r
 */
export function targetSize(w, h, r) {
  let tw = w;
  let th = h;

  switch (r.mode) {
    case 'percent':
      if (positive(r.percent)) { tw = (w * r.percent) / 100; th = (h * r.percent) / 100; }
      break;
    case 'width':
      if (positive(r.width)) { tw = r.width; th = (h * r.width) / w; }
      break;
    case 'height':
      if (positive(r.height)) { th = r.height; tw = (w * r.height) / h; }
      break;
    case 'fit':
      if (positive(r.width) && positive(r.height)) {
        const s = Math.min(r.width / w, r.height / h);
        tw = w * s; th = h * s;
      }
      break;
    case 'exact':
      if (positive(r.width) && positive(r.height)) { tw = r.width; th = r.height; }
      break;
  }

  if (r.noUpscale && r.mode !== 'exact' && (tw > w || th > h)) {
    tw = w; th = h;
  }

  // Keep within WebP's limit without distorting the ratio.
  const over = Math.max(tw / MAX_DIM, th / MAX_DIM);
  if (over > 1) { tw /= over; th /= over; }

  return { width: clampDim(tw), height: clampDim(th) };
}
