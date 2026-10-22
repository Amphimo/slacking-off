'use strict'

/**
 * 抖音签名代理。
 *
 * 抖音 Web 的 a_bogus/msToken/uifid 不适合离线重放，这里不自己造签名：
 * 常驻一个隐藏抖音页面，借用页面内已初始化的 axiosInstance 发请求。
 * 请求和登录态都走 persist:moyu_douyin，与原来的抖音网页分区一致。
 */

const { BrowserWindow } = require('electron')

const HOME_URL = 'https://www.douyin.com/?recommend=1'

// 只允许抖音自己的页面；登录页会挂在 passport/passport.douyin.com 等子域。
const DOUYIN_HOST = /(^|\.)douyin\.com$/i
// 抖音会往微软商店导流，这些 HTTPS 请求也一并掐掉，避免系统弹「去 Microsoft Store」。
const STORE_URL = /^https?:\/\/(apps\.microsoft\.com|(www\.)?microsoft\.com\/[^?#]*store)/i

function parseUrl(raw) {
  try { return new URL(String(raw)) } catch (_) { return null }
}

function isAllowedFrameUrl(raw) {
  const u = parseUrl(raw)
  return !!u && ['http:', 'https:', 'about:', 'data:', 'blob:'].includes(u.protocol)
}

function isDouyinUrl(raw) {
  const u = parseUrl(raw)
  return !!u && (u.protocol === 'http:' || u.protocol === 'https:') && DOUYIN_HOST.test(u.hostname)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 抖音个别接口参数不对时会一直挂起（不返回、不报错），必须自己掐断。
const REQUEST_TIMEOUT = 15000

class DouyinBridge {
  constructor(siteSession) {
    this.session = siteSession
    this.win = null
    this.ready = null
    this._challengeWatch = false
    this._challengeWaiters = new Set()
  }

  async ensure() {
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: 1280,
        height: 800,
        title: '抖音签名代理',
        autoHideMenuBar: true,
        webPreferences: {
          session: this.session,
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      })
      this.ready = this._boot()
      const win = this.win
      win.on('closed', () => {
        console.warn('[douyin bridge] window closed')
        if (this.win === win) {
          this.win = null
          this.ready = null
        }
      })
      win.webContents.on('render-process-gone', (_e, details) => {
        console.warn('[douyin bridge] renderer gone:', details && details.reason)
      })
    }
    await this.ready
    return this.win
  }

  async _boot() {
    const wc = this.win.webContents
    // 这个窗口只负责拿签名 / 登个录，永远不该出声。
    wc.setAudioMuted(true)

    this._watchChallenges()

    this.session.webRequest.onBeforeRequest((details, callback) => {
      const cancel = STORE_URL.test(details.url)
      if (cancel) console.warn('[douyin bridge] blocked store request:', details.url)
      callback({ cancel })
    })

    wc.setWindowOpenHandler(({ url }) => {
      if (isDouyinUrl(url)) wc.loadURL(url).catch(() => {})
      else console.warn('[douyin bridge] blocked popup:', url)
      return { action: 'deny' }
    })

    // 主框架只许留在抖音；子框架放行正常 http(s)（登录验证码等），只拦自定义协议。
    const guardNavigation = (event) => {
      const url = event && event.url
      if (!url) return
      const isMainFrame = event.isMainFrame !== false
      if (isMainFrame ? isDouyinUrl(url) : isAllowedFrameUrl(url)) return
      event.preventDefault()
      console.warn('[douyin bridge] blocked navigation:', url)
    }
    wc.on('will-navigate', guardNavigation)
    wc.on('will-redirect', guardNavigation)
    wc.on('will-frame-navigate', guardNavigation)
    wc.on('did-fail-load', () => {
      /* 网络抖动时交给下一次 request 重试 */
    })
    await wc.loadURL(HOME_URL)
    for (let i = 0; i < 80; i++) {
      const ok = await wc.executeJavaScript('!!(window.axiosInstance && window.axiosInstance.request)').catch(() => false)
      if (ok) return true
      await sleep(500)
    }
    throw new Error('抖音辅助页面初始化超时，可能被风控拦截')
  }

  /**
   * 楼中楼接口被风控时返回 200 + 空 body，真正的信号是 x-vc-bdturing-parameters。
   * 页面里的 XHR 不会结束（一直等到 axios 超时），这里收到响应头就立刻让请求失败。
   */
  _watchChallenges() {
    if (this._challengeWatch) return
    this._challengeWatch = true
    this.session.webRequest.onHeadersReceived(
      { urls: ['*://*.douyin.com/aweme/v1/web/*'] },
      (details, callback) => {
        const headers = details.responseHeaders || {}
        const key = Object.keys(headers).find((k) => k.toLowerCase() === 'x-vc-bdturing-parameters')
        if (key && this._challengeWaiters.size) {
          let path = ''
          try { path = new URL(details.url).pathname } catch (_) {}
          const err = new Error('抖音要求人机验证（接口被风控）')
          err.code = 'BDTURING'
          for (const waiter of [...this._challengeWaiters]) {
            if (waiter.path !== path) continue
            this._challengeWaiters.delete(waiter)
            clearTimeout(waiter.timer)
            waiter.reject(err)
          }
        }
        callback({})
      },
    )
  }

  async request({ method = 'GET', url, params = {}, data = null }) {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const win = await this.ensure()
        if (win.webContents.isLoading()) await sleep(800)
        const path = (() => {
          try { return new URL(url, 'https://www.douyin.com').pathname } catch (_) { return String(url) }
        })()
        const script = `(async () => {
          try {
            const config = {
              method: ${JSON.stringify(method)},
              url: ${JSON.stringify(url)},
              params: ${JSON.stringify(params || {})},
              withCredentials: true,
              timeout: ${REQUEST_TIMEOUT},
            }
            if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
              config.signal = AbortSignal.timeout(${REQUEST_TIMEOUT})
            }
            const raw = ${JSON.stringify(data)}
            if (raw) {
              config.data = new URLSearchParams(Object.fromEntries(
                Object.entries(raw).map(([k, v]) => [k, String(v)])
              )).toString()
              config.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
            const r = await window.axiosInstance.request(config)
            return { ok: true, status: r.status, data: r.data }
          } catch (e) {
            // 抖音自带的 axios 超时抛的是 CanceledError：__CANCEL__ 为 true，message 就是 "canceled"，没有 code。
            const cancelled = e && (
              e.code === 'ERR_CANCELED' ||
              e.code === 'ECONNABORTED' ||
              e.__CANCEL__ === true ||
              /^canceled$/i.test(String(e.message || ''))
            )
            return {
              ok: false,
              code: cancelled ? 'ETIMEDOUT' : undefined,
              status: (e && e.response && e.response.status) || 0,
              message: cancelled ? '请求超时（抖音接口没有响应）' : (e && (e.message || String(e))) || '请求失败',
              data: e && e.response ? e.response.data : null,
            }
          }
        })()`
        let timer = null
        let waiter = null
        // 风控挑战可能在 axios 超时前几秒就返回响应头，等到它就不必干等 15 秒。
        const challenged = new Promise((_, reject) => {
          waiter = { path, at: Date.now(), reject, timer: null }
          waiter.timer = setTimeout(() => this._challengeWaiters.delete(waiter), REQUEST_TIMEOUT + 2000)
          this._challengeWaiters.add(waiter)
        })
        try {
          return await Promise.race([
            win.webContents.executeJavaScript(script, true),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const err = new Error('抖音接口超时（15 秒）')
                err.code = 'ETIMEDOUT'
                reject(err)
              }, REQUEST_TIMEOUT + 1000)
            }),
            challenged,
          ])
        } finally {
          clearTimeout(timer)
          if (waiter) {
            clearTimeout(waiter.timer)
            this._challengeWaiters.delete(waiter)
          }
        }
      } catch (e) {
        if (e && (e.code === 'ETIMEDOUT' || e.code === 'BDTURING')) throw e
        lastError = e
        this.ready = null
        // 登录窗口可见时用户可能正在跳转/扫码，别强行 reload 把人踢回首页。
        if (this.win && !this.win.isDestroyed() && !this.win.isVisible()) {
          this.win.webContents.loadURL(HOME_URL).catch(() => {})
        }
        await sleep(500)
      }
    }
    throw new Error(lastError?.message || '抖音签名代理不可用')
  }

  async logout() {
    try {
      await this.session.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers'],
      })
      await this.session.clearCache()
    } finally {
      // 销毁签名页，下次请求会用干净分区重新加载抖音。
      this.destroy()
    }
    return { ok: true }
  }

  async isLoggedIn() {
    try {
      const cookies = await this.session.cookies.get({})
      const names = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'])
      return cookies.some((c) => names.has(c.name) && !!c.value && /(^|\.)douyin\.com$/i.test(c.domain || ''))
    } catch (_) {
      return false
    }
  }

  async showLogin() {
    const win = await this.ensure()
    win.setBounds({ x: 120, y: 80, width: 980, height: 760 })
    win.setTitle('抖音登录（登录完成后关闭本窗口）')
    win.show()
    win.focus()
    return { ok: true }
  }

  /**
   * 接口触发 bdturing 后，抖音脚本会在当前页面弹出官方验证码。
   * 这里只把隐藏窗口亮出来让用户自己完成验证，不做任何自动识别。
   */
  async showVerify() {
    const win = await this.ensure()
    win.setSkipTaskbar(false)
    win.setBounds({ x: 140, y: 90, width: 960, height: 740 })
    win.setTitle('抖音人机验证（完成后回到小窗点重试）')
    win.show()
    win.focus()
    const rendered = await this._renderChallenge().catch((e) => ({ error: e && e.message }))
    console.warn('[douyin bridge] verify render:', JSON.stringify(rendered))
    return { ok: true }
  }

  /**
   * 风控响应头先于页面脚本到达，验证码参数可能晚几百毫秒才写进页面 SDK。
   * 等参数就绪后调用抖音自己的 verifyCenter.autoRender 把官方验证码渲染出来。
   */
  async _renderChallenge() {
    if (!this.win || this.win.isDestroyed()) return null
    return this.win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms))
        // 给页面 SDK 一点时间把刚收到的风控参数写入运行时，避免拿到上一次挑战。
        await wait(500)
        let seen = false
        for (let i = 0; i < 24; i++) {
          if (window.__vc_is_render__) return { rendered: true, already: true }
          const rt = window.__VERIFY_CENTER_RUNTIME__
          const vd = rt && rt.myOptions && rt.myOptions.verify_data
          if (vd && window.verifyCenter && window.verifyCenter.autoRender) {
            seen = true
            const o = (rt.myOptions && rt.myOptions.options) || {}
            try {
              window.verifyCenter.autoRender({
                verify_data: vd,
                commonOptions: o.commonOptions,
                captchaOptions: o.captchaOptions,
              })
            } catch (e) {
              return { rendered: false, error: String((e && e.message) || e) }
            }
            await wait(800)
            return { rendered: !!window.__vc_is_render__, subtype: vd.subtype || '' }
          }
          await wait(250)
        }
        return { rendered: false, pending: true, seen }
      })()`,
      true,
    )
  }

  async hideVerify() {
    if (this.win && !this.win.isDestroyed()) {
      // 关掉验证码遮罩，避免下次打开时还挂着上一次的旧题。
      await this.win.webContents
        .executeJavaScript(
          'try { if (window.verifyCenter && window.verifyCenter.closeCaptcha) window.verifyCenter.closeCaptcha() } catch (_) {}',
          true,
        )
        .catch(() => {})
    }
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.hide()
      this.win.setSkipTaskbar(true)
    }
    return { ok: true }
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.ready = null
  }
}

module.exports = { DouyinBridge, HOME_URL }
