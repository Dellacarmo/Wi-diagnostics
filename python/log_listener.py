"""
Log Listener Module
UDP log listener on port 1514 for router/network device logs.
Detects connection drops, PPPoE events, and network anomalies.
Integrated with WebSocket server for real-time frontend updates.
"""

import socket
import threading
import json
from datetime import datetime
from typing import List, Dict, Any, Optional, Callable
from dataclasses import dataclass


@dataclass
class LogEntry:
    """Represents a single log entry."""
    timestamp: datetime
    message: str
    source_ip: str
    log_type: str  # "info", "warning", "error", "connection"
    parsed_data: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "timestamp": self.timestamp.isoformat(),
            "message": self.message,
            "source_ip": self.source_ip,
            "log_type": self.log_type,
            "parsed_data": self.parsed_data,
        }


class LogListener:
    """UDP log listener with event detection and WebSocket integration."""

    HOST = "0.0.0.0"
    PORT = 1514
    BUFFER_SIZE = 4096

    def __init__(self, host: str = None, port: int = None):
        self.host = host or self.HOST
        self.port = port or self.PORT

        self.logs: List[LogEntry] = []
        self.quedas: List[Dict[str, Any]] = []
        self._queda_ativa = False
        self._inicio_queda: Optional[datetime] = None

        self._running = False
        self._socket: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

        # Callbacks for WebSocket broadcast
        self._callbacks: List[Callable] = []

        # Event patterns to detect
        self._event_patterns = {
            "pppoe_down": ["pppoe disconnected", "wan link down", "pppoe down", "wan disconnect"],
            "pppoe_up": ["pppoe connected", "wan link up", "pppoe up", "wan connect"],
            "wifi_event": ["wifi", "wireless", "wlan", "ssid", "association", "disassociation"],
            "dhcp_event": ["dhcp", "lease", "ip address"],
            "firewall_event": ["firewall", "blocked", "denied", "attack", "intrusion"],
            "dns_event": ["dns", "resolve", "domain"],
        }

        self._max_logs = 10000  # Keep last 10k logs in memory

    def on_log_received(self, callback: Callable):
        """Register callback for new log entries."""
        self._callbacks.append(callback)

    def classify_log(self, message: str) -> str:
        """Classify log message type."""
        msg_lower = message.lower()

        for event_type, patterns in self._event_patterns.items():
            for pattern in patterns:
                if pattern in msg_lower:
                    if event_type in ("pppoe_down",):
                        return "error"
                    elif event_type in ("pppoe_up",):
                        return "connection"
                    elif event_type in ("firewall_event",):
                        return "warning"
                    else:
                        return "info"

        return "info"

    def analyze_log(self, entry: LogEntry):
        """Analyze log for connection events."""
        msg_lower = entry.message.lower()

        # Detect connection drops
        if any(p in msg_lower for p in self._event_patterns["pppoe_down"]):
            if not self._queda_ativa:
                self._queda_ativa = True
                self._inicio_queda = entry.timestamp
                print(f"[log_listener] 🔴 Queda detectada: {entry.message}")

        # Detect connection restoration
        elif any(p in msg_lower for p in self._event_patterns["pppoe_up"]):
            if self._queda_ativa:
                fim = entry.timestamp
                duracao = (fim - self._inicio_queda).total_seconds()

                queda_record = {
                    "inicio": self._inicio_queda.isoformat(),
                    "fim": fim.isoformat(),
                    "duracao_segundos": duracao,
                    "message": entry.message,
                }

                with self._lock:
                    self.quedas.append(queda_record)

                self._queda_ativa = False
                print(f"[log_listener] 🟢 Conexão restaurada | duração: {duracao:.0f}s")

                # Fire callbacks with outage event
                self._notify({
                    "type": "outage",
                    "data": queda_record,
                })

    def _notify(self, data: Dict[str, Any]):
        """Notify all registered callbacks."""
        for cb in self._callbacks:
            try:
                cb(data)
            except Exception as e:
                print(f"[log_listener] Callback error: {e}")

    def _handle_packet(self, data: bytes, addr: tuple):
        """Handle a received UDP packet."""
        try:
            message = data.decode(errors="ignore").strip()
            if not message:
                return

            timestamp = datetime.now()
            source_ip = addr[0] if addr else "unknown"

            entry = LogEntry(
                timestamp=timestamp,
                message=message,
                source_ip=source_ip,
                log_type=self.classify_log(message),
            )

            # Analyze for events
            self.analyze_log(entry)

            # Store log
            with self._lock:
                self.logs.append(entry)
                if len(self.logs) > self._max_logs:
                    self.logs = self.logs[-self._max_logs:]

            # Notify callbacks
            self._notify({
                "type": "log",
                "data": entry.to_dict(),
            })

        except Exception as e:
            print(f"[log_listener] Error handling packet: {e}")

    def start(self):
        """Start the UDP log listener."""
        if self._running:
            return

        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind((self.host, self.port))
        self._socket.settimeout(1.0)  # Allow periodic check of _running flag

        self._running = True
        self._thread = threading.Thread(target=self._listen_loop, daemon=True)
        self._thread.start()

        print(f"[log_listener] 📡 Listening for logs on UDP {self.host}:{self.port}")

    def _listen_loop(self):
        """Main listening loop."""
        while self._running:
            try:
                data, addr = self._socket.recvfrom(self.BUFFER_SIZE)
                self._handle_packet(data, addr)
            except socket.timeout:
                continue
            except OSError:
                # Socket closed
                break
            except Exception as e:
                if self._running:
                    print(f"[log_listener] Error: {e}")

    def stop(self):
        """Stop the UDP log listener."""
        self._running = False
        if self._socket:
            try:
                self._socket.close()
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=3)
        print("[log_listener] Stopped")

    def get_logs(self, limit: int = 100, log_type: Optional[str] = None) -> List[Dict]:
        """Get recent logs, optionally filtered by type."""
        with self._lock:
            logs = self.logs.copy()

        if log_type:
            logs = [l for l in logs if l.log_type == log_type]

        # Return most recent first
        logs = logs[-limit:]
        return [l.to_dict() for l in reversed(logs)]

    def get_quedas(self) -> List[Dict]:
        """Get all detected outages."""
        with self._lock:
            return self.quedas.copy()

    def get_stats(self) -> Dict[str, Any]:
        """Get log statistics."""
        with self._lock:
            total = len(self.logs)
            errors = sum(1 for l in self.logs if l.log_type == "error")
            warnings = sum(1 for l in self.logs if l.log_type == "warning")
            connections = sum(1 for l in self.logs if l.log_type == "connection")

            total_downtime = sum(q["duracao_segundos"] for q in self.quedas)

            return {
                "total_logs": total,
                "errors": errors,
                "warnings": warnings,
                "connections": connections,
                "total_outages": len(self.quedas),
                "total_downtime_seconds": total_downtime,
                "currently_down": self._queda_ativa,
            }

    def generate_report_data(self) -> Dict[str, Any]:
        """Generate data for report generation."""
        return {
            "generated_at": datetime.now().isoformat(),
            "stats": self.get_stats(),
            "outages": self.get_quedas(),
            "recent_logs": self.get_logs(limit=50),
        }


if __name__ == "__main__":
    listener = LogListener()

    def on_event(data):
        print(f"[EVENT] {data['type']}: {json.dumps(data['data'], indent=2, default=str)}")

    listener.on_log_received(on_event)
    listener.start()

    try:
        while True:
            import time
            time.sleep(1)
    except KeyboardInterrupt:
        listener.stop()
        print("\n📄 Stats:", json.dumps(listener.get_stats(), indent=2))