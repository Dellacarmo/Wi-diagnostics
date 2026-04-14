/**
 * RF Space Observatory — WebSocket Client
 * Connects to the Python backend WebSocket server,
 * handles message routing and reconnection.
 */

class WSClient {
  constructor(url = "ws://127.0.0.1:8765") {
    this.url = url;
    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 50;
    this.reconnectDelay = 2000;
    this.pingInterval = null;

    // Event handlers
    this.handlers = {
      connected: [],
      disconnected: [],
      scan: [],
      position_update: [],
      network_config: [],
      stats: [],
      log: [],
      outage: [],
      full_state: [],
      report_request_ack: [],
      report_done: [],
      report_error: [],
      batch: [],
    };

    // Generic message handler
    this._onMessage = null;
  }

  connect() {
    console.log(`[ws] Connecting to ${this.url}...`);

    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      console.error("[ws] Failed to create WebSocket:", e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log("[ws] ✅ Connected");
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Start ping
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);

      this._emit("connected", {});
    };

    this.ws.onclose = (event) => {
      console.log(`[ws] Disconnected (code: ${event.code})`);
      this.isConnected = false;
      clearInterval(this.pingInterval);
      this._emit("disconnected", { code: event.code });
      this._scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error("[ws] Error:", error);
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this._handleMessage(message);
      } catch (e) {
        console.error("[ws] Failed to parse message:", e);
      }
    };
  }

  _handleMessage(message) {
    const type = message.type;
    const data = message.data;

    // Handle batch messages (multiple events in one frame)
    if (type === "batch" && Array.isArray(data)) {
      for (const item of data) {
        this._routeMessage(item.type, item.data);
      }
      return;
    }

    this._routeMessage(type, data);
  }

  _routeMessage(type, data) {
    // Emit to specific handlers
    if (this.handlers[type]) {
      for (const handler of this.handlers[type]) {
        try {
          handler(data);
        } catch (e) {
          console.error(`[ws] Handler error for "${type}":`, e);
        }
      }
    }

    // Generic message handler
    if (this._onMessage) {
      try {
        this._onMessage(type, data);
      } catch (e) {
        console.error("[ws] Generic handler error:", e);
      }
    }
  }

  _emit(event, data) {
    if (this.handlers[event]) {
      for (const handler of this.handlers[event]) {
        try {
          handler(data);
        } catch (e) {
          console.error(`[ws] Emit error for "${event}":`, e);
        }
      }
    }
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("[ws] Max reconnection attempts reached");
      return;
    }

    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts + 1, 5);
    console.log(
      `[ws] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`,
    );

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  // ─── Public API ───

  on(event, handler) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }
    this.handlers[event].push(handler);
  }

  off(event, handler) {
    if (!this.handlers[event]) return;
    this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
  }

  onMessage(handler) {
    this._onMessage = handler;
  }

  send(type, data = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }));
    }
  }

  requestReport(format) {
    this.send("generate_report", { format });
  }

  disconnect() {
    clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Export
window.WSClient = WSClient;
