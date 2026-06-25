const $ = (id) => document.getElementById(id);

const fields = ["prompt", "negative", "steps", "cfg", "width", "height", "seed"];

let MODELS = [];
let initImage = null; // filename of the img2img starting image, or null

// Seed lock. Unlocked (default): every Generate rerolls a fresh random seed and
// writes it into the field, so the field always shows the seed that made the
// current image. Locked: that exact seed is reused on every run, so you can
// change the prompt and keep the composition. The -1 in the field is the
// "random" sentinel; locking materializes a concrete seed (see toggleSeedLock)
// so you can never be locked-but-random.
let seedLocked = false;

// The gallery as last loaded (newest first), plus which image is "open" in the
// preview. Tracked by id rather than index so the selection survives the
// reloads that happen after every generation (which renumber the grid).
let galleryItems = [];
let selectedId = null;
// The gallery is paged: 8 rows of photos per page, newest first. The grid is
// responsive, so a page is 8 × however many columns currently fit (see
// galleryPageSize). galleryItems holds only the current page; galleryPage is the
// zero-based page; galleryTotal is the total image count (for bounds + readout).
const GALLERY_ROWS = 8;
// Mirror of the .gallery grid metrics in style.css, used to work out the column
// count from the container width before any thumbnails have rendered.
const GALLERY_MIN_COL = 160; // minmax() floor
const GALLERY_GAP = 12; // grid gap
const GALLERY_PADDING = 24; // left/right padding
let galleryPage = 0;
let galleryTotal = 0;
// When on, the gallery (and its page count) is filtered to favorited images.
let favoritesOnly = false;
// Substring filter on the prompt; empty means no search. Both filters compose.
let gallerySearch = "";

// Filename currently shown in the big preview (for the "Save image" button).
let currentPreview = null;
// Photos ticked for "Download selected"/"Delete selected" — a multi-select kept
// separate from the single preview-open image above. A Map of id → item so the
// selection (and the filenames it needs) survives paging: ticks made on page 1
// still count when you act from page 3.
let selected = new Map();
// The last thumbnail picked, the anchor for Shift+Click range selection. By id
// (not index) so it stays valid after the grid renumbers on a reload.
let lastPickId = null;

// The client-side view of the generation queue. Each prompt you submit is sent
// to the server right away — the server runs them one at a time, FIFO — and
// gets a row here so you can line up several without waiting. Finished and
// cancelled jobs drop off automatically; failed ones stay until you dismiss them.
//   { jobId, label, status, step, total, seed, filename, error, cancelling,
//     startedAt }  (startedAt: ms timestamp of the first "running" tick, used
//     for the elapsed/ETA readout)
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
    restoreForm(); // override the defaults with the last saved form, if any
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
  renderAspect();
  saveForm();
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

// -- form persistence -----------------------------------------------------
// Keep the prompt and settings across reloads (and container restarts), so an
// accidental refresh never costs a carefully-tuned prompt. The form is saved to
// localStorage on every edit and restored once the model list has loaded.
//
// `formLoaded` gates saving: it stays false until restoreForm() runs, so the
// model defaults applied during startup don't overwrite the stored form before
// we've had a chance to read it back.
const FORM_KEY = "imagen.form";
let formLoaded = false;

function saveForm() {
  if (!formLoaded) return;
  const data = { model: $("model").value, strength: $("strength").value, seedLocked };
  for (const f of fields) data[f] = $(f).value;
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify(data));
  } catch {} // private mode / quota — persistence is a nicety, never fatal
}

// Repopulate the form from the last saved state, if any. Runs after the model
// <select> is filled so a saved model id can be reselected; a saved id that no
// longer exists is ignored (the startup default stands). Always flips
// formLoaded on so subsequent edits persist, even when there was nothing saved.
function restoreForm() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(FORM_KEY) || "null");
  } catch {} // corrupt/blocked storage — fall through to the startup defaults
  if (data) {
    if (data.model && MODELS.some((m) => m.id === data.model)) $("model").value = data.model;
    for (const f of fields) if (data[f] != null) $(f).value = data[f];
    if (data.strength != null) {
      $("strength").value = data.strength;
      $("strength-val").textContent = parseFloat(data.strength).toFixed(2);
    }
    seedLocked = !!data.seedLocked;
    renderSeedLock();
    renderAspect();
  }
  formLoaded = true;
}

// A fresh random seed in 0 .. 2^32-1, matching the server's os.urandom(4) range
// so client- and server-side seeds are interchangeable.
function randomSeed() {
  return Math.floor(Math.random() * 0x100000000);
}

// Resolve the seed for the next generation, updating the field to match. Locked
// with a valid seed → reuse it; otherwise reroll and show the new value.
function nextSeed() {
  const v = parseInt($("seed").value, 10);
  if (seedLocked && Number.isInteger(v) && v >= 0) return v;
  const s = randomSeed();
  $("seed").value = s;
  return s;
}

// Drop a fresh random seed into the field. A one-shot — it doesn't change the
// lock, so you can grab a specific random value and then lock it.
function randomizeSeed() {
  $("seed").value = randomSeed();
  saveForm();
}

// Toggle the seed lock. Locking a -1/blank field materializes a concrete random
// seed right away, so "locked" always means an exact, reproducible number and
// never locked-but-random. Unlocking drops back to -1 (random each run).
function toggleSeedLock() {
  seedLocked = !seedLocked;
  if (seedLocked) {
    const v = parseInt($("seed").value, 10);
    if (!Number.isInteger(v) || v < 0) $("seed").value = randomSeed();
  } else {
    $("seed").value = -1;
  }
  renderSeedLock();
  saveForm();
}

// Reflect the lock state on the button (glyph, title, pressed) and accent the
// field so it's obvious the seed is pinned.
function renderSeedLock() {
  const btn = $("seed-lock");
  btn.textContent = seedLocked ? "🔒" : "🔓";
  btn.title = seedLocked ? "Seed locked — click to randomize each run" : "Lock seed to reuse it";
  btn.setAttribute("aria-pressed", String(seedLocked));
  btn.classList.toggle("on", seedLocked);
  $("seed").closest(".seed-field").classList.toggle("locked", seedLocked);
}

// Aspect-ratio presets. Sizes scale to the selected model's native resolution
// (512 for SD 1.5 / Turbo, 1024 for SDXL-class), so 1:1 / Portrait / Landscape
// always land on sensible dimensions for whichever model is loaded.
function modelBaseSize() {
  const m = MODELS.find((x) => x.id === $("model").value);
  return (m && m.size) || 512;
}

function snap64(v) {
  return Math.min(1536, Math.max(128, Math.round(v / 64) * 64));
}

// Dimensions for ratio w:h at the current model's base size: the long side is
// the base, the short side scaled down and snapped to the 64-px step.
function aspectDims(w, h) {
  const base = modelBaseSize();
  const short = snap64((base * Math.min(w, h)) / Math.max(w, h));
  return [w >= h ? base : short, h >= w ? base : short];
}

function setAspect(w, h) {
  const [W, H] = aspectDims(w, h);
  $("width").value = W;
  $("height").value = H;
  renderAspect();
  saveForm();
}

const ASPECTS = [["ar-square", 1, 1], ["ar-portrait", 3, 4], ["ar-landscape", 4, 3]];

// Light up whichever preset matches the current size (none if width/height were
// hand-edited off the preset grid).
function renderAspect() {
  const w = parseInt($("width").value, 10);
  const h = parseInt($("height").value, 10);
  for (const [id, aw, ah] of ASPECTS) {
    const [W, H] = aspectDims(aw, ah);
    $(id).classList.toggle("on", w === W && h === H);
  }
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
  if (!$("prompt").value.trim()) {
    $("status").textContent = "Enter a prompt first.";
    return;
  }
  nextSeed(); // resolve & display the seed before reading the form
  saveForm(); // persist the resolved seed (and the rest) for the next reload
  const params = readParams();

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const { job_id } = await res.json();

  // The step count this job will actually run, so the queue-total ETA can
  // estimate its duration before it starts. img2img only denoises the last
  // `strength` fraction of the schedule, mirroring the engine's
  // total = max(1, int(steps * strength)).
  const effSteps = params.init_image
    ? Math.max(1, Math.floor(params.steps * params.strength))
    : params.steps;
  const item = {
    jobId: job_id,
    label: params.prompt.trim(),
    status: "queued",
    step: 0,
    total: 0,
    steps: effSteps,
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
    // Stamp when the job actually starts running, so renderQueue can show the
    // elapsed time and an ETA. The server streams state every 0.2s, so this
    // (and the readout it drives) stays current without a separate timer.
    if (item.status === "running" && !item.startedAt) item.startedAt = Date.now();

    if (job.status === "done") {
      // The finished image is now in the gallery; preview it and jump to page 1
      // (the newest page, where it lives), then drop this row from the queue.
      // Clear the active filters so the new image is visible (it won't be
      // favorited yet, and likely won't match an in-progress search).
      showImage(job.filename);
      if (favoritesOnly) {
        favoritesOnly = false;
        renderFavFilter();
      }
      if (gallerySearch) {
        gallerySearch = "";
        $("gallery-search").value = "";
      }
      loadGallery(0);
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

// Format a duration in seconds as "45s" or "1m05s".
function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// Rebuild the queue list and drive the headline status/progress bar from
// whichever job is currently running.
function renderQueue() {
  const list = $("queue");
  list.innerHTML = "";
  for (const item of queue) list.append(queueRow(item));

  const running = queue.find((q) => q.status === "running");
  const waiting = queue.filter((q) => q.status === "queued");
  if (running) {
    const pct = running.total ? Math.round((running.step / running.total) * 100) : 0;
    let line = `Generating… ${running.step}/${running.total}`;
    // Seconds per completed step on the current job, the basis for both the
    // single-job and whole-queue ETAs. Null until the first step lands.
    let secPerStep = null;
    if (running.startedAt) {
      const elapsed = (Date.now() - running.startedAt) / 1000;
      line += ` · ${fmtTime(elapsed)} elapsed`;
      // ETA from the average time per completed step. Needs at least one step
      // done, and there's nothing left to estimate on the last one. Early steps
      // include model-load time, so the estimate starts high and settles.
      if (running.step > 0 && running.step < running.total) {
        secPerStep = elapsed / running.step;
        line += ` · ~${fmtTime(secPerStep * (running.total - running.step))} left`;
      }
    }
    // Whole-queue ETA: the running job's remaining time plus each queued job's
    // steps at the same per-step rate. Lets you judge the total wait before
    // committing to it. The rate is the current job's, so a queue mixing models
    // or sizes is only a rough guide — hence the "~". Falls back to a plain
    // count until the first step gives us a rate.
    if (waiting.length) {
      if (secPerStep != null) {
        let stepsLeft = running.total - running.step;
        for (const q of waiting) stepsLeft += q.steps || running.total;
        line += ` · queue: ~${fmtTime(secPerStep * stepsLeft)} for ${waiting.length + 1} images`;
      } else {
        line += ` · ${waiting.length} queued`;
      }
    }
    $("status").textContent = line;
    $("bar").style.width = pct + "%";
  } else if (waiting.length) {
    $("status").textContent = `${waiting.length} queued…`;
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

// Photos per page: 8 rows × however many columns the responsive grid currently
// shows. Recomputed each load so it tracks the window width. Derived from the
// container width (works even before any thumbnail has rendered) using the same
// auto-fill maths the CSS grid applies: cols = ⌊(W + gap) / (minCol + gap)⌋.
function galleryPageSize() {
  const contentWidth = $("gallery").clientWidth - 2 * GALLERY_PADDING;
  const cols = Math.max(
    1,
    Math.floor((contentWidth + GALLERY_GAP) / (GALLERY_MIN_COL + GALLERY_GAP)),
  );
  return GALLERY_ROWS * cols;
}

// Monotonic id for the most recently started loadGallery. Each call does two
// sequential awaits (count, then list) and nothing cancels an in-flight load,
// so without this a slow earlier request (e.g. an older search keystroke, or a
// favorites toggle made mid-search) could resolve after a newer one and paint
// stale results. Each call claims the next id and bails after every await if a
// later call has since superseded it, so only the latest load ever renders.
let galleryLoadSeq = 0;

// Load one page of the gallery (8 rows, newest first) and render it, fully
// replacing whatever page was shown. `page` is clamped into range, so callers
// can pass galleryPage±1 freely. A new generation passes 0 to jump back to the
// newest page; deletes reload the current page (stepping back if it emptied).
async function loadGallery(page = galleryPage) {
  const seq = ++galleryLoadSeq;
  const filters = new URLSearchParams({ favorites: favoritesOnly, query: gallerySearch });
  const total = (await (await fetch(`/api/gallery/count?${filters}`)).json()).count;
  if (seq !== galleryLoadSeq) return; // a newer load started; drop this one
  galleryTotal = total;
  const pageSize = galleryPageSize();
  const pages = Math.max(1, Math.ceil(galleryTotal / pageSize));
  galleryPage = Math.min(Math.max(0, page), pages - 1);

  const offset = galleryPage * pageSize;
  const items = await (
    await fetch(`/api/gallery?limit=${pageSize}&offset=${offset}&${filters}`)
  ).json();
  if (seq !== galleryLoadSeq) return; // superseded while the list was in flight
  galleryItems = items;

  const gal = $("gallery");
  gal.innerHTML = "";
  for (const [i, it] of items.entries()) gal.append(galleryFigure(it, i));
  if (!items.length && (gallerySearch || favoritesOnly)) {
    const p = document.createElement("p");
    p.className = "gallery-empty";
    p.textContent = gallerySearch
      ? `No images match “${gallerySearch}”.`
      : "No favorites yet — tap ☆ on a photo to add one.";
    gal.append(p);
  }
  highlightSelected();
  renderSelection();
  renderPager(pages);
}

// Show the buttons + "Page X / Y" readout, disabling the ends. Hidden entirely
// when everything fits on a single page.
function renderPager(pages) {
  $("pager").hidden = pages <= 1;
  $("page-info").textContent = `Page ${galleryPage + 1} / ${pages}`;
  $("prev-page").disabled = galleryPage === 0;
  $("next-page").disabled = galleryPage >= pages - 1;
}

// Turn to an adjacent page and scroll the gallery heading into view, so the new
// page starts from its top rather than leaving you down by the pager.
async function goToPage(page) {
  await loadGallery(page);
  document.querySelector(".gallery-head").scrollIntoView({ behavior: "smooth" });
}

function renderFavFilter() {
  const b = $("fav-filter");
  b.classList.toggle("on", favoritesOnly);
  b.textContent = favoritesOnly ? "★ Favorites" : "☆ Favorites";
}

// Toggle the favorites-only filter and reload from the newest page.
function toggleFavoritesFilter() {
  favoritesOnly = !favoritesOnly;
  renderFavFilter();
  loadGallery(0);
}

// Debounce the prompt search so typing fires one reload after a short pause,
// not one per keystroke. Each change jumps back to the newest matching page.
let searchTimer = null;
function onSearchInput(e) {
  gallerySearch = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadGallery(0), 200);
}

// Build one gallery thumbnail (figure) for the image at index `i` on the page.
function galleryFigure(it, i) {
  const fig = document.createElement("figure");
  fig.dataset.id = it.id;
  if (it.favorite) fig.classList.add("fav-on");

  const img = document.createElement("img");
  img.src = `/api/outputs/${it.filename}`;
  img.title = it.prompt;
  // Clicking the photo opens it in the big preview and scrolls up to it.
  // (The checkbox and arrow keys deliberately don't scroll — see pickAt /
  // navigateGallery.)
  img.onclick = () => {
    selectImage(i);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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

  const fav = document.createElement("button");
  fav.className = "fav";
  fav.textContent = it.favorite ? "★" : "☆";
  fav.title = it.favorite ? "Unfavorite" : "Favorite";
  fav.onclick = (e) => {
    e.stopPropagation();
    toggleFavorite(it, fig);
  };

  fig.append(img, pick, edit, del, fav);
  return fig;
}

// Flag/unflag an image as a favorite. Updates the star in place; in the
// favorites-only view, unfavoriting drops the image out so the page reloads.
async function toggleFavorite(it, fig) {
  const next = !it.favorite;
  await fetch(`/api/gallery/${it.id}/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite: next }),
  });
  it.favorite = next;
  if (favoritesOnly && !next) {
    loadGallery();
    return;
  }
  const btn = fig.querySelector(".fav");
  btn.textContent = next ? "★" : "☆";
  btn.title = next ? "Unfavorite" : "Favorite";
  fig.classList.toggle("fav-on", next);
}

// Open a gallery image by its index: apply its settings, show it in the
// preview, and remember it so the arrow keys can step from here. Doesn't scroll
// on its own — the checkbox and arrow keys update the preview in place; only a
// direct photo click scrolls up to the preview (see loadGallery's img.onclick).
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
    for (let i = a; i <= b; i++) selected.set(galleryItems[i].id, galleryItems[i]);
  } else if (selected.has(it.id)) {
    selected.delete(it.id);
  } else {
    selected.set(it.id, it);
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

// Tick (or untick) every photo on the current page. Acts on this page only —
// selections on other pages are left untouched — so it pairs with "Clear",
// which drops the whole cross-page selection. Toggles based on whether the page
// is already fully selected.
function toggleSelectAllPage() {
  const allOn = galleryItems.length > 0 && galleryItems.every((it) => selected.has(it.id));
  for (const it of galleryItems) {
    if (allOn) selected.delete(it.id);
    else selected.set(it.id, it);
  }
  renderSelection();
}

// Delete every ticked photo at once (across all pages), after a confirmation
// (these can't be undone). Unknown/already-gone ids are ignored server-side.
async function deleteSelected() {
  const items = [...selected.values()];
  if (!items.length) return;
  const n = items.length;
  if (!confirm(`Delete ${n} selected photo${n > 1 ? "s" : ""}? This can't be undone.`)) return;

  await fetch("/api/gallery/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: items.map((it) => it.id) }),
  });

  // Drop dangling references to anything we just removed.
  const gone = new Set(items.map((it) => it.filename));
  if (initImage && gone.has(initImage)) clearInitImage();
  if (currentPreview && gone.has(currentPreview)) {
    currentPreview = null;
    $("preview").style.display = "none";
    $("download-current").hidden = true;
  }
  selected.clear();
  lastPickId = null;
  loadGallery();
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
  // The selection toolbar stays visible whenever the page has photos (the
  // parent #gallery-controls hides it on an empty page), so the count reads
  // "0 selected" rather than disappearing until something is ticked.
  const n = selected.size;
  $("sel-count").textContent = `${n} selected`;
  // Grey out the actions that need a selection when nothing is ticked.
  $("download-selected").disabled = n === 0;
  $("delete-selected").disabled = n === 0;

  // "Select all" is offered whenever the page has photos; it flips to "Select
  // none" once every photo on the page is already ticked. The whole controls row
  // is hidden on an empty page so it leaves no gap under the heading.
  const btn = $("select-all");
  const allOn = galleryItems.length > 0 && galleryItems.every((it) => selected.has(it.id));
  btn.hidden = galleryItems.length === 0;
  btn.textContent = allOn ? "Select none" : "Select all";
  $("gallery-controls").hidden = galleryItems.length === 0;
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
  const filenames = [...selected.values()].map((it) => it.filename);
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
  for (let i = a; i <= b; i++) selected.set(galleryItems[i].id, galleryItems[i]);
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
  renderAspect();
  saveForm();
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
  selected.delete(id); // and untick it if it was selected for download
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
$("seed-random").addEventListener("click", randomizeSeed);
$("seed-lock").addEventListener("click", toggleSeedLock);
$("ar-square").addEventListener("click", () => setAspect(1, 1));
$("ar-portrait").addEventListener("click", () => setAspect(3, 4));
$("ar-landscape").addEventListener("click", () => setAspect(4, 3));
$("width").addEventListener("input", renderAspect);
$("height").addEventListener("input", renderAspect);
$("clear-init").addEventListener("click", clearInitImage);
$("download-current").addEventListener("click", downloadCurrent);
$("download-selected").addEventListener("click", downloadSelected);
$("delete-selected").addEventListener("click", deleteSelected);
$("clear-selection").addEventListener("click", clearSelection);
$("select-all").addEventListener("click", toggleSelectAllPage);
$("fav-filter").addEventListener("click", toggleFavoritesFilter);
$("gallery-search").addEventListener("input", onSearchInput);
$("strength").addEventListener("input", () => {
  $("strength-val").textContent = parseFloat($("strength").value).toFixed(2);
});

// Persist the form on any edit. One delegated listener on the panel covers
// every typed/spinner/slider change; the programmatic setters (model defaults,
// aspect presets, seed, gallery reuse) call saveForm() themselves since setting
// .value in code doesn't emit an input event.
document.querySelector(".panel").addEventListener("input", saveForm);

// Pager: "Newer" steps toward page 1, "Older" toward the end of the gallery.
$("prev-page").addEventListener("click", () => goToPage(galleryPage - 1));
$("next-page").addEventListener("click", () => goToPage(galleryPage + 1));

init();
