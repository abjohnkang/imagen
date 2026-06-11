const $ = (id) => document.getElementById(id);

const fields = ["prompt", "negative", "steps", "cfg", "width", "height", "seed"];

let MODELS = [];
let initImage = null; // filename of the img2img starting image, or null

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
}

async function loadGallery() {
  const items = await (await fetch("/api/gallery")).json();
  const gal = $("gallery");
  gal.innerHTML = "";
  for (const it of items) {
    const fig = document.createElement("figure");

    const img = document.createElement("img");
    img.src = `/api/outputs/${it.filename}`;
    img.title = it.prompt;
    img.onclick = () => applySettings(it);

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

    fig.append(img, edit, del);
    gal.append(fig);
  }
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
  window.scrollTo({ top: 0, behavior: "smooth" });
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

$("go").addEventListener("click", generate);
$("clear-init").addEventListener("click", clearInitImage);
$("strength").addEventListener("input", () => {
  $("strength-val").textContent = parseFloat($("strength").value).toFixed(2);
});
init();
