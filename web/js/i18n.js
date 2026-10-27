// UI language: Portuguese (default) or English. Text coming from the engine (events, verdicts, notices)
// stays in Portuguese; the language switch reloads the page so every string is rendered again.

const STRINGS = {
  pt: {
    "app.title": "WI//DIAG — Espaço RF",
    "boot.connecting": "conectando ao engine…",
    "boot.renderer": "inicializando renderer WebGL…",
    "boot.radios": "{n} rádios",
    "status.offline": "engine offline — reconectando",
    "status.demo": "DEMO",
    "status.live": "AO VIVO",
    "status.connected": "conectada",
    "badge.stale": "fora do último scan",
    "ins.bssidHidden": "BSSID oculto",
    "ins.ssidHiddenOs": "SSID oculto pelo SO",
    "ins.hiddenNet": "rede oculta (SSID não anunciado)",
    "ins.range": "faixa provável",
    "ins.model": "modelo",
    "row.signal": "Sinal",
    "row.noise": "ruído",
    "row.notReported": "não reportado",
    "row.channel": "Canal",
    "row.spectrum": "Espectro",
    "row.peak": "pico",
    "row.maxRate": "Taxa máx.",
    "row.azimuth": "Azimute",
    "row.estimated": "estimado",
    "row.confidence": "confiança",
    "row.hidden": "oculto",
    "row.local": "local",
    "row.vendor": "Fabricante",
    "row.seen": "Visto",
    "row.ago": "há {v}",
    "row.samples": "{n} amostras",
    "rssi.excellent": "excelente",
    "rssi.good": "bom",
    "rssi.fair": "razoável",
    "rssi.weak": "fraco",
    "rssi.critical": "crítico",
    "net.bestChannels": "melhores canais:",
    "interf.cochannel": "{n} co-canal",
    "interf.partial": "{n} parcial",
    "dock.bestChannel": "melhor canal",
    "dock.load": "ocupação",
    "toast.envModel": "Modelo de propagação: {v}",
    "toast.reportBusy": "Gerando relatório {k}…",
    "toast.reportSaved": "Relatório salvo: {v}",
    "toast.reportUnavailable": "Relatório indisponível: {v}",
    "toast.failed": "Falha: {v}",
    "scene.you": "VOCÊ",
    "latency.avg": "méd",
    "latency.min": "mín",
    "latency.jitter": "jit",
    "latency.loss": "perda",
    "cam.title": "Câmera (1·2·3)",
    "cam.orbit": "Órbita",
    "cam.radar": "Radar",
    "cam.ground": "Solo",
    "env.title": "Modelo de propagação",
    "env.open": "Espaço aberto",
    "env.residential": "Residencial",
    "env.office": "Escritório",
    "env.dense": "Prédio denso",
    "layers.title": "Camadas",
    "layers.field": "Campo RF",
    "layers.beams": "Feixes de sinal",
    "layers.rain": "Chuva digital",
    "layers.rotate": "Auto-rotação",
    "labels.title": "Rótulos",
    "labels.auto": "Auto",
    "labels.all": "Todos",
    "labels.off": "Off",
    "export.title": "Exportar",
    "export.png": "Captura da cena (PNG)",
    "export.csv": "Redes (CSV)",
    "export.json": "Snapshot completo (JSON)",
    "export.pdf": "Relatório PDF",
    "export.word": "Relatório DOCX",
    "export.excel": "Planilha XLSX",
    "cinema.title": "Modo cinema (H)",
    "lang.title": "Idioma",
    "common.close": "Fechar",
    "networks.title": "Redes",
    "networks.collapse": "Recolher (N)",
    "networks.search": "Buscar  /",
    "networks.sort": "Ordenar",
    "networks.tab": "REDES",
    "bands.all": "Todas",
    "sort.signal": "Sinal",
    "sort.distance": "Distância",
    "sort.channel": "Canal",
    "sort.name": "Nome",
    "ins.close": "Fechar (Esc)",
    "ins.distance": "Distância estimada",
    "ins.interference": "Interferência",
    "ins.focus": "Centralizar câmera",
    "dock.spectrum": "Espectro",
    "dock.latency": "Latência",
    "dock.events": "Eventos",
    "dock.collapse": "Recolher (D)",
    "dock.tab": "ESPECTRO · LATÊNCIA · EVENTOS",
    "hint.cinema": "cinema",
    "hint.camera": "câmera",
    "hint.networks": "redes",
    "hint.field": "campo RF",
  },
  en: {
    "app.title": "WI//DIAG — RF Space",
    "boot.connecting": "connecting to engine…",
    "boot.renderer": "initializing WebGL renderer…",
    "boot.radios": "{n} radios",
    "status.offline": "engine offline — reconnecting",
    "status.demo": "DEMO",
    "status.live": "LIVE",
    "status.connected": "connected",
    "badge.stale": "outside last scan",
    "ins.bssidHidden": "BSSID hidden",
    "ins.ssidHiddenOs": "SSID hidden by the OS",
    "ins.hiddenNet": "hidden network (SSID not broadcast)",
    "ins.range": "likely range",
    "ins.model": "model",
    "row.signal": "Signal",
    "row.noise": "noise",
    "row.notReported": "not reported",
    "row.channel": "Channel",
    "row.spectrum": "Spectrum",
    "row.peak": "peak",
    "row.maxRate": "Max rate",
    "row.azimuth": "Azimuth",
    "row.estimated": "estimated",
    "row.confidence": "confidence",
    "row.hidden": "hidden",
    "row.local": "local",
    "row.vendor": "Vendor",
    "row.seen": "Seen",
    "row.ago": "{v} ago",
    "row.samples": "{n} samples",
    "rssi.excellent": "excellent",
    "rssi.good": "good",
    "rssi.fair": "fair",
    "rssi.weak": "weak",
    "rssi.critical": "critical",
    "net.bestChannels": "best channels:",
    "interf.cochannel": "{n} co-channel",
    "interf.partial": "{n} partial",
    "dock.bestChannel": "best channel",
    "dock.load": "load",
    "toast.envModel": "Propagation model: {v}",
    "toast.reportBusy": "Generating {k} report…",
    "toast.reportSaved": "Report saved: {v}",
    "toast.reportUnavailable": "Report unavailable: {v}",
    "toast.failed": "Failed: {v}",
    "scene.you": "YOU",
    "latency.avg": "avg",
    "latency.min": "min",
    "latency.jitter": "jit",
    "latency.loss": "loss",
    "cam.title": "Camera (1·2·3)",
    "cam.orbit": "Orbit",
    "cam.radar": "Radar",
    "cam.ground": "Ground",
    "env.title": "Propagation model",
    "env.open": "Open space",
    "env.residential": "Residential",
    "env.office": "Office",
    "env.dense": "Dense building",
    "layers.title": "Layers",
    "layers.field": "RF field",
    "layers.beams": "Signal beams",
    "layers.rain": "Digital rain",
    "layers.rotate": "Auto-rotate",
    "labels.title": "Labels",
    "labels.auto": "Auto",
    "labels.all": "All",
    "labels.off": "Off",
    "export.title": "Export",
    "export.png": "Scene capture (PNG)",
    "export.csv": "Networks (CSV)",
    "export.json": "Full snapshot (JSON)",
    "export.pdf": "PDF report",
    "export.word": "DOCX report",
    "export.excel": "XLSX spreadsheet",
    "cinema.title": "Cinema mode (H)",
    "lang.title": "Language",
    "common.close": "Close",
    "networks.title": "Networks",
    "networks.collapse": "Collapse (N)",
    "networks.search": "Search  /",
    "networks.sort": "Sort",
    "networks.tab": "NETWORKS",
    "bands.all": "All",
    "sort.signal": "Signal",
    "sort.distance": "Distance",
    "sort.channel": "Channel",
    "sort.name": "Name",
    "ins.close": "Close (Esc)",
    "ins.distance": "Estimated distance",
    "ins.interference": "Interference",
    "ins.focus": "Center camera",
    "dock.spectrum": "Spectrum",
    "dock.latency": "Latency",
    "dock.events": "Events",
    "dock.collapse": "Collapse (D)",
    "dock.tab": "SPECTRUM · LATENCY · EVENTS",
    "hint.cinema": "cinema",
    "hint.camera": "camera",
    "hint.networks": "networks",
    "hint.field": "RF field",
  },
};

const LOCALES = { pt: "pt-BR", en: "en-US" };
const STORAGE_KEY = "wi-lang";

function storedLang() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return STRINGS[value] ? value : null;
  } catch {
    return null; // storage unavailable (private mode): Portuguese
  }
}

export const lang = storedLang() ?? "pt";
export const locale = LOCALES[lang];

/** Translates a key; `{name}` placeholders are filled from `vars`. Falls back to Portuguese, then to the key. */
export function t(key, vars) {
  const text = STRINGS[lang][key] ?? STRINGS.pt[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "") : text;
}

/** Saves the choice and reloads, so engine-independent strings built in JS are rendered in the new language. */
export function setLang(next) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // not persisted: the switch still applies to this page load
  }
  location.reload();
}

/** Applies translations to the static markup marked with data-i18n attributes. */
export function applyStatic() {
  document.documentElement.lang = locale;
  document.title = t("app.title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  const picker = document.getElementById("lang");
  if (picker) picker.value = lang;
}

applyStatic();
