/**
 * RF Space Observatory — Electron Main Process
 * Spawns the Python backend and hosts the frontend in a BrowserWindow.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow = null;
let pythonProcess = null;
let isDev = false;

// Check for dev mode
if (process.argv.includes('--dev')) {
    isDev = true;
}

// Paths
const pythonDir = path.join(__dirname, '..', 'python');
const pythonScript = path.join(pythonDir, 'monitor.py');
const reportsDir = path.join(__dirname, '..', 'reports');

// Find Python executable
function findPython() {
    const pythonCommands = ['python', 'python3', 'py'];

    // On Windows, also check common paths
    if (process.platform === 'win32') {
        const winPaths = [
            'C:\\Python311\\python.exe',
            'C:\\Python310\\python.exe',
            'C:\\Python39\\python.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
        ];

        for (const p of winPaths) {
            if (fs.existsSync(p)) return p;
        }
    }

    return 'python'; // Fallback to PATH
}

// Start Python backend
function startPythonBackend() {
    const pythonExe = findPython();

    console.log(`[electron] Starting Python backend: ${pythonExe} ${pythonScript}`);

    const args = [
        pythonScript,
        '--ws-port', '8765',
        '--log-port', '1514',
        '--scan-interval', '2',
    ];

    pythonProcess = spawn(pythonExe, args, {
        cwd: pythonDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    pythonProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        console.log(`[python] ${output}`);
    });

    pythonProcess.stderr.on('data', (data) => {
        const output = data.toString().trim();
        console.error(`[python:err] ${output}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`[python] Process exited with code ${code}`);
        pythonProcess = null;
    });

    pythonProcess.on('error', (err) => {
        console.error(`[python] Failed to start: ${err.message}`);
        dialog.showErrorBox(
            'Python Backend Error',
            `Could not start the Python backend.\n\nError: ${err.message}\n\nPlease ensure Python 3.9+ is installed and the dependencies are installed:\n\npip install -r python/requirements.txt`
        );
    });
}

// Stop Python backend
function stopPythonBackend() {
    if (pythonProcess) {
        console.log('[electron] Stopping Python backend...');
        pythonProcess.kill('SIGTERM');

        // Force kill after 5 seconds
        setTimeout(() => {
            if (pythonProcess) {
                pythonProcess.kill('SIGKILL');
                pythonProcess = null;
            }
        }, 5000);
    }
}

// Create main window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        title: 'RF Space Observatory',
        backgroundColor: '#060A12',
        icon: path.join(__dirname, '..', 'src', 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        frame: true,
        titleBarStyle: 'default',
        show: false, // Show when ready
    });

    // Load the frontend
    const indexPath = path.join(__dirname, '..', 'src', 'index.html');
    mainWindow.loadFile(indexPath);

    // Show window when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    // Open DevTools in dev mode
    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// IPC Handlers
ipcMain.handle('generate-report', async (event, format) => {
    // Send report request to Python via WebSocket (handled by frontend)
    return { status: 'ok', format };
});

ipcMain.handle('open-reports-folder', async () => {
    const { shell } = require('electron');
    // Ensure reports directory exists
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    await shell.openPath(reportsDir);
    return { status: 'ok' };
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('get-python-status', () => {
    return {
        running: pythonProcess !== null,
        pid: pythonProcess?.pid || null,
    };
});

// App lifecycle
app.whenReady().then(() => {
    // Start Python backend first
    startPythonBackend();

    // Wait a bit for Python to initialize, then create window
    setTimeout(() => {
        createWindow();
    }, 2000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    stopPythonBackend();

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    stopPythonBackend();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('[electron] Uncaught exception:', error);
});