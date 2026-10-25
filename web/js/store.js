// Live snapshot store: WebSocket with exponential reconnect + REST bootstrap.

export class Store extends EventTarget {
  constructor() {
    super();
    this.snapshot = null;
    this.connected = false;
    this.retry = 0;
  }

  async start() {
    try {
      const res = await fetch("/api/snapshot");
      if (res.ok) this.#set(await res.json());
    } catch {
      // the socket will deliver it
    }
    this.#connect();
  }

  #connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.dispatchEvent(new CustomEvent("status", { detail: true }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "snapshot") this.#set(msg.data);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent("status", { detail: false }));
      const delay = Math.min(1000 * 2 ** this.retry++, 10000);
      setTimeout(() => this.#connect(), delay);
    };
  }

  #set(snap) {
    const prev = this.snapshot;
    this.snapshot = snap;
    this.dispatchEvent(new CustomEvent("snapshot", { detail: { snap, prev } }));
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
