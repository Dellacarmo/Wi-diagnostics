/**
 * RF Space Observatory — Dev Launcher
 * Starts Python backend and opens the frontend in a browser window.
 * Usage: npm start
 */
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const readline = require("readline");

const PORT = 3333;
const WS_PORT = 8765;
const ROOT = __dirname;
const SRC_ROOT = path.join(ROOT, "src");

// ─── Find python ───
function findPython() {
  if (process.env.PYTHON_EXECUTABLE) {
    return process.env.PYTHON_EXECUTABLE;
  }
  const candidates = ["python", "python3", "py"];
  return candidates[0]; // node will fall through on spawn error
}

function normalizeRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath || "/");
  const normalized = path.posix.normalize(decoded.replace(/\\/g, "/"));
  const cleaned = normalized.replace(/^\/+/, "");
  return cleaned || "index.html";
}

function attachPrefixedStream(stream, prefix, target = process.stdout) {
  stream.setEncoding("utf8");
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => target.write(`${prefix}${line}\n`));
}

// ─── Simple static file server ───
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const mimeMap = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };

    const server = http.createServer((req, res) => {
      let urlPath = req.url === "/" ? "/index.html" : req.url;
      // strip query string
      urlPath = urlPath.split("?")[0];

      let safePath;
      try {
        safePath = normalizeRequestPath(urlPath);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad request path");
        return;
      }

      const filePath = path.resolve(SRC_ROOT, safePath);
      if (!filePath.startsWith(SRC_ROOT)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      const ext = path.extname(filePath);
      const mime = mimeMap[ext] || "application/octet-stream";
      const isText =
        mime.startsWith("text/") ||
        mime.includes("javascript") ||
        mime.includes("json") ||
        mime.includes("svg");
      const contentType = isText ? `${mime}; charset=utf-8` : mime;

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Not found: ${urlPath}`);
        } else {
          res.writeHead(200, { "Content-Type": contentType });
          res.end(data);
        }
      });
    });

    server.listen(PORT, "127.0.0.1", () => {
      console.log(`\n🌐 Static server: http://127.0.0.1:${PORT}`);
      resolve(server);
    });

    server.on("error", reject);
  });
}

// ─── Open browser ───
function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === "win32") cmd = `start "" "${url}"`;
  else if (platform === "darwin") cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) console.warn("[launcher] Could not open browser:", err.message);
  });
}

// ─── Wait for WS port ───
function waitForPort(port, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function check() {
      const sock = new net.Socket();
      sock.setTimeout(500);

      sock.on("connect", () => {
        sock.destroy();
        resolve();
      });

      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - start > timeout) {
          reject(new Error(`Port ${port} not ready after ${timeout}ms`));
        } else {
          setTimeout(check, 500);
        }
      });

      sock.on("timeout", () => {
        sock.destroy();
        setTimeout(check, 500);
      });

      sock.connect(port, "127.0.0.1");
    }

    check();
  });
}

// ─── Main ───
async function main() {
  console.log("🛰️  RF Space Observatory — Launcher");
  console.log("═══════════════════════════════════\n");

  // 1. Start static file server
  let httpServer;
  try {
    httpServer = await startStaticServer();
  } catch (err) {
    console.error("[launcher] Failed to start static server:", err.message);
    process.exit(1);
  }

  // 2. Start Python backend
  const pythonCmd = findPython();
  const pythonScript = path.join(ROOT, "python", "monitor.py");
  const pythonArgs = process.argv.includes("--no-log") ? ["--no-log"] : [];

  console.log(`🐍 Starting Python backend: ${pythonCmd} ${pythonScript}`);

  const pyProc = spawn(pythonCmd, [pythonScript, ...pythonArgs], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      // Keep Python stdio UTF-8 for launcher logs, but do not force global UTF-8 mode.
      // Forcing PYTHONUTF8=1 can break subprocess decoding on localized Windows commands.
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
    },
  });

  attachPrefixedStream(pyProc.stdout, "[py] ", process.stdout);
  attachPrefixedStream(pyProc.stderr, "[py] ", process.stderr);

  pyProc.on("error", (err) => {
    console.error("\n❌ Python process failed:", err.message);
    console.error("   Make sure Python is installed and in your PATH.");
    console.error("   Run: pip install -r python/requirements.txt\n");
  });

  pyProc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[py] Process exited with code ${code}`);
    }
  });

  // 3. Wait for WS server to be ready
  console.log(`⏳ Waiting for WebSocket server on port ${WS_PORT}...`);
  try {
    await waitForPort(WS_PORT, 12000);
    console.log(`✅ WebSocket server ready!\n`);
  } catch (err) {
    console.warn(
      `⚠️  WebSocket not detected in time — opening browser anyway.\n`,
    );
  }

  // 4. Open browser
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`🚀 Opening: ${url}\n`);
  openBrowser(url);

  // 5. Graceful shutdown
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\n[launcher] Received ${signal}, shutting down...`);

    if (pyProc && !pyProc.killed) {
      pyProc.kill("SIGTERM");
      setTimeout(() => {
        if (!pyProc.killed) {
          pyProc.kill();
        }
      }, 1500);
    }

    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2500);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.log("Press Ctrl+C to stop.\n");
}

main().catch((err) => {
  console.error("[launcher] Fatal error:", err);
  process.exit(1);
});
