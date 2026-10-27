#!/usr/bin/env bun
/**
 * wi — Wi-Diagnostics command line.
 *
 *   wi                 live terminal UI
 *   wi web             3D web visualization (Bun server + browser)
 *   wi scan [--json]   one-shot scan, printed as a table or JSON
 *   wi authorize       macOS: grant Location so SSID/BSSID are revealed
 *   wi oui update      download the IEEE vendor database
 */

import { WiEngine, VERSION } from "../engine/engine";
import { ENV_ORDER } from "../engine/rf";
import type { EnvironmentPreset, Snapshot } from "../engine/types";
import { ouiStatus, updateOuiDatabase } from "../engine/oui";
import { authorizeHelper } from "../engine/sources/macos";
import { startServer } from "../server/server";
import { Tui } from "./tui/app";
import { BAND_COLOR, C, GRADE_COLOR, fmtDist, pad, padL, rssiColor } from "./tui/theme";

const HELP = `
  WI//DIAG v${VERSION} — visualizador de Wi-Fi

  uso
    wi                      painel ao vivo no terminal
    wi web                  visualização 3D no navegador
    wi scan [--json]        varredura única (tabela ou JSON)
    wi authorize            macOS: libera SSID/BSSID (permissão de Localização)
    wi oui update           baixa a base de fabricantes da IEEE

  opções
    --demo                  ambiente sintético (sem hardware)
    --web                   (painel) também sobe a visualização 3D
    --port <n>              porta HTTP da web (padrão 3333)
    --no-open               não abre o navegador
    --env <modelo>          ${ENV_ORDER.join(" | ")} (padrão residential)
    --interval <s>          intervalo entre varreduras (padrão 2)
    --iface <nome>          interface Wi-Fi (Linux/Windows)
    --syslog [porta]        escuta syslog UDP do roteador (padrão 1514)
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // --syslog's port is optional: only a number is taken, so `--syslog web` keeps the subcommand.
      const takesValue = key === "syslog" ? /^\d+$/.test(next ?? "") : ["port", "env", "interval", "iface"].includes(key);
      if (next !== undefined && !next.startsWith("--") && takesValue) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else if (a === "-h") flags.help = true;
    else positional.push(a);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? "live";

const rgb = (c: number, s: string) =>
  process.stdout.isTTY ? `\x1b[38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}m${s}\x1b[0m` : s;

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // no browser available — the URL is printed anyway
  }
}

function makeEngine(log: (msg: string) => void) {
  const env = (typeof flags.env === "string" ? flags.env : "residential") as EnvironmentPreset;
  if (!ENV_ORDER.includes(env)) {
    console.error(`modelo de ambiente inválido: ${env} (use ${ENV_ORDER.join(", ")})`);
    process.exit(1);
  }
  return new WiEngine({
    demo: !!flags.demo,
    env,
    interval: Number(flags.interval) || 2,
    iface: typeof flags.iface === "string" ? flags.iface : null,
    syslogPort: flags.syslog ? (typeof flags.syslog === "string" ? Number(flags.syslog) || 1514 : 1514) : null,
    log,
  });
}

function waitForScan(engine: WiEngine, timeoutMs = 25000): Promise<Snapshot> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(engine.current()), timeoutMs);
    // onSnapshot replays the latest snapshot synchronously, so unsubscribe on a microtask.
    const off = engine.onSnapshot((s) => {
      if (s.scan.count >= 1) {
        clearTimeout(timer);
        queueMicrotask(() => off());
        resolve(s);
      }
    });
  });
}

function printTable(s: Snapshot) {
  const out: string[] = [];
  out.push(rgb(C.title, `\n  WI//DIAG · ${s.source.label} · ${s.networks.length} rádios\n`));
  if (s.source.note) out.push(rgb(C.warn, `  ⚠ ${s.source.note}\n`));
  out.push(rgb(C.dim, `  ${pad("REDE", 24)}${pad("BANDA", 7)}${pad("CH", 5)}${pad("LARG", 6)}${padL("RSSI", 5)}  ${pad("DIST", 20)}${pad("SEG", 5)}${pad("GERAÇÃO", 10)}FABRICANTE`));
  for (const n of s.networks) {
    out.push(
      "  " +
        rgb(n.connected ? C.link : C.text, pad((n.connected ? "◆ " : "") + n.name, 24)) +
        rgb(BAND_COLOR[n.band], pad(`${n.band}G`, 7)) +
        pad(String(n.channel), 5) +
        pad(`${n.width}M`, 6) +
        rgb(rssiColor(n.rssi), padL(String(Math.round(n.rssi)), 5)) +
        "  " +
        pad(`~${fmtDist(n.distance.est)} (${fmtDist(n.distance.min)}–${fmtDist(n.distance.max)})`, 20) +
        rgb(GRADE_COLOR[n.securityGrade], pad(n.securityGrade, 5)) +
        pad(n.generation, 10) +
        rgb(C.dim, n.vendor ?? "—"),
    );
  }
  const l = s.link;
  if (l.connected) {
    out.push(
      rgb(C.dim, `\n  link: `) +
        `${l.rssi} dBm · SNR ${l.snr ?? "—"} dB · ${l.txRate ?? "—"} Mbps · ch ${l.channel} ${l.width}MHz · gw ${l.gateway} ${l.gatewayPing.last !== null ? l.gatewayPing.last.toFixed(1) + "ms" : "—"} · ${l.verdict}`,
    );
  }
  console.log(out.join("\n") + "\n");
}

async function main() {
  if (flags.help || command === "help") {
    console.log(HELP);
    return;
  }

  if (command === "authorize") {
    if (process.platform !== "darwin") {
      console.log("Só é necessário no macOS — Linux e Windows já expõem SSID/BSSID.");
      return;
    }
    console.log(rgb(C.title, "Abrindo o helper do scanner — aceite o pedido de Localização do macOS."));
    console.log(rgb(C.dim, "Se nada aparecer: Ajustes do Sistema → Privacidade e Segurança → Serviços de Localização → WiScan."));
    const status = await authorizeHelper((m) => console.log(rgb(C.dim, m)));
    const ok = status === "authorized";
    console.log(ok ? rgb(C.good, "✓ autorizado — SSIDs e BSSIDs serão exibidos.") : rgb(C.warn, `status: ${status}`));
    return;
  }

  if (command === "oui") {
    if (positional[1] === "update") {
      console.log("baixando registro OUI da IEEE…");
      const n = await updateOuiDatabase();
      console.log(rgb(C.good, `✓ ${n} fabricantes carregados`));
    } else {
      const st = ouiStatus();
      console.log(st.entries ? `${st.entries} fabricantes (${st.source})` : "nenhuma base OUI local — rode `wi oui update`");
    }
    return;
  }

  if (command === "scan") {
    const engine = makeEngine((m) => console.error(rgb(C.dim, `· ${m}`)));
    await engine.start();
    const snap = await waitForScan(engine);
    engine.stop();
    if (flags.json) console.log(JSON.stringify(snap, null, 2));
    else printTable(snap);
    process.exit(0);
  }

  if (command === "web") {
    const engine = makeEngine((m) => console.log(rgb(C.dim, `· ${m}`)));
    await engine.start();
    const server = startServer(engine, { port: Number(flags.port) || 3333 });
    console.log(rgb(C.title, `\n  WI//DIAG 3D ▸ ${server.url}`));
    console.log(rgb(C.dim, `  fonte: ${engine.current().source.label} · Ctrl+C para sair\n`));
    if (!flags["no-open"]) openBrowser(server.url);
    engine.onEvent((e) => {
      const color = e.level === "bad" ? C.bad : e.level === "warn" ? C.warn : e.level === "good" ? C.good : C.dim;
      console.log(rgb(color, `  ${new Date(e.t).toLocaleTimeString("pt-BR")}  ${e.message}`));
    });
    const shutdown = () => {
      server.stop();
      engine.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (command !== "live") {
    console.log(HELP);
    process.exit(1);
  }

  if (!process.stdout.isTTY) {
    // Not a terminal: behave like `wi scan`.
    const engine = makeEngine(() => {});
    await engine.start();
    printTable(await waitForScan(engine));
    engine.stop();
    process.exit(0);
  }

  const logs: string[] = [];
  const engine = makeEngine((m) => logs.push(m));
  let server = null as ReturnType<typeof startServer> | null;
  const startWeb = async () => {
    server ??= startServer(engine, { port: Number(flags.port) || 3333 });
    if (!flags["no-open"]) openBrowser(server.url);
    return server.url;
  };

  await engine.start();
  if (flags.web) await startWeb();

  const tui = new Tui(engine, { startWeb, webUrl: server?.url ?? null });
  const cleanup = () => {
    tui.stop();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("uncaughtException", (e) => {
    tui.stop();
    console.error(e);
    process.exit(1);
  });

  await tui.run();
  server?.stop();
  engine.stop();
  if (logs.length) console.log(rgb(C.dim, logs.slice(-5).map((l) => `· ${l}`).join("\n")));
  process.exit(0);
}

main();
