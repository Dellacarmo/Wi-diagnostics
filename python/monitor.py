"""
RF Space Observatory — Main Orchestrator
Coordinates WiFi scanning, position estimation, log listening,
WebSocket broadcasting, and report generation.

Usage:
    python monitor.py [--no-scan] [--scan-interval 2] [--ws-port 8765] [--log-port 1514]
"""

import sys
import os
import json
import time
import signal
import argparse
import threading
from datetime import datetime
from typing import Dict, Any, Optional

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(__file__))

from network_config import NetworkConfig
from scanner import WiFiScanner
from position_estimator import PositionEstimator
from log_listener import LogListener
from ws_server import WebSocketServer
from report_generator import ReportGenerator


class RFSpaceObservatory:
    """
    Main orchestrator for the RF Space Observatory.
    Coordinates all subsystems and broadcasts data via WebSocket.
    """

    VERSION = "1.0.0"

    def __init__(self, args=None):
        self.args = args or argparse.Namespace()
        self.running = False
        self.start_time = None

        # Initialize subsystems
        print("[observatory] 🔧 Initializing subsystems...")

        # Network auto-configuration
        self.network_config = NetworkConfig()
        print(f"[observatory] 📡 Network: {self.network_config.local_ip} @ {self.network_config.hostname}")
        if self.network_config.active_wifi_ssid:
            print(
                "[observatory] 📶 Active WiFi: "
                f"{self.network_config.active_wifi_ssid}"
                f" ({self.network_config.active_wifi_interface or 'auto'})"
            )

        # WiFi Scanner
        scan_interface = getattr(self.args, 'scan_interface', None) or self.network_config.get_scan_interface()
        self.scanner = WiFiScanner(interface_name=scan_interface)
        scan_interval = getattr(self.args, 'scan_interval', 2.0)
        self.scanner._scan_interval = scan_interval

        # Position Estimator
        self.position_estimator = PositionEstimator()

        # Log Listener
        log_port = getattr(self.args, 'log_port', 1514)
        self.log_listener = LogListener(port=log_port)

        # WebSocket Server
        ws_port = getattr(self.args, 'ws_port', 8765)
        self.ws_server = WebSocketServer(port=ws_port)

        # Report Generator
        self.report_generator = ReportGenerator()

        # Wire up callbacks
        self._setup_callbacks()
        self.ws_server.set_report_handler(self._handle_report_request)

        # Shared state
        self._state_lock = threading.Lock()
        self._latest_data = {
            "access_points": [],
            "positions": {},
            "scan_stats": {},
            "log_stats": {},
            "network_config": self.network_config.get_ifconfig_summary(),
        }

    def _setup_callbacks(self):
        """Wire up inter-component callbacks."""

        # Scanner → Position Estimator → WebSocket
        self.scanner.on_scan_complete(self._on_scan_complete)

        # Log Listener → WebSocket
        self.log_listener.on_log_received(self._on_log_event)

        # Position Estimator → WebSocket
        self.position_estimator.on_position_update(self._on_position_update)

    def _on_scan_complete(self, ap_list):
        """Called after each WiFi scan completes."""
        # Update position estimates
        positions = self.position_estimator.estimate_positions(ap_list)

        # Broadcast scan results
        self.ws_server.broadcast_scan_results(ap_list)

        # Broadcast position updates
        self.ws_server.broadcast_position_update(positions, ap_list)

        # Broadcast combined stats
        scan_stats = self.scanner.get_stats()
        log_stats = self.log_listener.get_stats()
        self.ws_server.broadcast_stats(scan_stats, log_stats)

        # Update shared state
        with self._state_lock:
            self._latest_data["access_points"] = [ap.to_dict() for ap in ap_list]
            self._latest_data["positions"] = {
                bssid: pos.to_dict() for bssid, pos in positions.items()
            }
            self._latest_data["scan_stats"] = scan_stats
            self._latest_data["log_stats"] = log_stats

    def _on_position_update(self, positions):
        """Called when position estimates are updated."""
        pass  # Already broadcast in _on_scan_complete

    def _on_log_event(self, event: Dict[str, Any]):
        """Called when a log event is received."""
        event_type = event.get("type", "")
        event_data = event.get("data", {})

        if event_type == "log":
            self.ws_server.broadcast_log(event_data)
        elif event_type == "outage":
            self.ws_server.broadcast_outage(event_data)

        # Update log stats
        with self._state_lock:
            self._latest_data["log_stats"] = self.log_listener.get_stats()

    def start(self):
        """Start all subsystems."""
        if self.running:
            return

        self.running = True
        self.start_time = datetime.now()

        print("\n" + "=" * 60)
        print("  🛰️  RF SPACE OBSERVATORY v" + self.VERSION)
        print("  WiFi Network Diagnostic & 3D Visualization")
        print("=" * 60)
        print()

        # Start WebSocket server first
        self.ws_server.start()
        time.sleep(0.5)  # Let WS server initialize

        # Start log listener
        if not getattr(self.args, 'no_log', False):
            try:
                self.log_listener.start()
            except OSError as e:
                print(f"[observatory] ⚠️ Could not start log listener: {e}")
                print("[observatory] Continuing without log listener...")

        # Broadcast initial network config
        self.ws_server.broadcast_network_config(
            self.network_config.get_ifconfig_summary()
        )

        # Start continuous WiFi scanning
        if not getattr(self.args, 'no_scan', False):
            self.scanner.start_continuous_scan(
                interval=getattr(self.args, 'scan_interval', 2.0)
            )
        else:
            print("[observatory] ⚠️ Scanning disabled (--no-scan)")

        # Start periodic full-state broadcast
        self._state_thread = threading.Thread(target=self._periodic_state_broadcast, daemon=True)
        self._state_thread.start()

        print()
        print(f"[observatory] ✅ All systems operational")
        print(f"[observatory] 🌐 WebSocket: ws://127.0.0.1:{self.ws_server.port}")
        print(f"[observatory] 📡 Log listener: UDP port {self.log_listener.port}")
        print(f"[observatory] 🛰️ WiFi scanning: every {self.scanner._scan_interval}s")
        print(f"[observatory] 🔎 Scan source: {self.network_config.scan_interface or 'auto'}")
        print("[observatory] 💻 Visualização 3D: bun run web  ·  painel no terminal: bun run cli")
        print()
        print("[observatory] Press Ctrl+C to stop and generate report...")
        print()

    def _periodic_state_broadcast(self):
        """Periodically broadcast full state for new clients."""
        while self.running:
            time.sleep(5)

            with self._state_lock:
                state_copy = dict(self._latest_data)

            # Full state broadcast
            self.ws_server.broadcast("full_state", {
                "access_points": state_copy.get("access_points", []),
                "positions": state_copy.get("positions", {}),
                "scan_stats": state_copy.get("scan_stats", {}),
                "log_stats": state_copy.get("log_stats", {}),
                "network_config": self.network_config.get_ifconfig_summary(),
                "uptime_seconds": (datetime.now() - self.start_time).total_seconds() if self.start_time else 0,
            })

    def stop(self):
        """Stop all subsystems gracefully."""
        if not self.running:
            return

        print("\n[observatory] 🛑 Shutting down...")
        self.running = False

        # Stop scanning
        self.scanner.stop_continuous_scan()

        # Stop log listener
        self.log_listener.stop()

        # Stop WebSocket server
        self.ws_server.stop()

        print("[observatory] ✅ All systems stopped")

    def generate_reports(self) -> Dict[str, str]:
        """Generate reports from collected data."""
        with self._state_lock:
            data = {
                "access_points": self._latest_data.get("access_points", []),
                "scan_stats": self._latest_data.get("scan_stats", {}),
                "log_stats": self._latest_data.get("log_stats", {}),
                "outages": self.log_listener.get_quedas(),
                "network_config": self.network_config.get_ifconfig_summary(),
                "positions": self._latest_data.get("positions", {}),
            }

        print("[observatory] 📊 Generating reports...")
        results = self.report_generator.generate_all(data)

        for format_name, path in results.items():
            if not format_name.endswith("_error"):
                print(f"[observatory] ✅ {format_name.upper()}: {path}")
            else:
                print(f"[observatory] ❌ {format_name}: {path}")

        return results

    def _collect_report_data(self) -> Dict[str, Any]:
        """Collect current state for report generation."""
        with self._state_lock:
            return {
                "access_points": self._latest_data.get("access_points", []),
                "scan_stats": self._latest_data.get("scan_stats", {}),
                "log_stats": self._latest_data.get("log_stats", {}),
                "outages": self.log_listener.get_quedas(),
                "network_config": self.network_config.get_ifconfig_summary(),
                "positions": self._latest_data.get("positions", {}),
            }

    def _handle_report_request(self, request: Dict[str, Any]):
        """Handle frontend-triggered report generation requests."""
        report_format = str((request or {}).get("format", "all")).lower()

        data = self._collect_report_data()
        generator = self.report_generator

        def emit_success(fmt: str, path: str):
            self.ws_server.broadcast("report_done", {
                "format": fmt,
                "filename": os.path.basename(path),
                "path": path,
            })

        def emit_error(fmt: str, err: str):
            self.ws_server.broadcast("report_error", {
                "format": fmt,
                "error": err,
            })

        try:
            if report_format == "all":
                results = generator.generate_all(data)
                any_success = False

                for fmt in ("pdf", "word", "excel"):
                    if fmt in results:
                        emit_success(fmt, results[fmt])
                        any_success = True
                    elif f"{fmt}_error" in results:
                        emit_error(fmt, results[f"{fmt}_error"])

                if not any_success:
                    emit_error("all", "No report format available. Install report dependencies.")
                return

            format_map = {
                "pdf": ("has_reportlab", generator.generate_pdf),
                "word": ("has_docx", generator.generate_word),
                "excel": ("has_openpyxl", generator.generate_excel),
            }

            if report_format not in format_map:
                emit_error(report_format, f"Unsupported report format: {report_format}")
                return

            dep_flag, generator_fn = format_map[report_format]
            if not getattr(generator, dep_flag, False):
                emit_error(report_format, f"Dependency for {report_format} report not installed")
                return

            path = generator_fn(data)
            emit_success(report_format, path)

        except Exception as e:
            emit_error(report_format, str(e))

    def run(self):
        """Run the observatory (blocking)."""
        self.start()

        try:
            while self.running:
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()
            self.generate_reports()


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="🛰️ RF Space Observatory — WiFi Network Diagnostic & 3D Visualization"
    )
    parser.add_argument(
        "--no-scan", action="store_true",
        help="Disable WiFi scanning (for testing frontend only)"
    )
    parser.add_argument(
        "--no-log", action="store_true",
        help="Disable UDP log listener"
    )
    parser.add_argument(
        "--scan-interval", type=float, default=2.0,
        help="Seconds between WiFi scans (default: 2.0)"
    )
    parser.add_argument(
        "--scan-interface", type=str, default=None,
        help="Specific WiFi interface/device to scan (auto-detected by default)"
    )
    parser.add_argument(
        "--ws-port", type=int, default=8765,
        help="WebSocket server port (default: 8765)"
    )
    parser.add_argument(
        "--log-port", type=int, default=1514,
        help="UDP log listener port (default: 1514)"
    )
    parser.add_argument(
        "--report-only", action="store_true",
        help="Generate report from existing data and exit"
    )
    return parser.parse_args()


def main():
    args = parse_args()

    # Handle graceful shutdown
    observatory = RFSpaceObservatory(args)

    def signal_handler(sig, frame):
        observatory.running = False

    signal.signal(signal.SIGINT, signal_handler)

    if args.report_only:
        # Just generate a report from current state
        print("[observatory] Report-only mode — performing a single scan...")
        observatory.scanner.scan()
        ap_list = observatory.scanner.get_access_points()
        observatory.position_estimator.estimate_positions(ap_list)
        observatory.generate_reports()
    else:
        observatory.run()


if __name__ == "__main__":
    main()