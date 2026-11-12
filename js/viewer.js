// Full-size image inspector with zoom and pan (mouse wheel, trackpad, pinch, drag, keyboard).

const $ = (sel, root = document) => root.querySelector(sel);
const MAX_SCALE = 32;
const PIXELATED_FROM = 2; // show crisp pixels from 200% up, to inspect compression artefacts

/**
 * @param {{ getItems: () => any[], formatBytes: (n: number) => string }} deps
 * @returns {{ open: (item: any) => void, refresh: (item: any) => void }}
 */
export function initViewer({ getItems, formatBytes }) {
  const dialog = $('#viewer');
  const stage = $('#viewer-stage');
  const img = $('#viewer-img');
  const msg = $('#viewer-msg');
  const title = $('#viewer-title');
  const info = $('#viewer-info');
  const count = $('#viewer-count');
  const prevBtn = $('#viewer-prev');
  const nextBtn = $('#viewer-next');
  const zoomLevel = $('#zoom-level');
  const zoomOutBtn = $('#zoom-out');
  const zoomInBtn = $('#zoom-in');
  const download = $('#viewer-download');
  const sourceButtons = [...$('#viewer-source').querySelectorAll('button')];

  let list = [];
  let index = 0;
  let wanted = 'output'; // which version the user asked for
  let loadToken = 0;

  // View state: image top-left at (x, y) in stage pixels, drawn at `scale`.
  let natW = 0;
  let natH = 0;
  let scale = 1;
  let x = 0;
  let y = 0;
  let fitMode = true;

  const stageSize = () => ({ w: stage.clientWidth, h: stage.clientHeight });
  const fitScale = () => {
    const { w, h } = stageSize();
    return natW && natH ? Math.min(w / natW, h / natH, 1) : 1;
  };
  const minScale = () => fitScale() / 2;

  function apply() {
    const { w, h } = stageSize();
    const dw = natW * scale;
    const dh = natH * scale;
    // Centre the image on an axis where it's smaller than the stage; otherwise keep it covering the stage.
    x = dw <= w ? (w - dw) / 2 : Math.min(0, Math.max(w - dw, x));
    y = dh <= h ? (h - dh) / 2 : Math.min(0, Math.max(h - dh, y));
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    img.classList.toggle('pixelated', scale >= PIXELATED_FROM);
    zoomLevel.textContent = `${Math.round(scale * 100)}%`;
    zoomOutBtn.disabled = scale <= minScale() + 1e-6;
    zoomInBtn.disabled = scale >= MAX_SCALE - 1e-6;
  }

  function fit() {
    fitMode = true;
    scale = fitScale();
    apply();
  }

  /** Zoom to `next`, keeping the image point under (px, py) in place. */
  function zoomTo(next, px, py) {
    const s = Math.min(MAX_SCALE, Math.max(minScale(), next));
    x = px - ((px - x) * s) / scale;
    y = py - ((py - y) * s) / scale;
    scale = s;
    fitMode = false;
    apply();
  }

  const zoomAtCentre = (factor) => {
    const { w, h } = stageSize();
    zoomTo(scale * factor, w / 2, h / 2);
  };

  function setDownload(item) {
    if (item.status === 'done') {
      download.href = item.output.url;
      download.download = item.outName;
      download.removeAttribute('aria-disabled');
    } else {
      download.removeAttribute('href');
      download.setAttribute('aria-disabled', 'true');
    }
  }

  let shownUrl = '';
  const sourceFor = (item) => (wanted === 'output' && item.status === 'done' ? 'output' : 'original');

  function updateChrome(item, source) {
    const hasOutput = item.status === 'done';
    title.textContent = item.outName;
    title.title = item.outName;
    count.textContent = list.length > 1 ? `${index + 1} / ${list.length}` : '';
    prevBtn.hidden = nextBtn.hidden = list.length < 2;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === list.length - 1;
    for (const b of sourceButtons) {
      b.setAttribute('aria-pressed', String(b.dataset.source === source));
      b.disabled = b.dataset.source === 'output' && !hasOutput;
    }
    sourceButtons[0].title = hasOutput ? '' : 'Not converted yet';
    setDownload(item);
  }

  async function show({ keepView }) {
    const item = list[index];
    if (!item) { dialog.close(); return; }
    const source = sourceFor(item);
    updateChrome(item, source);

    const token = ++loadToken;
    const url = source === 'output' ? item.output.url : item.srcUrl;
    shownUrl = url;
    msg.hidden = true;
    img.hidden = false;
    img.src = url;
    try {
      await img.decode();
    } catch {
      if (token !== loadToken) return;
      img.hidden = true;
      msg.textContent = "Your browser can't display this image.";
      msg.hidden = false;
      info.textContent = '';
      return;
    }
    if (token !== loadToken) return;

    const sameSize = img.naturalWidth === natW && img.naturalHeight === natH;
    natW = img.naturalWidth;
    natH = img.naturalHeight;
    img.style.width = `${natW}px`;
    img.style.height = `${natH}px`;

    const bytes = source === 'output' ? item.output.blob.size : item.file.size;
    info.textContent = `${source === 'output' ? 'WebP' : 'Original'} · ${natW}×${natH} · ${formatBytes(bytes)}`;

    // Switching WebP ↔ Original keeps the same zoom and position when the sizes match, for comparing.
    if (keepView && sameSize && !fitMode) apply();
    else fit();
  }

  function go(delta) {
    const next = index + delta;
    if (next < 0 || next >= list.length) return;
    index = next;
    show({ keepView: false });
  }

  /* ---------- Pointer: drag to pan, two fingers to pinch ---------- */

  const pointers = new Map();
  let last = null;

  function gesture() {
    const r = stage.getBoundingClientRect();
    const pts = [...pointers.values()];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length - r.left;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length - r.top;
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { n: pts.length, cx, cy, d };
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('dragging');
    last = gesture();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture();
    if (last && g.n === last.n) {
      if (g.n > 1 && last.d > 0) zoomTo(scale * (g.d / last.d), g.cx, g.cy);
      x += g.cx - last.cx;
      y += g.cy - last.cy;
      fitMode = false;
      apply();
    }
    last = g;
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    last = pointers.size ? gesture() : null;
    if (!pointers.size) stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const lines = e.deltaMode === 1 ? 16 : 1;
    // Trackpad pinch arrives as wheel + ctrlKey with small deltas.
    const factor = Math.exp(-e.deltaY * lines * (e.ctrlKey ? 0.01 : 0.0015));
    zoomTo(scale * factor, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  stage.addEventListener('dblclick', (e) => {
    const r = stage.getBoundingClientRect();
    if (fitMode) zoomTo(fitScale() < 1 ? 1 : 2, e.clientX - r.left, e.clientY - r.top);
    else fit();
  });

  /* ---------- Buttons & keys ---------- */

  zoomInBtn.addEventListener('click', () => zoomAtCentre(1.25));
  zoomOutBtn.addEventListener('click', () => zoomAtCentre(1 / 1.25));
  $('#zoom-fit').addEventListener('click', fit);
  $('#zoom-actual').addEventListener('click', () => {
    const { w, h } = stageSize();
    // Zoom around whatever is currently in the middle of the view.
    zoomTo(1, w / 2, h / 2);
  });
  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));
  $('#viewer-close').addEventListener('click', () => dialog.close());
  for (const b of sourceButtons) {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      wanted = b.dataset.source;
      show({ keepView: true });
    });
  }

  dialog.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case '+': case '=': zoomAtCentre(1.25); break;
      case '-': case '_': zoomAtCentre(1 / 1.25); break;
      case '0': fit(); break;
      case '1': $('#zoom-actual').click(); break;
      case 'ArrowLeft': go(-1); break;
      case 'ArrowRight': go(1); break;
      case 'o': case 'O': {
        // Quick toggle between WebP and the original.
        const other = sourceButtons.find((b) => b.getAttribute('aria-pressed') === 'false' && !b.disabled);
        if (other) other.click();
        break;
      }
      default: return;
    }
    e.preventDefault();
  });

  // Click on the dark backdrop outside the dialog closes it.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  new ResizeObserver(() => { if (dialog.open && natW) (fitMode ? fit() : apply()); }).observe(stage);

  dialog.addEventListener('close', () => {
    loadToken++;
    shownUrl = '';
    img.removeAttribute('src');
    natW = natH = 0;
    pointers.clear();
    stage.classList.remove('dragging');
  });

  return {
    /** Call when an item changes (e.g. finishes converting) so an open viewer stays current. */
    refresh(item) {
      if (!dialog.open || list[index] !== item) return;
      const source = sourceFor(item);
      const url = source === 'output' ? item.output.url : item.srcUrl;
      if (url !== shownUrl) show({ keepView: true });
      else updateChrome(item, source);
    },
    open(item) {
      list = getItems();
      index = Math.max(0, list.indexOf(item));
      wanted = 'output';
      natW = natH = 0;
      fitMode = true;
      dialog.showModal();
      stage.focus();
      show({ keepView: false });
    },
  };
}
