/**
 * RF Space Observatory — Main Application
 * Orchestrates boot, WebSocket, 3D scene, dashboard, export panel.
 */

(function () {
    'use strict';

    // ─── State ───────────────────────────────────────────────
    const state = {
        connected: false,
        scanCount: 0,
        apCount: 0,
        startTime: null,
        accessPoints: {},   // bssid → ap data
        positions: {},      // bssid → {x,y,z}
        networkConfig: {},
        scanStats: {},
        logCount: 0,
        exportBusy: false,
    };

    let scene = null;
    let ws    = null;

    // ─── DOM Cache ───────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const dom = {};

    function cacheDom() {
        // Boot
        dom.bootScreen  = $('boot-screen');
        dom.bootBar     = $('boot-progress-bar');
        dom.bootPct     = $('boot-pct');
        dom.bootStatus  = $('boot-status');
        dom.bsRenderer  = $('bs-renderer');
        dom.bsScanner   = $('bs-scanner');
        dom.bsWs        = $('bs-ws');
        dom.bsReady     = $('bs-ready');

        // App
        dom.app = $('app');

        // Topbar
        dom.connDot   = $('conn-dot');
        dom.connLabel = $('conn-label');
        dom.scanCount = $('scan-count');
        dom.apCount   = $('ap-count');
        dom.uptime    = $('uptime');

        // Header export buttons
        dom.btnPdf   = $('btn-pdf');
        dom.btnWord  = $('btn-word');
        dom.btnExcel = $('btn-excel');
        dom.btnAll   = $('btn-all');

        // Network info
        dom.netHostname    = $('net-hostname');
        dom.netLocalIp     = $('net-local-ip');
        dom.netGateway     = $('net-gateway');
        dom.netWifiAdapter = $('net-wifi-adapter');
        dom.netOs          = $('net-os');

        // Band stats
        dom.stat24    = $('stat-24ghz');
        dom.stat5     = $('stat-5ghz');
        dom.statAvg   = $('stat-avg-rssi');
        dom.bar24     = $('bar-24ghz');
        dom.bar5      = $('bar-5ghz');
        dom.barRssi   = $('bar-rssi');
        dom.spectrum  = $('signal-spectrum');

        // AP list
        dom.apList      = $('ap-list');
        dom.apListCount = $('ap-list-count');

        // Scan health
        dom.hbarStrong = $('hbar-strong');
        dom.hbarMedium = $('hbar-medium');
        dom.hbarWeak   = $('hbar-weak');
        dom.hvalStrong = $('hval-strong');
        dom.hvalMedium = $('hval-medium');
        dom.hvalWeak   = $('hval-weak');

        // Export panel (right side)
        dom.exportStatus = $('export-status');
        dom.exportLog    = $('export-log');
        dom.exportCards  = document.querySelectorAll('.ec-btn');

        // Log
        dom.logList    = $('log-list');
        dom.logCounter = $('log-counter');
        dom.btnClearLog = $('btn-clear-log');

        // Viewport
        dom.convergence = $('convergence-indicator');
        dom.outageRibbon = $('outage-ribbon');
        dom.outageMsg   = $('outage-msg');
        dom.outageClose = $('outage-close');

        // Status bar
        dom.sbOs     = $('sb-os');
        dom.sbHttp   = $('sb-http');
        dom.sbScanStatus = $('sb-scan-status');

        // Fullscreen btn
        dom.btnFullscreen = $('btn-fullscreen');
    }

    // ─── Boot Sequence ───────────────────────────────────────
    async function bootSequence() {
        console.log('[app] 🛰️ RF Space Observatory booting...');

        const setProgress = (pct, msg) => {
            dom.bootBar.style.width = pct + '%';
            if (dom.bootPct) dom.bootPct.textContent = pct + '%';
            if (msg && dom.bootStatus) dom.bootStatus.textContent = msg;
        };

        const markStep = (el, state) => {
            if (!el) return;
            el.classList.remove('done', 'active');
            el.classList.add(state);
        };

        // Step 1 — 3D Renderer
        markStep(dom.bsRenderer, 'active');
        setProgress(10, 'Initializing Three.js renderer...');
        await sleep(300);
        scene = new RFScene3D('three-container');
        setProgress(25, '3D RF space map created');
        markStep(dom.bsRenderer, 'done');
        await sleep(200);

        // Step 2 — Scanner init feedback
        markStep(dom.bsScanner, 'active');
        setProgress(40, 'Loading matrix rain shaders...');
        await sleep(250);
        setProgress(55, 'Calibrating force-directed layout...');
        markStep(dom.bsScanner, 'done');
        await sleep(200);

        // Step 3 — WebSocket
        markStep(dom.bsWs, 'active');
        setProgress(70, 'Connecting to Python backend (ws://127.0.0.1:8765)...');
        ws = new WSClient('ws://127.0.0.1:8765');
        setupWSHandlers();
        ws.connect();
        await sleep(600);
        setProgress(85, 'Syncing network configuration...');
        markStep(dom.bsWs, 'done');
        await sleep(200);

        // Step 4 — Ready
        markStep(dom.bsReady, 'active');
        setProgress(100, 'RF Space Observatory online ✓');
        await sleep(300);
        markStep(dom.bsReady, 'done');
        await sleep(350);

        // Transition
        dom.bootScreen.classList.add('fade-out');
        dom.app.classList.remove('hidden');

        state.startTime = Date.now();
        setInterval(updateUptime, 1000);
        setupUIHandlers();

        // Detect HTTP origin (if served via start.js)
        if (location.protocol !== 'file:') {
            if (dom.sbHttp) dom.sbHttp.textContent = location.host;
        } else {
            if (dom.sbHttp) dom.sbHttp.textContent = 'file://';
        }

        // Toast on boot
        showToast('info', '🛰️', 'RF Space Observatory Online');
        console.log('[app] ✅ Boot complete');
    }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ─── WebSocket Handlers ──────────────────────────────────
    function setupWSHandlers() {
        ws.on('connected', () => {
            state.connected = true;
            setConnStatus(true);
            if (dom.sbScanStatus) dom.sbScanStatus.textContent = 'Connected — waiting for scan...';
        });

        ws.on('disconnected', () => {
            state.connected = false;
            setConnStatus(false);
            if (dom.sbScanStatus) dom.sbScanStatus.textContent = 'Disconnected';
        });

        ws.on('scan', (data) => {
            state.scanCount++;
            setText(dom.scanCount, state.scanCount);

            if (data.access_points) {
                for (const ap of data.access_points) {
                    state.accessPoints[ap.bssid] = ap;
                }
                state.apCount = Object.keys(state.accessPoints).length;
                setText(dom.apCount, state.apCount);
            }

            if (scene) scene.triggerScanPulse();
            showConvergence();
            refreshAPList();
            refreshSignalHealth();
            refreshSpectrum();
            if (dom.sbScanStatus) dom.sbScanStatus.textContent = `Scan #${state.scanCount} — ${state.apCount} APs`;
        });

        ws.on('position_update', (data) => {
            if (!data.positions) return;
            state.positions = data.positions;
            if (scene) scene.updateAccessPoints(data.positions, data.ap_metadata || {});
        });

        ws.on('network_config', (data) => {
            state.networkConfig = data;
            applyNetworkConfig(data);
        });

        ws.on('stats', (data) => {
            state.scanStats = data.scan || {};
            refreshBandStats(data.scan || {});
        });

        ws.on('log', (data) => {
            addLogEntry(data);
        });

        ws.on('outage', (data) => {
            const dur = data.duracao_segundos?.toFixed(0) || '?';
            addLogEntry({
                timestamp: data.fim || new Date().toISOString(),
                message: `🔴 PPPoE outage — recovered after ${dur}s`,
                log_type: 'connection',
            });
            showOutageRibbon(`Connection outage — recovered after ${dur}s`);
        });

        ws.on('full_state', (data) => {
            if (data.network_config) {
                state.networkConfig = data.network_config;
                applyNetworkConfig(data.network_config);
            }
            if (data.access_points) {
                for (const ap of data.access_points) state.accessPoints[ap.bssid] = ap;
                state.apCount = Object.keys(state.accessPoints).length;
                setText(dom.apCount, state.apCount);
                refreshAPList();
                refreshSignalHealth();
                refreshSpectrum();
            }
            if (data.positions && scene) scene.updateAccessPoints(data.positions, {});
            if (data.scan_stats) refreshBandStats(data.scan_stats);
        });

        ws.on('report_done', (data) => {
            setExportBusy(false, data.format);
            const name = data.filename || data.format;
            addExportLog('success', `✓ ${name} saved`);
            showToast('success', '📄', `Report ready: ${name}`);
            resetExportBtns(data.format, 'success');
        });

        ws.on('report_error', (data) => {
            setExportBusy(false, data.format);
            addExportLog('error', `✗ ${data.error || 'Export failed'}`);
            showToast('error', '❌', `Export failed: ${data.error || data.format}`);
            resetExportBtns(data.format, 'error');
        });
    }

    // ─── UI Updates ──────────────────────────────────────────

    function setConnStatus(connected) {
        if (!dom.connDot || !dom.connLabel) return;
        if (connected) {
            dom.connDot.classList.replace('disconnected', 'connected');
            dom.connLabel.textContent = 'Connected';
        } else {
            dom.connDot.classList.replace('connected', 'disconnected');
            dom.connLabel.textContent = 'Disconnected';
        }
    }

    function applyNetworkConfig(cfg) {
        setText(dom.netHostname, cfg.hostname || '—');
        setText(dom.netLocalIp, cfg.local_ip || '—');
        setText(dom.netGateway, cfg.gateway || '—');
        setText(dom.netOs, cfg.os || '—');
        if (dom.netWifiAdapter) {
            dom.netWifiAdapter.textContent = cfg.wifi_adapter?.name || cfg.wifi_adapter?.description || 'Not found';
        }
        if (dom.sbOs) dom.sbOs.textContent = `${cfg.os || ''} · ${cfg.hostname || ''}`.trim();
    }

    function refreshBandStats(scan) {
        const c24 = scan.band_24ghz || 0;
        const c5  = scan.band_5ghz || 0;
        const total = c24 + c5 || 1;

        setText(dom.stat24, c24);
        setText(dom.stat5, c5);
        setText(dom.statAvg, scan.avg_rssi ? `${scan.avg_rssi}` : '—');

        if (dom.bar24) dom.bar24.style.width = ((c24 / total) * 100) + '%';
        if (dom.bar5)  dom.bar5.style.width  = ((c5 / total) * 100) + '%';

        // RSSI bar: map -90..-30 → 0..100%
        if (dom.barRssi && scan.avg_rssi) {
            const rssi = scan.avg_rssi;
            const pct = Math.max(0, Math.min(100, ((rssi + 90) / 60) * 100));
            dom.barRssi.style.width = pct + '%';
        }
    }

    function refreshSpectrum() {
        if (!dom.spectrum) return;
        const aps = Object.values(state.accessPoints);
        if (!aps.length) return;

        const sorted = [...aps].sort((a, b) => (b.rssi_mean ?? b.rssi ?? -80) - (a.rssi_mean ?? a.rssi ?? -80));
        let html = '';
        for (const ap of sorted) {
            const rssi    = ap.rssi_mean ?? ap.rssi ?? -80;
            const quality = ap.signal_quality ?? Math.max(0, Math.min(100, (rssi + 100) * 2));
            const h       = Math.max(3, (quality / 100) * 36);
            const cls     = ap.band === '5GHz' ? 'band-5' : 'band-24';
            html += `<div class="spectrum-bar ${cls}" style="height:${h}px" title="${ap.ssid_label}: ${rssi}dBm"></div>`;
        }
        dom.spectrum.innerHTML = html;
    }

    function refreshAPList() {
        if (!dom.apList) return;
        const aps = Object.values(state.accessPoints);

        if (!aps.length) {
            dom.apList.innerHTML = '<div class="list-empty">⏳ Waiting for scan data...</div>';
            setText(dom.apListCount, 0);
            return;
        }

        const sorted = [...aps].sort((a, b) => (b.rssi_mean ?? b.rssi ?? -80) - (a.rssi_mean ?? a.rssi ?? -80));
        setText(dom.apListCount, sorted.length);

        let html = '';
        for (const ap of sorted) {
            const rssi      = ap.rssi_mean ?? ap.rssi ?? -80;
            const bandCls   = ap.band === '5GHz' ? 'band-5' : 'band-24';
            const rssiCls   = rssi > -50 ? 'strong' : rssi > -70 ? 'medium' : 'weak';
            const quality   = Math.round(ap.signal_quality ?? Math.max(0, Math.min(100, (rssi + 100) * 2)));
            const dist      = (ap.distance_estimate ?? 0).toFixed(1);
            const ch        = ap.channel ?? '?';

            html += `
            <div class="ap-item" data-bssid="${escHtml(ap.bssid)}">
                <div class="ap-band-dot ${bandCls}"></div>
                <div class="ap-info">
                    <div class="ap-label">${escHtml(ap.ssid_label ?? 'Unknown')}</div>
                    <div class="ap-meta">
                        <span>Ch ${ch}</span>
                        <span>${ap.band ?? '?'}</span>
                        <span>${dist}m</span>
                        <span>${ap.security ?? ''}</span>
                    </div>
                </div>
                <div class="ap-signal">
                    <div class="ap-rssi ${rssiCls}">${rssi.toFixed(0)}</div>
                    <div class="ap-quality">${quality}%</div>
                </div>
            </div>`;
        }
        dom.apList.innerHTML = html;

        // Focus click handler
        dom.apList.querySelectorAll('.ap-item').forEach(item => {
            item.addEventListener('click', () => focusAP(item.dataset.bssid));
        });
    }

    function refreshSignalHealth() {
        const aps = Object.values(state.accessPoints);
        let strong = 0, medium = 0, weak = 0;

        for (const ap of aps) {
            const r = ap.rssi_mean ?? ap.rssi ?? -80;
            if (r > -50) strong++;
            else if (r > -70) medium++;
            else weak++;
        }

        const total = aps.length || 1;
        setText(dom.hvalStrong, strong);
        setText(dom.hvalMedium, medium);
        setText(dom.hvalWeak, weak);
        if (dom.hbarStrong) dom.hbarStrong.style.width = ((strong / total) * 100) + '%';
        if (dom.hbarMedium) dom.hbarMedium.style.width = ((medium / total) * 100) + '%';
        if (dom.hbarWeak)   dom.hbarWeak.style.width   = ((weak   / total) * 100) + '%';
    }

    function focusAP(bssid) {
        if (!scene?.apNodes?.[bssid]) return;
        const pos = scene.apNodes[bssid].mesh.position;
        const target = pos.clone();
        const startTarget = scene._target.clone();
        const t0 = Date.now();
        const dur = 700;

        (function anim() {
            const t = Math.min(1, (Date.now() - t0) / dur);
            const e = 1 - Math.pow(1 - t, 3);
            scene._target.lerpVectors(startTarget, target, e);
            if (t < 1) requestAnimationFrame(anim);
        })();
    }

    function addLogEntry(data) {
        if (!dom.logList) return;
        const empty = dom.logList.querySelector('.list-empty');
        if (empty) empty.remove();

        state.logCount++;
        setText(dom.logCounter, `${state.logCount} entries`);

        const time = data.timestamp
            ? new Date(data.timestamp).toLocaleTimeString('pt-BR', { hour12: false })
            : new Date().toLocaleTimeString('pt-BR', { hour12: false });
        const type = data.log_type || 'info';
        const msg  = data.message || '';

        const el = document.createElement('div');
        el.className = 'log-entry';
        el.innerHTML = `
            <span class="log-time">${time}</span>
            <span class="log-dot ${type}"></span>
            <span class="log-msg">${escHtml(msg)}</span>
        `;
        dom.logList.prepend(el);

        while (dom.logList.children.length > 100) {
            dom.logList.removeChild(dom.logList.lastChild);
        }
    }

    function showConvergence() {
        if (!dom.convergence) return;
        dom.convergence.classList.add('active');
        clearTimeout(state._convTimer);
        state._convTimer = setTimeout(() => dom.convergence.classList.remove('active'), 6000);
    }

    function showOutageRibbon(msg) {
        if (!dom.outageRibbon) return;
        if (dom.outageMsg) dom.outageMsg.textContent = msg;
        dom.outageRibbon.classList.remove('hidden');
    }

    function updateUptime() {
        if (!state.startTime || !dom.uptime) return;
        const e = Math.floor((Date.now() - state.startTime) / 1000);
        const h = Math.floor(e / 3600).toString().padStart(2, '0');
        const m = Math.floor((e % 3600) / 60).toString().padStart(2, '0');
        const s = (e % 60).toString().padStart(2, '0');
        dom.uptime.textContent = e >= 3600 ? `${h}:${m}:${s}` : `${m}:${s}`;
    }

    // ─── Export ──────────────────────────────────────────────

    function triggerExport(format) {
        if (state.exportBusy) {
            showToast('info', '⏳', 'An export is already in progress.');
            return;
        }

        if (!state.connected) {
            showToast('error', '⚠️', 'Not connected to backend. Start the Python server first.');
            return;
        }

        state.exportBusy = true;
        setExportBusy(true, format);
        addExportLog('busy', `⟳ Generating ${format.toUpperCase()}...`);

        if (ws?.requestReport) {
            ws.requestReport(format);
        } else {
            // Fallback: send via raw WS
            ws?.send(JSON.stringify({ type: 'generate_report', format }));
        }
    }

    function setExportBusy(busy, format) {
        // Update status indicator in right panel
        if (dom.exportStatus) {
            const dot  = dom.exportStatus.querySelector('.es-dot');
            const text = dom.exportStatus.querySelector('.es-text');
            if (dot)  { dot.className = 'es-dot' + (busy ? ' busy' : ''); }
            if (text) text.textContent = busy ? `Generating ${format?.toUpperCase() || ''}...` : 'Ready to export';
        }
    }

    function resetExportBtns(format, state) {
        // Quick flash on header buttons
        const map = { pdf: dom.btnPdf, word: dom.btnWord, excel: dom.btnExcel, all: dom.btnAll };
        const btn = map[format];
        if (btn) {
            btn.classList.add(state);
            setTimeout(() => btn.classList.remove(state, 'loading'), 2500);
        }

        // Also reset right panel card if exists
        const card = document.querySelector(`.ec-btn[data-format="${format}"]`);
        if (card) {
            card.classList.remove('loading');
            if (state === 'success') {
                card.classList.add('done');
                setTimeout(() => card.classList.remove('done'), 3000);
            }
        }
    }

    function addExportLog(type, msg) {
        if (!dom.exportLog) return;
        const el = document.createElement('div');
        el.className = `el-entry ${type}`;
        el.textContent = msg;
        dom.exportLog.prepend(el);
        while (dom.exportLog.children.length > 6) dom.exportLog.removeChild(dom.exportLog.lastChild);
    }

    // ─── Toast ───────────────────────────────────────────────

    function showToast(type, icon, msg, duration = 3500) {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escHtml(msg)}</span>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 350);
        }, duration);
    }

    // ─── UI Event Handlers ───────────────────────────────────
    function setupUIHandlers() {

        // Header export buttons
        [dom.btnPdf, dom.btnWord, dom.btnExcel, dom.btnAll].forEach(btn => {
            if (!btn) return;
            const fmt = btn.id.replace('btn-', '').replace('btn-', '');
            // derive format from id: btn-pdf → pdf, btn-word → word, btn-excel → excel, btn-all → all
            btn.addEventListener('click', () => {
                const format = btn.id === 'btn-pdf'   ? 'pdf'
                             : btn.id === 'btn-word'  ? 'word'
                             : btn.id === 'btn-excel' ? 'excel'
                             : 'all';
                btn.classList.add('loading');
                triggerExport(format);
            });
        });

        // Right panel export cards
        document.querySelectorAll('.ec-btn').forEach(card => {
            card.addEventListener('click', () => {
                const format = card.dataset.format;
                if (!format) return;
                card.classList.add('loading');
                triggerExport(format);
            });
        });

        // Outage close
        if (dom.outageClose) {
            dom.outageClose.addEventListener('click', () => dom.outageRibbon?.classList.add('hidden'));
        }

        // Clear log
        if (dom.btnClearLog) {
            dom.btnClearLog.addEventListener('click', () => {
                if (dom.logList) {
                    dom.logList.innerHTML = '<div class="list-empty">No syslog received</div>';
                    state.logCount = 0;
                    setText(dom.logCounter, '0 entries');
                }
            });
        }

        // Fullscreen toggle
        if (dom.btnFullscreen) {
            dom.btnFullscreen.addEventListener('click', () => {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen().catch(() => {});
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'p' || e.key === 'P') && e.ctrlKey) {
                e.preventDefault();
                triggerExport('pdf');
            }
            if ((e.key === 'e' || e.key === 'E') && e.ctrlKey) {
                e.preventDefault();
                triggerExport('excel');
            }
        });
    }

    // ─── Helpers ─────────────────────────────────────────────
    function setText(el, val) {
        if (el) el.textContent = val;
    }

    function escHtml(str) {
        const d = document.createElement('div');
        d.textContent = String(str);
        return d.innerHTML;
    }

    // ─── Init ────────────────────────────────────────────────
    function init() {
        cacheDom();
        bootSequence();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
