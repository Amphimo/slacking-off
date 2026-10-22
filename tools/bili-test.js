'use strict'

/** 匿名回归：feed → 详情 → 播放直链 → 评论。不依赖 Electron，不发写操作。 */

const { BiliService } = require('../src/bili/service')

const session = { fetch: (url, init) => fetch(url, init) }

async function main() {
  const s = new BiliService(session)

  const feed = await s.feed(true)
  if (!feed.cards.length) throw new Error('feed 为空')
  console.log(`feed: ${feed.cards.length} 张，首卡 ${feed.cards[0].bvid} / ${feed.cards[0].title.slice(0, 30)}`)

  const d = await s.detail(feed.cards[0].bvid)
  if (!d.title) throw new Error('详情缺标题')
  console.log(`detail: ${d.bvid} aid=${d.aid} pages=${d.pages.length} 评论=${d.commentTotal}`)
  console.log(`comments: ${d.comments.length} 条已加载，播放=${d.play ? d.play.qualityText : '无'}`)
  if (!d.play) throw new Error('没有播放地址')

  const search = await s.search('B站', 1)
  if (!search.cards.length) throw new Error('搜索结果为空')
  console.log(`search: ${search.cards.length} 张，首条 ${search.cards[0].bvid} / ${search.cards[0].title.slice(0, 30)}`)

  const media = await fetch(d.play.segments[0], { headers: { Range: 'bytes=0-1023' } })
  if (!media.ok) throw new Error(`播放直链 HTTP ${media.status}`)
  console.log(`media: HTTP ${media.status} ${media.headers.get('content-type')} ${(await media.arrayBuffer()).byteLength}B`)

  const qr = await s.loginStart()
  if (!/^https?:/.test(qr.url)) throw new Error('二维码内容异常')
  console.log(`qr: ${qr.url.slice(0, 80)}...`)

  console.log('OK')
}

main().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
