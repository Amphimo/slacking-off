'use strict'

/**
 * 小黑盒 App 协议签名（Node 移植版）
 * 算法来源：WenfuRainbow/heybox (MIT) src/api/signature.ts
 * 仅依赖 node:crypto。
 */

const crypto = require('node:crypto')

const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89'

function md5(input) {
  return crypto.createHash('md5').update(input).digest('hex')
}

// GF(2^8) 位变换家族，用于 MD5 尾部字节的混淆
function vm(e) {
  return 128 & e ? 255 & ((e << 1) ^ 27) : e << 1
}
function qm(e) {
  return vm(e) ^ e
}
function dollarM(e) {
  return qm(vm(e))
}
function ym(e) {
  return dollarM(qm(vm(e)))
}
function gm(e) {
  return ym(e) ^ dollarM(e) ^ qm(e)
}
function km(e) {
  const t = [0, 0, 0, 0]
  t[0] = gm(e[0]) ^ ym(e[1]) ^ dollarM(e[2]) ^ qm(e[3])
  t[1] = qm(e[0]) ^ gm(e[1]) ^ ym(e[2]) ^ dollarM(e[3])
  t[2] = dollarM(e[0]) ^ qm(e[1]) ^ gm(e[2]) ^ ym(e[3])
  t[3] = ym(e[0]) ^ dollarM(e[1]) ^ qm(e[2]) ^ gm(e[3])
  e[0] = t[0]
  e[1] = t[1]
  e[2] = t[2]
  e[3] = t[3]
  return e
}

function av(text, alphabet, offset) {
  let result = ''
  const sliced = alphabet.slice(0, offset)
  for (let i = 0; i < text.length; i++) {
    result += sliced[text.charCodeAt(i) % sliced.length]
  }
  return result
}

function sv(text, alphabet) {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    result += alphabet[text.charCodeAt(i) % alphabet.length]
  }
  return result
}

function interleave(arr) {
  let result = ''
  const maxLen = Math.max(...arr.map((s) => s.length))
  for (let i = 0; i < maxLen; i++) {
    for (const s of arr) {
      if (i < s.length) result += s[i]
    }
  }
  return result
}

/** 核心：对 API 路径生成 hkey 校验码 */
function ov(path, timestamp, nonce) {
  const normalizedPath = '/' + path.split('/').filter((s) => s).join('/') + '/'
  const encT = av(String(timestamp), ALPHABET, -2)
  const encP = sv(normalizedPath, ALPHABET)
  const encN = sv(nonce, ALPHABET)
  const interleaved = interleave([encT, encP, encN]).slice(0, 20)
  const hash = md5(interleaved)
  const last6Codes = hash.slice(-6).split('').map((c) => c.charCodeAt(0))
  const transformed = km([...last6Codes])
  let checksum = String(transformed.reduce((sum, val) => sum + val, 0) % 100)
  if (checksum.length < 2) checksum = '0' + checksum
  const prefix = av(hash.substring(0, 5), ALPHABET, -4)
  return prefix + checksum
}

/**
 * 为 API 路径生成签名
 * @returns {{ hkey: string, _time: number, nonce: string }}
 */
function generateSignature(apiPath) {
  const timestamp = Math.floor(Date.now() / 1000)
  const nonce = md5(timestamp + Math.random().toString()).toUpperCase()
  return generateSignatureFor(apiPath, timestamp, nonce)
}

function generateSignatureFor(apiPath, timestamp, nonce) {
  const hkey = ov(apiPath, timestamp + 1, nonce)
  return { hkey, _time: timestamp, nonce }
}

module.exports = { generateSignature, generateSignatureFor, md5 }
