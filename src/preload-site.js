'use strict'

/**
 * 注入到每个站点的 webview 里，在页面脚本之前执行。
 * 注意：必须在 contextIsolation:false 下运行，否则这些修改对页面不可见。
 *
 * 三层伪装 + 两层净化：
 *  伪装：navigator / userAgentData / ontouchstart / matchMedia / screen
 *  净化：per-host CSS（精准选择器）+ 通用启发式 Observer（兜底动态插入的浮条）
 */

const isTouchQuery = (q) =>
  /pointer:\s*coarse|any-pointer:\s*coarse|hover:\s*none|any-hover:\s*none/i.test(q)

function spy(obj, key, value) {
  try {
    Object.defineProperty(obj, key, { get: () => value, configurable: true })
  } catch (_) {
    /* 只读且不可重定义时忽略 */
  }
}

// ── per-host 精准净化规则（选择器来自 tools/probe.js 实测抓取） ──────
const HOST_RULES = [
  {
    // 实测：B站 m 站用自定义元素 <m-open-app> 承载「下载App」按钮和底部悬浮「App内打开」
    match: /(^|\.)bilibili\.com$/,
    css: `
      m-open-app, m-nav-openapp, m-fixed-openapp,
      [class*="fixed-openapp" i], [class*="m-nav-openapp" i],
      [class*="open-app-img" i], [class*="download-app" i] { display: none !important; }
    `,
  },
  {
    // 桌面版：移动 UA 会被降级成「热门+广告+引导下载 App」，桌面 UA 才有扫码登录和完整功能
    // 登录弹窗固定 440px，390 视口下缩放到 85% 避免左右被裁（二维码仍在正中）
    match: /(^|\.)xiaohongshu\.com$/,
    css: `
      .launch-app-container, [class*="launch-app" i],
      [class*="app-download" i], [class*="download-bar" i],
      [class*="open-app" i], [class*="openapp" i] { display: none !important; }
      @media (max-width: 460px) {
        [class*="login-container"] { zoom: .85; }
      }
    `,
  },
]

const GENERIC_KEYWORDS = /(下载App|下载APP|打开App|打开APP|App内打开|APP内打开|App内|打开看看|前往App|去App|打开应用|立即打开)/

function injectBaseDisguise() {
  spy(window.navigator, 'platform', 'iPhone')
  spy(window.navigator, 'maxTouchPoints', 5)
  spy(window.navigator, 'vendor', 'Apple Computer, Inc.')
  spy(window.navigator, 'userAgentData', undefined)

  if (!('ontouchstart' in window)) {
    try {
      window.ontouchstart = null
      window.ontouchmove = null
      window.ontouchend = null
    } catch (_) {}
  }

  const nativeMatchMedia = window.matchMedia.bind(window)
  const fakeMql = (media) => ({
    matches: true,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })
  window.matchMedia = (media) => (isTouchQuery(media) ? fakeMql(media) : nativeMatchMedia(media))

  spy(window.screen, 'width', 390)
  spy(window.screen, 'height', 844)
  spy(window.screen, 'availWidth', 390)
  spy(window.screen, 'availHeight', 844)
}

function injectDesktopDisguise() {
  spy(window.navigator, 'platform', 'Win32')
  spy(window.navigator, 'maxTouchPoints', 0)
  spy(window.navigator, 'vendor', 'Google Inc.')
  // --touch-events=enabled 会让页面误以为支持触摸，桌面版小红书不需要这层伪装
  for (const key of ['ontouchstart', 'ontouchmove', 'ontouchend']) {
    try { delete window[key] } catch (_) {}
    try { delete Window.prototype[key] } catch (_) {}
  }
}

function addStyle(css) {
  const style = document.createElement('style')
  style.setAttribute('data-moyu', 'rule')
  style.textContent = css
  ;(document.head || document.documentElement).appendChild(style)
  return style
}

/**
 * 命中元素往往只是内部一个 <span>（只藏它的话按钮框还在），
 * 需要向上回溯到真正的按钮/浮条容器再隐藏。
 */
function hideTarget(el) {
  let node = el
  while (node && node !== document.body) {
    const cls = (typeof node.className === 'string' ? node.className : '').toLowerCase()
    const tag = node.tagName
    if (tag === 'BUTTON' || tag === 'A' || tag === 'M-OPEN-APP') return node
    if (/button|btn|openapp|open-app|launch|app-|download|\bbar\b/.test(cls)) return node
    if (node.getBoundingClientRect().height > 90) break // 别膨胀到内容区
    node = node.parentElement
  }
  return el
}

/** 启发式清理：只动"边缘/fixed + 短文本 + 关键词"的小元素，避免误伤内容 */
function sweepOnce() {
  const vw = window.innerWidth
  const vh = window.innerHeight
  let n = 0
  for (const el of document.querySelectorAll('div,a,button,span,section,header,footer')) {
    if (el.closest('video,main article,[role="main"]')) continue
    const own = ([...el.childNodes]
      .filter((x) => x.nodeType === 3)
      .map((x) => x.textContent)
      .join('') || '').replace(/\s+/g, '')
    if (!own || own.length > 12 || !GENERIC_KEYWORDS.test(own)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0 || r.height > 140 || r.width > vw * 0.96) continue
    const fixed = getComputedStyle(el).position === 'fixed'
    const atEdge = r.top < 140 || r.bottom > vh - 140
    if (!(fixed || atEdge)) continue
    const target = hideTarget(el)
    if (target.dataset && target.dataset.moyuSwept) continue
    target.style.setProperty('display', 'none', 'important')
    if (target.dataset) target.dataset.moyuSwept = '1'
    n++
    if (n > 40) break
  }
  return n
}

function startSweepObserver() {
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    setTimeout(() => {
      queued = false
      try {
        sweepOnce()
      } catch (_) {}
    }, 400)
  }
  const mo = new MutationObserver(schedule)
  const attach = () => {
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true })
    schedule()
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true })
  } else {
    attach()
  }
  // SPA 路由切换后新浮条出现的兜底
  setInterval(() => {
    try {
      sweepOnce()
    } catch (_) {}
  }, 4000)
}

;(function main() {
  const host = location.hostname
  if (/(^|\.)xiaohongshu\.com$/.test(host)) injectDesktopDisguise()
  else injectBaseDisguise()

  const ready = (fn) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true })
    else fn()
  }

  ready(() => {
    const rules = HOST_RULES.filter((r) => r.match.test(host))
    if (rules.length) addStyle(rules.map((r) => r.css).join('\n'))
    startSweepObserver()

    const base = document.createElement('style')
    base.textContent = `
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      body { overscroll-behavior: contain; }
    `
    document.head && document.head.appendChild(base)
  })
})()
