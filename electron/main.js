/**
 * WI//DIAG — Electron shell
 * Starts the Bun engine + web server (cli/wi.ts web) and shows the 3D view in a window.
 */

const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");
const readline = require("readline");

// Packaged builds ship with asar disabled, so ROOT is a real directory (resources/app) Bun can read.
const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.WI_PORT) || 3333;
const READY_TIMEOUT_MS = 90000; // the first macOS run compiles the Swift scanner helper
const demo = process.argv.includes("--demo");

let mainWindow = null;
let engine = null; // { proc, exited, ready } of the running `wi web` child
let stopping = Promise.resolve(); // settles once the last stopped engine has exited
let quitting = false;

function findBun() {
  if (process.env.BUN_EXECUTABLE) return process.env.BUN_EXECUTABLE;
  const candidates = [
    app.isPackaged && path.join(process.resourcesPath, "bun", "bun.exe"),
    process.platform !== "win32" && path.join(ROOT, "node_modules", ".bin", "bun"),
    // bun's postinstall leaves the real binary here on every platform (.bin/ only has shims on Windows)
    path.join(ROOT, "node_modules", "bun", "bin", "bun.exe"),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || "bun";
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      const bound = srv.address().port;
      srv.close(() => resolve(bound));
    });
  });
}

// Prefer the fixed port (stable origin keeps the page's saved prefs); fall back to any free one.
const pickPort = () => listenOnce(PORT).catch(() => listenOnce(0));

function startEngine(port) {
  const args = [path.join(ROOT, "cli", "wi.ts"), "web", "--no-open", "--port", String(port)];
  if (demo) args.push("--demo");
  // Packaged apps must not write into their own (signed, possibly read-only) bundle.
  const env = app.isPackaged ? { ...process.env, WI_CACHE_DIR: path.join(app.getPath("userData"), "cache") } : process.env;
  const proc = spawn(findBun(), args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise((resolve) => {
    proc.once("exit", resolve);
    proc.once("error", resolve);
  });
  // Resolves with the URL our own child prints once its server listens, so a foreign
  // process on the port is never loaded; rejects as soon as the child fails.
  const ready = new Promise((resolve, reject) => {
    let lastError = "";
    const timer = setTimeout(() => reject(new Error(`sem resposta após ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS);
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      console.log(`[engine] ${line}`);
      const m = /WI\/\/DIAG 3D .*?(http:\/\/[^\s\x1b]+)/.exec(line);
      if (m) settle(resolve, m[1]);
    });
    readline.createInterface({ input: proc.stderr }).on("line", (line) => {
      console.error(`[engine] ${line}`);
      if (line.trim()) lastError = line.trim();
    });
    proc.once("error", (err) => settle(reject, new Error(`não foi possível iniciar o Bun (${err.message}). Rode: npm install`)));
    proc.once("exit", (code, signal) =>
      settle(reject, new Error(`o engine encerrou (${signal || `código ${code}`})${lastError ? `\n\n${lastError}` : ""}`)),
    );
  });
  const child = { proc, exited, ready };
  exited.then(() => {
    if (engine === child) engine = null;
  });
  return child;
}

async function ensureEngine() {
  if (!engine) {
    await stopping; // let a previous engine release the port first
    engine ??= startEngine(await pickPort());
  }
  return engine.ready;
}

function stopEngine() {
  if (!engine) return;
  const { proc, exited } = engine;
  engine = null;
  stopping = exited;
  proc.kill("SIGTERM");
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: "WI//DIAG",
    backgroundColor: "#010403",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow = win;
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  try {
    const url = await ensureEngine();
    if (!win.isDestroyed()) await win.loadURL(url);
  } catch (err) {
    if (quitting || win.isDestroyed()) return;
    // The window is still hidden: drop it and quit instead of leaving an invisible app behind.
    dialog.showErrorBox("WI//DIAG", `O engine não iniciou: ${err.message}`);
    win.destroy();
    app.quit();
  }
}

app.whenReady().then(() => {
  createWindow();
  // macOS: the engine was stopped with the last window; createWindow starts it again.
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  stopEngine();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  stopEngine();
});
