'use strict'

/**
 * B站 Web API 客户端（主进程用）。
 * 通过 Electron persist:moyu_bili session 发请求，cookie 直接复用网页端登录态。
 */

const { signWbi } = require('./wbi')

const API = 'https://api.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const AUTH_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

class BiliClient {
  constructor(session) {
    this.ses = session
    this.wbiCache = null
    this.wbiAt = 0
  }

  headers() {
    return {
      'User-Agent': UA,
      Referer: REFERER,
      Origin: 'https://www.bilibili.com',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }
  }

  async request(url, { method = 'GET', params, form } = {}) {
    let full = url
    if (params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      }
      const s = qs.toString()
      if (s) full += (url.includes('?') ? '&' : '?') + s
    }

    const hdrs = this.headers()
    let body
    if (form) {
      body = new URLSearchParams(form).toString()
      hdrs['Content-Type'] = 'application/x-www-form-urlencoded;charset=utf-8'
    }

    const res = await this.ses.fetch(full, {
      method,
      headers: hdrs,
      body,
      credentials: 'include',
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`)
    try {
      return JSON.parse(text)
    } catch (_) {
      throw new Error(`响应非 JSON: ${text.slice(0, 160)}`)
    }
  }

  get(url, params) {
    return this.request(url, { params })
  }

  post(url, form) {
    return this.request(url, { method: 'POST', form })
  }

  // ── WBI ───────────────────────────────────────────────────
  async wbiKeys() {
    if (this.wbiCache && Date.now() - this.wbiAt < 6 * 3600_000) return this.wbiCache
    const j = await this.get(`${API}/x/web-interface/nav`)
    const img = j?.data?.wbi_img?.img_url || ''
    const sub = j?.data?.wbi_img?.sub_url || ''
    const pick = (u) => String(u).slice(String(u).lastIndexOf('/') + 1).split('.')[0]
    if (!pick(img) || !pick(sub)) throw new Error('获取 WBI 密钥失败')
    this.wbiCache = { img: pick(img), sub: pick(sub) }
    this.wbiAt = Date.now()
    return this.wbiCache
  }

  async signedUrl(path, params) {
    const { img, sub } = await this.wbiKeys()
    return `${API}${path}?${signWbi(params, img, sub)}`
  }

  // ── 登录态 ────────────────────────────────────────────────
  async nav() {
    return this.get(`${API}/x/web-interface/nav`)
  }

  async getCookie(name) {
    if (!this.ses?.cookies) return ''
    const list = await this.ses.cookies.get({ name })
    return list[0]?.value || ''
  }

  async setCookies(cookies) {
    if (!this.ses?.cookies) return
    for (const c of cookies) {
      try {
        await this.ses.cookies.set(c)
      } catch (_) {}
    }
  }

  async clearAuthCookies() {
    if (!this.ses?.cookies) return
    const all = await this.ses.cookies.get({})
    for (const c of all) {
      if (!AUTH_COOKIES.includes(c.name)) continue
      const urls = [...new Set([c.url, 'https://www.bilibili.com', 'https://passport.bilibili.com', 'https://api.bilibili.com'].filter(Boolean))]
      for (const url of urls) {
        try {
          await this.ses.cookies.remove(url, c.name)
        } catch (_) {}
      }
    }
  }

  /** 新环境没有 buvid 时补一个，否则写操作容易被风控拒绝 */
  async ensureBuvid() {
    if (await this.getCookie('buvid3')) return
    const j = await this.get(`${API}/x/frontend/finger/spi`)
    if (j.code !== 0 || !j.data?.b_3) return
    const common = {
      url: 'https://www.bilibili.com',
      domain: '.bilibili.com',
      path: '/',
      secure: true,
      httpOnly: false,
      expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
    }
    const cookies = [{ ...common, name: 'buvid3', value: String(j.data.b_3) }]
    if (j.data.b_4) cookies.push({ ...common, name: 'buvid4', value: String(j.data.b_4) })
    await this.setCookies(cookies)
  }

  async startQrLogin() {
    const j = await this.get(`${PASSPORT}/x/passport-login/web/qrcode/generate`, {
      source: 'main-fe-header',
    })
    if (j.code !== 0 || !j.data?.url || !j.data?.qrcode_key) {
      throw new Error(j.message || '获取登录二维码失败')
    }
    return { url: j.data.url, key: j.data.qrcode_key, expiresAt: Date.now() + 180_000 }
  }

  async pollQrLogin(key) {
    const j = await this.get(`${PASSPORT}/x/passport-login/web/qrcode/poll`, {
      qrcode_key: key,
      source: 'main-fe-header',
    })
    if (j.code !== 0) throw new Error(j.message || '登录状态查询失败')
    return j.data || {}
  }

  // ── feed / 视频 ───────────────────────────────────────────
  async recommend(freshIdx = 1) {
    const url = await this.signedUrl('/x/web-interface/wbi/index/top/feed/rcmd', {
      ps: 12,
      fresh_type: 4,
      feed_version: 'V8',
      fresh_idx: freshIdx,
      fresh_idx_1h: freshIdx,
      brush: 0,
      homepage_ver: 1,
      y_num: 5,
      web_location: 1430650,
    })
    return this.get(url)
  }

  async popular(pn = 1, ps = 20) {
    return this.get(`${API}/x/web-interface/popular`, { pn, ps })
  }

  async search(keyword, pn = 1) {
    const url = await this.signedUrl('/x/web-interface/wbi/search/type', {
      search_type: 'video',
      keyword,
      page: pn,
      page_size: 30,
    })
    return this.get(url)
  }

  async view(bvid) {
    return this.get(`${API}/x/web-interface/view`, { bvid })
  }

  async relation(bvid) {
    return this.get(`${API}/x/web-interface/archive/relation`, { bvid })
  }

  async playurl(bvid, cid, qn = 80) {
    const url = await this.signedUrl('/x/player/wbi/playurl', {
      bvid,
      cid,
      qn,
      fnval: 0,
      fnver: 0,
      fourk: 1,
      platform: 'html5',
      high_quality: 1,
    })
    return this.get(url)
  }

  // ── 评论 ──────────────────────────────────────────────────
  async comments(aid, pn = 1, ps = 20) {
    return this.get(`${API}/x/v2/reply`, {
      type: 1,
      oid: aid,
      pn,
      ps,
      sort: 2,
    })
  }

  async subReplies(aid, root, pn = 1, ps = 10) {
    return this.get(`${API}/x/v2/reply/reply`, {
      type: 1,
      oid: aid,
      root,
      pn,
      ps,
    })
  }

  async likeReply(aid, rpid, on) {
    const csrf = await this.getCookie('bili_jct')
    if (!csrf) throw new Error('请先登录')
    return this.post(`${API}/x/v2/reply/action`, {
      oid: aid,
      type: 1,
      rpid,
      action: on ? 1 : 0,
      csrf,
    })
  }

  // ── 点赞 / 收藏 ───────────────────────────────────────────
  async like(bvid, on) {
    const csrf = await this.getCookie('bili_jct')
    if (!csrf) throw new Error('请先登录')
    return this.post(`${API}/x/web-interface/archive/like`, {
      bvid,
      like: on ? 1 : 2,
      csrf,
    })
  }

  async favFolders(mid, rid) {
    const params = { up_mid: mid, type: 2 }
    if (rid) params.rid = rid
    return this.get(`${API}/x/v3/fav/folder/created/list-all`, params)
  }

  async favList(mediaId, pn = 1, ps = 20) {
    return this.get(`${API}/x/v3/fav/resource/list`, {
      media_id: mediaId,
      pn,
      ps,
      order: 'mtime',
      type: 0,
      tid: 0,
      platform: 'web',
    })
  }

  async favDeal(aid, addIds = [], delIds = []) {
    const csrf = await this.getCookie('bili_jct')
    if (!csrf) throw new Error('请先登录')
    return this.post(`${API}/x/v3/fav/resource/deal`, {
      rid: aid,
      type: 2,
      add_media_ids: addIds.join(','),
      del_media_ids: delIds.join(','),
      csrf,
    })
  }
}

module.exports = { BiliClient, API, PASSPORT }
