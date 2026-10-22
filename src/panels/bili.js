'use strict'

const api = window.bili
const list = document.getElementById('list')
const status = document.getElementById('status')
const detail = document.getElementById('detail')
const detailBody = document.getElementById('detailBody')
const mePage = document.getElementById('mePage')
const meBody = document.getElementById('meBody')
const meProfile = document.getElementById('meProfile')
const subtitle = document.getElementById('subtitle')
const searchBar = document.getElementById('searchBar')
const searchInput = document.getElementById('searchInput')

let cards = []
let renderedCount = 0
let hasMore = true
let loading = false
let mode = 'feed'
let searchKeyword = ''
let searchPage = 0
let searchSeen = new Set()
let feedSeen = new Set()
let savedFeed = { cards: [], hasMore: true, seen: new Set(), valid: false }
let identity = { loggedIn: false }
let curDetail = null
let playSegments = []
let playIndex = 0
let favFolders = []
let favActive = ''
let favCache = []
let pollTimer = null
let detailSeq = 0

const ICON_THUMB = '<svg viewBox="0 0 16 16"><path d="M5 13H3V7h2m0 6h6.2a1 1 0 0 0 1-.8l.8-4A1 1 0 0 0 12 7H8.5l.5-2.2A1.2 1.2 0 0 0 7.8 3.5L5 7z"/></svg>'
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M4.5 3.2v9.6L13 8z"/></svg>'
const ICON_DM = '<svg viewBox="0 0 16 16"><path d="M2 4h12v7H7l-3 3v-3H2z"/><path d="M5 7h6M5 9h4"/></svg>'
const ICON_HEART = '<svg viewBox="0 0 16 16"><path d="M8 13.2S2.6 10 2.6 6.3A2.9 2.9 0 0 1 8 4.4a2.9 2.9 0 0 1 5.4 1.9C13.4 10 8 13.2 8 13.2z"/></svg>'
const ICON_STAR = '<svg viewBox="0 0 16 16"><path d="M8 2.2l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L2.2 6.4l4-.6z"/></svg>'

function esc(s) {
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

function statusText(t, isErr) {
  status.textContent = t || ''
  status.className = isErr ? 'err' : ''
}

function flashStatus(t, isErr) {
  statusText(t, isErr)
  clearTimeout(flashStatus._t)
  flashStatus._t = setTimeout(() => { status.textContent = '' }, 2600)
}

function cardHtml(c) {
  const cover = c.cover
    ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.cover)}" />`
    : ''
  const face = c.ownerFace
    ? `<img class="avatar" loading="lazy" referrerpolicy="no-referrer" src="${esc(c.ownerFace)}" />`
    : '<div class="avatar"></div>'
  return `
    <div class="card" data-bvid="${esc(c.bvid)}">
      <div class="cover">${cover}<span class="dur">${esc(c.durationText)}</span></div>
      <div class="cardBody">
        <div class="title">${esc(c.title)}</div>
        <div class="byline">${face}<span>${esc(c.owner || 'UP主')}</span></div>
        <div class="stats">
          <span>${ICON_PLAY}${esc(c.viewsText)}</span>
          ${c.danmakuText && c.danmakuText !== '0' ? `<span>${ICON_DM}${esc(c.danmakuText)}</span>` : ''}
        </div>
      </div>
    </div>`
}

function renderCards(append) {
  if (append) {
    const html = cards.slice(renderedCount).map(cardHtml).join('')
    if (html) list.insertAdjacentHTML('beforeend', html)
    renderedCount = cards.length
    return
  }
  const html = cards.map(cardHtml).join('')
  list.innerHTML = html || (loading ? '' : '<p class="empty">暂无内容</p>')
  renderedCount = cards.length
}

async function loadMore(reset) {
  if (loading) return
  loading = true
  if (reset) {
    hasMore = true
    statusText('刷新中...')
    list.scrollTop = 0
  } else {
    statusText('加载中...')
  }
  try {
    const r = await api.feed(!!reset)
    if (reset) {
      cards = []
      renderedCount = 0
      feedSeen = new Set()
    }
    addFeedCards(r.cards)
    hasMore = r.hasMore
    renderCards(!reset)
    statusText(cards.length ? (hasMore ? '' : '没有更多了') : '暂时没有内容')
  } catch (e) {
    statusText('加载失败: ' + e.message, true)
  } finally {
    loading = false
  }
}

list.addEventListener('click', (e) => {
  const card = e.target.closest('.card')
  if (!card) return
  openDetail({ bvid: card.dataset.bvid })
})

/* ── 搜索 ────────────────────────────────────────────────── */
function saveFeedState() {
  if (mode !== 'feed') return
  savedFeed = { cards: cards.slice(), hasMore, seen: new Set(feedSeen), valid: true }
}

function addSearchCards(items) {
  for (const c of items || []) {
    if (!c.bvid || searchSeen.has(c.bvid)) continue
    searchSeen.add(c.bvid)
    cards.push(c)
  }
}

function addFeedCards(items) {
  for (const c of items || []) {
    if (!c.bvid || feedSeen.has(c.bvid)) continue
    feedSeen.add(c.bvid)
    cards.push(c)
  }
}

async function runSearch(kw) {
  const keyword = String(kw || '').trim()
  if (!keyword) return
  saveFeedState()
  mode = 'search'
  searchKeyword = keyword
  subtitle.textContent = `搜索：${keyword}`
  list.scrollTop = 0
  await loadSearch(true)
}

async function loadSearch(reset = false) {
  if (loading || mode !== 'search') return
  loading = true
  if (reset) {
    searchPage = 0
    searchSeen = new Set()
    cards = []
    hasMore = true
    renderCards(false)
    statusText('搜索中...')
  } else {
    statusText('加载中...')
  }
  try {
    const page = searchPage + 1
    const r = await api.search(searchKeyword, page)
    addSearchCards(r.cards)
    searchPage = page
    hasMore = !!r.hasMore
    renderCards(!reset)
    statusText(cards.length ? (hasMore ? '' : '没有更多了') : '没有找到相关视频')
  } catch (e) {
    hasMore = false
    statusText('搜索失败: ' + e.message, true)
  } finally {
    loading = false
  }
}

function backToFeed() {
  mode = 'feed'
  searchKeyword = ''
  subtitle.textContent = '推荐'
  if (savedFeed.valid) {
    cards = savedFeed.cards
    hasMore = savedFeed.hasMore
    feedSeen = new Set(savedFeed.seen)
  } else {
    cards = []
    hasMore = true
    feedSeen = new Set()
  }
  renderCards(false)
  statusText(cards.length ? '' : '加载中...')
  if (!cards.length && hasMore) loadMore(false)
}

document.getElementById('searchBtn').addEventListener('click', () => {
  const hidden = searchBar.classList.toggle('hidden')
  if (hidden) {
    if (mode === 'search') backToFeed()
  } else {
    searchInput.focus()
  }
})

searchBar.addEventListener('submit', (e) => {
  e.preventDefault()
  runSearch(searchInput.value)
})

document.getElementById('searchCancel').addEventListener('click', () => {
  searchBar.classList.add('hidden')
  backToFeed()
})

/* ── 详情 / 播放 ─────────────────────────────────────────── */
async function openDetail(c) {
  const seq = ++detailSeq
  detail.classList.remove('hidden')
  detailBody.innerHTML = '<div class="spin"></div>'
  detailBody.scrollTop = 0
  document.getElementById('extLink').style.visibility = 'hidden'
  try {
    const d = await api.detail(c.bvid)
    if (seq !== detailSeq) return
    curDetail = d
    renderDetail(d)
  } catch (e) {
    if (seq !== detailSeq) return
    detailBody.innerHTML = `
      <p class="empty" style="padding-top:50px">视频加载失败（${esc(e.message)}）<br><br>
        <a data-ext="https://www.bilibili.com/video/${esc(c.bvid)}" style="color:#fb7299;cursor:pointer">在浏览器打开</a>
      </p>`
  }
}

function renderDetail(d) {
  const ext = document.getElementById('extLink')
  ext.style.visibility = 'visible'
  ext.onclick = () => api.openExternal(d.url)

  const face = d.ownerFace
    ? `<img class="avatar" referrerpolicy="no-referrer" src="${esc(d.ownerFace)}" />`
    : '<div class="avatar"></div>'

  detailBody.innerHTML = `
    <div class="playerWrap">
      <video id="player" controls playsinline preload="metadata" referrerpolicy="no-referrer" poster="${esc(d.cover)}"></video>
      <span class="qv" id="qualityTag">${esc(d.play ? d.play.qualityText : '')}</span>
      <div id="playerMsg" class="playerMsg">${d.play ? '正在加载视频…' : '无法获取播放地址'}</div>
    </div>
    <div class="dbody">
      <h1>${esc(d.title)}</h1>
      <div class="upRow">${face}
        <div><div class="upName">${esc(d.owner)}</div><div class="upTime">${esc(d.pubdate)} · ${esc(d.duration)}</div></div>
      </div>
      <div class="statRow">
        <span>${esc(d.stat.viewText)} 播放</span>
        <span>${esc(d.stat.danmakuText)} 弹幕</span>
        <span>${esc(d.stat.replyText)} 评论</span>
      </div>
      <div id="actionBar">
        <button id="likeBtn" class="abtn${d.liked ? ' on' : ''}">${ICON_HEART}<span id="likeNum">${esc(d.stat.likeText)}</span></button>
        <button id="favBtn" class="abtn${d.faved ? ' on' : ''}">${ICON_STAR}<span id="favText">${d.faved ? '已收藏' : '收藏'}</span></button>
      </div>
      ${d.pages.length > 1 ? `<div class="pages">${d.pages.map((p, i) => `
        <button class="pchip${i === 0 ? ' on' : ''}" data-cid="${esc(p.cid)}" title="${esc(p.part)}">P${p.page} ${esc(p.part)} · ${esc(p.durationText)}</button>
      `).join('')}</div>` : ''}
      ${d.desc ? `<details class="desc"><summary>简介</summary><p>${esc(d.desc).replace(/\n/g, '<br>')}</p></details>` : ''}
      <div class="cnum">评论 ${esc(d.stat.replyText)}</div>
      <div id="comments">${d.comments.length
        ? d.comments.map((c) => commentHtml(c)).join('')
        : '<p class="empty">暂无评论</p>'}</div>
      <button id="moreComments" class="moreBtn${d.commentsHasMore ? '' : ' hidden'}">加载更多评论</button>
    </div>`

  setupPlayer(d)
  bindActions(d)
  bindPages(d)
  document.getElementById('moreComments').addEventListener('click', loadMoreComments)
}

function setupPlayer(d) {
  const player = document.getElementById('player')
  const msg = document.getElementById('playerMsg')
  playSegments = d.play?.segments || []
  playIndex = 0

  const showError = () => {
    msg.classList.remove('hidden')
    msg.innerHTML = `播放失败，可能被限流或需要登录。<br><a data-ext="${esc(d.url)}">在浏览器打开</a>`
  }

  player.addEventListener('loadeddata', () => msg.classList.add('hidden'))
  player.onerror = showError
  player.addEventListener('ended', () => {
    playIndex++
    if (playIndex < playSegments.length) {
      player.src = playSegments[playIndex]
      player.play().catch(() => {})
    }
  })

  if (playSegments.length) {
    player.src = playSegments[0]
    player.play().catch(() => {})
  } else {
    showError()
  }
}

function setPlayerSource(p) {
  const player = document.getElementById('player')
  const msg = document.getElementById('playerMsg')
  const tag = document.getElementById('qualityTag')
  playSegments = p.segments || []
  playIndex = 0
  if (tag) tag.textContent = p.qualityText || ''
  if (!playSegments.length) return
  msg.classList.remove('hidden')
  msg.textContent = '正在加载视频…'
  player.src = playSegments[0]
  player.play().catch(() => {})
}

function bindPages(d) {
  detailBody.querySelectorAll('.pchip').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('on') || btn.disabled) return
      btn.disabled = true
      try {
        const p = await api.play(d.bvid, btn.dataset.cid)
        d.play = p
        setPlayerSource(p)
        detailBody.querySelectorAll('.pchip').forEach((x) => x.classList.toggle('on', x === btn))
      } catch (e) {
        flashStatus('切换分P失败: ' + e.message, true)
      } finally {
        btn.disabled = false
      }
    })
  })
}

function bindActions(d) {
  const likeBtn = document.getElementById('likeBtn')
  const favBtn = document.getElementById('favBtn')

  likeBtn.addEventListener('click', async () => {
    if (!identity.loggedIn) { openLogin(); return }
    const on = !d.liked
    likeBtn.disabled = true
    try {
      await api.like(d.bvid, on)
      d.liked = on
      d.stat.like = Math.max(0, d.stat.like + (on ? 1 : -1))
      likeBtn.classList.toggle('on', on)
      document.getElementById('likeNum').textContent = fmtCount(d.stat.like)
    } catch (e) {
      flashStatus((on ? '点赞失败: ' : '取消点赞失败: ') + e.message, true)
    } finally {
      likeBtn.disabled = false
    }
  })

  favBtn.addEventListener('click', async () => {
    if (!identity.loggedIn) { openLogin(); return }
    const on = !d.faved
    favBtn.disabled = true
    try {
      await api.favourite(d.bvid, d.aid, on)
      d.faved = on
      favBtn.classList.toggle('on', on)
      document.getElementById('favText').textContent = on ? '已收藏' : '收藏'
      flashStatus(on ? '已加入默认收藏夹' : '已取消收藏')
      favFolders = []
      if (!on) meBody.querySelector(`.card[data-bvid="${esc(d.bvid)}"]`)?.remove()
    } catch (e) {
      flashStatus((on ? '收藏失败: ' : '取消收藏失败: ') + e.message, true)
    } finally {
      favBtn.disabled = false
    }
  })
}

function commentHtml(c, sub) {
  const avatar = c.avatar
    ? `<img class="cava" loading="lazy" referrerpolicy="no-referrer" src="${esc(c.avatar)}" />`
    : '<div class="cava"></div>'
  return `
    <div class="cm${sub ? ' sub' : ''}" data-cid="${esc(c.id)}">
      ${avatar}
      <div class="cbd">
        <div class="chd">${esc(c.name)}${c.level ? ` <span class="lv">LV${c.level}</span>` : ''}</div>
        <div class="ct">${c.text || ''}</div>
        <div class="cmeta">
          <button class="clike${c.liked ? ' on' : ''}" data-cid="${esc(c.id)}">${ICON_THUMB}<span>${fmtCount(c.like)}</span></button>
          <span>${esc(c.time)}</span>
        </div>
        ${(c.subs || []).map((s) => commentHtml(s, true)).join('')}
        ${!sub && c.subCount > (c.subs || []).length
          ? `<button class="moreSub" data-cid="${esc(c.id)}">展开 ${c.subCount} 条回复</button>`
          : ''}
      </div>
    </div>`
}

function findComment(id) {
  for (const c of curDetail?.comments || []) {
    if (c.id === id) return c
    const s = (c.subs || []).find((x) => x.id === id)
    if (s) return s
  }
  return null
}

detailBody.addEventListener('click', async (e) => {
  const ext = e.target.closest('[data-ext]')
  if (ext) {
    e.preventDefault()
    api.openExternal(ext.dataset.ext)
    return
  }

  const likeBtn = e.target.closest('.clike')
  if (likeBtn) {
    if (!identity.loggedIn) { openLogin(); return }
    const cm = findComment(likeBtn.dataset.cid)
    if (!cm) return
    const on = !cm.liked
    const prev = cm.like
    cm.liked = on
    cm.like += on ? 1 : -1
    likeBtn.classList.toggle('on', on)
    likeBtn.querySelector('span').textContent = fmtCount(cm.like)
    try {
      await api.likeComment(curDetail.aid, cm.id, on)
    } catch (err) {
      cm.liked = !on
      cm.like = prev
      likeBtn.classList.toggle('on', cm.liked)
      likeBtn.querySelector('span').textContent = fmtCount(cm.like)
      flashStatus('点赞失败: ' + err.message, true)
    }
    return
  }

  const more = e.target.closest('.moreSub')
  if (more) {
    const root = findComment(more.dataset.cid)
    if (!root || more.dataset.busy) return
    more.dataset.busy = '1'
    const oldText = more.textContent
    more.textContent = '加载中...'
    try {
      const pn = (root._subPage || 1) + 1
      const r = await api.subComments(curDetail.aid, root.id, pn)
      for (const s of r.items) {
        if ((root.subs || []).some((x) => x.id === s.id)) continue
        root.subs.push(s)
        more.insertAdjacentHTML('beforebegin', commentHtml(s, true))
      }
      root._subPage = r.page || pn
      if (r.hasMore) {
        more.textContent = `继续展开（已看 ${root.subs.length}/${root.subCount} 条）`
      } else {
        more.remove()
      }
    } catch (err) {
      more.textContent = oldText
      flashStatus('回复加载失败: ' + err.message, true)
    } finally {
      delete more.dataset.busy
    }
  }
})

async function loadMoreComments() {
  const btn = document.getElementById('moreComments')
  if (!curDetail || btn.disabled) return
  const d = curDetail
  btn.disabled = true
  btn.textContent = '加载中...'
  try {
    const r = await api.comments(d.aid, d.commentsPage + 1)
    const box = document.getElementById('comments')
    if (!d.comments.length) box.innerHTML = ''
    for (const c of r.items) {
      if ((d.comments || []).some((x) => x.id === c.id)) continue
      d.comments.push(c)
      box.insertAdjacentHTML('beforeend', commentHtml(c))
    }
    d.commentsPage = r.page || d.commentsPage + 1
    d.commentsHasMore = r.hasMore
    btn.textContent = '加载更多评论'
    btn.classList.toggle('hidden', !r.hasMore)
  } catch (e) {
    btn.textContent = '加载失败，点我重试'
    flashStatus('评论加载失败: ' + e.message, true)
  } finally {
    btn.disabled = false
  }
}

document.getElementById('backBtn').addEventListener('click', () => {
  detailSeq++
  const player = document.getElementById('player')
  if (player) {
    player.pause()
    player.removeAttribute('src')
    player.load()
  }
  detail.classList.add('hidden')
  detailBody.innerHTML = ''
  curDetail = null
})

/* ── 登录 ────────────────────────────────────────────────── */
const loginLayer = document.getElementById('loginLayer')
const loginBtn = document.getElementById('loginBtn')
const meBtn = document.getElementById('meBtn')

async function refreshIdentity() {
  try {
    identity = await api.me()
  } catch (_) {
    identity = { loggedIn: false }
  }
  loginBtn.classList.toggle('hidden', identity.loggedIn)
  meBtn.classList.toggle('hidden', !identity.loggedIn)
  meBtn.textContent = identity.loggedIn ? `我的 · ${identity.nickname || 'B站'}` : '我的'
  return identity
}

loginBtn.addEventListener('click', openLogin)

function openLogin() {
  loginLayer.classList.remove('hidden')
  startLogin()
}

async function startLogin() {
  const box = document.getElementById('qrBox')
  const msg = document.getElementById('loginMsg')
  box.innerHTML = '<div class="spin"></div>'
  msg.textContent = '正在获取二维码...'
  clearTimeout(pollTimer)
  try {
    const s = await api.loginStart()
    box.innerHTML = `<img src="${s.dataUrl}" />`
    msg.textContent = `请用 B站 App 扫码（${s.expiresIn}s）`
    poll(s.expiresIn)
  } catch (e) {
    box.innerHTML = ''
    msg.textContent = '获取失败: ' + e.message
  }
}

function poll(remaining) {
  if (remaining <= 0) {
    document.getElementById('loginMsg').textContent = '二维码已过期'
    return
  }
  pollTimer = setTimeout(async () => {
    try {
      const r = await api.loginPoll()
      const msg = document.getElementById('loginMsg')
      if (r.state === 'success') {
        msg.textContent = `欢迎，${(r.me && r.me.nickname) || 'B站用户'}！`
        setTimeout(async () => {
          loginLayer.classList.add('hidden')
          await refreshIdentity()
          loadMore(true)
        }, 700)
        return
      }
      msg.textContent = r.message || r.state
      if (r.state !== 'expired' && r.state !== 'failed') poll(r.remainingSeconds)
    } catch (e) {
      document.getElementById('loginMsg').textContent = '轮询失败: ' + e.message
    }
  }, 1600)
}

document.getElementById('loginClose').addEventListener('click', () => {
  clearTimeout(pollTimer)
  loginLayer.classList.add('hidden')
})

/* ── 我的 / 收藏 ─────────────────────────────────────────── */
meBtn.addEventListener('click', () => {
  if (!identity.loggedIn) { openLogin(); return }
  mePage.classList.remove('hidden')
  renderMe()
})

document.getElementById('meBack').addEventListener('click', () => mePage.classList.add('hidden'))

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logout()
  identity = { loggedIn: false }
  favFolders = []
  favActive = ''
  mePage.classList.add('hidden')
  refreshIdentity()
  loadMore(true)
  flashStatus('已退出登录')
})

async function renderMe() {
  const face = identity.avatar
    ? `<img class="avatar" referrerpolicy="no-referrer" src="${esc(identity.avatar)}" />`
    : '<div class="avatar"></div>'
  meProfile.innerHTML = `${face}<div><div class="nick">${esc(identity.nickname || 'B站用户')}</div><div class="mid">UID ${esc(identity.mid || '')}</div></div>`
  meBody.innerHTML = '<div class="spin"></div>'
  try {
    if (!favFolders.length) favFolders = (await api.favFolders()).folders || []
    if (!favActive || !favFolders.some((f) => f.id === favActive)) favActive = favFolders[0]?.id || ''
    if (!favFolders.length) {
      meBody.innerHTML = '<p class="empty">没有可用的收藏夹</p>'
      return
    }
    const chips = favFolders
      .map((f) => `<button class="chip${f.id === favActive ? ' on' : ''}" data-fid="${esc(f.id)}">${esc(f.name)} ${f.count}</button>`)
      .join('')
    const r = await api.favourites(favActive)
    favCache = r.cards
    meBody.innerHTML = `${chips}${r.cards.length
      ? r.cards.map(cardHtml).join('')
      : '<p class="empty">这个收藏夹是空的</p>'}`
    meBody.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        favActive = c.dataset.fid
        renderMe()
      })
    })
    meBody.querySelectorAll('.card').forEach((card) => {
      card.addEventListener('click', () => openDetail({ bvid: card.dataset.bvid }))
    })
  } catch (e) {
    meBody.innerHTML = `<p class="empty">${esc(e.message)}</p>`
  }
}

/* ── 刷新 / 无限滚动 ─────────────────────────────────────── */
const refreshBtn = document.getElementById('refreshBtn')
refreshBtn.addEventListener('click', async () => {
  if (loading) return
  refreshBtn.classList.add('spinning')
  await (mode === 'search' ? loadSearch(true) : loadMore(true))
  refreshBtn.classList.remove('spinning')
})

list.addEventListener('scroll', () => {
  if (list.scrollTop + list.clientHeight <= list.scrollHeight - 400 || !hasMore) return
  if (mode === 'search') loadSearch(false)
  else loadMore(false)
})

refreshIdentity()
loadMore(true)
