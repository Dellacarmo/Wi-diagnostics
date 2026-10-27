/**
 * Exports: CSV straight from the snapshot, and PDF/DOCX/XLSX through the existing
 * Python ReportGenerator (python/report_cli.py) when its dependencies are installed.
 */

import { join } from "node:path";
import type { Snapshot } from "./types";

const ROOT = join(import.meta.dir, "..");

export function networksCsv(s: Snapshot): string {
  const cols = [
    "name", "ssid", "bssid", "vendor", "band", "channel", "width_mhz", "freq_mhz", "rssi_dbm", "rssi_std",
    "snr_db", "quality", "distance_m", "distance_min_m", "distance_max_m", "security", "grade", "phy",
    "generation", "interference", "sir_db", "connected", "samples",
  ];
  // SSIDs are attacker-controlled: neutralize spreadsheet formulas (strings only, so -54 stays a number).
  const esc = (v: unknown) => {
    let t = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = s.networks.map((n) =>
    [
      n.name, n.ssid, n.bssid, n.vendor, n.band, n.channel, n.width, n.freq, n.rssi, n.rssiStd, n.snr, n.quality,
      n.distance.est, n.distance.min, n.distance.max, n.security, n.securityGrade, n.phy, n.generation,
      n.interference.score, n.interference.sir, n.connected, n.samples,
    ].map(esc).join(","),
  );
  return [cols.join(","), ...rows].join("\n") + "\n";
}

/** openpyxl stores any string starting with "=" as a formula. */
const noFormula = (v: string | null) => (v?.startsWith("=") ? `'${v}` : v);

/** Maps the snapshot to the legacy report schema used by python/report_generator.py. */
function legacyPayload(s: Snapshot) {
  return {
    access_points: s.networks.map((n) => ({
      ssid_label: noFormula(n.name),
      ssid_raw: noFormula(n.ssid ?? n.name),
      bssid: n.bssid ?? n.id,
      band: n.band === "2.4" ? "2.4GHz" : `${n.band}GHz`,
      channel: n.channel,
      frequency: n.freq,
      rssi: n.rssiRaw,
      rssi_mean: n.rssi,
      rssi_std: n.rssiStd,
      signal_quality: n.quality,
      distance_estimate: n.distance.est,
      security: noFormula(n.security),
      sample_count: n.samples,
    })),
    scan_stats: {
      total_aps: s.stats.total,
      band_24ghz: s.stats.byBand["2.4"],
      band_5ghz: s.stats.byBand["5"] + s.stats.byBand["6"],
      avg_rssi: s.stats.avgRssi ?? 0,
      total_scans: s.scan.count,
    },
    log_stats: { total_logs: s.syslog.received, errors: 0, warnings: 0, connections: 0, total_outages: 0, total_downtime_seconds: 0, currently_down: false },
    outages: [],
    network_config: {
      hostname: noFormula(s.host.hostname),
      os: s.host.os,
      local_ip: s.link.ip,
      gateway: s.link.gateway,
      active_wifi_ssid: noFormula(s.link.ssid),
    },
    positions: Object.fromEntries(s.networks.map((n) => [n.bssid ?? n.id, { x: n.position.x, y: n.position.y, z: n.position.z }])),
  };
}

export interface ReportResult {
  ok: boolean;
  files?: Record<string, string>;
  error?: string;
}

export async function generateReport(s: Snapshot, format: string): Promise<ReportResult> {
  const python = Bun.which("python3") ?? Bun.which("python");
  if (!python) return { ok: false, error: "Python não encontrado — use a exportação CSV/JSON" };
  try {
    const proc = Bun.spawn([python, join(ROOT, "python", "report_cli.py"), format], {
      cwd: ROOT,
      // Windows pipes default to the ANSI code page; the bridge speaks UTF-8 JSON.
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify(legacyPayload(s)));
    proc.stdin.end();
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const parsed = JSON.parse(out.trim().split("\n").pop() || "{}");
    if (parsed.error) return { ok: false, error: parsed.error };
    const files = Object.fromEntries(Object.entries(parsed).filter(([k]) => !k.endsWith("_error"))) as Record<string, string>;
    const errors = Object.entries(parsed).filter(([k]) => k.endsWith("_error")).map(([k, v]) => `${k}: ${v}`);
    if (!Object.keys(files).length) return { ok: false, error: errors.join("; ") || err.trim() || "nenhum relatório gerado" };
    return { ok: true, files };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
