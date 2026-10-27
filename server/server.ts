/**
 * Bun HTTP + WebSocket server for the 3D web frontend.
 *   /            web app (web/)
 *   /vendor/three/*  three.js from node_modules (works offline)
 *   /ws          live snapshots (JSON), accepts {type:"env", preset}
 *   /api/snapshot, /api/networks.csv, POST /api/report?format=pdf|word|excel|all
 */

import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import type { WiEngine } from "../engine/engine";
import type { EnvironmentPreset } from "../engine/types";
import { generateReport, networksCsv } from "../engine/report";

const ROOT = resolve(import.meta.dir, "..");
const WEB = join(ROOT, "web");
const THREE = join(ROOT, "node_modules", "three");

function safeFile(base: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null; // malformed percent-encoding
  }
  const path = resolve(base, normalize(decoded).replace(/^([/\\])+/, ""));
  if (path !== base && !path.startsWith(base + sep)) return null;
  return existsSync(path) && statSync(path).isFile() ? path : null;
}

/** True when `origin` is http://<one of hosts>:<port>. */
function isLocalOrigin(origin: string, hosts: Set<string>, port: number | undefined): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && hosts.has(u.hostname) && Number(u.port || 80) === port;
  } catch {
    return false;
  }
}

export interface ServerHandle {
  url: string;
  port: number;
  stop(): void;
}

export function startServer(engine: WiEngine, opts: { port?: number; host?: string } = {}): ServerHandle {
  const host = opts.host ?? "127.0.0.1";
  const clients = new Set<ServerWebSocket<unknown>>();
  let lastPayload = "";
  const allowedHosts = new Set(["127.0.0.1", "localhost", host]);

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 3333,

    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Host check defeats DNS rebinding; Origin check stops other sites from using /ws
      // (browsers apply no CORS to WebSockets) or POSTing to /api. Clients without an
      // Origin header (curl, scripts) are not browsers and stay allowed.
      const hostHeader = req.headers.get("host");
      if (hostHeader !== null && !isLocalOrigin(`http://${hostHeader}`, allowedHosts, srv.port)) {
        return new Response("Forbidden", { status: 403 });
      }
      const origin = req.headers.get("origin");
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      if ((path === "/ws" || mutating) && origin !== null && !isLocalOrigin(origin, allowedHosts, srv.port)) {
        return new Response("Forbidden", { status: 403 });
      }

      if (path === "/ws") {
        return srv.upgrade(req) ? undefined : new Response("WebSocket expected", { status: 426 });
      }
      if (path === "/api/snapshot") return Response.json(engine.current());
      if (path === "/api/networks.csv") {
        return new Response(networksCsv(engine.current()), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="wi-networks-${Date.now()}.csv"`,
          },
        });
      }
      if (path === "/api/report" && req.method === "POST") {
        const format = url.searchParams.get("format") ?? "all";
        const result = await generateReport(engine.current(), format);
        return Response.json(result, { status: result.ok ? 200 : 500 });
      }

      if (path.startsWith("/vendor/three/")) {
        const file = safeFile(THREE, path.slice("/vendor/three/".length));
        return file ? new Response(Bun.file(file)) : new Response("Not found", { status: 404 });
      }

      const file = safeFile(WEB, path === "/" ? "index.html" : path);
      if (file) return new Response(Bun.file(file), { headers: { "Cache-Control": "no-cache" } });
      return new Response("Not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(lastPayload || JSON.stringify({ type: "snapshot", data: engine.current() }));
      },
      close(ws) {
        clients.delete(ws);
      },
      message(_ws, raw) {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "env") engine.setEnvironment(msg.preset as EnvironmentPreset);
        } catch {
          // ignore malformed client messages
        }
      },
    },
  });

  const unsubscribe = engine.onSnapshot((snap) => {
    lastPayload = JSON.stringify({ type: "snapshot", data: snap });
    for (const ws of clients) ws.send(lastPayload);
  });

  return {
    url: `http://${host}:${server.port}`,
    port: server.port!,
    stop() {
      unsubscribe();
      server.stop(true);
    },
  };
}
