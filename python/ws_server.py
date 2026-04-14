"""
WebSocket Server Module
Real-time communication bridge between Python backend and browser frontend.
Broadcasts WiFi scan results, position updates, and log events.
"""

import asyncio
import json
import threading
import time
from typing import Set, Dict, Any, Optional, List
from datetime import datetime

try:
    import websockets
    from websockets.server import serve
except ImportError:
    websockets = None
    print("[ws_server] ⚠️ websockets not installed. Run: pip install websockets")


class WebSocketServer:
    """Async WebSocket server for real-time data broadcasting."""

    DEFAULT_HOST = "127.0.0.1"
    DEFAULT_PORT = 8765

    def __init__(self, host: str = None, port: int = None):
        self.host = host or self.DEFAULT_HOST
        self.port = port or self.DEFAULT_PORT
        self.clients: Set = set()
        self._server = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._running = False
        self._message_queue: List[Dict[str, Any]] = []
        self._queue_lock = threading.Lock()

    def start(self):
        """Start the WebSocket server in a background thread."""
        if self._running:
            return

        if websockets is None:
            print("[ws_server] ❌ Cannot start — websockets not installed")
            return

        self._running = True
        self._thread = threading.Thread(target=self._run_server, daemon=True)
        self._thread.start()
        print(f"[ws_server] 🌐 Starting WebSocket server on ws://{self.host}:{self.port}")

    def _run_server(self):
        """Run the async WebSocket server."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        try:
            self._loop.run_until_complete(self._serve())
        except Exception as e:
            print(f"[ws_server] Server error: {e}")
        finally:
            self._loop.close()

    async def _serve(self):
        """Serve WebSocket connections."""
        async with serve(self._handler, self.host, self.port):
            # Periodically flush queued messages
            while self._running:
                await self._flush_queue()
                await asyncio.sleep(0.05)  # 20fps broadcast rate

    async def _handler(self, websocket):
        """Handle a new WebSocket connection."""
        self.clients.add(websocket)
        client_id = id(websocket)
        print(f"[ws_server] Client connected ({len(self.clients)} total)")

        try:
            # Send initial state on connection
            await websocket.send(json.dumps({
                "type": "connected",
                "data": {
                    "server_time": datetime.now().isoformat(),
                    "clients": len(self.clients),
                }
            }))

            # Listen for client messages (commands from frontend)
            async for message in websocket:
                try:
                    data = json.loads(message)
                    await self._handle_client_message(websocket, data)
                except json.JSONDecodeError:
                    pass

        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.clients.discard(websocket)
            print(f"[ws_server] Client disconnected ({len(self.clients)} total)")

    async def _handle_client_message(self, websocket, data: Dict):
        """Handle messages from the frontend client."""
        msg_type = data.get("type", "")

        if msg_type == "ping":
            await websocket.send(json.dumps({"type": "pong"}))

        elif msg_type == "request_state":
            # Frontend is requesting current state — trigger a scan
            await websocket.send(json.dumps({
                "type": "state_request_ack",
                "data": {"status": "ok"}
            }))

        elif msg_type == "generate_report":
            # Frontend wants a report generated
            await websocket.send(json.dumps({
                "type": "report_request",
                "data": data.get("data", {})
            }))

    async def _flush_queue(self):
        """Flush queued messages to all connected clients."""
        messages = []
        with self._queue_lock:
            if self._message_queue:
                messages = self._message_queue.copy()
                self._message_queue.clear()

        if messages and self.clients:
            # Combine messages into a single batch
            payload = json.dumps({
                "type": "batch",
                "data": messages,
                "timestamp": datetime.now().isoformat(),
            })

            # Send to all clients, remove disconnected ones
            disconnected = set()
            for client in self.clients:
                try:
                    await client.send(payload)
                except websockets.exceptions.ConnectionClosed:
                    disconnected.add(client)
                except Exception:
                    disconnected.add(client)

            self.clients -= disconnected

    def broadcast(self, message_type: str, data: Any):
        """
        Thread-safe broadcast to all connected clients.
        Can be called from any thread (scanner, log listener, etc.)
        """
        with self._queue_lock:
            self._message_queue.append({
                "type": message_type,
                "data": data,
            })

    def broadcast_scan_results(self, ap_list: list):
        """Broadcast WiFi scan results."""
        aps_data = []
        for ap in ap_list:
            ap_dict = ap.to_dict() if hasattr(ap, 'to_dict') else ap
            aps_data.append(ap_dict)

        self.broadcast("scan", {
            "access_points": aps_data,
            "count": len(aps_data),
            "timestamp": datetime.now().isoformat(),
        })

    def broadcast_position_update(self, positions: Dict, ap_list: list = None):
        """Broadcast position estimates."""
        pos_data = {}
        for bssid, pos in positions.items():
            pos_data[bssid] = pos.to_dict() if hasattr(pos, 'to_dict') else pos

        # Include AP metadata for the frontend
        ap_meta = {}
        if ap_list:
            for ap in ap_list:
                ap_meta[ap.bssid] = {
                    "ssid_label": ap.ssid_label,
                    "band": ap.band,
                    "rssi_mean": round(ap.rssi_mean, 1),
                    "signal_quality": round(ap.signal_quality, 1),
                    "distance_estimate": round(ap.distance_estimate, 1),
                    "sample_count": ap.sample_count,
                    "channel": ap.channel,
                    "security": ap.security,
                }

        self.broadcast("position_update", {
            "positions": pos_data,
            "ap_metadata": ap_meta,
            "timestamp": datetime.now().isoformat(),
        })

    def broadcast_network_config(self, config: Dict):
        """Broadcast network configuration."""
        self.broadcast("network_config", config)

    def broadcast_stats(self, scan_stats: Dict, log_stats: Dict = None):
        """Broadcast combined statistics."""
        self.broadcast("stats", {
            "scan": scan_stats,
            "logs": log_stats or {},
            "timestamp": datetime.now().isoformat(),
        })

    def broadcast_log(self, log_data: Dict):
        """Broadcast a log event."""
        self.broadcast("log", log_data)

    def broadcast_outage(self, outage_data: Dict):
        """Broadcast an outage event."""
        self.broadcast("outage", outage_data)

    def stop(self):
        """Stop the WebSocket server."""
        self._running = False
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread:
            self._thread.join(timeout=3)
        print("[ws_server] Stopped")


if __name__ == "__main__":
    import time

    server = WebSocketServer()
    server.start()

    # Test broadcast every 2 seconds
    counter = 0
    try:
        while True:
            counter += 1
            server.broadcast("test", {"counter": counter, "message": "Hello from WS!"})
            time.sleep(2)
    except KeyboardInterrupt:
        server.stop()