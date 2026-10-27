// Entry point: boot sequence, wiring between store, 3D scene, HUD and charts.

import { Store } from "./store.js";
import { RFScene } from "./scene.js";
import { Hud } from "./hud.js";
import { LatencyChart, SpectrumChart } from "./charts.js";
import { GLYPHS } from "./util.js";
import { setLang, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem("wi-prefs") || "{}");
  } catch {
    return {};
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem("wi-prefs", JSON.stringify(prefs));
  } catch {
    // storage unavailable (private mode) — preferences just won't persist
  }
};

// ─── Boot: digital rain + decoding logo ───────────────────────────────────

const boot = (() => {
  const canvas = $("boot-rain");
  const ctx = canvas.getContext("2d");
  const size = 16;
  let drops = [];
  const resize = () => {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    drops = Array.from({ length: Math.ceil(innerWidth / size) }, () => Math.random() * -60);
  };
  resize();
  addEventListener("resize", resize);
  let running = true;
  const tick = () => {
    if (!running) return;
    ctx.fillStyle = "rgba(0,0,0,0.085)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `${size}px 'JetBrains Mono', monospace`;
    drops.forEach((y, i) => {
      const ch = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      ctx.fillStyle = Math.random() < 0.08 ? "#e8ffef" : "#26ff7a";
      ctx.fillText(ch, i * size, y * size);
      drops[i] = y * size > canvas.height && Math.random() > 0.975 ? 0 : y + 1;
    });
    requestAnimationFrame(tick);
  };
  tick();

  const logo = $("boot-logo");
  const target = "WI//DIAG";
  let frame = 0;
  const scramble = setInterval(() => {
    frame++;
    logo.textContent = [...target].map((c, i) => (i < frame / 3 ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join("");
    if (frame > target.length * 3) clearInterval(scramble);
  }, 45);

  const started = performance.now();
  return {
    progress(p, text) {
      $("boot-bar").style.width = `${p}%`;
      if (text) $("boot-sub").textContent = text;
    },
    finish() {
      const wait = Math.max(0, 1500 - (performance.now() - started));
      setTimeout(() => {
        $("boot").classList.add("done");
        setTimeout(() => (running = false), 1000);
      }, wait);
    },
  };
})();

// ─── App ──────────────────────────────────────────────────────────────────

boot.progress(15, t("boot.renderer"));
const scene = new RFScene($("stage"));
const hud = new Hud();
const store = new Store();
const spectrum = new SpectrumChart($("spectrum"));
const latency = new LatencyChart($("latency"));
let selectedId = null;
let dockTab = "spectrum";
let firstSnapshot = true;
let manualBand = false;

function select(id, { focus = false } = {}) {
  selectedId = id;
  hud.selectedId = id;
  spectrum.selectedId = id;
  scene.select(id);
  const snap = store.snapshot;
  if (snap && id) {
    const n = snap.networks.find((x) => x.id === id);
    if (n && !manualBand) setSpectrumBand(n.band);
  }
  if (focus && id) scene.focus(id);
  render();
}

function setSpectrumBand(band) {
  spectrum.band = band;
  for (const b of $("spec-bands").children) b.classList.toggle("on", b.dataset.sband === band);
  drawDock();
}

function drawDock() {
  const snap = store.snapshot;
  if (!snap || $("dock").classList.contains("collapsed")) return;
  if (dockTab === "spectrum") spectrum.draw(snap);
  if (dockTab === "latency") latency.draw(snap);
  const spec = snap.spectrum.find((b) => b.band === spectrum.band);
  $("dock-info").innerHTML =
    dockTab === "spectrum" && spec?.best
      ? `${t("dock.bestChannel")} <b>${spec.best.channel}</b> · ${spec.best.width} MHz · ${t("dock.load")} ${(spec.best.load * 100).toFixed(0)}%`
      : dockTab === "latency"
        ? `${snap.link.verdict}`
        : "";
}

function render() {
  const snap = store.snapshot;
  if (!snap) return;
  hud.render(snap, store.connected);
  drawDock();
}

// The engine is shared (TUI, other tabs/windows), so the model can change under us.
function syncEnv(snap = store.snapshot) {
  const sel = $("env");
  if (snap && document.activeElement !== sel && sel.value !== snap.env.preset) sel.value = snap.env.preset;
}

store.addEventListener("snapshot", (e) => {
  const { snap } = e.detail;
  if (firstSnapshot) {
    firstSnapshot = false;
    boot.progress(100, `${snap.source.label} · ${t("boot.radios", { n: snap.networks.length })}`);
    boot.finish();
    if (snap.link.band) setSpectrumBand(snap.link.band);
  }
  syncEnv(snap);
  if (selectedId && !snap.networks.some((n) => n.id === selectedId)) select(null);
  scene.update(snap);
  render();
});
store.addEventListener("status", () => render());
boot.progress(45, t("boot.connecting"));
store.start();

// Scene interactions
scene.addEventListener("select", (e) => select(e.detail.id, { focus: false }));
scene.addEventListener("hover", (e) => {
  const snap = store.snapshot;
  const n = e.detail.id && snap?.networks.find((x) => x.id === e.detail.id);
  hud.tooltip(n && e.detail.id !== selectedId ? n : null, e.detail.x, e.detail.y);
  for (const li of $("net-list").children) li.classList.toggle("hover", li.dataset.id === e.detail.id);
});

// HUD interactions
hud.addEventListener("select", (e) => select(e.detail === selectedId ? null : e.detail, { focus: !!e.detail }));
hud.addEventListener("hover", (e) => {
  scene.hover(e.detail);
  spectrum.hoverId = e.detail;
  drawDock();
});
hud.addEventListener("focus", (e) => e.detail && scene.focus(e.detail));
hud.addEventListener("refresh", () => render());

// Spectrum hover / click
const specCanvas = $("spectrum");
specCanvas.addEventListener("mousemove", (e) => {
  const r = specCanvas.getBoundingClientRect();
  const id = spectrum.hitTest(e.clientX - r.left, e.clientY - r.top);
  if (id !== spectrum.hoverId) {
    spectrum.hoverId = id;
    scene.hover(id);
    drawDock();
  }
  const n = id && store.snapshot?.networks.find((x) => x.id === id);
  hud.tooltip(n || null, e.clientX, e.clientY);
  specCanvas.style.cursor = id ? "pointer" : "";
});
specCanvas.addEventListener("mouseleave", () => {
  spectrum.hoverId = null;
  scene.hover(null);
  hud.tooltip(null);
  drawDock();
});
specCanvas.addEventListener("click", () => spectrum.hoverId && select(spectrum.hoverId, { focus: true }));

// Dock tabs and band chips
document.querySelector(".dock-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  dockTab = b.dataset.tab;
  for (const t of document.querySelectorAll("[data-tab]")) t.classList.toggle("on", t === b);
  for (const p of document.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== dockTab;
  $("spec-bands").style.visibility = dockTab === "spectrum" ? "" : "hidden";
  drawDock();
});
$("spec-bands").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sband]");
  if (!b) return;
  manualBand = true;
  setSpectrumBand(b.dataset.sband);
});

// Panels
function setCollapsed(which, collapsed) {
  prefs[which] = collapsed;
  savePrefs();
  if (which === "networks") {
    $("networks").classList.toggle("collapsed", collapsed);
    $("networks-tab").hidden = !collapsed;
  } else {
    $("dock").classList.toggle("collapsed", collapsed);
    $("dock-tab").hidden = !collapsed;
    $("hud").classList.toggle("no-dock", collapsed);
    if (!collapsed) setTimeout(drawDock, 50);
  }
}
$("collapse-networks").onclick = () => setCollapsed("networks", true);
$("networks-tab").onclick = () => setCollapsed("networks", false);
$("collapse-dock").onclick = () => setCollapsed("dock", true);
$("dock-tab").onclick = () => setCollapsed("dock", false);
setCollapsed("networks", !!prefs.networks);
setCollapsed("dock", !!prefs.dock);

// Camera segment
function setCam(name) {
  scene.setCamera(name);
  for (const b of $("cam-seg").children) b.classList.toggle("on", b.dataset.cam === name);
}
$("cam-seg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cam]");
  if (b) setCam(b.dataset.cam);
});

// Environment model
$("env").addEventListener("change", (e) => {
  store.send({ type: "env", preset: e.target.value });
  hud.toast(t("toast.envModel", { v: e.target.selectedOptions[0].textContent }));
});
$("env").addEventListener("blur", () => syncEnv());
$("lang").addEventListener("change", (e) => setLang(e.target.value));

// Menus
document.querySelectorAll(".menu").forEach((menu) => {
  menu.querySelector("[data-menu]").addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll(".menu").forEach((m) => m !== menu && m.classList.remove("open"));
    menu.classList.toggle("open");
  });
  menu.querySelector(".menu-pop").addEventListener("click", (e) => e.stopPropagation());
});
document.addEventListener("click", () => document.querySelectorAll(".menu").forEach((m) => m.classList.remove("open")));

// Layer options
const optionInputs = { field: "opt-field", beams: "opt-beams", rain: "opt-rain", rotate: "opt-rotate" };
for (const [key, id] of Object.entries(optionInputs)) {
  const input = $(id);
  if (prefs[`opt-${key}`] !== undefined) input.checked = prefs[`opt-${key}`];
  scene.setOption(key, input.checked);
  input.addEventListener("change", () => {
    scene.setOption(key, input.checked);
    prefs[`opt-${key}`] = input.checked;
    savePrefs();
  });
}
const toggleOption = (key) => {
  const input = $(optionInputs[key]);
  input.checked = !input.checked;
  input.dispatchEvent(new Event("change"));
};

const LABEL_MODES = ["auto", "all", "off"];
function setLabels(mode) {
  scene.setLabelMode(mode);
  for (const b of $("label-seg").children) b.classList.toggle("on", b.dataset.labels === mode);
}
$("label-seg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-labels]");
  if (b) setLabels(b.dataset.labels);
});

// Cinema mode
const toggleCinema = () => $("hud").classList.toggle("cinema");
$("btn-cinema").onclick = toggleCinema;

// Exports
function download(name, href) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
}
// Bound on .menu-pop: its stopPropagation would keep clicks from reaching #export-menu.
document.querySelector("#export-menu .menu-pop").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-export]");
  if (!b) return;
  $("export-menu").classList.remove("open");
  const kind = b.dataset.export;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  if (kind === "png") return download(`wi-diag-${stamp}.png`, scene.capture());
  if (kind === "csv") return download(`wi-redes-${stamp}.csv`, "/api/networks.csv");
  if (kind === "json") {
    const blob = new Blob([JSON.stringify(store.snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    download(`wi-snapshot-${stamp}.json`, url);
    return setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  hud.toast(t("toast.reportBusy", { k: kind.toUpperCase() }));
  try {
    const res = await fetch(`/api/report?format=${kind}`, { method: "POST" });
    const body = await res.json();
    if (body.ok) hud.toast(t("toast.reportSaved", { v: Object.values(body.files).join(", ") }), "var(--good)");
    else hud.toast(t("toast.reportUnavailable", { v: body.error }), "var(--warn)");
  } catch (err) {
    hud.toast(t("toast.failed", { v: err.message }), "var(--bad)");
  }
});

// Keyboard
addEventListener("keydown", (e) => {
  // Leave browser/Electron shortcuts (Cmd/Ctrl+R, +F…) alone; AltGr still types "/" on some layouts.
  if ((e.metaKey || e.ctrlKey || e.altKey) && !e.getModifierState?.("AltGraph")) return;
  if (e.target instanceof Element && e.target.matches("input, select, textarea")) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const snap = store.snapshot;
  const list = snap ? hud.visibleNetworks(snap) : [];
  const idx = list.findIndex((n) => n.id === selectedId);
  switch (e.key) {
    case "h":
    case "H":
      return toggleCinema();
    case "1":
      return setCam("orbit");
    case "2":
      return setCam("radar");
    case "3":
      return setCam("ground");
    case "f":
    case "F":
      return toggleOption("field");
    case "r":
    case "R":
      return toggleOption("rain");
    case "b":
    case "B":
      return toggleOption("beams");
    case " ":
      e.preventDefault();
      return toggleOption("rotate");
    case "l":
    case "L":
      return setLabels(LABEL_MODES[(LABEL_MODES.indexOf(scene.labelMode) + 1) % LABEL_MODES.length]);
    case "n":
    case "N":
      return setCollapsed("networks", !$("networks").classList.contains("collapsed"));
    case "d":
    case "D":
      return setCollapsed("dock", !$("dock").classList.contains("collapsed"));
    case "/":
      e.preventDefault();
      setCollapsed("networks", false);
      return $("search").focus();
    case "Escape":
      return select(null);
    case "ArrowDown":
    case "ArrowUp": {
      e.preventDefault();
      if (!list.length) return;
      const down = e.key === "ArrowDown";
      const next = idx < 0 ? (down ? 0 : list.length - 1) : down ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length;
      select(list[next].id, { focus: true });
      document.querySelector(`.net[data-id="${CSS.escape(list[next].id)}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    case "Enter":
      if (selectedId) scene.focus(selectedId);
      return;
  }
});

addEventListener("resize", () => drawDock());
