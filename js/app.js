import { targetSize } from './resize.js';
import { initViewer } from './viewer.js';

/* ---------- Constants & helpers ---------- */

const IMAGE_EXT = /\.(png|jpe?g|jfif|pjpeg|gif|bmp|webp|avif|ico|tiff?|heic|heif)$/i;
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg',
  gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
};
const SETTINGS_KEY = 'webp-converter-settings';
const STATUS_LABELS = { pending: 'Waiting', working: 'Converting', done: 'Done', error: 'Error' };
const WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

const $ = (sel, root = document) => root.querySelector(sel);

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

function percentChange(from, to) {
  const raw = ((to - from) / from) * 100;
  // Avoid showing "−100%" for a file that still has some size.
  const pct = Math.abs(raw) >= 99.5 && to > 0 ? raw.toFixed(1) : String(Math.round(raw));
  return raw <= 0 ? `−${pct.replace('-', '')}%` : `+${pct}%`;
}

const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'image';

function uniqueName(name, used) {
  let candidate = name;
  let n = 1;
  while (used.has(candidate.toLowerCase())) {
    candidate = name.replace(/(\.webp)$/i, `-${n++}$1`);
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function isZip(file) {
  return /\.zip$/i.test(file.name) || ['application/zip', 'application/x-zip-compressed'].includes(file.type);
}

function isImage(file) {
  if (file.type === 'image/svg+xml') return false;
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------- Elements ---------- */

const form = $('#settings');
const fileInput = $('#file-input');
const dropzone = $('#dropzone');
const list = $('#list');
const toolbar = $('#toolbar');
const summary = $('#summary');
const notice = $('#notice');
const convertBtn = $('#convert-btn');
const downloadAllBtn = $('#download-all-btn');
const clearBtn = $('#clear-btn');
const cardTemplate = $('#card-template');

/* ---------- State ---------- */

/**
 * @typedef {{
 *   id: number, file: File, name: string, outName: string, srcUrl: string,
 *   width: number, height: number, crop: null | {x:number,y:number,width:number,height:number},
 *   status: 'pending'|'working'|'done'|'error', rev: number, error: string|null,
 *   output: null | {blob: Blob, url: string, width: number, height: number},
 *   el: HTMLLIElement
 * }} Item
 */

/** @type {Item[]} */
let items = [];
let nextId = 1;
let manualRun = false;
let settings = readSettings();
const viewer = initViewer({ getItems: () => items, formatBytes });

/* ---------- Settings ---------- */

function readSettings() {
  const f = form.elements;
  const num = (el) => {
    const v = parseInt(el.value, 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return {
    lossless: f.mode.value === 'lossless',
    quality: +f.quality.value,
    level: +f.level.value,
    resize: {
      mode: f.resizeMode.value,
      percent: num(f.percent),
      width: num(f.width),
      height: num(f.height),
      noUpscale: f.noUpscale.checked,
    },
  };
}

function readRename() {
  const f = form.elements;
  const int = (el, fallback, min) => {
    const v = parseInt(el.value, 10);
    return Number.isFinite(v) && v >= min ? v : fallback;
  };
  return {
    nameMode: f.nameMode.value,
    fixedName: f.fixedName.value,
    find: f.find.value,
    replace: f.replace.value,
    regex: f.regex.checked,
    matchCase: f.matchCase.checked,
    prefix: f.prefix.value,
    suffix: f.suffix.value,
    seq: f.seq.checked,
    seqStart: int(f.seqStart, 1, 0),
    seqStep: int(f.seqStep, 1, 1),
    seqDigits: Math.min(10, int(f.seqDigits, 1, 1)),
    seqPos: f.seqPos.value,
    seqSep: f.seqSep.value,
  };
}

function syncSettingsUI() {
  const f = form.elements;
  const mode = f.mode.value;
  for (const el of form.querySelectorAll('[data-show]')) el.hidden = el.dataset.show !== mode;
  $('#quality-out').textContent = f.quality.value;
  $('#level-out').textContent = f.level.value;
  for (const range of form.querySelectorAll('input[type="range"]')) {
    range.style.setProperty('--pct', `${((range.value - range.min) / (range.max - range.min)) * 100}%`);
  }
  const resizeMode = f.resizeMode.value;
  for (const el of form.querySelectorAll('[data-resize]')) {
    el.hidden = !el.dataset.resize.split(' ').includes(resizeMode);
  }
  for (const el of form.querySelectorAll('[data-name-mode]')) el.hidden = el.dataset.nameMode !== f.nameMode.value;
  $('[data-seq]', form).hidden = !f.seq.checked;
  $('[data-regex-hint]', form).hidden = !f.regex.checked;
}

// Every named field is saved, so new options are remembered automatically.
function saveSettings() {
  const data = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
    else data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

function restoreSettings() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { data = null; }
  if (!data || typeof data !== 'object') return;
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    const v = data[el.name];
    if (el.type === 'radio') el.checked = el.value === v;
    else if (el.type === 'checkbox') { if (typeof v === 'boolean') el.checked = v; }
    else if (typeof v === 'string') el.value = v;
  }
}

let settingsTimer;
function onSettingsChange(e) {
  syncSettingsUI();
  saveSettings();
  if (e.target.name === 'auto') {
    updateToolbar();
    pump();
    return;
  }
  // Renaming only changes output filenames, so nothing needs re-encoding.
  if (e.target.closest('[data-rename]')) {
    applyNames();
    return;
  }
  // Update the previewed output sizes right away, re-encode after a short pause.
  settings = readSettings();
  for (const item of items) renderItem(item);
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    for (const item of items) invalidate(item, false);
    pump();
  }, 350);
}

/* ---------- Renaming ---------- */

const regexError = $('#regex-error');
const renamePreview = $('#rename-preview');

// Characters Windows, macOS and Linux don't allow in file names.
const sanitizeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().replace(/[. ]+$/, '');

function buildMatcher(r) {
  regexError.hidden = true;
  if (r.nameMode !== 'keep' || !r.find) return null;
  const flags = r.matchCase ? 'g' : 'gi';
  if (!r.regex) {
    const escaped = r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // In plain mode "$" in the replacement is literal text.
    return { re: new RegExp(escaped, flags), replacement: r.replace.replace(/\$/g, '$$$$') };
  }
  try {
    return { re: new RegExp(r.find, flags), replacement: r.replace };
  } catch (err) {
    regexError.textContent = `Invalid pattern: ${err.message.replace(/^Invalid regular expression: (\/.*\/[a-z]*: )?/, '')}`;
    regexError.hidden = false;
    return null;
  }
}

function buildName(original, index, r, matcher) {
  let name = baseName(original);
  if (r.nameMode === 'fixed') name = r.fixedName;
  else if (r.nameMode === 'remove') name = '';
  else if (matcher) name = name.replace(matcher.re, matcher.replacement);

  name = r.prefix + name + r.suffix;

  if (r.seq) {
    const n = String(r.seqStart + index * r.seqStep).padStart(r.seqDigits, '0');
    const sep = name ? r.seqSep : '';
    name = r.seqPos === 'start' ? n + sep + name : name + sep + n;
  }
  return `${sanitizeName(name) || 'image'}.webp`;
}

/** Recalculate every output name, in list order, keeping them unique. */
function applyNames() {
  const r = readRename();
  const matcher = buildMatcher(r);
  const used = new Set();
  items.forEach((item, i) => {
    item.outName = uniqueName(buildName(item.name, i, r, matcher), used);
  });
  for (const item of items) renderItem(item);

  const sample = items[0]?.name || 'photo.jpg';
  const out = items[0]?.outName || buildName(sample, 0, r, matcher);
  renamePreview.replaceChildren(
    Object.assign(document.createElement('span'), { textContent: sample }),
    ' → ',
    Object.assign(document.createElement('strong'), { textContent: out }),
  );
}

/* ---------- Worker pool ---------- */

/** @type {{worker: Worker, job: null | {item: Item, rev: number}}[]} */
const pool = [];

function createSlot() {
  const slot = { worker: new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), job: null };
  slot.worker.onmessage = (e) => onWorkerResult(slot, e.data);
  slot.worker.onerror = (e) => {
    e.preventDefault();
    // The worker itself failed (e.g. out of memory). Replace it and report the error.
    const job = slot.job;
    slot.worker.terminate();
    pool.splice(pool.indexOf(slot), 1);
    if (job && items.includes(job.item) && job.item.rev === job.rev) {
      job.item.status = 'error';
      job.item.error = 'The encoder stopped unexpectedly. The image may be too large.';
      renderItem(job.item);
    }
    pump();
  };
  pool.push(slot);
  return slot;
}

function idleSlot() {
  return pool.find((s) => !s.job) || (pool.length < WORKER_COUNT ? createSlot() : null);
}

function pump() {
  const shouldRun = form.elements.auto.checked || manualRun;
  while (shouldRun) {
    const item = items.find((i) => i.status === 'pending');
    if (!item) break;
    const slot = idleSlot();
    if (!slot) break;
    item.status = 'working';
    slot.job = { item, rev: item.rev };
    slot.worker.postMessage({ file: item.file, crop: item.crop, settings });
    renderItem(item);
  }
  if (!items.some((i) => i.status === 'pending' || i.status === 'working')) manualRun = false;
  updateToolbar();
}

function onWorkerResult(slot, data) {
  const { item, rev } = slot.job;
  slot.job = null;
  // Ignore results for removed items or items whose settings changed mid-encode.
  if (items.includes(item) && item.rev === rev) {
    if (data.ok) {
      const blob = new Blob([data.buffer], { type: 'image/webp' });
      item.output = { blob, url: URL.createObjectURL(blob), width: data.width, height: data.height };
      item.width = data.srcWidth;
      item.height = data.srcHeight;
      item.status = 'done';
    } else {
      item.status = 'error';
      item.error = data.error;
    }
    renderItem(item);
  }
  pump();
}

/* ---------- Items ---------- */

function clearOutput(item) {
  if (item.output) URL.revokeObjectURL(item.output.url);
  item.output = null;
}

function invalidate(item, runPump = true) {
  item.rev++;
  clearOutput(item);
  item.status = 'pending';
  item.error = null;
  renderItem(item);
  if (runPump) pump();
}

function addImage(file) {
  const el = cardTemplate.content.firstElementChild.cloneNode(true);
  /** @type {Item} */
  const item = {
    id: nextId++, file, name: file.name || 'pasted-image', outName: `${baseName(file.name || 'pasted-image')}.webp`,
    srcUrl: URL.createObjectURL(file), width: 0, height: 0, crop: null,
    status: 'pending', rev: 0, error: null, output: null, el,
  };
  el.dataset.id = String(item.id);
  const img = $('.thumb img', el);
  img.addEventListener('load', () => {
    if (!item.width) { item.width = img.naturalWidth; item.height = img.naturalHeight; renderItem(item); }
  }, { once: true });
  img.src = item.srcUrl;
  items.push(item);
  list.append(el);
  renderItem(item);
}

function removeItem(item) {
  clearOutput(item);
  URL.revokeObjectURL(item.srcUrl);
  item.el.remove();
  items = items.filter((i) => i !== item);
  applyNames(); // sequence numbers close the gap
  updateToolbar();
}

function clearAll() {
  for (const item of items) { clearOutput(item); URL.revokeObjectURL(item.srcUrl); }
  items = [];
  list.replaceChildren();
  manualRun = false;
  hideNotice();
  applyNames();
  updateToolbar();
}

function renderItem(item) {
  const el = item.el;
  el.dataset.status = item.status;
  $('.name', el).textContent = item.outName;
  $('.name', el).title = item.outName;
  // Show the original name when renaming has changed more than the extension.
  const orig = $('.orig', el);
  const renamed = item.outName !== `${baseName(item.name)}.webp`;
  orig.hidden = !renamed;
  orig.textContent = renamed ? `from ${item.name}` : '';
  orig.title = item.name;
  $('.crop-badge', el).hidden = !item.crop;
  // Show the converted result once ready, so crops are visible in the thumbnail.
  const thumb = $('.thumb img', el);
  const thumbSrc = item.status === 'done' ? item.output.url : item.srcUrl;
  if (thumb.getAttribute('src') !== thumbSrc) thumb.src = thumbSrc;

  const srcDims = item.width ? `${item.width}×${item.height}` : '…';
  $('.src-meta', el).textContent = `${srcDims} · ${formatBytes(item.file.size)}`;

  const out = $('.out-meta', el);
  out.classList.remove('good', 'bad', 'err');
  if (item.status === 'done') {
    const { width, height, blob } = item.output;
    out.textContent = `→ ${width}×${height} · ${formatBytes(blob.size)} (${percentChange(item.file.size, blob.size)})`;
    out.classList.add(blob.size <= item.file.size ? 'good' : 'bad');
  } else if (item.status === 'error') {
    out.textContent = item.error;
    out.classList.add('err');
  } else {
    let dims = '';
    if (item.width) {
      const w = item.crop ? item.crop.width : item.width;
      const h = item.crop ? item.crop.height : item.height;
      const t = targetSize(w, h, settings.resize);
      dims = `→ ${t.width}×${t.height} · `;
    }
    out.textContent = dims ? dims.slice(0, -3) : '';
  }
  $('.status', el).textContent = STATUS_LABELS[item.status];

  const dl = $('[data-action="download"]', el);
  if (item.status === 'done') {
    dl.href = item.output.url;
    dl.download = item.outName;
    dl.removeAttribute('aria-disabled');
  } else {
    dl.removeAttribute('href');
    dl.setAttribute('aria-disabled', 'true');
  }
  viewer.refresh(item);
  updateToolbar();
}

function updateToolbar() {
  toolbar.hidden = items.length === 0;
  const done = items.filter((i) => i.status === 'done');
  const pending = items.filter((i) => i.status === 'pending' || i.status === 'error').length;
  const working = items.some((i) => i.status === 'working');

  let text = `${items.length} image${items.length === 1 ? '' : 's'}`;
  if (done.length) {
    const before = done.reduce((s, i) => s + i.file.size, 0);
    const after = done.reduce((s, i) => s + i.output.blob.size, 0);
    text += ` · ${done.length} converted · ${formatBytes(before)} → ${formatBytes(after)} (${percentChange(before, after)})`;
  }
  if (working) text += ' · converting…';
  summary.textContent = text;

  convertBtn.hidden = form.elements.auto.checked && !items.some((i) => i.status === 'error');
  convertBtn.disabled = pending === 0;
  convertBtn.textContent = pending ? `Convert ${pending}` : 'Convert';
  downloadAllBtn.disabled = done.length === 0;
  downloadAllBtn.textContent = done.length > 1 ? `Download all (.zip)` : 'Download';
}

/* ---------- Adding files ---------- */

function showNotice(text) { notice.textContent = text; notice.hidden = false; }
function hideNotice() { notice.hidden = true; notice.textContent = ''; }

async function addZip(file) {
  if (typeof JSZip === 'undefined') throw new Error('Zip support failed to load.');
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(
    (e) => !e.dir && IMAGE_EXT.test(e.name) && !/(^|\/)(__MACOSX\/|\.)/.test(e.name),
  );
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const entry of entries) {
    const blob = await entry.async('blob');
    const name = entry.name.split('/').pop();
    addImage(new File([blob], name, { type: MIME_BY_EXT[extOf(name)] || '' }));
  }
  return entries.length;
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  hideNotice();
  const problems = [];
  let skipped = 0;
  for (const file of files) {
    if (isZip(file)) {
      try {
        const count = await addZip(file);
        if (!count) problems.push(`No images found in ${file.name}.`);
      } catch {
        problems.push(`Couldn't open ${file.name}.`);
      }
    } else if (isImage(file)) {
      addImage(file);
    } else {
      skipped++;
    }
    applyNames();
    pump();
  }
  if (skipped) problems.push(`Skipped ${skipped} file${skipped === 1 ? '' : 's'} that ${skipped === 1 ? "isn't an image" : "aren't images"}.`);
  if (problems.length) showNotice(problems.join(' '));
}

/* ---------- Download all ---------- */

async function downloadAll() {
  const done = items.filter((i) => i.status === 'done');
  if (!done.length) return;
  if (done.length === 1) {
    triggerDownload(done[0].output.url, done[0].outName);
    return;
  }
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = 'Zipping…';
  try {
    const zip = new JSZip();
    const used = new Set();
    for (const item of done) zip.file(uniqueName(item.outName, used), item.output.blob);
    // WebP is already compressed, so store the files as-is.
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, 'webp-images.zip');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    showNotice("Couldn't create the zip file.");
  } finally {
    updateToolbar();
  }
}

/* ---------- Cropping ---------- */

const cropDialog = $('#crop-dialog');
const cropImg = $('#crop-img');
const cropSize = $('#crop-size');
const aspectButtons = $('#aspect-buttons');
let cropper = null;
/** @type {Item|null} */
let cropItem = null;

function setAspectPressed(btn) {
  for (const b of aspectButtons.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
}

async function openCrop(item) {
  if (typeof Cropper === 'undefined') { showNotice('Cropping failed to load.'); return; }
  cropItem = item;
  setAspectPressed(aspectButtons.querySelector('[data-ratio=""]'));
  cropSize.textContent = '';
  cropImg.src = item.srcUrl;
  cropDialog.showModal();
  try { await cropImg.decode(); } catch { /* handled below */ }
  if (cropItem !== item || !cropDialog.open) return;
  if (!cropImg.naturalWidth) {
    cropDialog.close();
    showNotice(`Your browser can't display ${item.name}, so it can't be cropped.`);
    return;
  }
  cropper = new Cropper(cropImg, {
    viewMode: 1,
    autoCropArea: 1,
    checkOrientation: false, // the browser already applies EXIF orientation
    zoomable: false,
    background: true,
    ready() { if (item.crop) cropper.setData(item.crop); },
    crop(e) { cropSize.textContent = `${Math.round(e.detail.width)} × ${Math.round(e.detail.height)} px`; },
  });
}

function applyCrop() {
  if (!cropper || !cropItem) return;
  const d = cropper.getData(true);
  const { naturalWidth: w, naturalHeight: h } = cropImg;
  const full = d.x <= 0 && d.y <= 0 && d.width >= w && d.height >= h;
  cropItem.crop = full ? null : { x: d.x, y: d.y, width: d.width, height: d.height };
  const item = cropItem;
  cropDialog.close();
  invalidate(item);
}

function removeCrop() {
  const item = cropItem;
  cropDialog.close();
  if (item?.crop) { item.crop = null; invalidate(item); }
}

cropDialog.addEventListener('close', () => {
  cropper?.destroy();
  cropper = null;
  cropItem = null;
  cropImg.removeAttribute('src');
});
aspectButtons.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || !cropper) return;
  setAspectPressed(btn);
  cropper.setAspectRatio(btn.dataset.ratio ? parseFloat(btn.dataset.ratio) : NaN);
});
$('#crop-apply').addEventListener('click', applyCrop);
$('#crop-cancel').addEventListener('click', () => cropDialog.close());
$('#crop-remove').addEventListener('click', removeCrop);

/* ---------- Events ---------- */

form.addEventListener('input', onSettingsChange);
form.addEventListener('change', onSettingsChange);
form.addEventListener('submit', (e) => e.preventDefault());

fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropzone.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('dragging');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    // Pasted images are often all called "image.png"; give them distinct names.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    addFiles(files.map((f, i) => new File([f], `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${extOf(f.name) || 'png'}`, { type: f.type })));
  }
});

list.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const item = items.find((i) => String(i.id) === target.closest('.card').dataset.id);
  if (!item) return;
  if (target.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
  switch (target.dataset.action) {
    case 'view': viewer.open(item); break;
    case 'crop': openCrop(item); break;
    case 'remove': removeItem(item); break;
  }
});

convertBtn.addEventListener('click', () => {
  for (const item of items) if (item.status === 'error') invalidate(item, false);
  manualRun = true;
  pump();
});
downloadAllBtn.addEventListener('click', downloadAll);
clearBtn.addEventListener('click', clearAll);

/* ---------- Start ---------- */

if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
  $('#unsupported').hidden = false;
}
restoreSettings();
syncSettingsUI();
settings = readSettings();
applyNames();
updateToolbar();
