'use strict'

/**
 * 小黑盒 API 客户端（Electron 主进程用）
 * 协议来源：WenfuRainbow/heybox (MIT)。Cookie 可空（匿名态看官方是否放行）。
 */

const https = require('node:https')
const { generateSignature } = require('./sign')

const API_BASE = 'https://api.xiaoheihe.cn'
const REFERER = 'https://www.xiaoheihe.cn/'

function makeClient({ cookie = '', deviceId = '', heyboxId = '' } = {}) {
  if (!deviceId) {
    const h = '0123456789abcdef'
    for (let i = 0; i < 32; i++) deviceId += h[Math.floor(Math.random() * 16)]
  }

  // 匿名请求（二维码登录）用的独立参数与 Cookie 池
  const anonCookies = {}
  const qrParams = () => ({
    ...commonParams(),
    app: 'web',
    heybox_id: '',
    _notip: 'true',
  })

  function mergeSetCookie(res) {
    const raw = res.headers['set-cookie']
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    for (const line of list) {
      const m = /^\s*([^=;\s]+)=([^;]*)/.exec(line)
      if (m) anonCookies[m[1]] = m[2]
    }
  }

  function anonCookieHeader() {
    return Object.entries(anonCookies).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  function commonParams() {
    return {
      os_type: 'web', app: 'heybox', client_type: 'web', version: '999.0.4',
      x_client_type: 'web', x_app: 'heybox_website',
      heybox_id: heyboxId, x_os_type: 'Windows', device_info: 'Chrome',
      device_id: deviceId,
    }
  }

  function buildUrl(path, extraParams = {}) {
    const sig = generateSignature(path)
    const params = {
      ...commonParams(),
      hkey: sig.hkey,
      _time: String(sig._time),
      nonce: sig.nonce,
      ...extraParams,
    }
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    return `${API_BASE}${path}?${qs}`
  }

  function headers() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: REFERER,
      Origin: 'https://www.xiaoheihe.cn',
      Cookie: cookie,
    }
  }

  function anonHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: REFERER,
      Origin: 'https://www.xiaoheihe.cn',
      Cookie: anonCookieHeader(),
    }
  }

  function rawGet(url, hdrs, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: hdrs }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve({ json: JSON.parse(data), res })
          } catch (_) {
            reject(new Error(`响应非 JSON: ${data.slice(0, 160)}`))
          }
        })
        res.on('error', reject)
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error('请求超时'))
      })
      req.on('error', reject)
    })
  }

  function get(path, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const req = https.get(buildUrl(path, params), { headers: headers() }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch (_) {
            reject(new Error(`响应非 JSON: ${data.slice(0, 200)}`))
          }
        })
        res.on('error', reject)
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error('请求超时'))
      })
      req.on('error', reject)
    })
  }

  /** 写操作：POST + form body（签名只对 path，与 heybox 插件一致） */
  function post(path, body = {}, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const bodyString = Object.entries(body)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
      const hdrs = {
        ...headers(),
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Content-Length': Buffer.byteLength(bodyString),
      }
      const req = https.request(buildUrl(path, params), { method: 'POST', headers: hdrs }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`))
            return
          }
          try {
            resolve(JSON.parse(data))
          } catch (_) {
            reject(new Error(`响应非 JSON: ${data.slice(0, 200)}`))
          }
        })
        res.on('error', reject)
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        reject(new Error('请求超时'))
      })
      req.on('error', reject)
      req.write(bodyString)
      req.end()
    })
  }

  return {
    get,
    post,
    setCookie: (c) => { cookie = c },
    getCookie: () => cookie,
    getDeviceId: () => deviceId,

    /** 创建扫码登录会话：返回二维码内容（xiaoheihe://...）与过期时间 */
    async startQrLogin() {
      const { json, res } = await rawGet(buildUrl('/account/get_qrcode_url/', qrParams()), anonHeaders())
      mergeSetCookie(res)
      if (json.status !== 'ok') throw new Error(json.msg || `获取二维码失败: ${json.status}`)
      const r = json.result || {}
      const qrContent = String(r.qr_url || r.qrcode || r.url || '')
      if (!qrContent) throw new Error('二维码响应缺少内容')
      let pollParams = {}
      try {
        pollParams = Object.fromEntries(new URL(qrContent).searchParams.entries())
      } catch (_) {
        throw new Error('二维码内容格式无效')
      }
      const rawExp = Number(r.expire ?? r.expires_in ?? 120)
      const ttl = Number.isFinite(rawExp)
        ? Math.max(10, Math.min(rawExp > 1e10 ? (rawExp - Date.now()) / 1000 : rawExp, 600))
        : 120
      return { qrContent, expiresAt: Date.now() + ttl * 1000, pollParams }
    },

    /** 轮询扫码状态。state: waiting | scanned | success | expired | failed */
    async pollQrLogin(session) {
      const remaining = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000))
      if (remaining === 0) return { state: 'expired', message: '二维码已过期', remainingSeconds: 0 }
      const { json, res } = await rawGet(buildUrl('/account/qr_state/', session.pollParams), anonHeaders())
      mergeSetCookie(res)
      const result = (json.result && typeof json.result === 'object') ? json.result : {}
      const message = String(result.error_msg || result.message || result.msg || json.msg || '')
      const marker = String(result.error || result.err || result.state || result.status || '').trim().toLowerCase()

      if (['ok', 'success', 'confirmed', '2'].includes(marker)) {
        const flat = (obj) => {
          for (const src of [obj, obj.user, obj.account, obj.profile]) {
            if (!src || typeof src !== 'object') continue
            for (const key of ['heybox_id', 'user_heybox_id', 'userid', 'uid']) {
              if (src[key] != null && String(src[key])) return String(src[key])
            }
          }
          return ''
        }
        const cookieHeader = Object.entries(anonCookies).map(([k, v]) => `${k}=${v}`).join('; ')
        // 优先从 Cookie 里取真实 ID（result 里常常没有），比空值可靠
        const cookieId = (/(?:user_heybox_id|heybox_id)=(\d+)/.exec(cookieHeader) || [])[1] || ''
        const userId = flat(result) || cookieId
        if (userId && !anonCookies.heybox_id) anonCookies.heybox_id = userId
        const nickname = String(result.nickname || (result.user && result.user.nickname) || '')
        return {
          state: 'success', message: '登录成功', remainingSeconds: remaining,
          cookie: cookieHeader, nickname, heyboxId: userId,
        }
      }
      if (['scanned', 'ready', 'confirm', '1'].includes(marker)) {
        return { state: 'scanned', message: message || '已扫码，请在手机上确认', remainingSeconds: remaining }
      }
      if (['expired', 'timeout', '3'].includes(marker) || /过期|失效|超时/i.test(message)) {
        return { state: 'expired', message: message || '二维码已过期', remainingSeconds: 0 }
      }
      if (['failed', 'error', '-1'].includes(marker)) {
        return { state: 'failed', message: message || '扫码登录失败', remainingSeconds: remaining }
      }
      return { state: 'waiting', message: message || '请使用小黑盒 App 扫码', remainingSeconds: remaining }
    },

    /** 帖子树：正文 + 评论（需登录态） */
    postTree(linkId, offset = 0, limit = 20) {
      return get('/bbs/app/link/tree', { link_id: linkId, offset: String(offset), limit: String(limit) })
    },

    /** 收藏夹列表（需登录态） */
    favouriteFolders() {
      return get('/bbs/app/profile/fav/folders', {})
    },

    /** 指定收藏夹的帖子（需登录态，folder_id 必填） */
    favouriteLinks(folderId, offset = 0, limit = 30) {
      return get('/bbs/app/profile/fav/folder/v2/links', {
        folder_id: String(folderId),
        enable_new_style_collect: '1',
        dw: '800',
        offset: String(offset),
        limit: String(limit),
      })
    },

    /** 消息中心（需登录态） */
    messages(offset = 0, limit = 20) {
      return get('/bbs/app/user/message', {
        list_type: '0', offset: String(offset), limit: String(limit), no_more: 'false',
      })
    },
  }
}

/** 推荐动态 feed（未登录可能返回本地混排或要求登录，实测见分晓） */
function unwrap(payload, what = '接口') {
  if (!payload || typeof payload !== 'object') throw new Error(`${what}返回异常`)
  if (payload.status !== 'ok') {
    const err = new Error(`${what}失败: [${payload.status}] ${payload.msg || ''}`)
    err.status = payload.status
    err.showLogin = payload.status === 'show_captcha' || /login|relogin/i.test(String(payload.status))
    throw err
  }
  return payload.result
}

module.exports = { makeClient, unwrap, API_BASE }
