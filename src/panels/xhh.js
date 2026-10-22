'use strict'

const api = window.panel
const list = document.getElementById('list')
const status = document.getElementById('status')
const detail = document.getElementById('detail')
const detailBody = document.getElementById('detailBody')
const viewer = document.getElementById('imgViewer')

let cards = []
let offset = 0
let hasMore = true
let loading = false

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function statusText(t, isErr) {
  status.textContent = t || ''
  status.className = isErr ? 'err' : ''
}

function imgGrid(images) {
  if (!images.length) return ''
  const cls = `n${Math.min(images.length, 9)}`
  return `<div class="imgs ${cls}">${images
    .map((u) => `<img loading="lazy" src="${esc(u)}" />`)
    .join('')}</div>`
}

function cardHtml(c) {
  const avatar = c.avatar
    ? `<img class="avatar" src="${esc(c.avatar)}" />`
    : `<div class="avatar"></div>`
  return `
    <div class="card" data-linkid="${esc(c.linkid)}">
      <div class="meta">${avatar}<span>${esc(c.author || '盒友')}</span>
        ${c.game ? `<span class="game-tag">${esc(c.game)}</span>` : ''}
        <span style="flex:1"></span><span>${esc(c.time)}</span>
      </div>
      ${c.title ? `<div class="title">${esc(c.title)}</div>` : ''}
      ${c.text ? `<div class="text">${esc(c.text)}</div>` : ''}
      ${imgGrid(c.images)}
      <div class="footer"><span>💬 ${c.comments}</span><span>👍 ${c.likes}</span></div>
    </div>`
}

function renderCards(append) {
  const html = cards.map(cardHtml).join('')
  if (append) {
    list.insertAdjacentHTML('beforeend', html)
  } else {
    list.innerHTML = html
  }
}

async function loadMore(reset) {
  if (loading) return
  loading = true
  if (reset) {
    offset = 0
    hasMore = true
    statusText('刷新中...')
  } else {
    statusText('加载中...')
  }
  try {
    const r = await api.feed(reset ? 0 : offset, reset ? '0' : '1')
    if (reset) cards = []
    cards = cards.concat(r.cards)
    offset = r.nextOffset
    hasMore = r.hasMore
    renderCards(!reset)
    statusText(hasMore ? '' : '没有更多了')
  } catch (e) {
    statusText('加载失败: ' + e.message, true)
  } finally {
    loading = false
  }
}

/* 卡片点击 → 详情（用已有数据展开全文 + 图片墙） */
list.addEventListener('click', (e) => {
  const card = e.target.closest('.card')
  if (!card) return
  const c = cards.find((x) => x.linkid === card.dataset.linkid)
  if (!c) return
  openDetail(c)
})

async function openDetail(c) {
  // 注意：api.me() 是异步的，必须 await —— 之前同步判断导致永远进降级分支
  let loggedIn = false
  try {
    loggedIn = (await api.me()).loggedIn
  } catch (_) {}
  if (loggedIn) {
    loadRealDetail(c)
    return
  }
  detailBody.innerHTML = `
    <h1>${esc(c.title || '帖子')}</h1>
    <div class="meta">${esc(c.author || '盒友')} · ${esc(c.time)} · 💬 ${c.comments}</div>
    ${c.text ? `<div class="text">${esc(c.text)}</div>` : ''}
    ${imgGrid(c.images)}
    ${c.url
      ? `<p style="margin:10px 0 20px"><a href="${esc(c.url)}" data-ext="1" style="color:#4b6bfb;font-size:13px">登录后可看评论，或点此在浏览器打开原帖 →</a></p>`
      : ''}
  `
  bindDetail(c)
  detail.classList.remove('hidden')
  detailBody.scrollTop = 0
}

async function loadRealDetail(c) {
  detailBody.innerHTML = '<div class="spin"></div>'
  detail.classList.remove('hidden')
  detailBody.scrollTop = 0
  try {
    const d = await api.detail(c.linkid)
    curDetail = d
    detailBody.innerHTML = `
      <h1>${esc(d.title || c.title || '帖子')}</h1>
      <div class="meta">${esc(d.author)} · ${esc(d.time)} · 💬 ${d.commentNum}</div>
      ${d.topics && d.topics.length ? `<div class="topics">${d.topics.map(esc).join(' · ')}</div>` : ''}
      <div class="article-html">${d.html || esc(c.text)}</div>
      <div id="actionBar">
        <button id="likeBtn" class="abtn${d.liked ? ' on' : ''}">👍 <span>${d.likedNum}</span></button>
        <button id="favBtn" class="abtn${d.faved ? ' on' : ''}">⭐ ${d.faved ? '已收藏' : '收藏'}</button>
      </div>
      <div class="cnum">评论 ${d.commentNum}</div>
      ${d.comments.map((g, gi) => `
        <section class="cg" data-gi="${gi}">
          ${commentHtml(g.main)}
          ${g.subs.map((s) => commentHtml(s, true)).join('')}
          ${g.childNum > g.subs.length
            ? `<button class="moreSub" data-gi="${gi}">展开全部 ${g.childNum} 条回复</button>`
            : ''}
        </section>`).join('') || '<p style="text-align:center;color:#98a2b3;padding:20px">暂无评论</p>'}
    `
    bindDetail(d)
    bindMoreSubs()
    bindActions(d)
  } catch (e) {
    detailBody.innerHTML = `
      <div style="text-align:center;padding:40px 16px;color:#98a2b3;font-size:13px">
        详情加载失败（${esc(e.message)}）<br/><br/>
        <a href="${esc(c.url)}" data-ext="1" style="color:#4b6bfb">在浏览器打开原帖 →</a>
      </div>`
    bindDetail(c)
  }
}

let curDetail = null

function bindActions(d) {
  const likeBtn = document.getElementById('likeBtn')
  const favBtn = document.getElementById('favBtn')
  likeBtn.addEventListener('click', async () => {
    const on = !d.liked
    likeBtn.disabled = true
    try {
      await api.likePost(d.linkid, on)
      d.liked = on
      d.likedNum = Math.max(0, d.likedNum + (on ? 1 : -1))
      likeBtn.classList.toggle('on', on)
      likeBtn.querySelector('span').textContent = d.likedNum
    } catch (e) {
      flashStatus('点赞失败: ' + e.message)
    } finally {
      likeBtn.disabled = false
    }
  })
  favBtn.addEventListener('click', async () => {
    const on = !d.faved
    favBtn.disabled = true
    try {
      await api.favPost(d.linkid, on)
      d.faved = on
      favBtn.classList.toggle('on', on)
      favBtn.textContent = on ? '⭐ 已收藏' : '⭐ 收藏'
      flashStatus(on ? '已加入默认收藏夹' : '已取消收藏')
      favFolders = []
      if (!on) meBody.querySelector(`.card[data-linkid="${esc(d.linkid)}"]`)?.remove()
    } catch (e) {
      flashStatus((on ? '收藏失败: ' : '取消收藏失败: ') + e.message)
    } finally {
      favBtn.disabled = false
    }
  })
}

function flashStatus(t) {
  status.textContent = t
  status.className = ''
  clearTimeout(flashStatus._t)
  flashStatus._t = setTimeout(() => { status.textContent = '' }, 2600)
}

function bindMoreSubs() {
  detailBody.querySelectorAll('.moreSub').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const gi = Number(btn.dataset.gi)
      const g = curDetail && curDetail.comments[gi]
      if (!g || btn.dataset.busy) return
      btn.dataset.busy = '1'
      btn.textContent = '加载中...'
      try {
        const r = await api.subComments(g.main.id, g.lastval || '')
        const sec = detailBody.querySelector(`.cg[data-gi="${gi}"]`)
        btn.remove()
        const moreBtn = sec.querySelector('.moreSub')
        const insertBefore = moreBtn || null
        for (const s of r.items) {
          if (g.subs.some((x) => x.id === s.id)) continue
          g.subs.push(s)
          sec.insertAdjacentHTML('beforeend', commentHtml(s, true))
        }
        g.lastval = r.lastval || g.lastval
        g.childNum = Math.max(g.childNum, g.main.subCount || g.childNum)
        const shown = g.subs.length
        if (r.hasMore) {
          const b = document.createElement('button')
          b.className = 'moreSub'
          b.dataset.gi = gi
          b.textContent = `继续展开（已看 ${shown} 条）`
          sec.appendChild(b)
          bindMoreSubs()
        }
      } catch (e) {
        btn.textContent = '加载失败，点我重试'
      } finally {
        delete btn.dataset.busy
      }
    })
  })
}

function commentHtml(cm, sub) {
  const avatar = cm.avatar ? `<img class="cava" src="${esc(cm.avatar)}" />` : '<div class="cava"></div>'
  return `
    <div class="cm${sub ? ' sub' : ''}" data-cid="${esc(cm.id)}">
      ${avatar}
      <div class="cbd">
        <div class="chd">${esc(cm.name)}${cm.floor ? ` <span class="flr">#${cm.floor}</span>` : ''}${cm.replyTo ? ` 回复 <span class="rpl">${esc(cm.replyTo)}</span>` : ''}</div>
        <div class="cmeta"><span class="upBtn${cm.liked ? ' on' : ''}" data-cid="${esc(cm.id)}">👍 ${cm.up}</span> · ${esc(cm.time)}${cm.ip ? ' · ' + esc(cm.ip) : ''}</div>
        <div class="ct rich">${cm.text || ''}</div>
        ${cm.imgs.map((u) => `<img class="cimg" loading="lazy" src="${esc(u)}" />`).join('')}
      </div>
    </div>`
}

function bindDetail(c) {
  detailBody.querySelectorAll('a[data-ext]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      api.openExternal(a.href)
    })
  })
  const ext = document.getElementById('extLink')
  ext.style.visibility = c.url ? 'visible' : 'hidden'
  ext.onclick = () => c.url && api.openExternal(c.url)
}

document.getElementById('backBtn').addEventListener('click', () => {
  detail.classList.add('hidden')
  detailBody.innerHTML = ''
})

viewer.addEventListener('click', () => viewer.classList.add('hidden'))

document.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && detail.contains(e.target)) {
    viewer.innerHTML = `<img src="${e.target.src}" />`
    viewer.classList.remove('hidden')
  }
})

/* 评论点赞（事件委托，楼中楼展开后的新按钮也生效） */
detailBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('.upBtn')
  if (!btn || !curDetail) return
  const cid = btn.dataset.cid
  let cm = null
  for (const g of curDetail.comments) {
    if (g.main.id === cid) { cm = g.main; break }
    const s = g.subs.find((x) => x.id === cid)
    if (s) { cm = s; break }
  }
  if (!cm) return
  const on = !cm.liked
  const prevUp = cm.up
  cm.liked = on
  cm.up += on ? 1 : -1
  btn.classList.toggle('on', on)
  btn.textContent = `👍 ${cm.up}`
  try {
    await api.likeComment(cid, on)
  } catch (err) {
    cm.liked = !on
    cm.up = prevUp
    btn.classList.toggle('on', cm.liked)
    btn.textContent = `👍 ${cm.up}`
    flashStatus('点赞失败: ' + err.message)
  }
})

/* 刷新：清空当前列表，从最新拉起（seen 集合保证不会复现刚看过的） */
const refreshBtn = document.getElementById('refreshBtn')
refreshBtn.addEventListener('click', async () => {
  if (loading) return
  refreshBtn.classList.add('spinning')
  list.scrollTop = 0
  await loadMore(true)
  refreshBtn.classList.remove('spinning')
})

/* 无限滚动 */
list.addEventListener('scroll', () => {
  if (list.scrollTop + list.clientHeight > list.scrollHeight - 400 && hasMore) {
    loadMore(false)
  }
})

/* ── 登录态 / 我的 ─────────────────────────────────────────── */

const loginLayer = document.getElementById('loginLayer')
const loginBtn = document.getElementById('loginBtn')
const meBtn = document.getElementById('meBtn')
const mePage = document.getElementById('mePage')
const meBody = document.getElementById('meBody')
let pollTimer = null

async function refreshIdentity() {
  const me = await api.me()
  loginBtn.classList.toggle('hidden', me.loggedIn)
  meBtn.classList.toggle('hidden', !me.loggedIn)
  meBtn.textContent = me.loggedIn ? `我的 · ${me.nickname || '盒友'}` : '我的'
  return me
}

loginBtn.addEventListener('click', () => openLogin())

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
    msg.textContent = `请用小黑盒 App 扫码（${s.expiresIn}s）`
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
        msg.textContent = `欢迎，${(r.me && r.me.nickname) || '盒友'}！`
        setTimeout(() => {
          loginLayer.classList.add('hidden')
          refreshIdentity()
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

/* 我的页 */
meBtn.addEventListener('click', () => {
  mePage.classList.remove('hidden')
  showMeTab('fav')
})

document.getElementById('meBack').addEventListener('click', () => mePage.classList.add('hidden'))

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api.logout()
  mePage.classList.add('hidden')
  refreshIdentity()
  statusText('已退出登录')
})

document.querySelectorAll('.mtab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.mtab').forEach((x) => x.classList.toggle('active', x === t))
    showMeTab(t.dataset.tab)
  }),
)

let favFolders = []
let favActive = ''
let favCardCache = []

async function showMeTab(tab) {
  meBody.innerHTML = '<div class="spin"></div>'
  try {
    if (tab === 'fav') {
      if (!favFolders.length) favFolders = (await api.favFolders()).folders || []
      const chips = favFolders
        .map((f) => `<button class="chip${f.id === favActive ? ' on' : ''}" data-fid="${esc(f.id)}">${esc(f.name)} ${f.count}</button>`)
        .join('')
      const { cards } = await api.favourites(favActive)
      favCardCache = cards
      meBody.innerHTML = `
        <div id="favChips">${chips}</div>
        ${cards.length ? cards.map(cardHtml).join('') : '<p style="text-align:center;color:#98a2b3;padding:40px 0">这个收藏夹是空的</p>'}`
      meBody.querySelectorAll('.chip').forEach((c) =>
        c.addEventListener('click', () => {
          favActive = c.dataset.fid
          showMeTab('fav')
        }),
      )
      meBody.querySelectorAll('.card').forEach((card) =>
        card.addEventListener('click', () => {
          const c = favCardsOf(card)
          if (c) openDetail(c)
        }),
      )
    } else {
      const { items } = await api.messages()
      meBody.innerHTML = items.length
        ? items.map((m) => `
          <div class="card" data-linkid="${esc(m.linkid)}">
            <div class="meta">
              ${m.avatar ? `<img class="avatar" src="${esc(m.avatar)}" />` : '<div class="avatar"></div>'}
              <span>${esc(m.from || '有人')}</span>
              ${m.topic ? `<span class="game-tag">${esc(m.topic)}</span>` : ''}
              <span style="flex:1"></span><span>${esc(m.time)}</span>
            </div>
            <div class="title">${esc(m.title)}</div>
            ${m.text ? `<div class="text">${esc(m.text)}</div>` : ''}
          </div>`).join('')
        : '<p style="text-align:center;color:#98a2b3;padding:40px 0">没有消息</p>'
      meBody.querySelectorAll('.card').forEach((card) => {
        const m = items.find((x) => x.linkid === card.dataset.linkid)
        card.addEventListener('click', () => {
          if (m && m.linkid) openDetail({ linkid: m.linkid, title: m.title, text: m.text, url: '' })
        })
      })
    }
  } catch (e) {
    meBody.innerHTML = `<p style="text-align:center;color:#d4494c;padding:40px 0;font-size:13px">${esc(e.message)}</p>`
  }
}

function favCardsOf(cardEl) {
  const idx = [...meBody.querySelectorAll('.card')].indexOf(cardEl)
  return favCardCache[idx] || null
}

refreshIdentity()

loadMore(true)
