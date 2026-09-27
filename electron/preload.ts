import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/contracts';

// Deliberately expose individual capabilities, never raw IPC or filesystem access.
const bridge: DesktopBridge = Object.freeze({
  getPreferences: () => ipcRenderer.invoke('blue-hour:preferences:get'),
  updatePreferences: (patch: Parameters<DesktopBridge['updatePreferences']>[0]) =>
    ipcRenderer.invoke('blue-hour:preferences:update', patch),
  importKey: () => ipcRenderer.invoke('blue-hour:key:import'),
  saveKey: (value: string) => ipcRenderer.invoke('blue-hour:key:save', value),
});

contextBridge.exposeInMainWorld('blueHour', bridge);
