/**
 * Shared data model for the Wi-Diagnostics engine.
 * Everything the CLI and the web frontend render comes from a `Snapshot`.
 */

export type Band = "2.4" | "5" | "6";

export type SourceKind = "macos" | "macos-profiler" | "linux" | "windows" | "demo";

/** One network as reported by a platform scanner, before tracking/filtering. */
export interface RawObservation {
  ssid: string | null;
  bssid: string | null;
  rssi: number;
  noise: number | null;
  channel: number;
  band: Band;
  width: number; // MHz
  security: string[]; // normalized tokens: open, wep, wpa, wpa2, wpa3, wpa3t, wpa2e, wpa3e, owe
  phy: string[]; // a, b, g, n, ac, ax, be
  beaconInterval: number | null;
}

/** Link-level telemetry for the interface the host is associated with. */
export interface RawLink {
  iface: string | null;
  ssid: string | null;
  bssid: string | null;
  rssi: number | null;
  noise: number | null;
  txRate: number | null; // Mbps
  mcs: number | null;
  channel: number | null;
  band: Band | null;
  width: number | null;
  phy: string | null;
  security: string | null;
  txPower: number | null; // mW
  mac: string | null;
  country: string | null;
}

export interface ScanBatch {
  networks: RawObservation[];
  durationMs: number;
}

export interface SourceStatus {
  kind: SourceKind;
  label: string;
  redacted: boolean; // OS hides SSID/BSSID (macOS without Location permission)
  note: string | null;
}

export interface DistanceEstimate {
  est: number; // meters
  min: number;
  max: number;
}

export interface Position {
  x: number; // meters, receiver at origin, y is up
  y: number;
  z: number;
  azimuth: number; // radians
  confidence: number; // 0..1
}

export interface Interference {
  score: number; // 0 (clean) .. 100 (saturated)
  cochannel: number; // networks sharing the primary channel
  overlapping: number; // networks with partial spectral overlap
  sir: number | null; // signal-to-interference ratio in dB
  neighbors: string[]; // ids of the strongest overlapping networks
}

export interface NetworkView {
  id: string;
  name: string; // SSID or generated codename
  ssid: string | null;
  redacted: boolean;
  hidden: boolean;
  bssid: string | null;
  vendor: string | null;
  randomizedMac: boolean;
  group: string | null; // physical radio cluster id

  band: Band;
  channel: number;
  width: number;
  freq: number; // primary channel center, MHz
  span: [number, number]; // occupied spectrum, MHz

  rssi: number; // filtered dBm
  rssiRaw: number;
  rssiStd: number;
  rssiPeak: number;
  noise: number | null;
  snr: number | null;
  quality: number; // 0..100
  history: number[]; // filtered RSSI, oldest first

  distance: DistanceEstimate;
  position: Position;

  security: string; // human readable, e.g. "WPA2/WPA3"
  securityTokens: string[];
  securityGrade: "A" | "B" | "C" | "D" | "F";
  phy: string; // "802.11ax"
  generation: string; // "Wi-Fi 6E"
  maxRate: number | null; // theoretical PHY rate estimate, Mbps
  beaconInterval: number | null;

  interference: Interference;
  connected: boolean;
  stale: boolean; // missed the last scan(s)
  firstSeen: number;
  lastSeen: number;
  samples: number;
}

export interface PingStat {
  target: string | null;
  last: number | null; // ms
  avg: number | null;
  min: number | null;
  max: number | null;
  jitter: number | null;
  loss: number; // 0..1 over the window
  history: (number | null)[]; // null = timeout
}

export interface LinkView {
  connected: boolean;
  iface: string | null;
  ssid: string | null;
  bssid: string | null;
  networkId: string | null; // matched NetworkView id
  rssi: number | null;
  noise: number | null;
  snr: number | null;
  txRate: number | null;
  mcs: number | null;
  phy: string | null;
  generation: string | null;
  channel: number | null;
  band: Band | null;
  width: number | null;
  security: string | null;
  txPowerDbm: number | null;
  mac: string | null;
  ip: string | null;
  ipv6: string | null;
  gateway: string | null;
  routerMac: string | null;
  routerVendor: string | null;
  dns: string[];
  country: string | null;
  quality: number | null; // 0..100 composite link score
  verdict: string; // short human diagnosis
  rssiHistory: number[];
  gatewayPing: PingStat;
  internetPing: PingStat;
}

export interface ChannelStat {
  channel: number;
  freq: number;
  load: number; // 0..1 relative airtime pressure
  count: number;
}

export interface BandSpectrum {
  band: Band;
  range: [number, number]; // MHz
  channels: ChannelStat[];
  best: { channel: number; width: number; load: number; span: [number, number] } | null;
}

export interface WiEvent {
  id: number;
  t: number;
  level: "info" | "good" | "warn" | "bad";
  kind: string;
  message: string;
  networkId?: string;
}

export interface EnvironmentModel {
  preset: EnvironmentPreset;
  label: string;
  exponent: number; // path loss exponent n
  shadowing: number; // dB, log-normal sigma
}

export type EnvironmentPreset = "open" | "residential" | "office" | "dense";

export interface Snapshot {
  t: number;
  seq: number;
  version: string;
  source: SourceStatus;
  host: { hostname: string; os: string; platform: string };
  scan: { count: number; lastAt: number | null; durationMs: number | null; intervalMs: number };
  env: EnvironmentModel;
  networks: NetworkView[];
  link: LinkView;
  spectrum: BandSpectrum[];
  events: WiEvent[];
  stats: {
    total: number;
    visible: number;
    byBand: Record<Band, number>;
    avgRssi: number | null;
    strongest: string | null;
    openNetworks: number;
    busiestChannel: { band: Band; channel: number; count: number } | null;
  };
  syslog: { enabled: boolean; port: number | null; received: number };
}
