'use strict'

const { contextBridge, ipcRenderer, shell } = require('electron')

contextBridge.exposeInMainWorld('panel', {
  feed: (offset, pull) => ipcRenderer.invoke('panel:xhh-feed', { offset, pull }),
  openExternal: (url) => shell.openExternal(url),
  me: () => ipcRenderer.invoke('panel:xhh-me'),
  loginStart: () => ipcRenderer.invoke('panel:xhh-login-start'),
  loginPoll: () => ipcRenderer.invoke('panel:xhh-login-poll'),
  logout: () => ipcRenderer.invoke('panel:xhh-logout'),
  detail: (linkid) => ipcRenderer.invoke('panel:xhh-detail', { linkid }),
  likePost: (linkid, on) => ipcRenderer.invoke('panel:xhh-like-post', { linkid, on }),
  likeComment: (commentId, on) => ipcRenderer.invoke('panel:xhh-like-comment', { commentId, on }),
  favPost: (linkid, on) => ipcRenderer.invoke('panel:xhh-fav-post', { linkid, on: on !== false }),
  subComments: (rootId, lastval) => ipcRenderer.invoke('panel:xhh-sub-comments', { rootId, lastval }),
  favFolders: () => ipcRenderer.invoke('panel:xhh-fav-folders'),
  favourites: (folderId) => ipcRenderer.invoke('panel:xhh-fav', folderId),
  messages: () => ipcRenderer.invoke('panel:xhh-msg'),
})

contextBridge.exposeInMainWorld('bili', {
  feed: (refresh) => ipcRenderer.invoke('bili:feed', { refresh: !!refresh }),
  search: (keyword, pn) => ipcRenderer.invoke('bili:search', { keyword, pn }),
  me: () => ipcRenderer.invoke('bili:me'),
  loginStart: () => ipcRenderer.invoke('bili:login-start'),
  loginPoll: () => ipcRenderer.invoke('bili:login-poll'),
  logout: () => ipcRenderer.invoke('bili:logout'),
  detail: (bvid) => ipcRenderer.invoke('bili:detail', { bvid }),
  play: (bvid, cid) => ipcRenderer.invoke('bili:play', { bvid, cid }),
  comments: (aid, pn) => ipcRenderer.invoke('bili:comments', { aid, pn }),
  subComments: (aid, root, pn) => ipcRenderer.invoke('bili:sub-comments', { aid, root, pn }),
  like: (bvid, on) => ipcRenderer.invoke('bili:like', { bvid, on: on !== false }),
  likeComment: (aid, rpid, on) => ipcRenderer.invoke('bili:like-comment', { aid, rpid, on: on !== false }),
  favourite: (bvid, aid, on) => ipcRenderer.invoke('bili:fav', { bvid, aid, on: on !== false }),
  favFolders: () => ipcRenderer.invoke('bili:fav-folders'),
  favourites: (folderId) => ipcRenderer.invoke('bili:favourites', { folderId }),
  openExternal: (url) => shell.openExternal(url),
})

contextBridge.exposeInMainWorld('douyin', {
  feed: (refresh) => ipcRenderer.invoke('douyin:feed', { refresh: !!refresh }),
  search: (keyword, cursor) => ipcRenderer.invoke('douyin:search', { keyword, cursor }),
  me: () => ipcRenderer.invoke('douyin:me'),
  login: () => ipcRenderer.invoke('douyin:login'),
  verify: () => ipcRenderer.invoke('douyin:verify'),
  verifyHide: () => ipcRenderer.invoke('douyin:verify-hide'),
  logout: () => ipcRenderer.invoke('douyin:logout'),
  detail: (id) => ipcRenderer.invoke('douyin:detail', { id }),
  comments: (id, cursor) => ipcRenderer.invoke('douyin:comments', { id, cursor }),
  replies: (id, commentId, cursor) => ipcRenderer.invoke('douyin:replies', { id, commentId, cursor }),
  like: (id, liked) => ipcRenderer.invoke('douyin:like', { id, liked: !!liked }),
  collect: (id, collected, awemeType) => ipcRenderer.invoke('douyin:collect', { id, collected: !!collected, awemeType: Number(awemeType) || 0 }),
})
