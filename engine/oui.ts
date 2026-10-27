/**
 * MAC vendor (OUI) lookup.
 * Uses whatever OUI database exists locally (project cache, IEEE files, Wireshark),
 * and can download the official IEEE registry on demand (`wi oui update`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OUI_CACHE = join(process.env.WI_CACHE_DIR || join(import.meta.dir, "..", ".cache"), "oui.csv");
const IEEE_URL = "https://standards-oui.ieee.org/oui/oui.csv";

const CANDIDATES = [
  OUI_CACHE,
  "/usr/share/ieee-data/oui.csv",
  "/usr/share/ieee-data/oui.txt",
  "/usr/share/misc/oui.txt",
  "/usr/share/wireshark/manuf",
  "/opt/homebrew/share/wireshark/manuf",
  "/Applications/Wireshark.app/Contents/Resources/share/wireshark/manuf",
];

let table: Map<string, string> | null = null;
let loadedFrom: string | null = null;

function parseInto(map: Map<string, string>, text: string) {
  for (const line of text.split("\n")) {
    // IEEE CSV: MA-L,AABBCC,Org Name,Address
    let m = line.match(/^MA-L,([0-9A-F]{6}),("?)(.+?)\2,/i);
    if (m) {
      map.set(m[1].toUpperCase(), m[3].trim());
      continue;
    }
    // IEEE TXT: AA-BB-CC   (hex)		Org Name
    m = line.match(/^([0-9A-F]{2})-([0-9A-F]{2})-([0-9A-F]{2})\s+\(hex\)\s+(.+)$/i);
    if (m) {
      map.set((m[1] + m[2] + m[3]).toUpperCase(), m[4].trim());
      continue;
    }
    // Wireshark manuf: AA:BB:CC<TAB>Short<TAB>Long
    m = line.match(/^([0-9A-F]{2}):([0-9A-F]{2}):([0-9A-F]{2})\s+(\S+)(?:\s+(.+))?$/i);
    if (m) map.set((m[1] + m[2] + m[3]).toUpperCase(), (m[5] || m[4]).trim());
  }
}

function load() {
  table = new Map();
  for (const path of CANDIDATES) {
    if (!existsSync(path)) continue;
    try {
      parseInto(table, readFileSync(path, "utf8"));
      if (table.size) {
        loadedFrom = path;
        return;
      }
    } catch {
      // try the next candidate
    }
  }
}

function shorten(org: string): string {
  return org
    .replace(/,?\s+(Inc|Ltd|LLC|Corp|Corporation|Co|GmbH|S\.A|Limited|Technologies|Technology|Electronics)\.?\b.*$/i, "")
    .trim()
    .slice(0, 28);
}

export function lookupVendor(mac: string | null): string | null {
  if (!mac) return null;
  if (!table) load();
  const key = mac.replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase();
  const org = table!.get(key);
  return org ? shorten(org) : null;
}

export function ouiStatus() {
  if (!table) load();
  return { entries: table!.size, source: loadedFrom };
}

export async function updateOuiDatabase(): Promise<number> {
  const res = await fetch(IEEE_URL);
  if (!res.ok) throw new Error(`IEEE registry respondeu ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(OUI_CACHE), { recursive: true });
  writeFileSync(OUI_CACHE, text);
  table = null;
  return ouiStatus().entries;
}
