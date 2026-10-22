'use strict'

const crypto = require('node:crypto')

// B站 WBI 混淆表，官方 web 端固定值
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function mixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n] || '').join('').slice(0, 32)
}

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex')
}

/** 对 query 参数做 wbi 签名，返回已排好序的 query string（含 wts/w_rid） */
function signWbi(params, imgKey, subKey, now = Math.floor(Date.now() / 1000)) {
  const mixin = mixinKey(String(imgKey) + String(subKey))
  const all = { ...params, wts: now }
  const query = Object.keys(all)
    .filter((k) => all[k] !== undefined && all[k] !== null && all[k] !== '')
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  return `${query}&w_rid=${md5(query + mixin)}`
}

module.exports = { signWbi, mixinKey }
