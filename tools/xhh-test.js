'use strict'

/** 实测小黑盒 API：匿名 vs 带参，验证签名与登录要求 */

const { makeClient, unwrap } = require('../src/xhh/client')

async function tryCall(label, fn) {
  try {
    const r = await fn()
    console.log(`[${label}] OK ->`, JSON.stringify(r).slice(0, 400))
  } catch (e) {
    console.log(`[${label}] FAIL ->`, e.message)
  }
}

async function main() {
  const c = makeClient({ deviceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' })

  await tryCall('feeds(匿名)', async () => {
    const p = await c.get('/bbs/app/feeds', { offset: '0', pull: '0', dw: '800' })
    const r = unwrap(p, '推荐动态')
    const links = r.links || []
    return {
      total: links.length,
      first: links[0] && {
        title: (links[0].link ? links[0].link.title : links[0].title || '').slice(0, 40),
        game: links[0].link && links[0].link.game && links[0].link.game.name,
      },
    }
  })

  await tryCall('search/welcome_page(匿名)', async () => {
    const p = await c.get('/bbs/app/api/search/welcome_page/v2', {})
    return { keys: Object.keys(p.result || {}).slice(0, 6) }
  })

  await tryCall('topic/categories(匿名)', async () => {
    const p = await c.get('/bbs/app/topic/categories', {})
    const r = unwrap(p, '话题分类')
    return { count: (r.categories || r.category || []).length }
  })
}

main()
