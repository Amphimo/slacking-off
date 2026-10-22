'use strict'

const api = window.shell
const tabs = document.getElementById('tabs')
const hint = document.getElementById('hint')

let cfg = null
let activeId = null
const opacitySteps = [1, 0.9, 0.75, 0.55]
let opacityIdx = 0

api.onBootstrap(init)

function init(payload) {
  cfg = payload

  cfg.sites.forEach((site, i) => {
    const b = document.createElement('button')
    b.className = 'tab' + (i === 0 ? ' active' : '')
    b.textContent = site.name
    b.dataset.site = site.id
    b.addEventListener('click', () => activate(site.id))
    tabs.appendChild(b)
  })

  document.getElementById('btnTop').classList.toggle('on', payload.alwaysOnTop)
  bindButtons()
  activate(cfg.sites[0].id)
  flashHint()
}

function activate(id) {
  activeId = id
  for (const child of tabs.children) {
    child.classList.toggle('active', child.dataset.site === id)
  }
  api.showSite(id)
}

function bindButtons() {
  document.getElementById('winbtn').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    if (b.dataset.act === 'min') api.minimize()
    else api.closeApp()
  })

  document.getElementById('toolbar').addEventListener('click', async (e) => {
    const b = e.target.closest('button')
    if (!b || !activeId) return
    switch (b.dataset.act) {
      case 'back':
        api.viewBack()
        break
      case 'reload':
        api.viewReload()
        break
      case 'narrow':
        api.zoomView(-20)
        break
      case 'wider':
        api.zoomView(20)
        break
      case 'top':
        b.classList.toggle('on', await api.toggleTop())
        break
      case 'fade':
        opacityIdx = (opacityIdx + 1) % opacitySteps.length
        api.setOpacity(opacitySteps[opacityIdx])
        b.classList.toggle('on', opacityIdx !== 0)
        break
      case 'declutter': {
        const msg = await api.declutter()
        flashHint(msg)
        break
      }
      case 'reset':
        await api.viewReset(activeId)
        break
    }
  })
}

let hintTimer = null
function flashHint(text) {
  clearTimeout(hintTimer)
  hint.textContent = text || 'Ctrl + Alt + M 快速隐藏 / 呼出'
  hint.classList.add('show')
  hintTimer = setTimeout(() => hint.classList.remove('show'), 3200)
}
