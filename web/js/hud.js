// DOM overlay: link bar, network list, inspector, events and toasts.

import { drawSparkline } from "./charts.js";
import { BAND_CSS, GRADE_CSS, LINK_CSS, ago, clock, esc, fmtDist, fmtMs, isDfs, levelCss, rssiCss, rssiLabel } from "./util.js";

const $ = (id) => document.getElementById(id);

export class Hud extends EventTarget {
  constructor() {
    super();
    this.filter = { band: "all", search: "", sort: "signal" };
    this.selectedId = null;
    this.lastEventId = null;
    this.noticeDismissed = false;
    this.#bind();
  }

  #bind() {
    const list = $("net-list");
    list.addEventListener("click", (e) => {
      const li = e.target.closest("[data-id]");
      if (li) this.#emit("select", li.dataset.id);
    });
    list.addEventListener("mouseover", (e) => {
      const li = e.target.closest("[data-id]");
      this.#emit("hover", li?.dataset.id ?? null);
    });
    list.addEventListener("mouseleave", () => this.#emit("hover", null));

    $("band-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-band]");
      if (!b) return;
      this.filter.band = b.dataset.band;
      for (const el of $("band-chips").children) el.classList.toggle("on", el === b);
      this.#emit("refresh");
    });
    $("search").addEventListener("input", (e) => {
      this.filter.search = e.target.value.trim().toLowerCase();
      this.#emit("refresh");
    });
    $("sort").addEventListener("change", (e) => {
      this.filter.sort = e.target.value;
      this.#emit("refresh");
    });
    $("ins-close").addEventListener("click", () => this.#emit("select", null));
    $("ins-focus").addEventListener("click", () => this.#emit("focus", this.selectedId));
    $("ins-neighbors").addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (b) this.#emit("select", b.dataset.id);
    });
    $("notice-close").addEventListener("click", () => {
      this.noticeDismissed = true;
      $("notice").hidden = true;
    });
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  visibleNetworks(snap) {
    const f = this.filter;
    const nets = snap.networks.filter(
      (n) =>
        (f.band === "all" || n.band === f.band) &&
        (!f.search || `${n.name} ${n.bssid ?? ""} ${n.vendor ?? ""} ${n.channel}`.toLowerCase().includes(f.search)),
    );
    const by = {
      signal: (a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi,
      distance: (a, b) => a.distance.est - b.distance.est,
      channel: (a, b) => a.band.localeCompare(b.band) || a.channel - b.channel,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return nets.sort(by[f.sort]);
  }

  render(snap, connected) {
    this.#status(snap, connected);
    this.#linkbar(snap);
    this.#notice(snap);
    this.#list(snap);
    this.#inspector(snap);
    this.#events(snap);
  }

  #status(snap, connected) {
    const el = $("status");
    const kind = !connected ? "off" : snap.source.kind === "demo" ? "demo" : "live";
    el.className = `pill status ${kind}`;
    $("status-text").textContent = !connected ? "engine offline — reconectando" : `${kind === "demo" ? "DEMO" : "AO VIVO"} · ${snap.source.label}`;
    $("ver").textContent = `v${snap.version}`;
  }

  #linkbar(snap) {
    const l = snap.link;
    const bar = $("linkbar");
    bar.hidden = !l.connected;
    if (!l.connected) return;
    const net = snap.networks.find((n) => n.id === l.networkId);
    $("lk-ssid").textContent = l.ssid ?? net?.name ?? "—";
    $("lk-sub").textContent = `${l.band} GHz · ch ${l.channel} · ${l.width} MHz · ${l.generation ?? ""}`;
    const rssi = $("lk-rssi");
    rssi.textContent = l.rssi ?? "—";
    rssi.style.color = l.rssi != null ? rssiCss(l.rssi) : "";
    $("lk-snr").textContent = l.snr ?? "—";
    $("lk-tx").textContent = l.txRate != null ? Math.round(l.txRate) : "—";
    $("lk-gw").textContent = fmtMs(l.gatewayPing.last);
    $("lk-net").textContent = fmtMs(l.internetPing.last);
    const q = l.quality ?? 0;
    const arc = $("lk-q-arc");
    arc.style.strokeDashoffset = String(94.25 * (1 - q / 100));
    arc.style.stroke = q >= 75 ? "var(--good)" : q >= 50 ? "var(--warn)" : "var(--bad)";
    $("lk-q").textContent = l.quality ?? "—";
    bar.title = l.verdict;
  }

  #notice(snap) {
    const note = snap.source.note;
    const el = $("notice");
    if (!note || this.noticeDismissed) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    $("notice-text").innerHTML = esc(note).replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  #list(snap) {
    const nets = this.visibleNetworks(snap);
    $("net-count").textContent = snap.stats.visible;
    $("net-list").innerHTML = nets
      .map((n) => {
        const color = n.connected ? LINK_CSS : BAND_CSS[n.band];
        const q = Math.min(Math.max((n.rssi + 95) / 65, 0), 1);
        const cls = ["net", n.connected && "connected", n.stale && "stale", n.id === this.selectedId && "sel"].filter(Boolean).join(" ");
        return `<li class="${cls}" data-id="${esc(n.id)}" style="--band:${color}">
          <span class="net-name">${esc(n.name)}</span>
          <span class="net-rssi" style="color:${rssiCss(n.rssi)}"><b>${Math.round(n.rssi)}</b><span class="mini"><i style="width:${q * 100}%"></i></span><small>~${fmtDist(n.distance.est)}</small></span>
          <span class="net-meta"><span class="grade" style="background:${GRADE_CSS[n.securityGrade]}">${n.securityGrade}</span>${n.band} GHz · ch ${n.channel} · ${n.width}M · ${esc(n.generation)}</span>
        </li>`;
      })
      .join("");
    const best = snap.spectrum.map((b) => (b.best ? `${b.band}→${b.best.channel}` : null)).filter(Boolean).join(" · ");
    $("net-foot").innerHTML = `scan #${snap.scan.count}${snap.scan.durationMs ? ` · ${(snap.scan.durationMs / 1000).toFixed(1)}s` : ""} · ${esc(snap.env.label)} n=${snap.env.exponent}<br>melhores canais: ${best || "—"}`;
  }

  #inspector(snap) {
    const panel = $("inspector");
    const n = snap.networks.find((x) => x.id === this.selectedId);
    panel.hidden = !n;
    document.getElementById("toasts").classList.toggle("no-inspector", !n);
    document.getElementById("hud").classList.toggle("inspecting", !!n);
    if (!n) return;

    const color = n.connected ? LINK_CSS : BAND_CSS[n.band];
    panel.style.setProperty("--accent", color);
    const badges = [
      n.connected ? `<span class="badge" style="color:${LINK_CSS}">◆ conectada</span>` : "",
      `<span class="badge" style="color:${BAND_CSS[n.band]}">${n.band} GHz</span>`,
      `<span class="badge" style="color:${GRADE_CSS[n.securityGrade]}">${esc(n.security)} · ${n.securityGrade}</span>`,
      n.stale ? `<span class="badge" style="color:var(--dim)">fora do último scan</span>` : "",
      isDfs(n.channel, n.band) ? `<span class="badge" style="color:var(--warn)">DFS</span>` : "",
    ];
    $("ins-badges").innerHTML = badges.join("");
    $("ins-name").textContent = n.name;
    $("ins-sub").textContent = n.ssid ? `${n.bssid ?? "BSSID oculto"}${n.vendor ? " · " + n.vendor : ""}` : n.redacted ? "SSID oculto pelo SO" : "rede oculta (SSID não anunciado)";

    const arc = $("g-rssi-arc");
    const q = Math.min(Math.max((n.rssi + 95) / 65, 0), 1);
    arc.style.strokeDashoffset = String(125.7 * (1 - q));
    arc.style.stroke = rssiCss(n.rssi);
    arc.style.color = rssiCss(n.rssi);
    $("g-rssi-val").textContent = Math.round(n.rssi);

    $("ins-dist").textContent = `~${fmtDist(n.distance.est)}`;
    const scale = (m) => Math.min(Math.log1p(m / 2) / Math.log1p(60 / 2), 1) * 100;
    const bar = $("ins-range-bar");
    bar.style.left = `${scale(n.distance.min)}%`;
    bar.style.width = `${Math.max(scale(n.distance.max) - scale(n.distance.min), 2)}%`;
    $("ins-range-dot").style.left = `${scale(n.distance.est)}%`;
    $("ins-range").textContent = `faixa provável ${fmtDist(n.distance.min)} – ${fmtDist(n.distance.max)} · modelo ${snap.env.label}`;

    drawSparkline($("ins-spark"), n.history, rssiCss(n.rssi));

    const rows = [
      ["Sinal", `${Math.round(n.rssi)} dBm <em>· ${rssiLabel(n.rssi)} · σ ${n.rssiStd} dB · pico ${n.rssiPeak}</em>`],
      ["SNR", n.snr != null ? `${n.snr} dB <em>· ruído ${n.noise} dBm</em>` : "<em>não reportado</em>"],
      ["Canal", `${n.channel} <em>· ${n.freq} MHz · ${n.width} MHz</em>`],
      ["Espectro", `${n.span[0]}–${n.span[1]} MHz`],
      ["PHY", `${esc(n.phy)} <em>· ${esc(n.generation)}</em>`],
      ["Taxa máx.", n.maxRate ? `~${n.maxRate} Mbps <em>(2×2)</em>` : "—"],
      ["Azimute", `${Math.round((n.position.azimuth * 180) / Math.PI)}° <em>· estimado · confiança ${Math.round(n.position.confidence * 100)}%</em>`],
      ["BSSID", n.bssid ? `${esc(n.bssid)}${n.randomizedMac ? " <em>· local</em>" : ""}` : "<em>oculto</em>"],
      ["Fabricante", esc(n.vendor ?? "—")],
      ["Beacon", n.beaconInterval ? `${n.beaconInterval} TU` : "—"],
      ["Visto", `há ${ago(n.firstSeen)} <em>· ${n.samples} amostras</em>`],
    ];
    $("ins-kv").innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");

    const it = n.interference;
    const intEl = $("ins-int");
    intEl.textContent = `${it.score}/100${it.sir != null ? ` · SIR ${it.sir} dB` : ""}`;
    intEl.style.color = it.score > 60 ? "var(--bad)" : it.score > 30 ? "var(--warn)" : "var(--good)";
    const bar2 = $("ins-int-bar");
    bar2.style.width = `${Math.max(it.score, 2)}%`;
    bar2.style.backgroundPosition = `${-it.score * 2}px 0`;
    const neighbors = it.neighbors
      .map((id) => snap.networks.find((m) => m.id === id))
      .filter(Boolean)
      .map((m) => `<button data-id="${esc(m.id)}" style="border-color:${BAND_CSS[m.band]}55">${esc(m.name)} · ${Math.round(m.rssi)}</button>`);
    $("ins-neighbors").innerHTML =
      `<span class="none">${it.cochannel} co-canal · ${it.overlapping} parcial</span>` + (neighbors.length ? neighbors.join("") : "");
  }

  #events(snap) {
    $("ev-count").textContent = snap.events.length;
    $("events").innerHTML = [...snap.events]
      .reverse()
      .map((e) => `<li><time>${clock(e.t)}</time><i style="background:${levelCss(e.level)}"></i><span>${esc(e.message)}</span></li>`)
      .join("");

    // Event ids restart when the engine restarts; treat that as a fresh baseline.
    const newest = snap.events.at(-1)?.id ?? 0;
    if (this.lastEventId !== null && newest < this.lastEventId) this.lastEventId = newest;
    const fresh = this.lastEventId === null ? [] : snap.events.filter((e) => e.id > this.lastEventId);
    if (snap.events.length) this.lastEventId = snap.events[snap.events.length - 1].id;
    // Warnings always surface; routine churn (new/lost networks) at most every 8 s.
    const now = Date.now();
    for (const e of fresh.slice(-3)) {
      if (e.level === "info") {
        if (now - (this.lastInfoToast ?? 0) < 8000) continue;
        this.lastInfoToast = now;
      }
      this.toast(e.message, levelCss(e.level));
    }
  }

  toast(text, color = "var(--matrix)") {
    const box = $("toasts");
    const el = document.createElement("div");
    el.className = "toast";
    el.style.setProperty("--c", color);
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 500);
    }, 5000);
  }

  tooltip(n, x, y) {
    const el = $("tooltip");
    if (!n) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = `<b>${esc(n.name)}</b><br><small>${Math.round(n.rssi)} dBm · ~${fmtDist(n.distance.est)} · ${n.band} GHz ch ${n.channel}</small>`;
    el.style.left = `${x + 14}px`;
    el.style.top = `${y + 14}px`;
  }
}
