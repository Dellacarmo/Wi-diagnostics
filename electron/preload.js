/**
 * RF Space Observatory — Electron Preload Script
 * Secure bridge between renderer and main process.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Report generation
    generateReport: (format) => ipcRenderer.invoke('generate-report', format),

    // Open reports folder
    openReportsFolder: () => ipcRenderer.invoke('open-reports-folder'),

    // App info
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Python backend status
    getPythonStatus: () => ipcRenderer.invoke('get-python-status'),

    // Platform info
    platform: process.platform,
});