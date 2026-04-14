"""
Network Auto-Configuration Module
Auto-discovers network interfaces, WiFi adapter, and configures monitoring.
Cross-platform: Windows 11 + Ubuntu Linux
"""

import platform
import subprocess
import re
import socket
import json
from typing import Optional, Dict, List, Any


class NetworkConfig:
    """Auto-discovers and configures network monitoring parameters."""

    def __init__(self):
        self.os_type = platform.system()  # 'Windows' or 'Linux'
        self.interfaces: List[Dict[str, Any]] = []
        self.wifi_adapter: Optional[Dict[str, Any]] = None
        self.local_ip: Optional[str] = None
        self.gateway: Optional[str] = None
        self.subnet: Optional[str] = None
        self.hostname: str = socket.gethostname()
        self._discover()

    def _discover(self):
        """Run all discovery routines."""
        self._discover_interfaces()
        self._discover_wifi_adapter()
        self._discover_network_params()

    def _discover_interfaces(self):
        """Discover all network interfaces with details."""
        if self.os_type == "Windows":
            self._discover_interfaces_windows()
        else:
            self._discover_interfaces_linux()

    def _discover_interfaces_windows(self):
        """Use ipconfig /all to discover interfaces on Windows."""
        try:
            result = subprocess.run(
                ["ipconfig", "/all"],
                capture_output=True, text=True, timeout=10
            )
            output = result.stdout

            # Parse interfaces from ipconfig output
            current_if = {}
            for line in output.split("\n"):
                line = line.strip()

                # New adapter section
                if line and not line.startswith(" ") and ":" in line and "adapter" in line.lower():
                    if current_if.get("name"):
                        self.interfaces.append(current_if)
                    current_if = {"name": line.split("adapter")[0].strip().rstrip(":")}

                # IP Address
                if "IPv4 Address" in line or "Endereço IPv4" in line:
                    ip = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                    if ip:
                        current_if["ipv4"] = ip.group(1)
                        current_if["is_up"] = True

                # Subnet Mask
                if "Subnet Mask" in line or "Máscara de Sub-rede" in line:
                    mask = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                    if mask:
                        current_if["netmask"] = mask.group(1)

                # Default Gateway
                if "Default Gateway" in line or "Gateway Padrão" in line:
                    gw = re.search(r'(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', line)
                    if gw:
                        current_if["gateway"] = gw.group(1)

                # Description
                if "Description" in line or "Descrição" in line:
                    desc = line.split(":", 1)[1].strip() if ":" in line else ""
                    current_if["description"] = desc
                    if "wireless" in desc.lower() or "wi-fi" in desc.lower() or "wifi" in desc.lower():
                        current_if["is_wifi"] = True

                # DNS Servers
                if "DNS Servers" in line or "Servidores DNS" in line:
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
            result = subprocess.run(
                ["ip", "-j", "addr", "show"],
                capture_output=True, text=True, timeout=10
            )
            interfaces = json.loads(result.stdout)
            for iface in interfaces:
                if_info = {
                    "name": iface.get("ifname", ""),
                    "is_up": iface.get("operstate") == "UP",
                    "mac": iface.get("address", ""),
                    "is_wifi": iface.get("link_type") == "ether" or "wl" in iface.get("ifname", ""),
                }
                for addr_info in iface.get("addr_info", []):
                    if addr_info.get("family") == "inet":
                        if_info["ipv4"] = addr_info.get("local")
                        if_info["netmask"] = str(addr_info.get("prefixlen"))
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
        current_if = {}
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

        if current_if.get("name"):
            self.interfaces.append(current_if)

    def _discover_wifi_adapter(self):
        """Identify the active WiFi adapter."""
        for iface in self.interfaces:
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
        # Get local IP
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
                result = subprocess.run(
                    ["route", "print", "0.0.0.0"],
                    capture_output=True, text=True, timeout=10
                )
                for line in result.stdout.split("\n"):
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
                result = subprocess.run(
                    ["ip", "route", "show", "default"],
                    capture_output=True, text=True, timeout=10
                )
                parts = result.stdout.strip().split()
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

        print(f"[network_config] Local IP: {self.local_ip}")
        print(f"[network_config] Gateway: {self.gateway}")

    def get_scan_command(self) -> List[str]:
        """Return the appropriate WiFi scan command for the OS."""
        if self.os_type == "Windows":
            return ["netsh", "wlan", "show", "networks", "mode=bssid"]
        else:
            return ["nmcli", "-t", "-f", "SSID,BSSID,SIGNAL,FREQ,CHAN,SECURITY,RATES", "dev", "wifi", "list", "--rescan", "yes"]

    def get_ifconfig_summary(self) -> Dict[str, Any]:
        """Return a summary of network configuration (like ifconfig)."""
        return {
            "hostname": self.hostname,
            "os": self.os_type,
            "local_ip": self.local_ip,
            "gateway": self.gateway,
            "wifi_adapter": self.wifi_adapter,
            "interfaces": self.interfaces,
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