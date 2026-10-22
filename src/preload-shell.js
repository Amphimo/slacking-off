'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('shell', {
  onBootstrap: (cb) => ipcRenderer.on('bootstrap', (_e, payload) => cb(payload)),
  showSite: (id) => ipcRenderer.invoke('view:show', id),
  viewBack: () => ipcRenderer.invoke('view:back'),
  viewReload: () => ipcRenderer.invoke('view:reload'),
  viewReset: (id) => ipcRenderer.invoke('view:reset', id),
  declutter: () => ipcRenderer.invoke('view:declutter'),
  zoomView: (delta) => ipcRenderer.invoke('view:zoomView', delta),
  toggleTop: () => ipcRenderer.invoke('win:toggleTop'),
  toggleVisible: () => ipcRenderer.invoke('win:toggleVisible'),
  setOpacity: (v) => ipcRenderer.invoke('win:opacity', v),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  closeApp: () => ipcRenderer.invoke('win:close'),
})
