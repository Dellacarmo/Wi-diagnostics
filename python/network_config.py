"""
Network Auto-Configuration Module
Auto-discovers network interfaces, WiFi adapter, and configures monitoring.
Cross-platform: Windows 11 + Ubuntu Linux
"""

import ipaddress
import json
import locale
import platform
import re
import socket
import subprocess
import ctypes
import unicodedata
from typing import Any, Dict, List, Optional


class NetworkConfig:
    """Auto-discovers and configures network monitoring parameters."""

    def __init__(self):
        self.os_type = platform.system()  # 'Windows' or 'Linux'
        self.interfaces: List[Dict[str, Any]] = []
        self.wifi_adapter: Optional[Dict[str, Any]] = None
        self.active_wifi_ssid: Optional[str] = None
        self.active_wifi_bssid: Optional[str] = None
        self.active_wifi_interface: Optional[str] = None
        self.local_ip: Optional[str] = None
        self.gateway: Optional[str] = None
        self.subnet: Optional[str] = None
        self.scan_interface: Optional[str] = None
        self.hostname: str = socket.gethostname()
        self._discover()

    def _decode_output(self, data: bytes) -> str:
        """Decode subprocess output in a locale-safe way on Windows/Linux."""
        if isinstance(data, str):
            return data

        candidates: List[str] = []

        if self.os_type == "Windows":
            try:
                oem_cp = ctypes.windll.kernel32.GetOEMCP()
                if oem_cp:
                    candidates.append(f"cp{oem_cp}")
            except Exception:
                pass

            try:
                ansi_cp = ctypes.windll.kernel32.GetACP()
                if ansi_cp:
                    candidates.append(f"cp{ansi_cp}")
            except Exception:
                pass

            candidates.extend(["utf-8", "cp850", "cp1252", "mbcs", "latin-1"])
        else:
            candidates.extend(["utf-8", "latin-1"])

        preferred = locale.getpreferredencoding(False)
        if preferred:
            candidates.insert(0, preferred)

        seen = set()
        for encoding in candidates:
            enc = (encoding or "").strip().lower()
            if not enc or enc in seen:
                continue
            seen.add(enc)
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue

        return data.decode("utf-8", errors="replace")

    def _run_command(self, command: List[str], timeout: int = 10) -> str:
        """Run command and return decoded stdout."""
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=False,
                timeout=timeout,
            )
            return self._decode_output(result.stdout)
        except Exception:
            return ""

    def _normalize(self, text: str) -> str:
        """Normalize text to ASCII-friendly lowercase for locale-agnostic parsing."""
        if not text:
            return ""
        normalized = unicodedata.normalize("NFKD", text)
        normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
        return normalized.strip().lower()

    def _split_escaped_fields(self, line: str, sep: str = ":") -> List[str]:
        """Split nmcli terse lines while honoring escaped separators."""
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
        """Unescape nmcli escaped chars."""
        return value.replace("\\:", ":").replace("\\\\", "\\").strip()

    def _discover(self):
        """Run all discovery routines."""
        self._discover_interfaces()
        self._discover_active_wifi()
        self._discover_wifi_adapter()
        self._discover_network_params()
        self._set_scan_interface()

    def _discover_interfaces(self):
        """Discover all network interfaces with details."""
        if self.os_type == "Windows":
            self._discover_interfaces_windows()
        else:
            self._discover_interfaces_linux()

    def _discover_interfaces_windows(self):
        """Use ipconfig /all to discover interfaces on Windows."""
        try:
            output = self._run_command(["ipconfig", "/all"], timeout=15)

            # Parse interfaces from ipconfig output
            current_if: Dict[str, Any] = {}
            for line in output.split("\n"):
                line = line.strip()
                normalized_line = self._normalize(line)

                # New adapter section
                if line and line.endswith(":") and ("adapter" in normalized_line or "adaptador" in normalized_line):
                    if current_if.get("name"):
                        self.interfaces.append(current_if)
                    current_if = {"name": line.rstrip(":")}
                    if any(token in normalized_line for token in ("wi-fi", "wifi", "wireless", "wlan")):
                        current_if["is_wifi"] = True

                if not current_if:
                    continue

                # IP Address
                if "ipv4" in normalized_line:
                    ip = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                    if ip:
                        current_if["ipv4"] = ip.group(1)
                        current_if["is_up"] = True

                # Subnet Mask
                if "subnet mask" in normalized_line or "mascara de sub-rede" in normalized_line:
                    mask = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                    if mask:
                        current_if["netmask"] = mask.group(1)

                # Default Gateway
                if "default gateway" in normalized_line or "gateway padrao" in normalized_line:
                    gw = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                    if gw:
                        current_if["gateway"] = gw.group(1)

                # Description
                if normalized_line.startswith("description") or normalized_line.startswith("descricao"):
                    desc = line.split(":", 1)[1].strip() if ":" in line else ""
                    current_if["description"] = desc
                    desc_norm = self._normalize(desc)
                    if any(token in desc_norm for token in ("wireless", "wi-fi", "wifi", "wlan")):
                        current_if["is_wifi"] = True

                # DNS Servers
                if "dns servers" in normalized_line or "servidores dns" in normalized_line:
                    dns = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                    if dns:
                        current_if["dns"] = dns.group(1)

            if current_if.get("name"):
                self.interfaces.append(current_if)

        except (subprocess.TimeoutExpired, Exception) as e:
            print(f"[network_config] Error discovering Windows interfaces: {e}")

    def _discover_interfaces_linux(self):
        """Use ip addr to discover interfaces on Linux."""
        try:
            output = self._run_command(["ip", "-j", "addr", "show"], timeout=10)
            interfaces = json.loads(output)
            for iface in interfaces:
                ifname = iface.get("ifname", "")
                if_info = {
                    "name": ifname,
                    "is_up": iface.get("operstate") == "UP",
                    "mac": iface.get("address", ""),
                    "is_wifi": ifname.startswith("wl") or ifname.startswith("wlan") or "wifi" in ifname.lower(),
                }
                for addr_info in iface.get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        if_info["ipv4"] = addr_info.get("local")
                        prefix = addr_info.get("prefixlen")
                        if prefix is not None:
                            if_info["prefixlen"] = int(prefix)
                self.interfaces.append(if_info)

        except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception) as e:
            # Fallback to ifconfig
            try:
                result = subprocess.run(
                    ["ifconfig"],
                    capture_output=True, text=True, timeout=10
                )
                self._parse_ifconfig(result.stdout)
            except Exception as e2:
                print(f"[network_config] Error discovering Linux interfaces: {e2}")

    def _parse_ifconfig(self, output: str):
        """Parse ifconfig output as fallback."""
        current_if: Dict[str, Any] = {}
        for line in output.split("\n"):
            if line and not line.startswith(" ") and not line.startswith("\t"):
                if current_if.get("name"):
                    self.interfaces.append(current_if)
                name = line.split(":")[0].strip()
                current_if = {"name": name}
                if "flags" in line and "UP" in line:
                    current_if["is_up"] = True
                if name.startswith("wl") or name.startswith("wlan"):
                    current_if["is_wifi"] = True

            if "inet " in line:
                ip = re.search(r'inet (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                if ip:
                    current_if["ipv4"] = ip.group(1)
                    current_if["is_up"] = True

            if "netmask" in line:
                mask = re.search(r'netmask (\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                if mask:
                    current_if["netmask"] = mask.group(1)

                prefix = re.search(r'/(\d{1,2})', line)
                if prefix:
                    current_if["prefixlen"] = int(prefix.group(1))

        if current_if.get("name"):
            self.interfaces.append(current_if)

    def _discover_active_wifi(self):
        """Detect currently connected WiFi network/interface."""
        if self.os_type == "Windows":
            self._discover_active_wifi_windows()
        else:
            self._discover_active_wifi_linux()

    def _discover_active_wifi_windows(self):
        """Discover active WiFi interface + SSID on Windows using netsh."""
        output = self._run_command(["netsh", "wlan", "show", "interfaces"], timeout=10)
        if not output.strip():
            return

        current: Dict[str, str] = {}
        blocks: List[Dict[str, str]] = []

        for raw_line in output.splitlines():
            line = raw_line.strip()
            if not line:
                if current:
                    blocks.append(current)
                    current = {}
                continue

            if ":" not in line:
                continue

            key, value = line.split(":", 1)
            key_norm = self._normalize(key)
            current[key_norm] = value.strip()

        if current:
            blocks.append(current)

        for block in blocks:
            state = self._normalize(block.get("state", block.get("estado", "")))
            if "connected" not in state and "conectado" not in state:
                continue

            self.active_wifi_interface = block.get("name", block.get("nome"))
            self.active_wifi_ssid = block.get("ssid")
            self.active_wifi_bssid = block.get("bssid")
            break

    def _discover_active_wifi_linux(self):
        """Discover active WiFi interface + SSID on Linux using nmcli."""
        output = self._run_command(
            ["nmcli", "-t", "-e", "yes", "-f", "DEVICE,TYPE,STATE,CONNECTION", "dev", "status"],
            timeout=10,
        )
        if not output.strip():
            return

        for raw_line in output.splitlines():
            if not raw_line.strip():
                continue

            fields = self._split_escaped_fields(raw_line)
            if len(fields) < 4:
                continue

            device = self._unescape_nmcli_field(fields[0])
            dev_type = self._normalize(self._unescape_nmcli_field(fields[1]))
            state = self._normalize(self._unescape_nmcli_field(fields[2]))
            conn = self._unescape_nmcli_field(fields[3])

            if dev_type != "wifi":
                continue

            if "connected" in state or "conectado" in state:
                self.active_wifi_interface = device
                self.active_wifi_ssid = conn if conn and conn != "--" else None
                break

        if self.active_wifi_interface:
            bssid_out = self._run_command(
                ["nmcli", "-t", "-e", "yes", "-f", "ACTIVE,BSSID,SSID", "dev", "wifi"],
                timeout=10,
            )
            for raw_line in bssid_out.splitlines():
                if not raw_line.strip():
                    continue
                fields = self._split_escaped_fields(raw_line)
                if len(fields) < 3:
                    continue
                active = self._normalize(self._unescape_nmcli_field(fields[0]))
                bssid = self._unescape_nmcli_field(fields[1])
                ssid = self._unescape_nmcli_field(fields[2])
                if active in ("yes", "sim") and (not self.active_wifi_ssid or ssid == self.active_wifi_ssid):
                    self.active_wifi_bssid = bssid
                    break

    def _discover_wifi_adapter(self):
        """Identify the active WiFi adapter."""
        if self.active_wifi_interface:
            target = self._normalize(self.active_wifi_interface)
            for iface in self.interfaces:
                iface_name = self._normalize(iface.get("name", ""))
                if target and (target in iface_name or iface_name in target):
                    iface["is_active_wifi"] = True
                    iface["is_wifi"] = True
                    iface["is_up"] = True
                    self.wifi_adapter = iface
                    break

        for iface in self.interfaces:
            if self.wifi_adapter:
                break
            if iface.get("is_wifi") and iface.get("is_up"):
                self.wifi_adapter = iface
                break

        # If no explicit WiFi adapter found, try to find by name patterns
        if not self.wifi_adapter:
            wifi_patterns = ["wi-fi", "wireless", "wlan", "wl"]
            for iface in self.interfaces:
                name_lower = iface.get("name", "").lower()
                desc_lower = iface.get("description", "").lower()
                for pattern in wifi_patterns:
                    if pattern in name_lower or pattern in desc_lower:
                        self.wifi_adapter = iface
                        break
                if self.wifi_adapter:
                    break

        if self.wifi_adapter:
            print(f"[network_config] WiFi adapter found: {self.wifi_adapter.get('name', 'Unknown')}")
        else:
            print("[network_config] ⚠️ No WiFi adapter found — scan will be limited")

    def _discover_network_params(self):
        """Discover local IP, gateway, and subnet."""
        if self.wifi_adapter and self.wifi_adapter.get("ipv4"):
            self.local_ip = self.wifi_adapter.get("ipv4")

        # Get local IP
        if not self.local_ip:
            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.connect(("8.8.8.8", 80))
                self.local_ip = s.getsockname()[0]
                s.close()
            except Exception:
                # Fallback: use interface data
                for iface in self.interfaces:
                    if iface.get("ipv4") and iface.get("is_up"):
                        self.local_ip = iface["ipv4"]
                        break

        # Get gateway
        if self.os_type == "Windows":
            try:
                output = self._run_command(["route", "print", "0.0.0.0"], timeout=10)
                for line in output.split("\n"):
                    if "0.0.0.0" in line and "On-link" not in line:
                        parts = line.split()
                        if len(parts) >= 3:
                            gw = parts[2]
                            if re.match(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}', gw):
                                self.gateway = gw
                                break
            except Exception:
                pass
        else:
            try:
                output = self._run_command(["ip", "route", "show", "default"], timeout=10)
                parts = output.strip().split()
                if "via" in parts:
                    self.gateway = parts[parts.index("via") + 1]
            except Exception:
                pass

        # Also check interface data for gateway
        if not self.gateway:
            for iface in self.interfaces:
                if iface.get("gateway"):
                    self.gateway = iface["gateway"]
                    break

        self._calculate_subnet()

        print(f"[network_config] Local IP: {self.local_ip}")
        print(f"[network_config] Gateway: {self.gateway}")

    def _calculate_subnet(self):
        """Calculate subnet from available adapter/local address data."""
        if not self.local_ip:
            return

        # Prefer WiFi adapter if available.
        adapter = self.wifi_adapter or {}
        netmask = adapter.get("netmask")
        prefixlen = adapter.get("prefixlen")

        try:
            if netmask:
                network = ipaddress.IPv4Network(f"{self.local_ip}/{netmask}", strict=False)
                self.subnet = str(network)
                return
            if prefixlen is not None:
                network = ipaddress.IPv4Network(f"{self.local_ip}/{int(prefixlen)}", strict=False)
                self.subnet = str(network)
                return
        except Exception:
            pass

    def _set_scan_interface(self):
        """Choose the best interface for WiFi scan commands."""
        if self.active_wifi_interface:
            self.scan_interface = self.active_wifi_interface
            return

        if self.wifi_adapter:
            self.scan_interface = self.wifi_adapter.get("name")

    def get_scan_interface(self) -> Optional[str]:
        """Return preferred interface name for WiFi scans."""
        return self.scan_interface

    def get_scan_command(self) -> List[str]:
        """Return the appropriate WiFi scan command for the OS."""
        if self.os_type == "Windows":
            command = ["netsh", "wlan", "show", "networks", "mode=bssid"]
            if self.scan_interface:
                command.append(f"interface={self.scan_interface}")
            return command

        command = [
            "nmcli", "-t", "-e", "yes", "-f", "SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY",
            "dev", "wifi", "list", "--rescan", "yes"
        ]
        if self.scan_interface:
            command.extend(["ifname", self.scan_interface])
        return command

    def _active_interfaces(self) -> List[Dict[str, Any]]:
        return [
            iface for iface in self.interfaces
            if iface.get("is_up") and iface.get("ipv4")
        ]

    def _wired_interfaces(self) -> List[Dict[str, Any]]:
        return [
            iface for iface in self._active_interfaces()
            if not iface.get("is_wifi")
        ]

    def get_ifconfig_summary(self) -> Dict[str, Any]:
        """Return a summary of network configuration (like ifconfig)."""
        active_interfaces = self._active_interfaces()
        wired_interfaces = self._wired_interfaces()

        return {
            "hostname": self.hostname,
            "os": self.os_type,
            "local_ip": self.local_ip,
            "gateway": self.gateway,
            "subnet": self.subnet,
            "wifi_adapter": self.wifi_adapter,
            "active_wifi_interface": self.active_wifi_interface,
            "active_wifi_ssid": self.active_wifi_ssid,
            "active_wifi_bssid": self.active_wifi_bssid,
            "scan_interface": self.scan_interface,
            "interfaces": self.interfaces,
            "active_interfaces": active_interfaces,
            "wired_interfaces": wired_interfaces,
            "log_bind": "0.0.0.0:1514",
            "scan_command": " ".join(self.get_scan_command()),
        }

    def to_json(self) -> str:
        """Serialize config to JSON."""
        return json.dumps(self.get_ifconfig_summary(), indent=2, default=str)


if __name__ == "__main__":
    config = NetworkConfig()
    print("\n" + "=" * 60)
    print("  NETWORK CONFIGURATION SUMMARY")
    print("=" * 60)
    print(config.to_json())