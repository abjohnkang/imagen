const $ = (id) => document.getElementById(id);

const fields = ["prompt", "negative", "steps", "cfg", "width", "height", "seed"];

async function init() {
  try {
    const info = await (await fetch("/api/models")).json();
    $("device").textContent = `device: ${info.device} · ${info.default}`;
  } catch {}
  loadGallery();
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
  };
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

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.onclick = (e) => {
      e.stopPropagation();
      removeImage(it.id);
    };

    fig.append(img, del);
    gal.append(fig);
  }
}

function applySettings(it) {
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

async function removeImage(id) {
  await fetch(`/api/gallery/${id}`, { method: "DELETE" });
  loadGallery();
}

$("go").addEventListener("click", generate);
init();
