'use strict'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

// 桌面 Chrome UA：小红书用。移动 UA 会被官方降级成「热门+广告+引导下载 App」的残缺页
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// ua: null 表示用 Electron 默认桌面 UA
// fitZoom: 桌面版页面(min-width 超宽)动态缩放适配窗口；点进自适应宽度的页面(如沉浸流)后自动回 1
const SITES = [
  {
    id: 'douyin',
    name: '抖音',
    color: '#FE2C55',
    type: 'panel', // 借用隐藏抖音页面的 axios 完成签名，面板做竖屏沉浸播放
    // 默认 Electron UA 会暴露 Electron/33，楼中楼接口直接被风控；用普通 Chrome UA 才放行。
    ua: DESKTOP_UA,
    url: '',
    note: '竖屏刷推荐/搜索结果，不再缩放整张桌面网页；搜索和登录态依赖已登录的 persist:moyu_douyin',
  },
  {
    id: 'xhs',
    name: '小红书',
    color: '#FF2442',
    ua: DESKTOP_UA,
    url: 'https://www.xiaohongshu.com/',
    note: '桌面版 + 窄屏响应式：可扫码登录，登录后是个人推荐、收藏和评论；移动 UA 只会推热门并引导下载 App',
  },
  {
    id: 'bili',
    name: 'B站',
    color: '#FB7299',
    type: 'panel', // App/Web API 面板：走推荐 feed + 视频直链播放，复用网页登录 cookie
    ua: DESKTOP_UA,
    url: '',
    note: '网页版点视频会引导下载 App / 跳 Microsoft Store；面板内直接播放 MP4，登录态来自 persist:moyu_bili',
  },
  {
    id: 'xhh',
    name: '小黑盒',
    color: '#1F1F1F',
    type: 'panel', // 不再嵌网页：走 App 协议 API（签名移植自 heybox 插件），面板自绘
    url: '',
    note: '匿名可刷推荐流（实测）；帖子详情/评论需登录态，二期做扫码登录',
  },
]

module.exports = { SITES, IPHONE_UA, ANDROID_UA }
