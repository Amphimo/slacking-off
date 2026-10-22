'use strict'

/** 抖音业务层：feed/搜索/详情/评论。所有请求都通过 DouyinBridge 的页面 axios 发出。 */

const { DouyinBridge } = require('./bridge')

function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e9 ? 0 : 1)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(v >= 1e5 ? 0 : 1)}万`
  return String(v)
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

// 页面 axios 拦截器只补指纹参数，不带这三个；缺了它们部分接口会误判未登录。
const BASE_PARAMS = { device_platform: 'webapp', aid: 6383, channel: 'channel_pc_web' }

function urls(obj) {
  return (obj && obj.url_list ? obj.url_list : []).filter((u) => /^https?:\/\//i.test(String(u)))
}

function firstUrl(obj) {
  return urls(obj)[0] || ''
}

function mapAweme(a) {
  const video = a.video || {}
  const st = a.statistics || {}
  const author = a.author || {}
  const play = urls(video.play_addr)
  const images = (a.images || []).map((im) => firstUrl(im)).filter(Boolean)
  return {
    id: String(a.aweme_id || ''),
    title: String(a.desc || '').trim(),
    author: author.nickname || '',
    avatar: firstUrl(author.avatar_thumb),
    music: String((a.music && (a.music.title || a.music.author)) || '').trim(),
    cover: firstUrl(video.cover) || firstUrl(video.origin_cover) || firstUrl(a.share_info?.cover_url),
    playUrls: play,
    images,
    isImage: !play.length && images.length > 0,
    duration: Number(video.duration || a.duration || 0),
    durationText: fmtDuration(video.duration || a.duration),
    awemeType: Number(a.aweme_type || 0),
    digg: Number(st.digg_count || 0),
    diggText: fmtCount(st.digg_count),
    liked: !!(a.is_digg || a.user_digged),
    comments: Number(st.comment_count || 0),
    commentsText: fmtCount(st.comment_count),
    collects: Number(st.collect_count || 0),
    collectsText: fmtCount(st.collect_count),
    collected: !!(a.is_collect || a.is_favor),
    shares: Number(st.share_count || 0),
    sharesText: fmtCount(st.share_count),
    url: a.aweme_id ? `https://www.douyin.com/video/${a.aweme_id}` : '',
  }
}

function mapComment(c) {
  const user = c.user || {}
  return {
    id: String(c.cid || c.comment_id || ''),
    name: user.nickname || '抖音用户',
    avatar: firstUrl(user.avatar_thumb),
    text: String(c.text || ''),
    time: c.create_time ? new Date(c.create_time * 1000).toLocaleDateString('zh-CN') : '',
    ip: c.ip_label || '',
    like: Number(c.digg_count || 0),
    likeText: fmtCount(c.digg_count),
    liked: !!c.is_digg,
    replyCount: Number(c.reply_comment_total || 0),
    replies: (c.reply_comment || []).map(mapComment),
  }
}

class DouyinService {
  constructor(siteSession) {
    this.bridge = siteSession instanceof DouyinBridge ? siteSession : new DouyinBridge(siteSession)
    this.refreshIndex = 0
    this.seen = new Set()
    this.presented = []
    this.gids = []
  }

  async call(opts) {
    const r = await this.bridge.request({ ...opts, params: { ...BASE_PARAMS, ...(opts.params || {}) } })
    if (!r.ok) {
      const err = new Error(r.message || `HTTP ${r.status}`)
      if (r.code) err.code = r.code
      throw err
    }
    const d = r.data || {}
    if (d.status_code !== undefined && Number(d.status_code) !== 0) {
      const err = new Error(d.status_msg || `抖音接口返回 ${d.status_code}`)
      err.code = Number(d.status_code)
      throw err
    }
    return d
  }

  async me() {
    try {
      const d = await this.call({
        method: 'GET',
        url: '/aweme/v1/web/user/profile/self/',
        params: {
          publish_video_strategy_type: 2,
          source: 'channel_pc_web',
          personal_center_strategy: 1,
        },
      })
      const u = d.user || {}
      if (u.uid || u.sec_uid) {
        return {
          loggedIn: true,
          verified: true,
          uid: String(u.uid || ''),
          secUid: u.sec_uid || '',
          nickname: u.nickname || '',
          avatar: firstUrl(u.avatar_thumb),
        }
      }
    } catch (_) {}
    // 登录页还没跳回抖音时接口调不通，但 cookie 已经落盘，用 cookie 兜底。
    // 注意这不代表服务端认可登录：cookie 过期时写接口仍会返回 code 8。
    const loggedIn = await this.bridge.isLoggedIn()
    return { loggedIn, verified: false, uid: '', secUid: '', nickname: '', avatar: '' }
  }

  async login() {
    return this.bridge.showLogin()
  }

  async verify() {
    return this.bridge.showVerify()
  }

  async verifyHide() {
    return this.bridge.hideVerify()
  }

  async logout() {
    this.refreshIndex = 0
    this.seen = new Set()
    this.presented = []
    this.gids = []
    return this.bridge.logout()
  }

  remember(item) {
    if (!item.id || this.seen.has(item.id)) return false
    this.seen.add(item.id)
    this.presented.push(item.id)
    if (item.cover && item.id) this.gids.push(item.id)
    if (this.presented.length > 120) {
      const evicted = this.presented.shift()
      this.seen.delete(evicted)
    }
    return true
  }

  async feed(refresh = false) {
    if (refresh) {
      this.refreshIndex = 0
      this.seen = new Set()
      this.presented = []
      this.gids = []
    }
    this.refreshIndex++
    // 官方「推荐」页走 tab/feed；module/feed(3003101) 登录后会变成关注/精选内容。
    const d = await this.call({
      method: 'GET',
      url: '/aweme/v1/web/tab/feed/',
      params: {
        filterGids: this.gids.slice(-80).join(','),
        tag_id: '',
        live_insert_type: '',
        count: 10,
        refresh_index: this.refreshIndex,
        video_type_select: 1,
        aweme_pc_rec_raw_data: JSON.stringify({
          is_client: true,
          ff_danmaku_status: 1,
          danmaku_switch_status: 0,
          is_dash_user: 1,
          related_recommend: 1,
          min_window: 0,
          is_xigua_user: 0,
        }),
        pull_type: 0,
        min_window: 0,
        free_right: 0,
        view_count: 0,
        plug_block: 0,
        ug_source: '',
        creative_id: '',
      },
    })
    const cards = []
    for (const raw of d.aweme_list || []) {
      if (!raw || !raw.aweme_id || raw.is_ads) continue
      const item = mapAweme(raw)
      if (!item.playUrls.length && !item.isImage) continue
      if (this.remember(item)) cards.push(item)
    }
    return { cards, hasMore: d.has_more !== false && cards.length > 0 }
  }

  async search(keyword, cursor = 0) {
    const kw = String(keyword || '').trim()
    if (!kw) return { cards: [], cursor: 0, hasMore: false }
    const d = await this.call({
      method: 'GET',
      url: '/aweme/v1/web/general/search/single/',
      params: {
        keyword: kw,
        search_channel: 'aweme_general',
        search_source: 'normal_search',
        query_correct_type: 1,
        is_filter_search: 0,
        from_group_id: '',
        offset: Number(cursor) || 0,
        count: 20,
        need_filter_history: false,
        disable_boost: 0,
        sort_type: 0,
        publish_time: 0,
        filter_duration: 0,
      },
    })
    const cards = (d.data || [])
      .map((x) => mapAweme(x.AwemeInfo || x.aweme_info || x.aweme || {}))
      .filter((x) => x.id && (x.playUrls.length || x.isImage))
    return {
      cards,
      cursor: Number(d.cursor ?? ((Number(cursor) || 0) + cards.length)),
      hasMore: !!d.has_more && cards.length > 0,
    }
  }

  async write(url, params) {
    try {
      const d = await this.call({ method: 'POST', url, params })
      return { ok: true, statusCode: Number(d.status_code || 0) }
    } catch (e) {
      if (e && e.code === 8) e.message = '登录已失效，请重新登录'
      else if (e && e.code === 4) e.message = '抖音暂时拒绝了操作，请稍后重试'
      throw e
    }
  }

  async like(id, liked) {
    return this.write('/aweme/v1/web/commit/item/digg/', {
      aweme_id: String(id),
      type: liked ? 1 : 0,
      item_type: 0,
    })
  }

  async collect(id, collected, awemeType = 0) {
    return this.write('/aweme/v1/web/aweme/collect/', {
      aweme_id: String(id),
      action: collected ? 1 : 0,
      aweme_type: Number(awemeType) || 0,
    })
  }

  async detail(id) {
    const d = await this.call({
      method: 'GET',
      url: '/aweme/v1/web/aweme/detail/',
      params: { aweme_id: String(id), request_source: 600, origin_type: 'video_page' },
    })
    const item = mapAweme(d.aweme_detail || {})
    if (!item.id) throw new Error('视频不存在或已删除')
    return item
  }

  async comments(id, cursor = 0) {
    const d = await this.call({
      method: 'GET',
      url: '/aweme/v1/web/comment/list/',
      params: { aweme_id: String(id), cursor: Number(cursor) || 0, count: 20, item_type: 0, reply_style: 2 },
    })
    return {
      items: (d.comments || []).map(mapComment),
      cursor: Number(d.cursor || 0),
      hasMore: !!d.has_more,
      total: Number(d.total || 0),
    }
  }

  async replies(id, commentId, cursor = 0) {
    let d
    try {
      d = await this.call({
        method: 'GET',
        url: '/aweme/v1/web/comment/list/reply/',
        // 官方网页用 item_id 定位作品，别照抄主评论的 aweme_id；Electron 下该端点常被 bdturing 风控。
        params: {
          device_platform: 'webapp',
          aid: 6383,
          channel: 'channel_pc_web',
          item_id: String(id),
          comment_id: String(commentId),
          cut_version: 1,
          cursor: Number(cursor) || 0,
          count: 10,
          item_type: 0,
        },
      })
    } catch (e) {
      if (e && e.code === 'BDTURING') {
        const err = new Error('抖音要求人机验证，楼中楼暂时无法加载')
        err.code = 'BDTURING'
        throw err
      }
      throw e
    }
    if (!Array.isArray(d.comments)) {
      const err = new Error('抖音没有返回楼中楼数据，请稍后重试')
      err.code = 'BDTURING'
      throw err
    }
    return {
      items: (d.comments || []).map(mapComment),
      cursor: Number(d.cursor || 0),
      hasMore: !!d.has_more,
    }
  }
}

module.exports = { DouyinService, mapAweme, fmtCount }
