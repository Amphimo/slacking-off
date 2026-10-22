'use strict'

/**
 * 小黑盒 feed 服务 v2：
 * 主源（推荐 feed）+ 板块轮换补充 + 全局 linkid 去重。
 *
 * 背景：推荐 feed 是动态队列，绝对 offset 在时间推移后会与已看内容错位（用户实测重复）。
 * 策略：offset 仍推进主源，但所有卡片过 seen 集合；凑不满一页就从热门板块轮换补内容，
 * 板块多（67+）内容多样性足够，每板块独立 offset。
 */

const fs = require('node:fs')
const path = require('node:path')
const { makeClient, unwrap } = require('./client')

const SEEN_MAX = 900
const TOPIC_PAGE = 20
const MIN_PAGE = 6

/** 受限 HTML 清洗：只留白名单标签与 http(s) 图片 */
function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return ''
  return String(html)
    .replace(/<\s*(script|style|iframe|object|embed|form|template)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|template)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '$1="#"')
    .replace(/<img([^>]*)\ssrc\s*=\s*"([^"]*)"([^>]*)>/gi, (m, pre, src, post) =>
      /^https?:\/\//i.test(src) ? `<img${pre} src="${src}" loading="lazy"${post}>` : '',
    )
}

/**
 * 富文本渲染：小黑盒的正文/评论有三种形态，统一转安全 HTML。
 * 1) JSON 块数组 [{"type":"text","text":...},{"type":"img","url":...}]（实测正文主形态）
 * 2) 纯 HTML
 * 3) 纯文本
 */
function escText(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function renderRich(input) {
  if (!input) return ''
  const raw = String(input).trim()

  const tryJson = raw.startsWith('[') || raw.startsWith('{')
  if (tryJson) {
    try {
      const blocks = JSON.parse(raw)
      if (Array.isArray(blocks)) {
        const out = []
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue
          if (b.type === 'text' && b.text) {
            out.push(`<p>${escText(b.text).replace(/\n/g, '<br>')}</p>`)
          } else if (b.type === 'img' && /^https?:\/\//.test(String(b.url || ''))) {
            out.push(`<img src="${escText(b.url)}" loading="lazy" alt="帖子图片" />`)
          }
        }
        return out.join('')
      }
      if (blocks && typeof blocks === 'object') return ''
    } catch (_) {
      /* 不是合法 JSON，走 HTML/文本分支 */
    }
  }
  if (/<[a-z][\s\S]*>/i.test(raw)) return sanitizeHtml(raw)
  return `<p>${escText(raw).replace(/\n/g, '<br>')}</p>`
}

function parseMaybeJson(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      return JSON.parse(value)
    } catch (_) {
      return []
    }
  }
  return []
}

function formatTime(createAt) {
  const t = Number(createAt)
  if (!t) return ''
  const ts = t > 1e12 ? t : t * 1000
  const diff = (Date.now() - ts) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}天前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${d.getDate()}`
}

function toCard(item) {
  const imgs = parseMaybeJson(item.imgs)
  const thumbs = parseMaybeJson(item.thumbs)
  const preview = (thumbs.length ? thumbs : imgs).filter(
    (u) => typeof u === 'string' && /^https?:\/\//.test(u),
  )
  return {
    linkid: String(item.linkid || ''),
    title: String(item.title || '').trim(),
    text: String(item.description || '').trim(),
    author: (item.user && (item.user.nickname || item.user.username)) || '',
    avatar: (item.user && item.user.avatar) || '',
    game: (item.game && item.game.name) || item.game_name || '',
    comments: Number(item.comment_num || 0),
    likes: Number(item.likes || item.link_award_num || item.award_num || item.up || 0),
    time: formatTime(item.create_at),
    url: item.share_url || '',
    images: preview.slice(0, 9),
  }
}

class XhhService {
  constructor(configDir) {
    this.configPath = path.join(configDir, 'xhh-config.json')
    this.client = null
    this.load()
    this.seen = new Set()
    this.seenQueue = []
    this.topics = []
    this.topicCursor = 0
    this.topicOffsets = new Map()
    this.topicsLoadedAt = 0
    this.mainMiss = 0
    this.mainPause = 0
    this.defaultFavFolderId = ''
  }

  load() {
    let saved = {}
    try {
      saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
    } catch (_) {
      /* 首次运行 */
    }
    // 兜底：旧版本存的 heyboxId 可能为空，从 cookie 里补齐
    const cookie = saved.cookie || ''
    const cookieId = (/(?:user_heybox_id|heybox_id)=(\d+)/.exec(cookie) || [])[1] || ''
    this.client = makeClient({
      deviceId: saved.deviceId,
      cookie,
      heyboxId: saved.heyboxId || cookieId,
    })
    this.deviceId = this.client.getDeviceId()
    this.heyboxId = saved.heyboxId || cookieId
    this.nickname = saved.nickname || ''
    // 登录态在磁盘上：xhh-config.json 与进程无关，npm 反复启动不掉登录
    if (!saved.deviceId || !saved.heyboxId) this.persist()
  }

  persist() {
    try {
      fs.writeFileSync(
        this.configPath,
        JSON.stringify({
          deviceId: this.deviceId,
          cookie: this.client.getCookie(),
          heyboxId: this.heyboxId || '',
          nickname: this.nickname || '',
        }),
      )
    } catch (_) {}
  }

  // ── 登录态 ────────────────────────────────────────────────
  me() {
    return { loggedIn: !!this.client.getCookie(), nickname: this.nickname || '', heyboxId: this.heyboxId || '' }
  }

  setLogin({ cookie, nickname, heyboxId }) {
    this.client.setCookie(cookie)
    this.heyboxId = heyboxId || ''
    this.nickname = nickname || ''
    this.defaultFavFolderId = ''
    this.persist()
    return this.me()
  }

  logout() {
    this.client.setCookie('')
    this.heyboxId = ''
    this.nickname = ''
    this.defaultFavFolderId = ''
    this.persist()
    return this.me()
  }

  /** 帖子详情：正文 + 评论组（需登录） */
  async detail(linkid) {
    const payload = await this.client.postTree(linkid, 0, 20)
    if (payload.status !== 'ok') {
      const err = new Error(payload.msg || `状态 ${payload.status}`)
      err.status = payload.status
      throw err
    }
    const tree = payload.result || {}
    const link = tree.link || {}
    const groups = (tree.comments || [])
      .map((g) => {
        const list = g.comment || []
        if (!list.length) return null
        const mk = (c) => ({
          id: String(c.commentid || ''),
          name: (c.user && (c.user.nickname || c.user.username)) || '盒友',
          avatar: (c.user && c.user.avatar) || '',
          floor: c.floor_num || '',
          replyTo: (c.replyuser && c.replyuser.username) || '',
          time: formatTime(c.create_at),
          ip: c.ip_location || '',
          up: Number(c.up || 0),
          liked: Number(c.is_support) === 1,
          text: renderRich(c.text || ''),
          imgs: (c.imgs || []).map((i) => i.url).filter(Boolean),
        })
        return {
          id: String(list[0].commentid || ''),
          main: mk(list[0]),
          subs: list.slice(1).map(mk),
          childNum: Number(list[0].child_num || 0),
          lastval: '',
        }
      })
      .filter(Boolean)
    return {
      linkid: String(linkid),
      title: String(link.title || '').trim(),
      author: (link.user && (link.user.nickname || link.user.username)) || '盒友',
      avatar: (link.user && link.user.avatar) || '',
      time: formatTime(link.create_at),
      game: (link.game && link.game.name) || '',
      topics: (link.topics || []).map((t) => t.name).filter(Boolean),
      html: renderRich(link.text || link.content || link.description || ''),
      comments: groups,
      commentNum: Number(link.comment_num || 0),
      hasMoreFloors: Number(tree.has_more_floors || 0),
      // 互动状态（link/tree 直接给出，无需额外请求）
      liked: Number(link.is_award_link) === 1,
      likedNum: Number(link.award_num || link.link_award_num || 0),
      faved: Number(link.is_favour) === 1,
      favCount: Number(link.favour_count || 0),
    }
  }

  /** 帖子点赞/取消：POST award/link，award_type 1=赞 0=取消（均实测通过） */
  async likePost(linkid, on = true) {
    const payload = await this.client.post(
      '/bbs/app/profile/award/link',
      { link_id: String(linkid), award_type: on ? '1' : '0' },
      { link_id: String(linkid) },
    )
    if (payload.status !== 'ok') throw new Error(payload.msg || '点赞失败')
    return { ok: true }
  }

  /**
   * 收藏/取消收藏：同一个端点 /bbs/app/link/favour。
   * 官方网页端 body 为 {favour_type: 1|2, link_id, userid, folder_id}，1=收藏 2=取消。
   * 收藏仍发最小的 link_id（已实测通过），取消补齐 favour_type/folder_id/userid。
   */
  async favouritePost(linkid, on = true) {
    const id = String(linkid)
    const body = { link_id: id }
    if (!on) {
      body.favour_type = '2'
      body.folder_id = await this.resolveDefaultFavFolderId()
      if (this.heyboxId) body.userid = String(this.heyboxId)
    }
    const payload = await this.client.post('/bbs/app/link/favour', body, { link_id: id })
    if (payload.status !== 'ok') throw new Error(payload.msg || (on ? '收藏失败' : '取消收藏失败'))
    return { ok: true }
  }

  /** 评论点赞/取消：POST comment/support，support_type 1=赞 0=取消（均实测通过） */
  async likeComment(commentId, on = true) {
    const payload = await this.client.post(
      '/bbs/app/comment/support',
      { comment_id: String(commentId), support_type: on ? '1' : '0' },
    )
    if (payload.status !== 'ok') throw new Error(payload.msg || '操作失败')
    return { ok: true }
  }

  /** 楼中楼子评论（需登录）：root_comment_id + lastval 游标 */
  async subComments(rootId, lastval = '') {
    const payload = await this.client.get('/bbs/app/comment/sub/comments', {
      root_comment_id: String(rootId),
      lastval: String(lastval || ''),
    })
    if (payload.status !== 'ok') throw new Error(payload.msg || '子评论获取失败')
    const result = payload.result || {}
    const list = result.comments || []
    const mk = (c) => ({
      id: String(c.commentid || ''),
      name: (c.user && (c.user.nickname || c.user.username)) || '盒友',
      avatar: (c.user && c.user.avatar) || '',
      floor: c.floor_num || '',
      replyTo: (c.replyuser && c.replyuser.username) || '',
      time: formatTime(c.create_at),
      ip: c.ip_location || '',
      up: Number(c.up || 0),
      text: renderRich(c.text || ''),
      imgs: (c.imgs || []).map((i) => i.url).filter(Boolean),
    })
    return {
      items: list.map(mk),
      lastval: String(result.lastval || ''),
      hasMore: String(result.has_more) === '1' || Number(result.has_more) > 0,
    }
  }

  /** 收藏夹列表 + 指定夹的帖子（需登录） */
  async favouriteFolders() {
    const payload = await this.client.favouriteFolders()
    if (payload.status !== 'ok') throw new Error(payload.msg || '收藏夹获取失败')
    const folders = (payload.result && payload.result.folders) || []
    return {
      folders: folders.map((f) => ({
        id: String(f.id ?? f.folder_id ?? ''),
        name: f.name || '收藏夹',
        count: Number(f.count || 0),
        isDefault: !!f.is_default,
      })),
    }
  }

  /** 取消收藏必带 folder_id；面板只往默认夹写，优先取 is_default */
  async resolveDefaultFavFolderId() {
    if (this.defaultFavFolderId) return this.defaultFavFolderId
    const { folders } = await this.favouriteFolders()
    const target = folders.find((f) => f.isDefault) || folders[0]
    if (!target || !target.id) throw new Error('未找到默认收藏夹')
    this.defaultFavFolderId = target.id
    return this.defaultFavFolderId
  }

  async favourites(folderId) {
    let target = String(folderId || '')
    if (!target) {
      const { folders } = await this.favouriteFolders()
      target = (folders.find((f) => f.isDefault) || folders[0] || {}).id || ''
      if (!target) return { cards: [], folderName: '', folders: [] }
    }
    const payload = await this.client.favouriteLinks(target, 0, 30)
    if (payload.status !== 'ok') throw new Error(payload.msg || '收藏获取失败')
    const links = (payload.result && payload.result.links) || []
    const cards = links
      .filter((x) => x && x.link && String(x.is_deleted || '0') !== '1')
      .map((x) => toCard(x.link))
      .filter((c) => c.linkid)
    return { cards, folderName: target }
  }

  /** 消息中心（需登录）：字段是 entries，不是 message_list */
  async messages() {
    const payload = await this.client.messages(0, 20)
    if (payload.status !== 'ok') throw new Error(payload.msg || '消息获取失败')
    const result = payload.result || {}
    const list = result.entries || []
    const strip = (s) => String(s || '').replace(/<[^>]+>/g, '')
    const items = list.map((m) => ({
      id: String(m.comment_b_id || m.comment_a_id || m.root_comment_id || ''),
      linkid: String(m.linkid || ''),
      // a 是对方，b 是自己：消息标题展示"对方评论了/回复了你"
      title: strip(m.link_title) || '互动消息',
      text: strip(m.comment_a_text) || strip(m.link_desc) || '',
      topic: m.topic_name || '',
      from: (m.user_a && (m.user_a.nickname || m.user_a.username)) || '',
      avatar: (m.user_a && m.user_a.avatar) || '',
      time: formatTime(m.create_at),
    }))
    return { items, unread: Number(result.message_unread_num) || 0 }
  }


  remember(card) {
    if (!card.linkid || this.seen.has(card.linkid)) return false
    this.seen.add(card.linkid)
    this.seenQueue.push(card.linkid)
    if (this.seenQueue.length > SEEN_MAX) {
      const evicted = this.seenQueue.shift()
      this.seen.delete(evicted)
    }
    return true
  }

  /** 板块字典：按热度降序，缓存 24h */
  async ensureTopics() {
    if (this.topics.length && Date.now() - this.topicsLoadedAt < 86400_000) return
    const payload = await this.client.get('/bbs/app/topic/categories', {})
    const result = payload.result || {}
    const cats = result.categories || result.category || []
    const list = []
    for (const cat of cats) {
      for (const ch of cat.children || []) {
        if (!ch.topic_id || ch.valid === 0) continue
        const hotNum = Number((ch.hot && ch.hot.desc) || 0)
        list.push({ id: String(ch.topic_id), name: ch.name || '', hotNum })
      }
    }
    list.sort((a, b) => b.hotNum - a.hotNum)
    this.topics = list
    this.topicsLoadedAt = Date.now()
  }

  async pullMain(offset) {
    const payload = await this.client.get('/bbs/app/feeds', {
      offset: String(offset),
      pull: '0',
      dw: '800',
    })
    const result = unwrap(payload, '推荐动态')
    return result.links || []
  }

  async pullTopic() {
    await this.ensureTopics()
    if (!this.topics.length) return []
    const topic = this.topics[this.topicCursor % this.topics.length]
    this.topicCursor++
    const off = this.topicOffsets.get(topic.id) || 0
    const payload = await this.client.get('/bbs/app/topic/feeds', {
      topic_id: topic.id,
      offset: String(off),
      limit: String(TOPIC_PAGE),
    })
    if (payload.status !== 'ok') return []
    const links = (payload.result && payload.result.links) || []
    this.topicOffsets.set(topic.id, off + links.length)
    return links
  }

  /**
   * 拉一页混合 feed。
   * 返回 nextOffset = 主源已消耗条数（含被去重丢弃的），保证主源持续向前。
   */
  async feed(offset = 0, pull = '0') {
    let collected = []
    let mainConsumed = 0

    // 主源连续多轮零产出（offset 与动态队列错位到没意义）时暂停几轮，纯走板块源
    if (this.mainPause > 0) {
      this.mainPause--
    } else {
      try {
        const raw = await this.pullMain(offset)
        mainConsumed = raw.length
        let fresh = 0
        for (const item of raw) {
          const card = toCard(item)
          if (this.remember(card)) {
            collected.push(card)
            fresh++
          }
        }
        if (mainConsumed > 0 && fresh === 0) this.mainMiss++
        else this.mainMiss = 0
        if (this.mainMiss >= 3) {
          this.mainPause = 5
          this.mainMiss = 0
        }
      } catch (_) {
        /* 主源失败不阻断，走板块补充 */
      }
    }

    let guard = 0
    while (collected.length < MIN_PAGE && guard < 4) {
      guard++
      try {
        const raw = await this.pullTopic()
        for (const item of raw) {
          const card = toCard(item)
          if (this.remember(card)) collected.push(card)
          if (collected.length >= TOPIC_PAGE) break
        }
      } catch (_) {
        /* 单板块失败换下一个 */
      }
    }

    return {
      cards: collected.slice(0, TOPIC_PAGE),
      nextOffset: offset + Math.max(mainConsumed, 1),
      hasMore: collected.length > 0,
    }
  }
}

module.exports = { XhhService, toCard }
