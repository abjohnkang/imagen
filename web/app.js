const $ = (id) => document.getElementById(id);

const fields = ["prompt", "negative", "steps", "cfg", "width", "height", "seed"];

let MODELS = [];
let initImage = null; // filename of the img2img starting image, or null

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
  $("go").disabled = true;
  $("status").textContent = "Queued…";
  $("bar").style.width = "0";

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const { job_id } = await res.json();
  watch(job_id);
}

function watch(jobId) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/progress/${jobId}`);

  ws.onmessage = (ev) => {
    const job = JSON.parse(ev.data);
    if (job.status === "running") {
      const pct = job.total ? Math.round((job.step / job.total) * 100) : 0;
      $("status").textContent = `Generating… ${job.step}/${job.total}`;
      $("bar").style.width = pct + "%";
    } else if (job.status === "queued") {
      $("status").textContent = "Queued…";
    } else if (job.status === "done") {
      $("bar").style.width = "100%";
      $("status").textContent = `Done · seed ${job.seed}`;
      showImage(job.filename);
      $("seed").value = job.seed;
      $("go").disabled = false;
      loadGallery();
      ws.close();
    } else if (job.status === "error") {
      $("status").textContent = "Error: " + job.error;
      $("go").disabled = false;
      ws.close();
    }
  };
  ws.onerror = () => {
    $("status").textContent = "Connection lost.";
    $("go").disabled = false;
  };
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
