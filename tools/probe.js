'use strict'

/**
 * 站点适配探测器：用真实的移动端伪装加载每个站点，截图 + 导出诊断信息。
 * 用法：ELECTRON_RUN_AS_NODE 必须为空
 *      ./node_modules/electron/dist/electron.exe tools/probe.js [caseId]
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')
const { SITES } = require('../src/sites')

const OUT = path.join(__dirname, '..', 'shots')
const FALLBACK_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

const BLOCK_WORDS = [
  '打开 App', '打开APP', '打开应用', '在 App 内打开', '在APP内打开',
  '下载', '客户端', '扫码', 'App 内', 'APP 内', '请使用抖音',
  '404', 'Not Found', '页面不存在', '出错了',
]

const VIEWPORTS = [{ tag: 'normal', width: 390, height: 844 }]

async function probeOne(site, vp, url, usePreload) {
  const ses = session.fromPartition(`probe_${site.id}_${vp.tag}_${Date.now()}`)
  ses.setUserAgent(site.ua || FALLBACK_UA, 'zh-CN,zh;q=0.9')
  if (usePreload) ses.setPreloads([path.join(__dirname, '..', 'src', 'preload-site.js')])
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const headers = { ...details.requestHeaders }
    for (const k of Object.keys(headers)) if (/^sec-ch-ua(-|$)/i.test(k)) delete headers[k]
    cb({ requestHeaders: headers })
  })

  const win = new BrowserWindow({
    show: false,
    width: vp.width,
    height: vp.height,
    backgroundColor: '#ffffff',
    webPreferences: {
      session: ses,
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      offscreen: false,
    },
  })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let navError = null
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    navError = `${code} ${desc}`
  })

  try {
    await Promise.race([
      win.loadURL(url, { userAgent: site.ua || FALLBACK_UA }),
      sleep(15000).then(() => {
        throw new Error('load timeout')
      }),
    ])
  } catch (e) {
    navError = navError || e.message
  }

  await sleep(7000)

  let diag = {}
  try {
    diag = await win.webContents.executeJavaScript(`(() => {
      const t = document.body ? document.body.innerText.slice(0, 800) : ''
      const re = /(下载|打开App|打开APP|App内|APP内|打开看看|客户端|前往App)/
      const sels = []
      for (const el of document.querySelectorAll('div,a,button,span,header,footer,section,img,input')) {
        const own = ([...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('') || '').replace(/\\s+/g, '')
        const alt = (el.tagName === 'IMG' ? (el.alt || '') : '').replace(/\\s+/g, '')
        const label = own || alt
        if (!label || label.length > 12 || !re.test(label)) continue
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        const path = []
        let n = el
        while (n && n.nodeType === 1 && n !== document.body && path.length < 4) {
          let s = n.tagName.toLowerCase()
          if (n.id) s += '#' + n.id
          else if (typeof n.className === 'string' && n.className.trim()) s += '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.')
          path.unshift(s)
          n = n.parentElement
        }
        sels.push({ label, path: path.join('>'), top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) })
      }
      return {
        title: document.title,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
        viewportContent: (document.querySelector('meta[name="viewport"]') || {}).content || '',
        landingHref: location.href,
        text: t,
        hasVideo: !!document.querySelector('video'),
        nodes: document.querySelectorAll('*').length,
        floats: sels.slice(0, 25),
      }
    })()`)
  } catch (e) {
    diag = { evalError: e.message }
  }

  const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 40)
  const name = `${site.id}__${slug}${usePreload ? '' : '__raw'}`
  let shot = null
  try {
    const img = await win.webContents.capturePage()
    fs.mkdirSync(OUT, { recursive: true })
    shot = path.join(OUT, `${name}.png`)
    fs.writeFileSync(shot, img.toPNG())
  } catch (e) {
    shot = `capture failed: ${e.message}`
  }

  win.destroy()
  const hit = BLOCK_WORDS.filter((w) => (diag.text || '').includes(w))
  return { site: site.id, url, vp: vp.tag, usePreload, navError, hit, diag, shot }
}

app.whenReady().then(async () => {
  // 单 case 模式：electron tools/probe.js -- <siteId> <url>
  // 由外部循环调用，避免一个站点拖死整批；结果写 shots/<slug>.json
  const sep = process.argv.indexOf('--')
  if (sep === -1) {
    console.error('usage: electron probe.js -- <siteId> <url>')
    app.quit()
    return
  }
  const siteId = process.argv[sep + 1]
  const url = process.argv[sep + 2]
  const site = SITES.find((s) => s.id === siteId)
  if (!site) {
    console.error('unknown site:', siteId)
    app.quit()
    return
  }

  process.on('uncaughtException', (e) => {
    try { fs.appendFileSync(path.join(OUT, 'errors.log'), `${siteId} uncaught: ${e.stack}\n`) } catch (_) {}
    app.quit()
  })
  process.on('unhandledRejection', (e) => {
    try { fs.appendFileSync(path.join(OUT, 'errors.log'), `${siteId} rejection: ${e}\n`) } catch (_) {}
  })

  const results = []
  for (const vp of VIEWPORTS) {
    try {
      results.push(await probeOne(site, vp, url, true))
    } catch (e) {
      results.push({ site: site.id, vp: vp.tag, url, fatal: e.message })
    }
  }
  fs.mkdirSync(OUT, { recursive: true })
  const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 40)
  fs.writeFileSync(path.join(OUT, `r_${siteId}__${slug}.json`), JSON.stringify(results, null, 2))
  app.quit()
})
