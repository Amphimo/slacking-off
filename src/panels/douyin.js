'use strict'

const api = window.douyin
const stage = document.getElementById('stage')
const player = document.getElementById('player')
const playerB = document.getElementById('playerB')
const imagePlayer = document.getElementById('imagePlayer')
const poster = document.getElementById('poster')
const videos = [player, playerB]
const empty = document.getElementById('empty')
const playOverlay = document.getElementById('playOverlay')
const authorEl = document.getElementById('author')
const descEl = document.getElementById('desc')
const commentCount = document.getElementById('commentCount')
const likeBtn = document.getElementById('likeBtn')
const likeCount = document.getElementById('likeCount')
const collectBtn = document.getElementById('collectBtn')
const collectCount = document.getElementById('collectCount')
const progressFill = document.getElementById('progressFill')
const progressWrap = document.getElementById('progressWrap')
const status = document.getElementById('status')
const subtitle = document.getElementById('subtitle')
const backHomeBtn = document.getElementById('backHomeBtn')
const searchPage = document.getElementById('searchPage')
const searchInput = document.getElementById('searchInput')
const searchList = document.getElementById('searchList')
const commentSheet = document.getElementById('commentSheet')
const commentList = document.getElementById('commentList')
const loginBtn = document.getElementById('loginBtn')
const accountBtn = document.getElementById('accountBtn')
const accountImg = document.getElementById('accountImg')
const accountFallback = document.getElementById('accountFallback')
const accountSheet = document.getElementById('accountSheet')
const accAvatar = document.getElementById('accAvatar')
const accAvatarFallback = document.getElementById('accAvatarFallback')
const accName = document.getElementById('accName')
const accUid = document.getElementById('accUid')
const reloginBtn = document.getElementById('reloginBtn')
const logoutBtn = document.getElementById('logoutBtn')
const backdrop = document.getElementById('backdrop')
const meta = document.getElementById('meta')
const side = document.getElementById('side')
const musicRow = document.getElementById('musicRow')
const musicText = document.getElementById('musicText')
const subtitleText = document.getElementById('subtitleText')
const scrim = document.getElementById('scrim')
const commentBtn = document.getElementById('commentBtn')
const searchHint = document.getElementById('searchHint')

for (const img of [accountImg, accAvatar]) {
  img.addEventListener('error', () => {
    const fallback = img === accountImg ? accountFallback : accAvatarFallback
    img.classList.add('hidden')
    fallback.classList.remove('hidden')
  })
}

let queue = []
let index = -1
let current = null
let loading = false
let mode = 'feed'
let identity = { loggedIn: false, verified: false }
let savedFeed = { queue: [], index: -1, valid: false }
let searchKeyword = ''
let searchCards = []
let searchCursor = 0
let searchHasMore = true
let commentCursor = 0
let commentHasMore = false
let commentItems = []
let verifyWindowOpen = false
let wheelLock = 0
let mediaEpoch = 0
let lastSwitchAt = 0
let activeVideo = player
let displayedKind = 'none'
let pendingVideo = null
let handoffAutoplay = true
let primeTimer = null

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

// IPC 报错会带 "Error invoking remote method 'douyin:xxx':Error:" 前缀，展示时去掉。
function errorText(err) {
  const msg = String((err && err.message) || err || '')
  return msg.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/i, '')
}

function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(v >= 1e9 ? 0 : 1)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(v >= 1e5 ? 0 : 1)}万`
  return String(v)
}

function statusText(t, isErr) {
  clearTimeout(statusText._t)
  status.textContent = t || ''
  status.className = isErr ? 'err' : ''
  if (!t) return
  status.style.animation = 'none'
  void status.offsetWidth
  status.style.animation = ''
  statusText._t = setTimeout(() => {
    if (status.textContent === t) status.textContent = ''
  }, 3200)
}

function flash(t, isErr) {
  statusText(t, isErr)
}

function setSubtitle(text, mode = 'feed') {
  subtitleText.textContent = text
  subtitle.dataset.mode = mode
}

function syncNav() {
  const inSearchPlayback = mode === 'search' && searchPage.classList.contains('hidden')
  backHomeBtn.classList.toggle('hidden', !inSearchPlayback)
  subtitle.classList.toggle('hidden', inSearchPlayback)
}

function richText(s) {
  return esc(s).replace(/#([^\s#]+)/g, '<span class="tag">#$1</span>')
}

function emptyStateHtml(title, hint, kind = 'search') {
  const icon = kind === 'comment'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.3 9.3 0 0 1-3.8-.8L3 21l1.7-5a8.2 8.2 0 0 1-.7-3.4A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4 21 21"/></svg>'
  return `<div class="empty-state">${icon}<strong>${esc(title)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`
}

function showEmpty(text) {
  pendingVideo = null
  clearTimeout(primeTimer)
  for (const v of videos) {
    v.pause()
    v.classList.remove('on')
    v.style.zIndex = '0'
  }
  imagePlayer.classList.remove('on')
  poster.classList.remove('on')
  displayedKind = 'none'
  playOverlay.classList.add('hidden')
  empty.textContent = text
  empty.classList.remove('hidden')
  meta.classList.add('hidden')
  side.classList.add('hidden')
  progressWrap.classList.add('hidden')
  backdrop.classList.remove('on')
  renderActions()
}

function renderActions() {
  const liked = !!(current && current.liked)
  const collected = !!(current && current.collected)
  likeCount.textContent = current ? fmtCount(current.digg) : '0'
  collectCount.textContent = current ? fmtCount(current.collects) : '0'
  likeBtn.classList.toggle('active', liked)
  collectBtn.classList.toggle('active', collected)
  likeBtn.setAttribute('aria-pressed', String(liked))
  collectBtn.setAttribute('aria-pressed', String(collected))
  likeBtn.setAttribute('aria-label', liked ? '取消点赞' : '点赞')
  collectBtn.setAttribute('aria-label', collected ? '取消收藏' : '收藏')
  likeBtn.title = liked ? '取消点赞' : '点赞'
  collectBtn.title = collected ? '取消收藏' : '收藏'
}

function spareVideo() {
  return activeVideo === player ? playerB : player
}

// 抖音卡片的 url_list 前几个 CDN 地址经常直接 403，按顺序回退比重新请求详情快得多。
let goodHost = ''

function hostOf(u) {
  try { return new URL(u).host } catch (_) { return '' }
}

function playUrlFor(item) {
  const list = item && item.playUrls
  if (!list || !list.length) return ''
  if (item._urlIdx == null && goodHost) {
    const idx = list.findIndex((u) => u.includes('//' + goodHost + '/'))
    if (idx > 0) item._urlIdx = idx
  }
  const i = Math.max(0, Math.min(list.length - 1, item._urlIdx || 0))
  return list[i]
}

function nextCandidate(item) {
  const list = item && item.playUrls
  if (!list || !list.length) return false
  const tried = item._tried || (item._tried = [])
  const used = playUrlFor(item)
  if (used && !tried.includes(used)) tried.push(used)
  const idx = list.findIndex((u) => !tried.includes(u))
  if (idx < 0) {
    // 全部试过一轮后清空记录，下次从头按 goodHost 偏好重来，避免整条队列被一次性网络抖动打废。
    item._tried = []
    item._urlIdx = null
    return false
  }
  item._urlIdx = idx
  return true
}

function showPoster(src) {
  if (!src) return
  if (poster.getAttribute('src') !== src) poster.src = src
  poster.classList.add('on')
}

function hidePoster() {
  poster.classList.remove('on')
}

function showImage(epoch) {
  clearTimeout(primeTimer)
  if (pendingVideo) {
    pendingVideo.pause()
    pendingVideo = null
  }
  if (displayedKind === 'video') activeVideo.pause()

  const src = (current.images && current.images[0]) || current.cover || ''
  if (!src) {
    showPoster(current.cover || '')
    return
  }

  const reveal = () => {
    if (epoch !== mediaEpoch) return
    if (displayedKind === 'video') {
      activeVideo.style.zIndex = '0'
      activeVideo.classList.remove('on')
    }
    imagePlayer.style.zIndex = '1'
    imagePlayer.classList.add('on')
    displayedKind = 'image'
    playOverlay.classList.add('hidden')
    hidePoster()
    schedulePrime()
  }

  if (imagePlayer.getAttribute('src') !== src) imagePlayer.src = src
  if (imagePlayer.complete && imagePlayer.naturalWidth) {
    reveal()
  } else {
    imagePlayer.onload = reveal
    imagePlayer.onerror = () => {
      if (epoch === mediaEpoch) showPoster(current.cover || src)
    }
  }
}

function completeSwap(v) {
  const outgoing = v === player ? playerB : player
  const prevKind = displayedKind
  pendingVideo = null
  clearTimeout(primeTimer)
  v.style.zIndex = '1'
  v.classList.add('on')
  activeVideo = v
  displayedKind = 'video'
  if (current) current._tries = 0
  goodHost = hostOf(v.getAttribute('src')) || goodHost
  outgoing.pause()
  outgoing.style.zIndex = '0'
  outgoing.classList.remove('on')
  if (prevKind === 'image') {
    imagePlayer.style.zIndex = '0'
    imagePlayer.classList.remove('on')
  }
  if (handoffAutoplay) {
    playOverlay.classList.add('hidden')
    musicRow.classList.remove('paused')
  } else {
    playOverlay.classList.remove('hidden')
    musicRow.classList.add('paused')
    v.pause()
  }
  hidePoster()
  empty.classList.add('hidden')
  schedulePrime()
}

function showVideo(epoch, force = false, autoplay = true) {
  const url = playUrlFor(current)
  const outgoing = displayedKind === 'video' ? activeVideo : null
  // 上一次交接还没出帧就被新的渲染打断，先停掉，避免它晚点 playing 时把错误的一条顶上来。
  if (pendingVideo) {
    pendingVideo.pause()
    pendingVideo = null
  }

  if (!url) {
    if (!outgoing) showPoster(current.cover || (current.images && current.images[0]) || '')
    return
  }

  if (!force && outgoing && outgoing.getAttribute('src') === url && !outgoing.error) {
    handoffAutoplay = autoplay
    if (autoplay && outgoing.paused) outgoing.play().catch(() => playOverlay.classList.remove('hidden'))
    if (!autoplay && !outgoing.paused) outgoing.pause()
    return
  }

  clearTimeout(primeTimer)
  if (outgoing) outgoing.pause()
  musicRow.classList.add('paused')

  const target = displayedKind === 'none' ? player : spareVideo()
  pendingVideo = target
  handoffAutoplay = autoplay
  target.__epoch = epoch
  target.classList.remove('on')
  target.style.zIndex = '0'
  if (target.getAttribute('src') !== url) {
    target.src = url
    target.__awemeId = current.id
    target.load()
  } else if (target.error) {
    target.load()
  }
  try { target.currentTime = 0 } catch (_) {}
  const started = target.play()
  if (started && started.catch) {
    started.catch(() => {
      if (target.__epoch !== mediaEpoch || pendingVideo !== target) return
      pendingVideo = null
      const old = target === player ? playerB : player
      old.classList.remove('on')
      old.style.zIndex = '0'
      imagePlayer.style.zIndex = '0'
      imagePlayer.classList.remove('on')
      target.style.zIndex = '1'
      target.classList.add('on')
      activeVideo = target
      displayedKind = 'video'
      showPoster(current.cover || (current.images && current.images[0]) || '')
      playOverlay.classList.remove('hidden')
      musicRow.classList.add('paused')
    })
  }
}

function primeNextVideo() {
  const nextItem = queue[index + 1]
  const spare = spareVideo()
  if (!nextItem || nextItem.isImage || !nextItem.playUrls || !nextItem.playUrls.length) {
    if (spare.__awemeId) {
      spare.pause()
      spare.removeAttribute('src')
      spare.__awemeId = null
      spare.load()
    }
    return
  }
  const url = playUrlFor(nextItem)
  if (!url) return
  if (spare.__awemeId === nextItem.id && spare.getAttribute('src') === url && !spare.error) return
  spare.pause()
  spare.__awemeId = nextItem.id
  spare.src = url
  spare.load()
}

function schedulePrime(delay = 340) {
  clearTimeout(primeTimer)
  primeTimer = setTimeout(() => {
    if (!pendingVideo) primeNextVideo()
  }, delay)
}

function renderStage(force = false, autoplay = true) {
  if (!current) {
    showEmpty('暂无内容')
    return
  }
  empty.classList.add('hidden')
  meta.classList.remove('hidden')
  side.classList.remove('hidden')
  authorEl.textContent = `@${current.author || '抖音用户'}`
  descEl.innerHTML = richText(current.title || '')
  commentCount.textContent = current.commentsText || '0'
  renderActions()
  mediaEpoch++
  const epoch = mediaEpoch

  const bg = current.cover || (current.images && current.images[0]) || ''
  backdrop.style.backgroundImage = bg ? `url(${JSON.stringify(bg)})` : 'none'
  backdrop.classList.toggle('on', !!bg)

  const music = current.music || ''
  musicText.textContent = music ? `原创音乐 · ${music}` : ''
  musicRow.classList.toggle('hidden', !music)
  musicRow.classList.toggle('paused', !!current.isImage)

  progressWrap.classList.toggle('hidden', !!current.isImage)
  progressFill.style.width = '0'

  for (const el of [meta, side]) {
    el.classList.remove('swap')
    void el.offsetWidth
    el.classList.add('swap')
  }

  // 只有当前没有可留存的画面（首次加载 / 播放出错）时才让封面兜底，
  // 正常切条由旧视频的最后一帧顶到新视频出帧，避免黑场。
  if (displayedKind === 'none' || force) showPoster(bg)

  if (current.isImage) showImage(epoch)
  else showVideo(epoch, force, autoplay)
}

async function playAt(i) {
  if (i < 0 || i >= queue.length) return
  index = i
  current = queue[i]
  renderStage()
  if (!current.playUrls.length && !current.isImage) {
    try {
      const fresh = await api.detail(current.id)
      queue[i] = fresh
      current = fresh
      renderStage()
    } catch (e) {
      flash('取播放地址失败: ' + errorText(e), true)
    }
  }
  if (queue.length - i < 5) loadMore()
}

function next(delta = 1) {
  const target = index + delta
  if (Date.now() - lastSwitchAt < 450 || target < 0) return
  lastSwitchAt = Date.now()
  if (target >= queue.length) {
    loadMore()
    return
  }
  playAt(target)
}

async function loadFeed(reset = false) {
  if (loading) return
  loading = true
  const hadContent = queue.length > 0 && !!current
  if (reset && !hadContent) {
    queue = []
    index = -1
    current = null
    showEmpty('正在准备抖音推荐...')
  }
  statusText(reset ? '刷新中...' : '加载中...')
  try {
    const r = await api.feed(!!reset)
    if (reset) {
      // 旧视频继续播到新一批返回，避免刷新时整屏空 2 秒多。
      queue = r.cards
      index = -1
      current = null
      if (queue.length) await playAt(0)
      else showEmpty('暂时没有内容')
    } else {
      queue = queue.concat(r.cards)
      if (index < 0 && queue.length) await playAt(0)
      else if (index >= 0) schedulePrime()
    }
    statusText(queue.length ? (r.hasMore ? '' : '暂时没有更多了') : '暂时没有内容')
  } catch (e) {
    const msg = errorText(e)
    if (!hadContent) showEmpty(msg)
    statusText('加载失败: ' + msg, true)
  } finally {
    loading = false
  }
}

function loadMore() {
  if (mode === 'search') {
    if (searchHasMore) loadSearch(false, true)
  } else {
    loadFeed(false)
  }
}

/* ── 播放控制 ─────────────────────────────────────────────── */
async function handlePlaybackError() {
  if (!current || current.isImage) return
  const total = current.playUrls ? current.playUrls.length : 0
  const tries = (current._tries = (current._tries || 0) + 1)
  if (tries <= total && nextCandidate(current)) {
    renderStage(true)
    return
  }
  if (tries > total + 2) {
    flash('播放失败，自动下一条', true)
    setTimeout(() => next(1), 700)
    return
  }
  try {
    const fresh = await api.detail(current.id)
    fresh._tries = tries
    queue[index] = fresh
    current = fresh
    renderStage(true)
  } catch (e) {
    flash('刷新播放地址失败: ' + errorText(e), true)
    playOverlay.classList.remove('hidden')
  }
}

function handlePreloadError(v) {
  const item = queue[index + 1]
  v.__awemeId = null
  if (!item || !item.playUrls || !item.playUrls.includes(v.getAttribute('src'))) return
  if (nextCandidate(item)) primeNextVideo()
}

for (const v of videos) {
  v.addEventListener('timeupdate', () => {
    if (v !== activeVideo || displayedKind !== 'video') return
    if (!Number.isFinite(v.duration) || v.duration <= 0) return
    progressFill.style.width = `${Math.min(100, (v.currentTime / v.duration) * 100)}%`
  })
  v.addEventListener('playing', () => {
    if (v === pendingVideo) {
      if (v.__epoch !== mediaEpoch) return
      completeSwap(v)
      return
    }
    if (v !== activeVideo) return
    playOverlay.classList.add('hidden')
    empty.classList.add('hidden')
    musicRow.classList.remove('paused')
    hidePoster()
  })
  v.addEventListener('pause', () => {
    if (v !== activeVideo || pendingVideo) return
    if (!current || current.isImage) return
    playOverlay.classList.remove('hidden')
    musicRow.classList.add('paused')
  })
  v.addEventListener('ended', () => {
    if (v !== activeVideo || pendingVideo) return
    if (v.__epoch !== mediaEpoch) return
    next(1)
  })
  v.addEventListener('error', () => {
    if (v !== activeVideo && v !== pendingVideo) {
      handlePreloadError(v)
      return
    }
    if (v.__epoch !== mediaEpoch) return
    if (v === pendingVideo) pendingVideo = null
    handlePlaybackError()
  })
}

function togglePlay() {
  if (!current || current.isImage || pendingVideo) return
  if (activeVideo.paused) activeVideo.play().catch(() => playOverlay.classList.remove('hidden'))
  else activeVideo.pause()
}

playOverlay.tabIndex = 0
playOverlay.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  togglePlay()
})

function seekFromEvent(e) {
  if (!current || current.isImage || pendingVideo) return
  if (!Number.isFinite(activeVideo.duration)) return
  const r = progressWrap.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
  activeVideo.currentTime = activeVideo.duration * ratio
}

progressWrap.addEventListener('pointerdown', (e) => {
  e.stopPropagation()
  seekFromEvent(e)
})
progressWrap.addEventListener('pointermove', (e) => {
  if (e.buttons) seekFromEvent(e)
})

stage.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (Date.now() < wheelLock || Math.abs(e.deltaY) < 18) return
  wheelLock = Date.now() + 520
  next(e.deltaY > 0 ? 1 : -1)
}, { passive: false })

let startY = null
let moved = false
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#progressWrap,#side,#commentSheet')) return
  startY = e.clientY
  moved = false
})
stage.addEventListener('pointermove', (e) => {
  if (startY == null) return
  if (Math.abs(e.clientY - startY) > 8) moved = true
})
stage.addEventListener('pointerup', (e) => {
  if (startY == null) return
  const dy = e.clientY - startY
  startY = null
  if (dy < -70) next(1)
  else if (dy > 70) next(-1)
  else if (!moved) togglePlay()
})
stage.addEventListener('pointercancel', () => { startY = null })

document.getElementById('nextBtn').addEventListener('click', () => next(1))

/* ── 点赞 / 收藏 ───────────────────────────────────────────── */
async function ensureLoggedIn() {
  if (identity.loggedIn && identity.verified) return true
  await refreshIdentity()
  if (identity.loggedIn && identity.verified) return true
  flash(identity.loggedIn ? '登录已失效，请点右上角「重新登录」' : '点赞/收藏需要先登录', true)
  return false
}

function markLoginStale() {
  if (!identity.loggedIn) return
  identity = { ...identity, verified: false }
  renderIdentity()
  if (!accountSheet.classList.contains('hidden')) renderAccountSheet()
}

async function toggleLike() {
  const item = current
  if (!item || !item.id || likeBtn.dataset.busy === item.id) return
  likeBtn.dataset.busy = item.id
  try {
    if (!(await ensureLoggedIn()) || current !== item) return
    const beforeLiked = !!item.liked
    const beforeDigg = Number(item.digg) || 0
    item.liked = !beforeLiked
    item.digg = Math.max(0, beforeDigg + (item.liked ? 1 : -1))
    renderActions()
    try {
      await api.like(item.id, item.liked)
      if (current === item) flash(item.liked ? '已点赞' : '已取消点赞')
    } catch (e) {
      item.liked = beforeLiked
      item.digg = beforeDigg
      if (current === item) renderActions()
      const msg = errorText(e)
      if (/登录/.test(msg)) markLoginStale()
      flash('点赞失败：' + msg, true)
    }
  } finally {
    if (likeBtn.dataset.busy === item.id) delete likeBtn.dataset.busy
  }
}

async function toggleCollect() {
  const item = current
  if (!item || !item.id || collectBtn.dataset.busy === item.id) return
  collectBtn.dataset.busy = item.id
  try {
    if (!(await ensureLoggedIn()) || current !== item) return
    const beforeCollected = !!item.collected
    const beforeCount = Number(item.collects) || 0
    item.collected = !beforeCollected
    item.collects = Math.max(0, beforeCount + (item.collected ? 1 : -1))
    renderActions()
    try {
      await api.collect(item.id, item.collected, item.awemeType || 0)
      if (current === item) flash(item.collected ? '已收藏' : '已取消收藏')
    } catch (e) {
      item.collected = beforeCollected
      item.collects = beforeCount
      if (current === item) renderActions()
      const msg = errorText(e)
      if (/登录/.test(msg)) markLoginStale()
      flash('收藏失败：' + msg, true)
    }
  } finally {
    if (collectBtn.dataset.busy === item.id) delete collectBtn.dataset.busy
  }
}

likeBtn.addEventListener('click', toggleLike)
collectBtn.addEventListener('click', toggleCollect)

/* ── 搜索 ─────────────────────────────────────────────────── */
function searchSkeletonHtml() {
  return Array.from({ length: 6 }, () => `
    <div class="search-skeleton">
      <div class="sk-cover shimmer"></div>
      <div class="sk-line shimmer" style="width: 82%"></div>
      <div class="sk-line shimmer" style="width: 52%"></div>
    </div>`).join('')
}

function searchCardHtml(c, i) {
  const cover = c.cover || (c.images && c.images[0]) || ''
  const dur = c.durationText || (c.isImage ? '图集' : '')
  return `
    <article class="search-card" data-index="${i}" style="--i:${i % 8}" tabindex="0" role="button" aria-label="播放：${esc(c.title)}">
      <div class="cover">
        ${cover ? `<img loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(cover)}" />` : '<div class="cover-fallback"></div>'}
        ${dur ? `<span class="dur">${esc(dur)}</span>` : ''}
        <span class="likes">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 10.6S1.6 7.9 1.6 4.9A2.2 2.2 0 0 1 6 3.6a2.2 2.2 0 0 1 4.4 1.3c0 3-4.4 5.7-4.4 5.7z"/></svg>
          ${esc(c.diggText || '0')}
        </span>
      </div>
      <div class="body">
        <div class="title">${esc(c.title)}</div>
        <div class="byline">@${esc(c.author)}</div>
      </div>
    </article>`
}

function renderSearch() {
  searchList.innerHTML = searchCards.length
    ? searchCards.map(searchCardHtml).join('')
    : emptyStateHtml('没有找到相关视频', '换个关键词，或许能遇见下一段画面')
}

async function loadSearch(reset = false, intoQueue = false) {
  if (loading || !searchKeyword) return
  loading = true
  if (reset) {
    searchCards = []
    searchCursor = 0
    searchHasMore = true
    searchList.innerHTML = searchSkeletonHtml()
    searchList.scrollTop = 0
    searchHint.textContent = '正在检索 · 请稍候'
  }
  statusText('搜索中...')
  try {
    const r = await api.search(searchKeyword, reset ? 0 : searchCursor)
    searchCards = searchCards.concat(r.cards)
    searchCursor = r.cursor
    searchHasMore = r.hasMore
    renderSearch()
    searchHint.textContent = searchCards.length
      ? (r.hasMore ? `已载入 ${searchCards.length} 条` : `${searchCards.length} 条结果`)
      : '没有匹配内容'
    if (intoQueue) {
      queue = searchCards.slice()
      flash(`已加载 ${r.cards.length} 条`)
      if (index >= 0) schedulePrime()
    }
    statusText(searchCards.length ? (r.hasMore ? '' : '没有更多了') : '没有找到相关视频')
  } catch (e) {
    const msg = errorText(e)
    searchHasMore = false
    searchList.innerHTML = emptyStateHtml('搜索遇到问题', msg)
    searchHint.textContent = '搜索失败'
    statusText('搜索失败: ' + msg, true)
  } finally {
    loading = false
  }
}

function openSearchPage() {
  const wasPlaying = !!(current && !current.isImage && (pendingVideo ? handoffAutoplay : !activeVideo.paused))
  if (mode === 'feed') {
    savedFeed = { queue: queue.slice(), index, valid: true, playing: wasPlaying }
  }
  if (pendingVideo) {
    pendingVideo.pause()
    pendingVideo.__epoch = -1
    pendingVideo = null
  }
  if (!activeVideo.paused) activeVideo.pause()
  mode = 'search'
  setSubtitle(searchKeyword ? `搜索：${searchKeyword}` : '搜索', 'search')
  if (!searchKeyword && !searchCards.length) {
    searchList.innerHTML = emptyStateHtml('搜索抖音', '输入关键词，开始探索视频、图集与话题')
    searchHint.textContent = '输入关键词开始探索'
  }
  searchPage.classList.remove('hidden')
  syncNav()
  searchInput.focus()
}

function closeSearchPage() {
  searchPage.classList.add('hidden')
  if (mode === 'search') {
    mode = 'feed'
    setSubtitle('推荐')
    if (savedFeed.valid) {
      queue = savedFeed.queue
      index = savedFeed.index
      current = queue[index] || null
      renderStage(false, savedFeed.playing)
    } else {
      loadFeed(true)
    }
  }
  syncNav()
}

document.getElementById('searchBtn').addEventListener('click', openSearchPage)
document.getElementById('searchCancel').addEventListener('click', closeSearchPage)
backHomeBtn.addEventListener('click', closeSearchPage)
document.getElementById('searchBar').addEventListener('submit', (e) => {
  e.preventDefault()
  searchKeyword = searchInput.value.trim()
  if (!searchKeyword) return
  mode = 'search'
  setSubtitle(`搜索：${searchKeyword}`, 'search')
  syncNav()
  loadSearch(true)
})
searchList.addEventListener('click', (e) => {
  const card = e.target.closest('.search-card')
  if (!card) return
  queue = searchCards.slice()
  mode = 'search'
  searchPage.classList.add('hidden')
  syncNav()
  playAt(Number(card.dataset.index) || 0)
})
searchList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const card = e.target.closest('.search-card')
  if (!card) return
  e.preventDefault()
  card.click()
})
searchList.addEventListener('scroll', () => {
  if (searchList.scrollTop + searchList.clientHeight > searchList.scrollHeight - 300 && searchHasMore) {
    loadSearch(false, true)
  }
})

/* ── 评论 ─────────────────────────────────────────────────── */
function replyHtml(r) {
  return `<div class="reply"><span class="reply-name">${esc(r.name)}</span>${esc(r.text)}</div>`
}

function commentHtml(c) {
  const avatar = c.avatar
    ? `<img class="avatar" loading="lazy" alt="" referrerpolicy="no-referrer" src="${esc(c.avatar)}" />`
    : '<div class="avatar"></div>'
  const replies = (c.replies || []).map(replyHtml).join('')
  const more = c.replyCount > (c.replies || []).length
    ? `<button class="moreReplies" data-cid="${esc(c.id)}">查看 ${c.replyCount} 条回复</button>`
    : ''
  return `
    <div class="comment" data-cid="${esc(c.id)}">
      ${avatar}
      <div class="content">
        <div class="name">${esc(c.name)}</div>
        <div class="text">${esc(c.text)}</div>
        <div class="foot"><span>${esc(c.likeText)} 赞</span><span>${esc(c.time)}</span>${c.ip ? `<span>${esc(c.ip)}</span>` : ''}</div>
        ${replies}${more}
      </div>
    </div>`
}

function commentSkeletonHtml(n = 5) {
  return Array.from({ length: n }, () => `
    <div class="comment-skeleton">
      <div class="sk-avatar shimmer"></div>
      <div class="sk-body">
        <div class="sk-line shimmer" style="width: 34%"></div>
        <div class="sk-line shimmer" style="width: 92%"></div>
        <div class="sk-line shimmer" style="width: 66%"></div>
      </div>
    </div>`).join('')
}

async function openComments() {
  if (!current) return
  accountSheet.classList.add('hidden')
  accountBtn.setAttribute('aria-expanded', 'false')
  commentBtn.setAttribute('aria-expanded', 'true')
  commentSheet.classList.remove('hidden')
  document.getElementById('commentTitle').textContent = `评论 ${current.commentsText}`
  commentList.scrollTop = 0
  await loadComments(true)
}

async function loadComments(reset = false) {
  if (!current) return
  if (reset) {
    commentCursor = 0
    commentHasMore = false
    commentItems = []
    commentList.innerHTML = commentSkeletonHtml()
  }
  try {
    const r = await api.comments(current.id, commentCursor)
    commentItems = commentItems.concat(r.items)
    commentList.innerHTML = commentItems.length
      ? commentItems.map(commentHtml).join('')
      : emptyStateHtml('还没有评论', '来留下第一条想法', 'comment')
    commentCursor = r.cursor
    commentHasMore = r.hasMore
    if (r.hasMore) {
      const btn = document.createElement('button')
      btn.id = 'loadComments'
      btn.type = 'button'
      btn.textContent = '加载更多评论'
      btn.onclick = loadMoreComments
      commentList.appendChild(btn)
    }
  } catch (e) {
    commentList.innerHTML = emptyStateHtml('评论加载失败', errorText(e), 'comment')
  }
}

async function loadMoreComments() {
  if (!current || !commentHasMore) return
  const btn = document.getElementById('loadComments')
  if (btn) btn.textContent = '加载中...'
  try {
    const r = await api.comments(current.id, commentCursor)
    if (btn) btn.remove()
    commentItems = commentItems.concat(r.items)
    commentList.insertAdjacentHTML('beforeend', r.items.map(commentHtml).join(''))
    commentCursor = r.cursor
    commentHasMore = r.hasMore
    if (r.hasMore) {
      const nextBtn = document.createElement('button')
      nextBtn.id = 'loadComments'
      nextBtn.textContent = '加载更多评论'
      nextBtn.onclick = loadMoreComments
      commentList.appendChild(nextBtn)
    }
  } catch (e) {
    if (btn) btn.textContent = '加载失败，点我重试'
  }
}

commentList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.moreReplies')
  if (!btn || !current || btn.dataset.busy) return
  const c = commentItems.find((x) => x.id === btn.dataset.cid)
  if (!c) return

  if (btn.dataset.verify) {
    delete btn.dataset.verify
    btn.dataset.busy = '1'
    btn.textContent = '正在打开验证窗口...'
    try {
      await api.verify()
      verifyWindowOpen = true
      btn.textContent = '验证完成后点此重试'
    } catch (err) {
      btn.dataset.verify = '1'
      btn.textContent = '打开官方验证'
      flash('验证窗口打开失败：' + errorText(err), true)
    } finally {
      if (btn.isConnected) delete btn.dataset.busy
    }
    return
  }

  btn.dataset.busy = '1'
  const oldText = btn.textContent
  btn.textContent = '加载中...'
  try {
    const r = await api.replies(current.id, c.id, c._replyCursor || 0)
    if (verifyWindowOpen) {
      verifyWindowOpen = false
      api.verifyHide().catch(() => {})
    }
    const existing = new Set((c.replies || []).map((x) => x.id))
    for (const item of r.items) {
      if (existing.has(item.id)) continue
      c.replies.push(item)
      btn.insertAdjacentHTML('beforebegin', replyHtml(item))
    }
    c._replyCursor = r.cursor
    if (!r.hasMore) btn.remove()
    else btn.textContent = `继续查看回复（已看 ${c.replies.length}/${c.replyCount}）`
  } catch (err) {
    const msg = errorText(err)
    if (/人机验证/.test(msg)) {
      btn.dataset.verify = '1'
      btn.textContent = '打开官方验证'
      flash('抖音要求人机验证，点按钮完成官方验证后重试', true)
    } else {
      btn.textContent = oldText
      flash('回复加载失败：' + msg, true)
    }
  } finally {
    if (btn.isConnected) delete btn.dataset.busy
  }
})

document.getElementById('commentBtn').addEventListener('click', openComments)

/* ── 登录 / 刷新 ─────────────────────────────────────────── */
let loginPollTimer = null
let loginPollStart = 0

function stopLoginPoll() {
  clearTimeout(loginPollTimer)
  loginPollTimer = null
}

async function pollLoginState() {
  loginPollTimer = null
  if (identity.loggedIn && identity.verified) return
  if (Date.now() - loginPollStart > 5 * 60 * 1000) return
  try {
    const me = await api.me()
    if (me.loggedIn && me.verified) {
      identity = me
      renderIdentity()
      savedFeed.valid = false
      flash('登录成功，正在刷新推荐')
      if (mode === 'feed') await loadFeed(true)
      return
    }
  } catch (_) {}
  loginPollTimer = setTimeout(pollLoginState, 2000)
}

function startLoginPoll() {
  stopLoginPoll()
  loginPollStart = Date.now()
  loginPollTimer = setTimeout(pollLoginState, 1500)
}

function renderIdentity() {
  const hasCookie = !!identity.loggedIn
  const on = hasCookie && identity.verified === true
  const initial = (identity.nickname || '我').slice(0, 1)
  loginBtn.classList.toggle('hidden', on)
  loginBtn.textContent = hasCookie ? '重新登录' : '登录'
  accountBtn.classList.toggle('hidden', !hasCookie)
  accountBtn.classList.toggle('stale', hasCookie && !on)
  accountBtn.title = on ? '账号' : '登录已失效，点击查看'
  accountBtn.setAttribute('aria-label', on ? '账号' : '登录已失效，查看账号')
  accountFallback.textContent = initial
  if (on && identity.avatar) {
    accountImg.src = identity.avatar
    accountImg.classList.remove('hidden')
    accountFallback.classList.add('hidden')
  } else {
    accountImg.removeAttribute('src')
    accountImg.classList.add('hidden')
    accountFallback.classList.remove('hidden')
  }
  if (!accountSheet.classList.contains('hidden')) renderAccountSheet()
}

function renderAccountSheet() {
  const hasCookie = !!identity.loggedIn
  const on = hasCookie && identity.verified === true
  const initial = (identity.nickname || '我').slice(0, 1)
  accName.textContent = on
    ? (identity.nickname || '已登录')
    : (hasCookie ? '登录已失效' : '未登录')
  accUid.textContent = on
    ? (identity.uid ? `UID ${identity.uid}` : '登录态已保存在本机')
    : (hasCookie ? '请重新登录后再点赞或收藏' : '登录后可搜索和使用个性化推荐')
  accAvatarFallback.textContent = initial
  if (on && identity.avatar) {
    accAvatar.src = identity.avatar
    accAvatar.classList.remove('hidden')
    accAvatarFallback.classList.add('hidden')
  } else {
    accAvatar.removeAttribute('src')
    accAvatar.classList.add('hidden')
    accAvatarFallback.classList.remove('hidden')
  }
  reloginBtn.classList.toggle('hidden', !hasCookie || on)
  logoutBtn.classList.toggle('hidden', !hasCookie)
  accountSheet.classList.toggle('stale', hasCookie && !on)
}

async function refreshIdentity() {
  try {
    identity = await api.me()
  } catch (_) {
    identity = { loggedIn: false, verified: false }
  }
  renderIdentity()
  if (identity.loggedIn && identity.verified) stopLoginPoll()
}

accountBtn.addEventListener('click', () => setAccountOpen(true))

function setAccountOpen(open) {
  accountSheet.classList.toggle('hidden', !open)
  accountBtn.setAttribute('aria-expanded', String(open))
  if (!open) return
  commentSheet.classList.add('hidden')
  commentBtn.setAttribute('aria-expanded', 'false')
  renderAccountSheet()
  refreshIdentity()
}

function closeOverlays() {
  commentSheet.classList.add('hidden')
  accountSheet.classList.add('hidden')
  commentBtn.setAttribute('aria-expanded', 'false')
  accountBtn.setAttribute('aria-expanded', 'false')
}

document.getElementById('accountClose').addEventListener('click', () => setAccountOpen(false))
document.getElementById('commentClose').addEventListener('click', () => {
  commentSheet.classList.add('hidden')
  commentBtn.setAttribute('aria-expanded', 'false')
})

scrim.addEventListener('click', closeOverlays)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  if (!commentSheet.classList.contains('hidden') || !accountSheet.classList.contains('hidden')) {
    closeOverlays()
    return
  }
  if (mode === 'search') closeSearchPage()
})

logoutBtn.addEventListener('click', async () => {
  if (logoutBtn.dataset.busy) return
  logoutBtn.dataset.busy = '1'
  const oldText = logoutBtn.textContent
  logoutBtn.textContent = '退出中...'
  try {
    await api.logout()
    stopLoginPoll()
    identity = { loggedIn: false, verified: false }
    renderIdentity()
    accountSheet.classList.add('hidden')
    accountBtn.setAttribute('aria-expanded', 'false')
    savedFeed.valid = false
    if (mode === 'feed') await loadFeed(true)
    flash('已退出登录')
  } catch (e) {
    flash('退出失败: ' + errorText(e), true)
  } finally {
    logoutBtn.textContent = oldText
    delete logoutBtn.dataset.busy
  }
})

async function beginLogin() {
  try {
    await api.login()
    flash('在弹出的抖音窗口完成登录，成功后会自动刷新')
    startLoginPoll()
  } catch (e) {
    flash('打开登录窗口失败: ' + errorText(e), true)
  }
}

loginBtn.addEventListener('click', beginLogin)
reloginBtn.addEventListener('click', beginLogin)

const refreshBtn = document.getElementById('refreshBtn')
refreshBtn.addEventListener('click', async () => {
  if (loading) return
  refreshBtn.classList.add('spinning')
  // 登录态检查不阻塞刷新，否则抖音会比别的面板多等一个 /profile/self 往返。
  refreshIdentity()
  await (mode === 'search' ? loadSearch(true) : loadFeed(true))
  refreshBtn.classList.remove('spinning')
})

refreshIdentity()
loadFeed(true)
