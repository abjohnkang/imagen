const $ = (id) => document.getElementById(id);

const fields = ["prompt", "negative", "steps", "cfg", "width", "height", "seed"];

let MODELS = [];
let initImage = null; // filename of the img2img starting image, or null

// The gallery as last loaded (newest first), plus which image is "open" in the
// preview. Tracked by id rather than index so the selection survives the
// reloads that happen after every generation (which renumber the grid).
let galleryItems = [];
let selectedId = null;

// Filename currently shown in the big preview (for the "Save image" button).
let currentPreview = null;
// Ids ticked for "Download selected" (a multi-select, separate from the single
// preview-open image above). Held by id so it survives gallery reloads.
let selected = new Set();
// The last thumbnail picked, the anchor for Shift+Click range selection. By id
// (not index) so it stays valid after the grid renumbers on a reload.
let lastPickId = null;

// The client-side view of the generation queue. Each prompt you submit is sent
// to the server right away — the server runs them one at a time, FIFO — and
// gets a row here so you can line up several without waiting. Finished and
// cancelled jobs drop off automatically; failed ones stay until you dismiss them.
//   { jobId, label, status, step, total, seed, filename, error, cancelling }
let queue = [];

async function init() {
  try {
    const info = await (await fetch("/api/models")).json();
    $("device").textContent = `device: ${info.device}`;
    MODELS = info.models || [];
    const sel = $("model");
    sel.innerHTML = "";
    for (const m of MODELS) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === info.default) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", applyModelDefaults);
    applyModelDefaults();
  } catch {}
  loadGallery();
}

// When the model changes, snap size and sampler settings to that model's
// recommended values. This matters most for Turbo, which only looks right at
// ~4 steps with guidance disabled (cfg 0).
function applyModelDefaults() {
  const m = MODELS.find((x) => x.id === $("model").value);
  if (!m) return;
  if (m.size) {
    $("width").value = m.size;
    $("height").value = m.size;
  }
  if (m.steps != null) $("steps").value = m.steps;
  if (m.cfg != null) $("cfg").value = m.cfg;
  if (m.negative != null) $("negative").value = m.negative;
}

function readParams() {
  return {
    prompt: $("prompt").value,
    negative: $("negative").value,
    steps: parseInt($("steps").value, 10),
    cfg: parseFloat($("cfg").value),
    width: parseInt($("width").value, 10),
    height: parseInt($("height").value, 10),
    seed: parseInt($("seed").value, 10),
    model: $("model").value,
    init_image: initImage || "",
    strength: parseFloat($("strength").value),
  };
}

// img2img: start the next generation from an existing image instead of noise.
function setInitImage(filename) {
  initImage = filename;
  $("init-thumb").src = `/api/outputs/${filename}`;
  $("init-row").hidden = false;
}

function clearInitImage() {
  initImage = null;
  $("init-row").hidden = true;
}

async function generate() {
  const params = readParams();
  if (!params.prompt.trim()) {
    $("status").textContent = "Enter a prompt first.";
    return;
  }

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const { job_id } = await res.json();

  const item = {
    jobId: job_id,
    label: params.prompt.trim(),
    status: "queued",
    step: 0,
    total: 0,
  };
  queue.push(item);
  renderQueue();
  watch(item);
}

// Cancel a job that's still queued or running. The server flips it to
// "cancelled" and the WebSocket reports back; `cancelling` shows interim
// feedback meanwhile (the socket keeps streaming the old status until then).
async function cancelItem(item) {
  item.cancelling = true;
  renderQueue();
  await fetch(`/api/jobs/${item.jobId}/cancel`, { method: "POST" });
}

// Drop a finished (failed/cancelled) row from the list.
function dismissItem(item) {
  queue = queue.filter((q) => q !== item);
  renderQueue();
}

// One WebSocket per job streams its progress. The server processes jobs FIFO,
// so queued rows simply wait their turn while their socket reports "queued".
function watch(item) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/progress/${item.jobId}`);

  ws.onmessage = (ev) => {
    const job = JSON.parse(ev.data);
    Object.assign(item, {
      status: job.status,
      step: job.step,
      total: job.total,
      seed: job.seed,
      filename: job.filename,
      error: job.error,
    });

    if (job.status === "done") {
      // The finished image is now in the gallery; preview the latest and drop
      // this row from the queue.
      showImage(job.filename);
      loadGallery();
      queue = queue.filter((q) => q !== item);
      ws.close();
    } else if (job.status === "cancelled") {
      // "cancelling…" is just interim feedback; once the server confirms the
      // cancel, drop the row entirely rather than leaving a "cancelled" entry.
      queue = queue.filter((q) => q !== item);
      ws.close();
    } else if (job.status === "error") {
      ws.close();
    }
    renderQueue();
  };
  ws.onerror = () => {
    item.status = "error";
    item.error = "connection lost";
    renderQueue();
  };
}

// Rebuild the queue list and drive the headline status/progress bar from
// whichever job is currently running.
function renderQueue() {
  const list = $("queue");
  list.innerHTML = "";
  for (const item of queue) list.append(queueRow(item));

  const running = queue.find((q) => q.status === "running");
  const waiting = queue.filter((q) => q.status === "queued").length;
  if (running) {
    const pct = running.total ? Math.round((running.step / running.total) * 100) : 0;
    $("status").textContent =
      `Generating… ${running.step}/${running.total}` + (waiting ? ` · ${waiting} queued` : "");
    $("bar").style.width = pct + "%";
  } else if (waiting) {
    $("status").textContent = `${waiting} queued…`;
    $("bar").style.width = "0";
  } else {
    $("status").textContent = "";
    $("bar").style.width = "0";
  }
}

function queueRow(item) {
  const row = document.createElement("div");
  row.className = `qitem ${item.status}`;

  const label = document.createElement("div");
  label.className = "qlabel";
  label.textContent = item.label;
  label.title = item.label;

  const state = document.createElement("span");
  state.className = "qstate";
  const active = item.status === "queued" || item.status === "running";
  if (item.cancelling && active) state.textContent = "cancelling…";
  else if (item.status === "running") state.textContent = `${item.step}/${item.total}`;
  else if (item.status === "queued") state.textContent = "queued";
  else if (item.status === "error") state.textContent = "failed";
  else if (item.status === "cancelled") state.textContent = "cancelled";

  const btn = document.createElement("button");
  btn.className = "qx ghost";
  btn.textContent = active ? "Cancel" : "✕";
  btn.title = active ? "Cancel this job" : "Dismiss";
  btn.disabled = Boolean(item.cancelling && active);
  btn.onclick = () => (active ? cancelItem(item) : dismissItem(item));

  row.append(label, state, btn);
  return row;
}

function showImage(filename) {
  const img = $("preview");
  img.src = `/api/outputs/${filename}?t=${Date.now()}`;
  img.style.display = "block";
  currentPreview = filename;
  $("download-current").hidden = false;
}

async function loadGallery() {
  const items = await (await fetch("/api/gallery")).json();
  galleryItems = items;
  // Forget any ticked images that no longer exist (e.g. just deleted).
  selected = new Set([...selected].filter((id) => items.some((it) => it.id === id)));
  const gal = $("gallery");
  gal.innerHTML = "";
  for (const [i, it] of items.entries()) {
    const fig = document.createElement("figure");
    fig.dataset.id = it.id;

    const img = document.createElement("img");
    img.src = `/api/outputs/${it.filename}`;
    img.title = it.prompt;
    img.onclick = () => selectImage(i);

    const pick = document.createElement("button");
    pick.className = "pick";
    pick.title = "Select for download (Shift+Click for a range)";
    pick.onclick = (e) => {
      e.stopPropagation();
      pickAt(i, e.shiftKey);
    };

    const edit = document.createElement("button");
    edit.className = "edit";
    edit.textContent = "✎";
    edit.title = "Use as starting image (img2img)";
    edit.onclick = (e) => {
      e.stopPropagation();
      useAsInit(it);
    };

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.onclick = (e) => {
      e.stopPropagation();
      removeImage(it.id, it.filename);
    };

    fig.append(img, pick, edit, del);
    gal.append(fig);
  }
  highlightSelected();
  renderSelection();
}

// Open a gallery image by its index: apply its settings, show it in the
// preview, and remember it so the arrow keys can step from here. Never scrolls
// the page — selecting a photo (by click, checkbox, or arrow key) updates the
// preview in place rather than yanking the view around.
function selectImage(index) {
  const it = galleryItems[index];
  if (!it) return;
  selectedId = it.id;
  applySettings(it);
  highlightSelected();
}

// Mark the currently open image in the grid. We deliberately don't scroll it
// into view: arrow-key browsing keeps you at the top looking at the large
// preview, so pulling the page down to the gallery would be disruptive.
function highlightSelected() {
  const figs = $("gallery").children;
  for (let i = 0; i < figs.length; i++) {
    const on = galleryItems[i] && galleryItems[i].id === selectedId;
    figs[i].classList.toggle("selected", on);
  }
}

// -- multi-select & downloads --------------------------------------------

// Pick a thumbnail at `index`. A plain click toggles just that one; Shift+Click
// adds the whole contiguous range between the last pick and this one (resolving
// the anchor by id, so it survives reloads). Either way this becomes the new
// anchor for the next Shift+Click.
function pickAt(index, shiftKey) {
  const it = galleryItems[index];
  if (!it) return;
  const anchor = lastPickId === null ? -1 : galleryItems.findIndex((x) => x.id === lastPickId);
  if (shiftKey && anchor !== -1) {
    const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
    for (let i = a; i <= b; i++) selected.add(galleryItems[i].id);
  } else if (selected.has(it.id)) {
    selected.delete(it.id);
  } else {
    selected.add(it.id);
  }
  lastPickId = it.id;
  // A mouse pick also opens the photo in the big preview (without scrolling).
  selectImage(index);
  renderSelection();
}

function clearSelection() {
  selected.clear();
  lastPickId = null;
  renderSelection();
}

// Reflect the current selection in the grid (checkmarks + outlines) and the
// gallery toolbar (count + show/hide). Reads ids off each figure's dataset so
// it works without rebuilding the DOM.
function renderSelection() {
  for (const fig of $("gallery").children) {
    const on = selected.has(fig.dataset.id);
    fig.classList.toggle("checked", on);
    const pick = fig.querySelector(".pick");
    if (pick) pick.textContent = on ? "✓" : "";
  }
  const n = selected.size;
  $("gallery-actions").hidden = n === 0;
  $("sel-count").textContent = n ? `${n} selected` : "";
}

// Open the browser's "choose location" dialog when supported (Chromium over
// localhost), returning a file handle. null = the user cancelled (caller should
// abort); undefined = unsupported (caller falls back to a normal download).
async function pickSaveHandle(suggestedName) {
  if (!window.showSaveFilePicker) return undefined;
  try {
    return await window.showSaveFilePicker({ suggestedName });
  } catch (e) {
    return e.name === "AbortError" ? null : undefined;
  }
}

// Write a blob to the chosen handle, or fall back to a normal browser download
// (to the default location) when no handle was obtained.
async function writeBlob(handle, blob, suggestedName) {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Save the image currently shown in the preview to a location of your choice.
async function downloadCurrent() {
  if (!currentPreview) return;
  // Open the picker BEFORE fetching so the click's user-gesture isn't lost.
  const handle = await pickSaveHandle(currentPreview);
  if (handle === null) return;
  const blob = await (await fetch(`/api/outputs/${encodeURIComponent(currentPreview)}`)).blob();
  await writeBlob(handle, blob, currentPreview);
}

// Download the ticked images. Default is individual PNGs; tick "as .zip" to get
// one bundle instead.
async function downloadSelected() {
  const filenames = galleryItems.filter((it) => selected.has(it.id)).map((it) => it.filename);
  if (!filenames.length) return;
  if ($("zip-option").checked) await downloadSelectedZip(filenames);
  else await downloadSelectedPngs(filenames);
}

// Save each PNG separately. Where supported (Chromium), pick a folder once and
// write them all into it; otherwise fall back to one download per file.
async function downloadSelectedPngs(filenames) {
  if (window.showDirectoryPicker) {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      if (e.name === "AbortError") return; // cancelled
      dir = null; // unsupported/denied → fall through to per-file downloads
    }
    if (dir) {
      for (const name of filenames) {
        const blob = await (await fetch(`/api/outputs/${encodeURIComponent(name)}`)).blob();
        const handle = await dir.getFileHandle(name, { create: true });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
      }
      return;
    }
  }
  // Fallback: trigger a normal download for each file (goes to the default
  // location). The small gap keeps browsers from coalescing/dropping them.
  for (const name of filenames) {
    const a = document.createElement("a");
    a.href = `/api/outputs/${encodeURIComponent(name)}`;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Zip every ticked image (server-side) and save the bundle in one go.
async function downloadSelectedZip(filenames) {
  const name = "imagen-images.zip";
  const handle = await pickSaveHandle(name);
  if (handle === null) return;
  const res = await fetch("/api/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filenames }),
  });
  if (!res.ok) {
    $("status").textContent = "Download failed.";
    return;
  }
  await writeBlob(handle, await res.blob(), name);
}

// How many columns the responsive grid is currently showing: count the figures
// sharing the top row's offset. Used so Up/Down step by a full row at any width.
function galleryColumns() {
  const figs = $("gallery").children;
  if (!figs.length) return 1;
  const top = figs[0].offsetTop;
  let cols = 0;
  for (const f of figs) {
    if (f.offsetTop !== top) break;
    cols++;
  }
  return Math.max(1, cols);
}

// Step through the gallery with the arrow keys. The grid is newest-first and
// reads left-to-right, so ArrowRight moves to the next (older) image and
// ArrowLeft to the previous (newer) one; Up/Down move a whole row at a time.
// With nothing open yet, the first press opens an end of the list.
function navigateGallery(delta) {
  if (!galleryItems.length) return;
  const idx = galleryItems.findIndex((it) => it.id === selectedId);
  let next;
  if (idx === -1) next = delta > 0 ? 0 : galleryItems.length - 1;
  else next = Math.max(0, Math.min(galleryItems.length - 1, idx + delta));
  selectImage(next);
}

// Shift+Arrow: move the focus the same way, but ALSO tick every photo stepped
// over (inclusive of both ends) for download — the keyboard twin of Shift+Click.
// Like Shift+Click it only adds; use Clear or individual clicks to remove.
function extendSelection(delta) {
  if (!galleryItems.length) return;
  let idx = galleryItems.findIndex((it) => it.id === selectedId);
  let next;
  if (idx === -1) {
    next = delta > 0 ? 0 : galleryItems.length - 1;
    idx = next;
  } else {
    next = Math.max(0, Math.min(galleryItems.length - 1, idx + delta));
  }
  const [a, b] = idx < next ? [idx, next] : [next, idx];
  for (let i = a; i <= b; i++) selected.add(galleryItems[i].id);
  lastPickId = galleryItems[next].id;
  selectImage(next);
  renderSelection();
}

function applySettings(it) {
  if (it.model && MODELS.some((m) => m.id === it.model)) $("model").value = it.model;
  $("prompt").value = it.prompt || "";
  $("negative").value = it.negative || "";
  $("steps").value = it.steps;
  $("cfg").value = it.cfg;
  $("width").value = it.width;
  $("height").value = it.height;
  $("seed").value = it.seed;
  // Restore the img2img strength if this image was made with one; the slider
  // and its label are otherwise left at whatever they were.
  if (it.strength != null) {
    $("strength").value = it.strength;
    $("strength-val").textContent = parseFloat(it.strength).toFixed(2);
  }
  showImage(it.filename);
}

// Load an existing generation's settings AND set it as the img2img base, so
// you can tweak the prompt (e.g. "...sitting...") and nudge just that image.
function useAsInit(it) {
  applySettings(it);
  setInitImage(it.filename);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function removeImage(id, filename) {
  await fetch(`/api/gallery/${id}`, { method: "DELETE" });
  // If the deleted image was the current img2img base, drop the dangling ref.
  if (filename && filename === initImage) clearInitImage();
  loadGallery();
}

// Arrow keys browse the gallery: left/right by one image, up/down by a whole
// row. Holding Shift extends the download selection instead of just moving.
// Only when the user isn't typing in a field or dragging the strength slider,
// where arrows have their own meaning.
document.addEventListener("keydown", (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  let delta;
  if (e.key === "ArrowLeft") delta = -1;
  else if (e.key === "ArrowRight") delta = 1;
  else if (e.key === "ArrowUp") delta = -galleryColumns();
  else if (e.key === "ArrowDown") delta = galleryColumns();
  else return;
  e.preventDefault();
  if (e.shiftKey) extendSelection(delta);
  else navigateGallery(delta);
});

$("go").addEventListener("click", generate);
$("clear-init").addEventListener("click", clearInitImage);
$("download-current").addEventListener("click", downloadCurrent);
$("download-selected").addEventListener("click", downloadSelected);
$("clear-selection").addEventListener("click", clearSelection);
$("strength").addEventListener("input", () => {
  $("strength-val").textContent = parseFloat($("strength").value).toFixed(2);
});
init();
