'use strict'

/** 面板冒烟：加载 xhh 面板页，确认 feed 卡片真的渲染出来 */

const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')
const { XhhService } = require('../src/xhh/service')

app.whenReady().then(async () => {
  const service = new XhhService(app.getPath('userData'))
  ipcMain.handle('panel:xhh-feed', (_e, { offset, pull } = {}) =>
    service.feed(Number(offset) || 0, String(pull || '0')))

  const win = new BrowserWindow({ show: false, width: 390, height: 760, webPreferences: {
    preload: path.join(__dirname, '..', 'src', 'preload-panel.js'),
    contextIsolation: true, sandbox: false,
  } })
  await win.loadFile(path.join(__dirname, '..', 'src', 'panels', 'xhh.html'))
  await new Promise((r) => setTimeout(r, 6000))

  const diag = await win.webContents.executeJavaScript(`(() => ({
    cards: document.querySelectorAll('.card').length,
    imgs: document.querySelectorAll('.card img').length,
    err: document.getElementById('status').textContent,
  }))()`)

  console.error('PANEL SMOKE:', JSON.stringify(diag))
  app.exit(diag.cards >= 5 ? 0 : 1)
})
