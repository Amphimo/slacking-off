'use strict'

/**
 * B站业务层：feed/详情/播放/评论/点赞/收藏。
 * 登录态不落自己的配置文件 —— 直接复用 persist:moyu_bili 的网页登录 cookie。
 */

const { BiliClient } = require('./client')

const QUALITY = {
  127: '8K', 126: '杜比视界', 125: 'HDR', 120: '4K', 116: '1080P60',
  112: '1080P+', 80: '1080P', 74: '720P60', 64: '720P', 32: '480P', 16: '360P',
}

function https(u) {
  const s = String(u || '')
  if (s.startsWith('//')) return `https:${s}`
  return s.replace(/^http:\/\//i, 'https://')
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e9 ? 0 : 1)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(v >= 1e5 ? 0 : 1)}万`
  return String(v)
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

function fmtTime(ts) {
  const t = Number(ts)
  if (!t) return ''
  const ms = t > 1e12 ? t : t * 1000
  const diff = (Date.now() - ms) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}天前`
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function renderComment(content) {
  let out = escHtml(content?.message || '')
  const emotes = content?.emote || {}
  for (const [token, e] of Object.entries(emotes)) {
    if (!e || !e.url) continue
    const img = `<img class="emote" referrerpolicy="no-referrer" src="${escHtml(https(e.url))}" alt="${escHtml(token)}">`
    out = out.split(escHtml(token)).join(img)
  }
  return out.replace(/\n/g, '<br>')
}

function mapReply(r) {
  const member = r.member || {}
  return {
    id: String(r.rpid || ''),
    name: member.uname || '用户',
    avatar: https(member.avatar),
    level: Number(member.level_info?.current_level || 0),
    time: fmtTime(r.ctime),
    like: Number(r.like || 0),
    liked: Number(r.action) === 1,
    text: renderComment(r.content),
    subCount: Number(r.rcount || 0),
    subs: (r.replies || []).map(mapReply),
  }
}

function mapCommentPage(j) {
  const data = j.data || {}
  const page = data.page || {}
  const items = (data.replies || []).map(mapReply)
  const total = Number(page.count || 0)
  const pn = Number(page.num || 1)
  const ps = Number(page.size || 20)
  return { items, total, page: pn, size: ps, hasMore: pn * ps < total }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '')
}

function parseSeconds(value) {
  if (typeof value === 'number') return Math.max(0, value)
  const parts = String(value || '').split(':').map(Number)
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function mapCard(x) {
  const owner = x.owner || x.upper || {}
  const stat = x.stat || x.cnt_info || {}
  const views = Number(stat.view || stat.play || x.play || 0)
  const danmaku = Number(stat.danmaku || x.dm || 0)
  const seconds = parseSeconds(x.duration)
  return {
    bvid: String(x.bvid || ''),
    title: stripHtml(x.title).trim(),
    cover: https(x.pic || x.cover),
    owner: owner.name || owner.uname || x.author || '',
    ownerFace: https(owner.face || owner.avatar),
    ownerMid: String(owner.mid || x.mid || ''),
    duration: seconds,
    durationText: x.durationText || fmtDuration(seconds),
    views,
    viewsText: fmtCount(views),
    danmaku,
    danmakuText: fmtCount(danmaku),
    comments: Number(stat.reply || stat.comment || x.reply || 0),
    commentsText: fmtCount(stat.reply || stat.comment || x.reply || 0),
    time: fmtTime(x.pubdate || x.pubtime || x.ctime),
    url: x.bvid ? `https://www.bilibili.com/video/${x.bvid}` : '',
  }
}

function mapPlay(j) {
  if (!j || j.code !== 0 || !j.data) return null
  const d = j.data
  const segments = (d.durl || []).map((x) => https(x.url)).filter(Boolean)
  if (!segments.length) return null
  return {
    quality: Number(d.quality || 0),
    qualityText: QUALITY[d.quality] || `${d.quality}P`,
    accept: d.accept_description || [],
    segments,
  }
}

function mapFolders(j) {
  const list = (j && j.code === 0 && j.data && j.data.list) || []
  return list.map((f, i) => {
    const name = f.title || f.name || '收藏夹'
    return {
      id: String(f.id ?? f.fid ?? ''),
      name,
      count: Number(f.media_count ?? f.count ?? 0),
      isDefault: name === '默认收藏夹' || i === 0,
      favState: Number(f.fav_state || 0) === 1,
    }
  }).filter((f) => f.id)
}

function pickRawQuery(url, key) {
  const q = String(url || '').split('?')[1]?.split('#')[0] || ''
  for (const part of q.split('&')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i) === key) return part.slice(i + 1)
  }
  return ''
}

function loginCookies(url) {
  const out = []
  for (const name of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
    const value = pickRawQuery(url, name)
    if (!value) continue
    out.push({
      url: 'https://www.bilibili.com',
      domain: '.bilibili.com',
      path: '/',
      name,
      value,
      secure: true,
      httpOnly: name === 'SESSDATA',
      expirationDate: Math.floor(Date.now() / 1000) + 180 * 86400,
    })
  }
  return out
}

class BiliService {
  constructor(session) {
    this.session = session
    this.client = new BiliClient(session)
    this.freshIdx = 0
    this.popularPage = 0
    this.seen = new Set()
    this.seenQueue = []
    this.mid = ''
    this.nickname = ''
  }

  // ── 登录 ──────────────────────────────────────────────────
  async me() {
    try {
      const j = await this.client.nav()
      if (j.code === 0 && j.data?.isLogin) {
        this.mid = String(j.data.mid || '')
        this.nickname = j.data.uname || ''
        return {
          loggedIn: true,
          mid: this.mid,
          nickname: this.nickname,
          avatar: https(j.data.face),
          level: Number(j.data.level_info?.current_level || 0),
          vip: !!j.data.vipStatus,
        }
      }
    } catch (_) {
      /* 网络问题时按未登录处理，不阻断 feed */
    }
    this.mid = ''
    this.nickname = ''
    return { loggedIn: false }
  }

  async loginStart() {
    return this.client.startQrLogin()
  }

  async loginPoll(session) {
    if (!session || Date.now() > session.expiresAt) return { state: 'expired', remainingSeconds: 0 }
    const d = await this.client.pollQrLogin(session.key)
    const remainingSeconds = Math.max(0, Math.ceil((session.expiresAt - Date.now()) / 1000))
    const code = Number(d.code)

    if (code === 0) {
      const cookies = loginCookies(d.url)
      if (cookies.length) await this.client.setCookies(cookies)
      await this.client.ensureBuvid().catch(() => {})
      const me = await this.me()
      return { state: 'success', message: '登录成功', me, remainingSeconds }
    }
    if (code === 86090) return { state: 'scanned', message: '已扫码，请在手机上确认', remainingSeconds }
    if (code === 86101) return { state: 'waiting', message: '请使用 B站 App 扫码', remainingSeconds }
    if (code === 86038) return { state: 'expired', message: '二维码已过期', remainingSeconds: 0 }
    return { state: 'failed', message: d.message || '登录失败', remainingSeconds }
  }

  async logout() {
    await this.client.clearAuthCookies()
    this.mid = ''
    this.nickname = ''
    return { loggedIn: false }
  }

  // ── feed ──────────────────────────────────────────────────
  remember(card) {
    if (!card.bvid || this.seen.has(card.bvid)) return false
    this.seen.add(card.bvid)
    this.seenQueue.push(card.bvid)
    if (this.seenQueue.length > 600) this.seen.delete(this.seenQueue.shift())
    return true
  }

  async feed(refresh = false) {
    if (refresh) {
      this.freshIdx = 0
      this.popularPage = 0
      this.seen.clear()
      this.seenQueue = []
    }

    const collected = []
    let guard = 0

    while (collected.length < 12 && guard < 4) {
      guard++
      let raw = []

      this.freshIdx++
      try {
        const j = await this.client.recommend(this.freshIdx)
        if (j.code === 0) raw = (j.data?.item || []).filter((x) => x.goto === 'av' && x.bvid)
      } catch (_) {
        /* 推荐失败走热门兜底 */
      }

      if (!raw.length) {
        this.popularPage++
        try {
          const j = await this.client.popular(this.popularPage, 20)
          if (j.code === 0) raw = j.data?.list || []
        } catch (_) {}
      }

      for (const x of raw) {
        const card = mapCard(x)
        if (this.remember(card)) collected.push(card)
      }

      if (!raw.length) break
    }

    return { cards: collected.slice(0, 20), hasMore: collected.length > 0 }
  }

  async search(keyword, pn = 1) {
    const kw = String(keyword || '').trim()
    if (!kw) return { cards: [], hasMore: false }
    const j = await this.client.search(kw, pn)
    if (j.code !== 0) throw new Error(j.message || '搜索失败')
    const data = j.data || {}
    const cards = (data.result || []).filter((x) => x && x.bvid && x.type === 'video').map(mapCard)
    const numPages = Number(data.numPages || 0)
    return {
      cards,
      keyword: kw,
      total: Number(data.numResults || 0),
      hasMore: numPages ? pn < numPages : cards.length >= 20,
    }
  }

  // ── 详情 / 播放 ───────────────────────────────────────────
  async detail(bvid) {
    const v = await this.client.view(bvid)
    if (v.code !== 0 || !v.data) throw new Error(v.message || '视频不存在')
    const d = v.data
    const aid = d.aid
    const firstCid = d.pages?.[0]?.cid || d.cid

    const [cmt, rel, play] = await Promise.all([
      this.client.comments(aid, 1, 20).catch(() => null),
      this.client.relation(bvid).catch(() => null),
      this.client.playurl(bvid, firstCid).catch(() => null),
    ])

    const commentPage = cmt && cmt.code === 0 ? mapCommentPage(cmt) : { items: [], total: 0, page: 1, size: 20, hasMore: false }
    const relation = rel && rel.code === 0 ? rel.data || {} : {}

    return {
      bvid: d.bvid,
      aid,
      title: d.title,
      cover: https(d.pic),
      desc: String(d.desc || ''),
      url: `https://www.bilibili.com/video/${d.bvid}`,
      owner: d.owner?.name || '',
      ownerFace: https(d.owner?.face),
      ownerMid: String(d.owner?.mid || ''),
      pubdate: fmtTime(d.pubdate),
      duration: fmtDuration(d.duration),
      stat: {
        view: Number(d.stat?.view || 0),
        viewText: fmtCount(d.stat?.view),
        danmaku: Number(d.stat?.danmaku || 0),
        danmakuText: fmtCount(d.stat?.danmaku),
        reply: Number(d.stat?.reply || 0),
        replyText: fmtCount(d.stat?.reply),
        like: Number(d.stat?.like || 0),
        likeText: fmtCount(d.stat?.like),
        coin: Number(d.stat?.coin || 0),
        coinText: fmtCount(d.stat?.coin),
        favorite: Number(d.stat?.favorite || 0),
        favoriteText: fmtCount(d.stat?.favorite),
      },
      liked: !!relation.like,
      faved: !!relation.favorite,
      coin: Number(relation.coin || 0),
      pages: (d.pages || []).map((p) => ({
        cid: p.cid,
        page: p.page,
        part: p.part || '',
        duration: p.duration,
        durationText: fmtDuration(p.duration),
      })),
      play: mapPlay(play),
      comments: commentPage.items,
      commentTotal: Number(d.stat?.reply || commentPage.total || 0),
      commentsPage: 1,
      commentsHasMore: commentPage.hasMore,
    }
  }

  async play(bvid, cid) {
    const j = await this.client.playurl(bvid, cid)
    const play = mapPlay(j)
    if (!play) throw new Error(j.message || '取播放地址失败')
    return play
  }

  // ── 评论 ──────────────────────────────────────────────────
  async comments(aid, pn = 1) {
    const j = await this.client.comments(aid, pn, 20)
    if (j.code !== 0) throw new Error(j.message || '评论加载失败')
    return mapCommentPage(j)
  }

  async subComments(aid, root, pn = 1) {
    const j = await this.client.subReplies(aid, root, pn, 10)
    if (j.code !== 0) throw new Error(j.message || '回复加载失败')
    return mapCommentPage(j)
  }

  async likeComment(aid, rpid, on) {
    const j = await this.client.likeReply(aid, rpid, on)
    if (j.code !== 0) throw new Error(j.message || '操作失败')
    return { ok: true }
  }

  // ── 点赞 / 收藏 ───────────────────────────────────────────
  async like(bvid, on) {
    const j = await this.client.like(bvid, on)
    if (j.code !== 0) throw new Error(j.message || (on ? '点赞失败' : '取消点赞失败'))
    return { ok: true }
  }

  async favFolders() {
    const me = await this.me()
    if (!me.loggedIn) throw new Error('请先登录')
    const j = await this.client.favFolders(this.mid)
    if (j.code !== 0) throw new Error(j.message || '收藏夹获取失败')
    return { folders: mapFolders(j) }
  }

  async favFoldersFor(aid) {
    const j = await this.client.favFolders(this.mid, aid)
    if (j.code !== 0) throw new Error(j.message || '收藏夹获取失败')
    return mapFolders(j)
  }

  async favourite(bvid, aid, on) {
    const me = await this.me()
    if (!me.loggedIn) throw new Error('请先登录')
    const folders = await this.favFoldersFor(aid)
    if (!folders.length) throw new Error('没有可用收藏夹')

    if (on) {
      if (folders.some((f) => f.favState)) return { ok: true }
      const target = folders.find((f) => f.isDefault) || folders[0]
      const j = await this.client.favDeal(aid, [target.id], [])
      if (j.code !== 0) throw new Error(j.message || '收藏失败')
    } else {
      let ids = folders.filter((f) => f.favState).map((f) => f.id)
      if (!ids.length) {
        const target = folders.find((f) => f.isDefault) || folders[0]
        ids = [target.id]
      }
      const j = await this.client.favDeal(aid, [], ids)
      if (j.code !== 0) throw new Error(j.message || '取消收藏失败')
    }
    return { ok: true }
  }

  async favourites(folderId) {
    if (!folderId) {
      const { folders } = await this.favFolders()
      folderId = folders[0]?.id || ''
      if (!folderId) return { cards: [], folderName: '' }
    }
    const j = await this.client.favList(folderId)
    if (j.code !== 0) throw new Error(j.message || '收藏内容获取失败')
    const medias = j.data?.medias || []
    const cards = medias
      .filter((m) => m && m.bvid && !(Number(m.attr || 0) & 1))
      .map((m) => mapCard({ ...m, stat: m.cnt_info }))
    return { cards, folderName: j.data?.info?.title || '' }
  }
}

module.exports = { BiliService, mapCard, fmtCount, fmtDuration, fmtTime }
