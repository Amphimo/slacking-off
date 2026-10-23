'use strict'

const path = require('node:path')
const maybeApp = require('electron')

// 某些终端残留了 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node 进程，
// 此时 require('electron') 拿不到 app，窗口永远出不来。检测到就自我重启一次。
if (!maybeApp || !maybeApp.app) {
  // 开发模式要显式传应用目录；打包后 exe 自带 app 路径，传 asar 反而会失败。
  const args = process.defaultApp
    ? [path.join(__dirname, '..'), ...process.argv.slice(2)]
    : process.argv.slice(1)
  const child = require('node:child_process').spawn(
    process.execPath,
    args,
    { env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')), detached: true, stdio: 'ignore' },
  )
  child.unref()
  process.exit(0)
}

const { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, session, screen, shell } = maybeApp
const { SITES } = require('./sites')
const { XhhService } = require('./xhh/service')
const { BiliService } = require('./bili/service')
const { DouyinService } = require('./douyin/service')

// ── 关键开关，必须在 app ready 之前设置 ────────────────────────────
// 让鼠标拖拽产生 touchstart/touchmove/touchend，等价于 DevTools 设备模式。
app.commandLine.appendSwitch('touch-events', 'enabled')
// 别让 Chromium 发送 Sec-CH-UA-*，它们是比 User-Agent 更可靠的「我是桌面」告密头
app.commandLine.appendSwitch('disable-features', 'UserAgentClientHints')
// 滚动条像手机一样悬浮，不再挤占视口宽度（否则 390px 视口实际只有 376，可能掉出移动断点）
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')

// 一键隐藏「下载 / 打开App」类浮条。手动触发而非自动注入，避免误杀正常 UI。
const DECLUTTER_JS = `(() => {
  const re = /(下载|打开App|打开APP|打开应用|App内|APP内|客户端|前往App|去App)/
  const killed = []
  for (const el of document.querySelectorAll('div,a,button,span,header,footer,section')) {
    const t = (el.innerText || '').replace(/\\s+/g, '')
    if (!t || t.length > 12 || !re.test(t)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    const fixed = getComputedStyle(el).position === 'fixed'
    const edge = r.top < 140 || r.bottom > innerHeight - 140
    if (!(fixed || edge)) continue
    el.style.setProperty('display', 'none', 'important')
    killed.push(t)
  }
  return killed.slice(0, 8).join(', ') || '没找到可清理的浮条'
})()`

const PAUSE_MEDIA_JS = `(() => {
  let n = 0
  for (const m of document.querySelectorAll('video,audio')) {
    if (m.paused) continue
    try { m.pause(); n++ } catch (_) {}
  }
  return n
})()`

function pauseMedia(view) {
  if (!view || view.webContents.isDestroyed()) return
  view.webContents.executeJavaScript(PAUSE_MEDIA_JS).catch(() => {})
}

const VIEWPORT_PRESETS = [
  { label: '小', width: 340, height: 640 },
  { label: '中', width: 390, height: 760 },
  { label: '大', width: 430, height: 860 },
]

const CHROME_TOP = 38    // 自绘标题栏高度，与 shell.css 保持一致
const CHROME_BOTTOM = 38 // 工具条高度

let win = null
let currentView = null
let alwaysOnTop = false
const views = new Map() // site.id -> WebContentsView

const sitePartition = (site) => `persist:moyu_${site.id}`

/**
 * 每个站点独立持久化 session：登录态隔离且长期保留。
 * UA 按站点设置：B站用移动 UA，小红书用桌面 UA（移动页会被降级成热门+下载 App 引导）。
 * 只有移动 UA 站点才拦 Client Hints —— 桌面 UA 保留它们才像正常 Chrome。
 */
function initSessions() {
  for (const site of SITES) {
    const s = session.fromPartition(sitePartition(site))
    if (site.ua) s.setUserAgent(site.ua, 'zh-CN,zh;q=0.9')
    const mobileUA = site.ua && /Mobile|Android|iPhone/i.test(site.ua)
    s.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders }
      if (mobileUA) {
        for (const key of Object.keys(headers)) {
          if (/^sec-ch-ua(-|$)/i.test(key)) delete headers[key]
        }
      }
      callback({ requestHeaders: headers })
    })
  }
}

function contentBounds() {
  const [w, h] = win.getContentSize()
  return { x: 0, y: CHROME_TOP, width: w, height: Math.max(120, h - CHROME_TOP - CHROME_BOTTOM) }
}

function getView(site) {
  if (views.has(site.id)) return views.get(site.id)

  const isPanel = site.type === 'panel'

  // 网页站：contextIsolation 必须关掉，否则 preload 运行在隔离 world，
  // 伪装改动页面完全看不到（第一版失效的根因）。
  // 面板站：加载本地 HTML（我们自己的代码），正常隔离 + IPC 桥。
  const v = new WebContentsView({
    webPreferences: isPanel
      ? {
          preload: path.join(__dirname, 'preload-panel.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false,
        }
      : {
          session: session.fromPartition(sitePartition(site)),
          preload: path.join(__dirname, 'preload-site.js'),
          contextIsolation: false,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
  })
  v.setBackgroundColor('#ffffff')
  v.setBounds(contentBounds())

  const wc = v.webContents
  // 「手机行为」：任何 target=_blank 的新窗口都留在本机内打开，不弹系统浏览器
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) wc.loadURL(url)
    return { action: 'deny' }
  })

  if (isPanel) {
    wc.loadFile(path.join(__dirname, 'panels', `${site.id}.html`))
  } else {
    wc.loadURL(site.url, site.ua ? { userAgent: site.ua } : {})
    if (site.fitZoom) startFitLoop(site, wc)
  }
  views.set(site.id, v)
  return v
}

/**
 * 桌面版页面通常有 min-width（如抖音约 1100px），塞进 390px 小窗会被裁掉一半。
 * 动态 zoom：scrollWidth 多宽就把整页缩到多小，保证完整可见；
 * 页面切到自适应宽度的视图（如抖音点进视频后的竖屏沉浸流）时缩放自动回到 1。
 */
function startFitLoop(site, wc) {
  const tick = async () => {
    if (!win || win.isDestroyed() || wc.isDestroyed()) return
    try {
      const sw = await wc.executeJavaScript(
        'Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0)',
      )
      if (!sw) return
      const [w] = win.getContentSize()
      const z = Math.min(1, Math.max(0.4, w / sw))
      if (Math.abs(wc.getZoomFactor() - z) > 0.02) wc.setZoomFactor(z)
    } catch (_) {
      /* 页面跳转间隙执行失败属正常 */
    }
  }
  const timer = setInterval(tick, 900)
  wc.once('destroyed', () => clearInterval(timer))
}

function showSite(id) {
  if (!win) return
  const site = SITES.find((s) => s.id === id)
  if (!site) return
  const v = getView(site)
  if (currentView !== v) {
    pauseMedia(currentView)
    if (currentView) win.contentView.removeChildView(currentView)
    win.contentView.addChildView(v)
    currentView = v
    v.setBounds(contentBounds())
  }
  v.setVisible(true)
  v.webContents.focus()
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea
  const preset = VIEWPORT_PRESETS[1]

  win = new BrowserWindow({
    width: preset.width,
    height: preset.height,
    x: area.x + area.width - preset.width - 16,
    y: area.y + 24,
    frame: false,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    backgroundColor: '#141417',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    minWidth: 300,
    minHeight: 420,
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
    },
  })

  win.loadFile(path.join(__dirname, 'shell.html'))
  win.setAlwaysOnTop(alwaysOnTop)

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('bootstrap', {
      sites: SITES,
      presets: VIEWPORT_PRESETS,
      alwaysOnTop,
    })
  })

  win.on('resize', () => {
    if (currentView) currentView.setBounds(contentBounds())
  })

  win.on('closed', () => {
    win = null
  })
}

function activeWC() {
  return currentView && currentView.webContents
}

function toggleVisible() {
  if (!win) return false
  if (win.isVisible() && win.isFocused()) {
    win.hide()
    pauseMedia(currentView)
  } else {
    win.show()
    win.focus()
  }
  return win.isVisible()
}

app.whenReady().then(() => {
  // 让 Windows 任务栏和通知按应用归组，而不是挂到 electron.exe 下。
  if (process.platform === 'win32') app.setAppUserModelId('com.slackingoff.moyu')
  initSessions()
  let xhhService = null
  let loginSession = null
  try {
    xhhService = new XhhService(app.getPath('userData'))
  } catch (e) {
    console.error('xhh service init failed:', e.message)
  }

  // B站面板复用网页端 persist:moyu_bili 的 cookie：登录一次，网页/面板共享
  let biliService = null
  let biliLoginSession = null
  try {
    biliService = new BiliService(session.fromPartition('persist:moyu_bili'))
  } catch (e) {
    console.error('bili service init failed:', e.message)
  }

  // 抖音签名依赖页面环境：常驻一个隐藏抖音窗口，用它的 axios 发已签名请求
  let douyinService = null
  try {
    douyinService = new DouyinService(session.fromPartition('persist:moyu_douyin'))
  } catch (e) {
    console.error('douyin service init failed:', e.message)
  }

  ipcMain.handle('panel:xhh-feed', async (_e, { offset, pull } = {}) => {
    if (!xhhService) throw new Error('小黑盒服务未初始化')
    return xhhService.feed(Number(offset) || 0, String(pull || '0'))
  })

  // ── 小黑盒登录态 ──────────────────────────────────────────
  ipcMain.handle('panel:xhh-me', () => (xhhService ? xhhService.me() : { loggedIn: false }))

  ipcMain.handle('panel:xhh-login-start', async () => {
    if (!xhhService) throw new Error('小黑盒服务未初始化')
    const QRCode = require('qrcode')
    loginSession = await xhhService.client.startQrLogin()
    const dataUrl = await QRCode.toDataURL(loginSession.qrContent, { width: 220, margin: 1 })
    return { dataUrl, expiresIn: Math.ceil((loginSession.expiresAt - Date.now()) / 1000) }
  })

  ipcMain.handle('panel:xhh-login-poll', async () => {
    if (!loginSession) return { state: 'expired', message: '会话不存在，请重新获取' }
    const r = await xhhService.client.pollQrLogin(loginSession)
    if (r.state === 'success') {
      loginSession = null
      return { ...r, me: xhhService.setLogin(r) }
    }
    return r
  })

  ipcMain.handle('panel:xhh-logout', () => xhhService.logout())

  ipcMain.handle('panel:xhh-detail', async (_e, { linkid } = {}) => {
    if (!xhhService) throw new Error('小黑盒服务未初始化')
    return xhhService.detail(String(linkid))
  })

  ipcMain.handle('panel:xhh-sub-comments', async (_e, { rootId, lastval } = {}) => {
    if (!xhhService) throw new Error('小黑盒服务未初始化')
    return xhhService.subComments(String(rootId), String(lastval || ''))
  })
  ipcMain.handle('panel:xhh-like-post', async (_e, { linkid, on } = {}) => {
    if (!xhhService) throw new Error('小黑盒服务未初始化')
    return xhhService.likePost(String(linkid), !!on)
  })
  ipcMain.handle('panel:xhh-like-comment', async (_e, { commentId, on } = {}) => {
    if (!xhhService) throw new Error('小黑盒服务未初始化')
    return xhhService.likeComment(String(commentId), !!on)
  })
  ipcMain.handle('panel:xhh-fav-post', async (_e, { linkid, on } = {}) => {
    if (!xhhService) throw new Error('小黑盒服务未初始化')
    return xhhService.favouritePost(String(linkid), on !== false)
  })

  ipcMain.handle('panel:xhh-fav-folders', async () => xhhService.favouriteFolders())
  ipcMain.handle('panel:xhh-fav', async (_e, { folderId } = {}) => xhhService.favourites(folderId))
  ipcMain.handle('panel:xhh-msg', async () => xhhService.messages())

  // ── B站面板 ──────────────────────────────────────────────
  ipcMain.handle('bili:feed', async (_e, { refresh } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.feed(!!refresh)
  })
  ipcMain.handle('bili:me', async () => (biliService ? biliService.me() : { loggedIn: false }))
  ipcMain.handle('bili:search', async (_e, { keyword, pn } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.search(String(keyword || ''), Number(pn) || 1)
  })
  ipcMain.handle('bili:login-start', async () => {
    if (!biliService) throw new Error('B站服务未初始化')
    const QRCode = require('qrcode')
    biliLoginSession = await biliService.loginStart()
    const dataUrl = await QRCode.toDataURL(biliLoginSession.url, { width: 220, margin: 1 })
    return { dataUrl, expiresIn: Math.ceil((biliLoginSession.expiresAt - Date.now()) / 1000) }
  })
  ipcMain.handle('bili:login-poll', async () => {
    if (!biliService || !biliLoginSession) return { state: 'expired', message: '会话不存在，请重新获取' }
    const r = await biliService.loginPoll(biliLoginSession)
    if (['success', 'expired', 'failed'].includes(r.state)) biliLoginSession = null
    return r
  })
  ipcMain.handle('bili:logout', async () => (biliService ? biliService.logout() : { loggedIn: false }))
  ipcMain.handle('bili:detail', async (_e, { bvid } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.detail(String(bvid))
  })
  ipcMain.handle('bili:play', async (_e, { bvid, cid } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.play(String(bvid), Number(cid))
  })
  ipcMain.handle('bili:comments', async (_e, { aid, pn } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.comments(String(aid), Number(pn) || 1)
  })
  ipcMain.handle('bili:sub-comments', async (_e, { aid, root, pn } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.subComments(String(aid), String(root), Number(pn) || 1)
  })
  ipcMain.handle('bili:like', async (_e, { bvid, on } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.like(String(bvid), on !== false)
  })
  ipcMain.handle('bili:like-comment', async (_e, { aid, rpid, on } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.likeComment(String(aid), String(rpid), on !== false)
  })
  ipcMain.handle('bili:fav', async (_e, { bvid, aid, on } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.favourite(String(bvid), String(aid), on !== false)
  })
  ipcMain.handle('bili:fav-folders', async () => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.favFolders()
  })
  ipcMain.handle('bili:favourites', async (_e, { folderId } = {}) => {
    if (!biliService) throw new Error('B站服务未初始化')
    return biliService.favourites(String(folderId || ''))
  })

  // ── 抖音面板 ─────────────────────────────────────────────
  ipcMain.handle('douyin:feed', async (_e, { refresh } = {}) => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.feed(!!refresh)
  })
  ipcMain.handle('douyin:search', async (_e, { keyword, cursor } = {}) => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.search(String(keyword || ''), Number(cursor) || 0)
  })
  ipcMain.handle('douyin:me', async () => (douyinService ? douyinService.me() : { loggedIn: false }))
  ipcMain.handle('douyin:login', async () => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.login()
  })
  ipcMain.handle('douyin:verify', async () => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.verify()
  })
  ipcMain.handle('douyin:verify-hide', async () => (douyinService ? douyinService.verifyHide() : { ok: true }))
  ipcMain.handle('douyin:logout', async () => (douyinService ? douyinService.logout() : { ok: true }))
  ipcMain.handle('douyin:detail', async (_e, { id } = {}) => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.detail(String(id))
  })
  ipcMain.handle('douyin:comments', async (_e, { id, cursor } = {}) => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.comments(String(id), Number(cursor) || 0)
  })
  ipcMain.handle('douyin:replies', async (_e, { id, commentId, cursor } = {}) => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.replies(String(id), String(commentId), Number(cursor) || 0)
  })
  ipcMain.handle('douyin:like', async (_e, { id, liked } = {}) => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.like(String(id), !!liked)
  })
  ipcMain.handle('douyin:collect', async (_e, { id, collected, awemeType } = {}) => {
    if (!douyinService) throw new Error('抖音服务未初始化')
    return douyinService.collect(String(id), !!collected, Number(awemeType) || 0)
  })

  createWindow()
  if (win) {
    win.on('closed', () => {
      try { douyinService?.bridge.destroy() } catch (_) {}
    })
  }

  ipcMain.handle('view:show', (_e, id) => showSite(id))
  ipcMain.handle('view:back', () => {
    const wc = activeWC()
    if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  })
  ipcMain.handle('view:reload', () => activeWC() && activeWC().reload())
  ipcMain.handle('view:reset', async (_e, id) => {
    const site = SITES.find((s) => s.id === id)
    if (!site) return
    await session.fromPartition(sitePartition(site)).clearStorageData({
      storages: ['cookies', 'localstorage'],
    })
    showSite(id)
    activeWC().reload()
  })
  ipcMain.handle('view:declutter', async () => {
    const wc = activeWC()
    if (!wc) return ''
    try {
      return await wc.executeJavaScript(DECLUTTER_JS)
    } catch (e) {
      return '清理失败: ' + e.message
    }
  })
  ipcMain.handle('view:zoomView', (_e, delta) => {
    if (!win) return
    const [w, h] = win.getSize()
    win.setSize(Math.round(w + delta), Math.round(h + Math.round(delta * 1.9)))
  })

  ipcMain.handle('win:resize', (_e, { width, height }) => {
    if (!win) return
    win.setSize(Math.round(width), Math.round(height + CHROME_TOP + CHROME_BOTTOM))
  })
  ipcMain.handle('win:toggleTop', () => {
    if (!win) return alwaysOnTop
    alwaysOnTop = !alwaysOnTop
    win.setAlwaysOnTop(alwaysOnTop)
    return alwaysOnTop
  })
  ipcMain.handle('win:toggleVisible', () => toggleVisible())
  ipcMain.handle('win:opacity', (_e, value) => {
    if (!win) return
    win.setOpacity(Math.min(1, Math.max(0.35, value)))
  })
  ipcMain.handle('win:minimize', () => win && win.minimize())
  ipcMain.handle('win:close', () => app.quit())

  // 老板键：Ctrl+Alt+M 秒隐 / 秒显
  globalShortcut.register('CommandOrControl+Alt+M', () => {
    toggleVisible()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
