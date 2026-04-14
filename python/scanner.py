"""
WiFi Scanner Module
Cross-platform WiFi access point scanning with RSSI, frequency, and BSSID collection.
Supports Windows (netsh) and Linux (nmcli/iwlist).
"""

import platform
import subprocess
import re
import hashlib
import time
import ctypes
import locale
import threading
import unicodedata
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field, asdict
from datetime import datetime


@dataclass
class AccessPoint:
    """Represents a discovered WiFi access point."""
    ssid_raw: str               # Original SSID
    ssid_label: str             # Obfuscated label (SSID1, SSID2, etc.)
    bssid: str                  # MAC address
    bssid_hash: str             # Hashed BSSID for deterministic positioning
    rssi: float                 # Signal strength in dBm
    signal_quality: float       # Signal quality percentage
    frequency: float            # Frequency in MHz
    channel: int                # Channel number
    band: str                   # "2.4GHz" or "5GHz"
    security: str               # Authentication type
    distance_estimate: float    # Estimated distance in meters
    first_seen: datetime = None
    last_seen: datetime = None
    sample_count: int = 0
    rssi_history: List[float] = field(default_factory=list)
    rssi_mean: float = 0.0
    rssi_std: float = 0.0
    position: Optional[Dict[str, float]] = None  # x, y, z
    position_uncertainty: float = 1.0  # 0=confident, 1=uncertain

    def __post_init__(self):
        if self.first_seen is None:
            self.first_seen = datetime.now()
        if self.last_seen is None:
            self.last_seen = datetime.now()

    def update_rssi(self, new_rssi: float):
        """Update with a new RSSI sample."""
        self.rssi = new_rssi
        self.rssi_history.append(new_rssi)
        self.sample_count += 1
        self.last_seen = datetime.now()

        # Keep last 100 samples
        if len(self.rssi_history) > 100:
            self.rssi_history = self.rssi_history[-100:]

        # Compute running statistics
        n = len(self.rssi_history)
        self.rssi_mean = sum(self.rssi_history) / n
        if n > 1:
            variance = sum((x - self.rssi_mean) ** 2 for x in self.rssi_history) / (n - 1)
            self.rssi_std = variance ** 0.5
        else:
            self.rssi_std = 0.0

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to dictionary for WebSocket transmission."""
        d = asdict(self)
        d["first_seen"] = self.first_seen.isoformat() if self.first_seen else None
        d["last_seen"] = self.last_seen.isoformat() if self.last_seen else None
        return d


class WiFiScanner:
    """Cross-platform WiFi scanner with continuous monitoring."""

    # Log-Distance Path Loss Model parameters
    REF_RSSI = -30.0       # Reference RSSI at 1 meter (typical for WiFi)
    PATH_LOSS_EXPONENT = 2.7  # Indoor environment typical value
    REF_DISTANCE = 1.0     # Reference distance in meters

    def __init__(self, interface_name: Optional[str] = None):
        self.os_type = platform.system()
        self.interface_name = interface_name
        self.access_points: Dict[str, AccessPoint] = {}  # Key: BSSID
        self.ssid_counter = 0
        self.ssid_map: Dict[str, str] = {}  # BSSID -> obfuscated label
        self._lock = threading.Lock()
        self._scanning = False
        self._scan_thread: Optional[threading.Thread] = None
        self._scan_interval = 2.0  # seconds between scans
        self._callbacks: List[Any] = []  # Called after each scan with AP list
        self.total_scans = 0
        self._last_scan_command = ""
        self._last_scan_os_ssid_count = 0
        self._last_scan_os_bssid_count = 0
        self._last_scan_parsed_count = 0
        self._last_scan_timestamp = None

    def _record_scan_metrics(
        self,
        command: List[str],
        os_ssid_count: int,
        os_bssid_count: int,
        parsed_count: int,
    ):
        """Store raw scan diagnostics for UI transparency and troubleshooting."""
        with self._lock:
            self._last_scan_command = " ".join(command)
            self._last_scan_os_ssid_count = int(max(0, os_ssid_count))
            self._last_scan_os_bssid_count = int(max(0, os_bssid_count))
            self._last_scan_parsed_count = int(max(0, parsed_count))
            self._last_scan_timestamp = datetime.now().isoformat()

    def on_scan_complete(self, callback):
        """Register a callback to be called after each scan."""
        self._callbacks.append(callback)

    def rssi_to_distance(self, rssi: float) -> float:
        """
        Convert RSSI to estimated distance using Log-Distance Path Loss Model.
        d = 10^((A - RSSI) / (10 * n))
        where A = reference RSSI at 1m, n = path loss exponent
        """
        try:
            ratio = (self.REF_RSSI - rssi) / (10.0 * self.PATH_LOSS_EXPONENT)
            distance = self.REF_DISTANCE * (10 ** ratio)
            # Cap at reasonable maximum
            return min(max(distance, 0.5), 100.0)
        except (ZeroDivisionError, OverflowError, ValueError):
            return 10.0  # Default fallback

    def quality_to_rssi(self, quality: float) -> float:
        """
        Convert Windows signal quality (%) to approximate RSSI (dBm).
        RSSI ≈ (quality / 2) - 100
        This is an approximation as the relationship is non-linear.
        """
        return (quality / 2.0) - 100.0

    def determine_band(self, frequency: float) -> str:
        """Determine WiFi band from frequency."""
        if frequency > 3000:
            return "5GHz"
        return "2.4GHz"

    def frequency_to_channel(self, freq: float) -> int:
        """Convert frequency to channel number."""
        if freq > 3000:  # 5GHz
            if 5170 <= freq <= 5320:
                return int((freq - 5000) / 5)
            elif 5500 <= freq <= 5720:
                return int((freq - 5000) / 5)
            elif 5745 <= freq <= 5825:
                return int((freq - 5000) / 5)
            else:
                return int((freq - 5000) / 5)
        else:  # 2.4GHz
            if 2412 <= freq <= 2484:
                return int((freq - 2407) / 5)
            return int((freq - 2407) / 5)

    def get_obfuscated_label(self, bssid: str) -> str:
        """Get or create an obfuscated SSID label for a BSSID."""
        if bssid not in self.ssid_map:
            self.ssid_counter += 1
            self.ssid_map[bssid] = f"SSID{self.ssid_counter}"
        return self.ssid_map[bssid]

    def hash_bssid(self, bssid: str) -> str:
        """Create a deterministic hash of BSSID for positioning seed."""
        return hashlib.md5(bssid.encode()).hexdigest()

    def _decode_output(self, data: bytes) -> str:
        """Decode command output with locale-aware fallback encodings."""
        if isinstance(data, str):
            return data

        encodings = []

        if self.os_type == "Windows":
            try:
                oem_cp = ctypes.windll.kernel32.GetOEMCP()
                if oem_cp:
                    encodings.append(f"cp{oem_cp}")
            except Exception:
                pass

            try:
                ansi_cp = ctypes.windll.kernel32.GetACP()
                if ansi_cp:
                    encodings.append(f"cp{ansi_cp}")
            except Exception:
                pass

            encodings.extend(["utf-8", "cp850", "cp1252", "mbcs", "latin-1"])
        else:
            encodings.extend(["utf-8", "latin-1"])

        preferred = locale.getpreferredencoding(False)
        if preferred:
            encodings.insert(0, preferred)

        seen = set()
        for encoding in encodings:
            enc = (encoding or "").strip().lower()
            if not enc or enc in seen:
                continue
            seen.add(enc)
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue

        return data.decode("utf-8", errors="replace")

    def _normalize_text(self, value: str) -> str:
        """Normalize keys/text for locale-agnostic parsing."""
        if not value:
            return ""
        normalized = unicodedata.normalize("NFKD", value)
        normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
        return normalized.strip().lower()

    def _split_escaped_fields(self, line: str, sep: str = ":") -> List[str]:
        """Split a nmcli terse line honoring escaped separators."""
        fields: List[str] = []
        current: List[str] = []
        escaped = False

        for ch in line:
            if escaped:
                current.append(ch)
                escaped = False
                continue

            if ch == "\\":
                escaped = True
                continue

            if ch == sep:
                fields.append("".join(current))
                current = []
                continue

            current.append(ch)

        fields.append("".join(current))
        return fields

    def _unescape_nmcli_field(self, value: str) -> str:
        return value.replace("\\:", ":").replace("\\\\", "\\").strip()

    def scan_windows(self) -> List[Dict[str, Any]]:
        """Scan WiFi networks on Windows using netsh."""
        aps = []
        command = ["netsh", "wlan", "show", "networks", "mode=bssid"]
        observed_ssid_count = 0
        observed_bssid_count = 0
        try:
            if self.interface_name:
                # Interface-scoped scans are more reliable on Windows adapters that expose
                # primary/secondary virtual interfaces (for example Wi-Fi 7 MLO devices).
                command.append(f"interface={self.interface_name}")

            result = subprocess.run(
                command,
                capture_output=True,
                text=False,
                timeout=30,
            )
            output = self._decode_output(result.stdout)

            current_ssid = "Hidden"
            current_security = "Unknown"
            current_ap: Optional[Dict[str, Any]] = None

            def finalize_current_ap():
                nonlocal current_ap
                if current_ap and current_ap.get("bssid"):
                    aps.append(self._finalize_windows_ap(current_ap, current_ap["bssid"]))
                current_ap = None

            for raw_line in output.splitlines():
                line = raw_line.strip()
                if not line:
                    continue

                # SSID header block: "SSID 1 : ..."
                ssid_match = re.match(r"^SSID\s+\d+\s*:\s*(.*)$", line, flags=re.IGNORECASE)
                if ssid_match and "BSSID" not in line.upper():
                    finalize_current_ap()
                    observed_ssid_count += 1
                    current_ssid = ssid_match.group(1).strip() or "Hidden"
                    current_security = "Unknown"
                    continue

                # BSSID row block: "BSSID 1 : xx:xx:..."
                bssid_match = re.match(
                    r"^BSSID\s+\d+\s*:\s*([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})",
                    line,
                    flags=re.IGNORECASE,
                )
                if bssid_match:
                    finalize_current_ap()
                    observed_bssid_count += 1
                    current_ap = {
                        "ssid": current_ssid,
                        "bssid": bssid_match.group(1).upper(),
                        "security": current_security,
                        "signal_quality": 0.0,
                        "rssi": -85.0,
                        "channel": 0,
                        "band_hint": "2.4GHz",
                    }
                    continue

                if ":" not in line:
                    continue

                key_raw, value_raw = line.split(":", 1)
                key = self._normalize_text(key_raw)
                key_compact = re.sub(r"\s+", " ", key)
                value = value_raw.strip()

                # Security sometimes appears before any BSSID line; keep SSID-level default.
                if current_ap is None:
                    if "authentication" in key or "autentic" in key:
                        current_security = value or "Unknown"
                    elif ("encryption" in key or "criptografia" in key) and current_security == "Unknown":
                        current_security = value or "Unknown"
                    continue

                if key_compact in ("signal", "sinal"):
                    signal_str = value.rstrip("%")
                    try:
                        quality = float(signal_str)
                        current_ap["signal_quality"] = quality
                        current_ap["rssi"] = self.quality_to_rssi(quality)
                    except ValueError:
                        current_ap["signal_quality"] = 50.0
                        current_ap["rssi"] = -75.0
                    continue

                if key_compact in ("channel", "canal"):
                    try:
                        current_ap["channel"] = int(value)
                    except ValueError:
                        # Keep previous channel if line is not a pure channel number.
                        pass
                    continue

                if "authentication" in key_compact or "autentic" in key_compact:
                    current_ap["security"] = value or current_ap.get("security", "Unknown")
                    continue

                if "encryption" in key_compact or "criptografia" in key_compact:
                    if current_ap.get("security", "Unknown") == "Unknown":
                        current_ap["security"] = value or "Unknown"
                    continue

                if "radio type" in key_compact or "tipo de radio" in key_compact:
                    radio = value.lower()
                    if any(tok in radio for tok in ("802.11a", "802.11ac", "802.11ax", "802.11be")):
                        current_ap["band_hint"] = "5GHz"
                    else:
                        current_ap["band_hint"] = "2.4GHz"
                    continue

                if key_compact.startswith("band") or key_compact == "banda":
                    band_val = value.lower()
                    if "5" in band_val:
                        current_ap["band_hint"] = "5GHz"
                    elif "2.4" in band_val:
                        current_ap["band_hint"] = "2.4GHz"

            finalize_current_ap()

        except subprocess.TimeoutExpired:
            print("[scanner] ⚠️ netsh scan timed out")
        except Exception as e:
            print(f"[scanner] Error scanning Windows: {e}")

        self._record_scan_metrics(
            command,
            os_ssid_count=observed_ssid_count,
            os_bssid_count=observed_bssid_count,
            parsed_count=len(aps),
        )

        return aps

    def _finalize_windows_ap(self, ap_data: Dict, bssid: str) -> Dict:
        """Finalize a parsed Windows AP entry."""
        channel = ap_data.get("channel", 0)
        band_hint = ap_data.get("band_hint", "2.4GHz")

        if channel > 14:
            band = "5GHz"
            frequency = 5000 + (channel * 5)
        else:
            band = band_hint
            frequency = 2407 + (channel * 5) if channel > 0 else 2412

        return {
            "ssid": ap_data.get("ssid", "Unknown"),
            "bssid": bssid,
            "rssi": ap_data.get("rssi", -80),
            "signal_quality": ap_data.get("signal_quality", 0),
            "channel": channel,
            "frequency": float(frequency),
            "band": band,
            "security": ap_data.get("security", "Unknown"),
        }

    def scan_linux(self) -> List[Dict[str, Any]]:
        """Scan WiFi networks on Linux using nmcli."""
        aps = []
        command = [
            "nmcli", "-t", "-e", "yes", "-f", "SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY",
            "dev", "wifi", "list", "--rescan", "yes"
        ]
        observed_bssid_count = 0
        observed_ssids = set()
        try:
            if self.interface_name:
                command.extend(["ifname", self.interface_name])

            result = subprocess.run(
                command,
                capture_output=True,
                text=False,
                timeout=30,
            )
            output = self._decode_output(result.stdout)

            for line in output.strip().split("\n"):
                if not line or line.startswith("SSID"):
                    continue

                observed_bssid_count += 1

                fields = self._split_escaped_fields(line)

                if len(fields) >= 6:
                    ssid = self._unescape_nmcli_field(fields[0]) or "Hidden"
                    bssid = self._unescape_nmcli_field(fields[1]).upper()
                    signal_str = self._unescape_nmcli_field(fields[2])
                    freq_str = self._unescape_nmcli_field(fields[3])
                    chan_str = self._unescape_nmcli_field(fields[4])
                    security = self._unescape_nmcli_field(fields[5]) if len(fields) > 5 else "Unknown"

                    if not re.match(r"^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$", bssid):
                        continue

                    observed_ssids.add(ssid)

                    try:
                        signal_quality = float(signal_str)
                        rssi = self.quality_to_rssi(signal_quality)
                    except ValueError:
                        signal_quality = 0
                        rssi = -90

                    try:
                        frequency = float(freq_str)
                    except ValueError:
                        frequency = 2412.0

                    try:
                        channel = int(chan_str)
                    except ValueError:
                        channel = self.frequency_to_channel(frequency)

                    band = self.determine_band(frequency)

                    aps.append({
                        "ssid": ssid,
                        "bssid": bssid,
                        "rssi": rssi,
                        "signal_quality": signal_quality,
                        "channel": channel,
                        "frequency": frequency,
                        "band": band,
                        "security": security,
                    })

        except subprocess.TimeoutExpired:
            print("[scanner] ⚠️ nmcli scan timed out")
        except FileNotFoundError:
            print("[scanner] nmcli not found, trying iwlist...")
            aps = self._scan_iwlist()
        except Exception as e:
            print(f"[scanner] Error scanning Linux: {e}")

        self._record_scan_metrics(
            command,
            os_ssid_count=len(observed_ssids),
            os_bssid_count=observed_bssid_count,
            parsed_count=len(aps),
        )

        return aps

    def _scan_iwlist(self) -> List[Dict[str, Any]]:
        """Fallback WiFi scan using iwlist."""
        aps = []
        command = ["sudo", "iwlist", self.interface_name or "wlan0", "scan"]
        try:
            iface = self.interface_name or "wlan0"
            result = subprocess.run(
                ["sudo", "iwlist", iface, "scan"],
                capture_output=True, text=True, timeout=30
            )
            output = result.stdout

            current_ap = {}
            for line in output.split("\n"):
                line = line.strip()

                if "Cell" in line and "Address" in line:
                    if current_ap.get("bssid"):
                        aps.append(current_ap)
                    bssid = line.split("Address:")[1].strip() if "Address:" in line else ""
                    current_ap = {"bssid": bssid, "ssid": "Unknown", "security": "Unknown"}

                if "ESSID:" in line:
                    ssid = line.split("ESSID:")[1].strip().strip('"')
                    current_ap["ssid"] = ssid or "Hidden"

                if "Quality=" in line:
                    quality_match = re.search(r'Quality=(\d+)/(\d+)', line)
                    if quality_match:
                        q = int(quality_match.group(1))
                        q_max = int(quality_match.group(2))
                        current_ap["signal_quality"] = (q / q_max) * 100

                    level_match = re.search(r'Signal level=(-?\d+)', line)
                    if level_match:
                        current_ap["rssi"] = float(level_match.group(1))
                    elif current_ap.get("signal_quality"):
                        current_ap["rssi"] = self.quality_to_rssi(current_ap["signal_quality"])

                if "Frequency:" in line:
                    freq_match = re.search(r'Frequency:(\d+\.?\d*)', line)
                    if freq_match:
                        freq = float(freq_match.group(1))
                        current_ap["frequency"] = freq * 1000  # GHz -> MHz
                        current_ap["band"] = self.determine_band(freq * 1000)
                        current_ap["channel"] = self.frequency_to_channel(freq * 1000)

                if "IE: IEEE 802.11i/WPA2" in line:
                    current_ap["security"] = "WPA2"
                elif "IE: WPA Version 1" in line:
                    current_ap["security"] = "WPA"

            if current_ap.get("bssid"):
                aps.append(current_ap)

        except Exception as e:
            print(f"[scanner] Error scanning with iwlist: {e}")

        self._record_scan_metrics(
            command,
            os_ssid_count=len({ap.get("ssid", "Hidden") for ap in aps}),
            os_bssid_count=len(aps),
            parsed_count=len(aps),
        )

        return aps

    def scan(self) -> List[AccessPoint]:
        """Perform a single WiFi scan and return updated AP list."""
        if self.os_type == "Windows":
            raw_aps = self.scan_windows()
        else:
            raw_aps = self.scan_linux()

        with self._lock:
            for raw_ap in raw_aps:
                bssid = raw_ap.get("bssid", "").upper()
                if not bssid:
                    continue

                rssi = raw_ap.get("rssi", -80)
                frequency = raw_ap.get("frequency", 2412.0)
                channel = raw_ap.get("channel", 0)
                band = raw_ap.get("band", "2.4GHz")

                if bssid in self.access_points:
                    # Update existing AP
                    ap = self.access_points[bssid]
                    ap.update_rssi(rssi)
                    ap.distance_estimate = self.rssi_to_distance(ap.rssi_mean)
                    ap.signal_quality = raw_ap.get("signal_quality", ap.signal_quality)
                else:
                    # New AP discovered
                    label = self.get_obfuscated_label(bssid)
                    distance = self.rssi_to_distance(rssi)

                    ap = AccessPoint(
                        ssid_raw=raw_ap.get("ssid", "Unknown"),
                        ssid_label=label,
                        bssid=bssid,
                        bssid_hash=self.hash_bssid(bssid),
                        rssi=rssi,
                        signal_quality=raw_ap.get("signal_quality", 0),
                        frequency=frequency,
                        channel=channel,
                        band=band,
                        security=raw_ap.get("security", "Unknown"),
                        distance_estimate=distance,
                    )
                    ap.update_rssi(rssi)
                    self.access_points[bssid] = ap

            self.total_scans += 1

        # Fire callbacks
        ap_list = self.get_access_points()
        for cb in self._callbacks:
            try:
                cb(ap_list)
            except Exception as e:
                print(f"[scanner] Callback error: {e}")

        return ap_list

    def get_access_points(self) -> List[AccessPoint]:
        """Get a copy of the current AP list."""
        with self._lock:
            return list(self.access_points.values())

    def get_stats(self) -> Dict[str, Any]:
        """Get scanning statistics."""
        with self._lock:
            aps = list(self.access_points.values())
            band_24 = sum(1 for ap in aps if ap.band == "2.4GHz")
            band_5 = sum(1 for ap in aps if ap.band == "5GHz")
            avg_rssi = sum(ap.rssi_mean for ap in aps) / len(aps) if aps else 0

            return {
                "total_aps": len(aps),
                "band_24ghz": band_24,
                "band_5ghz": band_5,
                "avg_rssi": round(avg_rssi, 1),
                "total_scans": self.total_scans,
                "strongest_signal": max((ap.rssi_mean for ap in aps), default=0),
                "weakest_signal": min((ap.rssi_mean for ap in aps), default=0),
                "last_scan_os_ssid_count": self._last_scan_os_ssid_count,
                "last_scan_os_bssid_count": self._last_scan_os_bssid_count,
                "last_scan_parsed_count": self._last_scan_parsed_count,
                "last_scan_command": self._last_scan_command,
                "last_scan_interface": self.interface_name,
                "last_scan_timestamp": self._last_scan_timestamp,
            }

    def start_continuous_scan(self, interval: float = 2.0):
        """Start continuous scanning in a background thread."""
        if self._scanning:
            return

        self._scanning = True
        self._scan_interval = interval
        self._scan_thread = threading.Thread(target=self._scan_loop, daemon=True)
        self._scan_thread.start()
        iface_msg = f" on {self.interface_name}" if self.interface_name else ""
        print(f"[scanner] 🛰️ Continuous scanning started{iface_msg} (interval: {interval}s)")

    def stop_continuous_scan(self):
        """Stop the continuous scanning loop."""
        if not self._scanning:
            return

        self._scanning = False
        if self._scan_thread:
            self._scan_thread.join(timeout=5)
            self._scan_thread = None
        print("[scanner] Scanning stopped")

    def _scan_loop(self):
        """Background scanning loop."""
        while self._scanning:
            try:
                self.scan()
            except Exception as e:
                print(f"[scanner] Scan error: {e}")
            time.sleep(self._scan_interval)


if __name__ == "__main__":
    scanner = WiFiScanner()

    def on_scan(aps):
        print(f"\n📡 Found {len(aps)} access points:")
        for ap in aps:
            print(f"  {ap.ssid_label} | {ap.band} | RSSI: {ap.rssi:.0f}dBm | "
                  f"Dist: {ap.distance_estimate:.1f}m | Ch: {ap.channel}")

    scanner.on_scan_complete(on_scan)

    # Run a few scans
    for i in range(3):
        print(f"\n--- Scan {i+1} ---")
        scanner.scan()
        time.sleep(2)