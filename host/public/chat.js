// Interface de chat : mise a jour en direct (liste des chats, fil de la conversation), envoi sans rechargement, saisie confortable.
// Amelioration progressive : sans ce script, les formulaires fonctionnent par rechargement classique.
(() => {
  const app = document.getElementById('chat-app')
  if (!app) return

  const liveUrl = app.dataset.live
  const list = document.getElementById('chat-list')
  const messages = document.getElementById('messages')
  const composer = document.getElementById('composer')
  const errorBox = document.getElementById('composer-error')
  const textarea = composer ? composer.querySelector('textarea') : null
  const baseTitle = document.title

  // --- bascule de la liste des chats (petits ecrans) ---
  for (const b of document.querySelectorAll('[data-toggle-list]')) b.addEventListener('click', () => app.classList.toggle('show-list'))

  // --- defilement : on suit le bas du fil, sauf si l'utilisateur est remonte lire plus haut ---
  const nearBottom = () => !messages || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90
  const toBottom = () => { if (messages) messages.scrollTop = messages.scrollHeight }
  toBottom()

  // --- details ouverts / fermes : le choix de l'utilisateur survit aux mises a jour ---
  const opened = new Map()
  document.addEventListener('toggle', (e) => {
    const d = e.target
    if (d instanceof HTMLDetailsElement && d.dataset.k) opened.set(d.dataset.k, d.open)
  }, true)
  const restoreDetails = (root) => {
    for (const d of root.querySelectorAll('details[data-k]')) if (opened.has(d.dataset.k)) d.open = opened.get(d.dataset.k)
  }
  restoreDetails(document)

  // --- mise a jour du fil SANS recharger les apercus d'interface ---
  // Remplacer tout le HTML rechargerait les <iframe> (l'etat d'un apercu interactif serait perdu a chaque mise a jour) : on ne touche qu'aux messages qui
  // ont change. Deplacer un <iframe> dans la page le recharge aussi : les messages inchanges restent donc exactement ou ils sont.
  const sameHtml = (a, b) => a.outerHTML.replace(/ open=""/g, '') === b.outerHTML.replace(/ open=""/g, '')
  const patchThread = (container, html) => {
    const tmp = document.createElement('div')
    tmp.innerHTML = html
    const next = tmp.querySelector('.thread')
    const cur = container.querySelector('.thread')
    if (!next || !cur) { container.innerHTML = html; return }
    const keyOf = (el, i) => el.id || 'n' + i
    const old = new Map()
    Array.from(cur.children).forEach((el, i) => old.set(keyOf(el, i), el))
    let prev = null
    Array.from(next.children).forEach((el, i) => {
      const k = keyOf(el, i)
      const o = old.get(k)
      let node
      if (o && sameHtml(o, el)) { node = o; old.delete(k) }
      else if (o) { o.replaceWith(el); old.delete(k); node = el }
      else { node = el; if (prev) prev.after(node); else cur.prepend(node) }
      prev = node
    })
    for (const o of old.values()) o.remove()
  }

  // --- mise a jour en direct ---
  let lastList = list ? list.innerHTML : ''
  let lastThread = messages ? messages.innerHTML : ''
  let timer = 0
  let inflight = false

  const setPending = (pending) => {
    app.dataset.pending = String(pending)
    if (!composer) return
    for (const el of composer.querySelectorAll('textarea, button.send')) el.disabled = pending || el.dataset.locked === '1'
  }
  if (composer) for (const el of composer.querySelectorAll('textarea, button.send')) if (el.disabled && app.dataset.pending !== 'true') el.dataset.locked = '1'

  const apply = (j) => {
    if (list && j.list !== lastList) { list.innerHTML = j.list; lastList = j.list }
    if (messages && j.thread !== lastThread) {
      const stick = nearBottom()
      patchThread(messages, j.thread)
      lastThread = j.thread
      restoreDetails(messages)
      if (stick) toBottom()
    }
    const wasPending = app.dataset.pending === 'true'
    setPending(j.pending)
    if (wasPending && !j.pending && textarea && !textarea.disabled && document.activeElement === document.body) textarea.focus()
    document.title = (j.unread ? `(${j.unread}) ` : '') + baseTitle
    return j
  }

  const poll = async () => {
    window.clearTimeout(timer)
    if (!liveUrl || inflight) return
    inflight = true
    let next = 4000
    try {
      const r = await fetch(liveUrl, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
      if (r.status === 401 || r.status === 302 || r.redirected) { location.reload(); return }
      if (r.ok) {
        const j = apply(await r.json())
        next = j.pending ? 1200 : j.busy ? 2500 : 6000
      } else next = 8000
    } catch { next = 8000 } finally { inflight = false }
    timer = window.setTimeout(poll, document.hidden ? 15000 : next)
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() })
  if (liveUrl) timer = window.setTimeout(poll, 1200)

  // --- envoi sans rechargement (messages, arret) ---
  const showError = (msg) => {
    if (!errorBox) return
    errorBox.textContent = ''
    if (!msg) return
    const p = document.createElement('p')
    p.className = 'alert error'
    p.setAttribute('role', 'alert')
    p.textContent = msg
    errorBox.append(p)
  }

  // --- fichiers joints : bouton, glisser-deposer, collage ; televerses un par un (avec progression) avant l'envoi du message ---
  const attachUrl = composer ? composer.dataset.attach : ''
  const csrf = composer ? composer.dataset.csrf : ''
  const staged = document.getElementById('attach-staged')
  const idsInput = document.getElementById('attachments')
  const fileInput = document.getElementById('file-input')
  const attachBtn = document.getElementById('attach-btn')
  let uploading = 0
  const stagedIds = () => (staged ? Array.from(staged.querySelectorAll('.achip[data-id]')).map((el) => el.dataset.id) : [])
  const syncIds = () => { if (idsInput) idsInput.value = stagedIds().join(',') }
  const fmt = (n) => (n < 1024 ? n + ' o' : n < 1048576 ? Math.round(n / 1024) + ' Ko' : (n / 1048576).toFixed(1) + ' Mo')
  const mk = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text !== undefined) x.textContent = text; return x }

  const chipFor = (name, size) => {
    const chip = mk('span', 'achip staged uploading')
    chip.append(mk('span', 'ak', '…'), mk('span', 'an', name), mk('span', 'as', fmt(size)), mk('span', 'bar'))
    return chip
  }
  const finishChip = (chip, f) => {
    chip.classList.remove('uploading')
    chip.dataset.id = f.id
    const bar = chip.querySelector('.bar')
    if (bar) bar.remove()
    const ak = chip.querySelector('.ak')
    if (f.url) { const img = mk('img'); img.src = f.url; img.alt = ''; ak.replaceWith(img) } else ak.textContent = f.kind === 'pdf' ? 'PDF' : f.kind === 'text' ? 'TXT' : 'FICHIER'
    chip.querySelector('.an').textContent = f.name
    const x = mk('button', 'x', '×')
    x.type = 'button'
    x.dataset.remove = '1'
    x.setAttribute('aria-label', 'Retirer ' + f.name)
    chip.append(x)
    syncIds()
  }

  const upload = (file) => new Promise((resolve) => {
    if (!attachUrl || !staged) return resolve()
    const chip = chipFor(file.name || 'image', file.size)
    staged.append(chip)
    uploading++
    const xhr = new XMLHttpRequest()
    xhr.open('POST', attachUrl)
    xhr.setRequestHeader('X-CSRF', csrf)
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'image'))
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) chip.style.setProperty('--p', Math.round((e.loaded / e.total) * 100) + '%') }
    const done = (err, f) => {
      uploading--
      if (err) { chip.remove(); showError(err) } else finishChip(chip, f)
      resolve()
    }
    xhr.onerror = () => done('Connexion impossible pendant le televersement.')
    xhr.onload = () => {
      let j = {}
      try { j = JSON.parse(xhr.responseText) } catch { /* reponse non JSON */ }
      if (xhr.status === 200 && j.id) done(null, j)
      else done(j.error || (xhr.status === 413 ? 'Fichier trop gros.' : 'Televersement impossible.'))
    }
    xhr.send(file)
  })
  const addFiles = async (files) => {
    showError('')
    for (const f of Array.from(files)) await upload(f)
  }
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => { const fl = Array.from(fileInput.files || []); fileInput.value = ''; addFiles(fl) })
  }
  if (staged) staged.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-remove]') : null
    const chip = b ? b.closest('.achip') : null
    if (!chip || !chip.dataset.id) return
    fetch(attachUrl + '/' + chip.dataset.id + '/delete', { method: 'POST', headers: { 'X-CSRF': csrf, Accept: 'application/json' }, credentials: 'same-origin' }).catch(() => {})
    chip.remove()
    syncIds()
  })
  if (composer && attachUrl) {
    // collage d'images (captures d'ecran) dans la zone de texte
    composer.addEventListener('paste', (e) => {
      const fl = Array.from((e.clipboardData && e.clipboardData.files) || [])
      if (fl.length) { e.preventDefault(); addFiles(fl) }
    })
    // glisser-deposer sur toute la page de chat
    let depth = 0
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
    app.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); depth++; app.classList.add('dropping') } })
    app.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
    app.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; app.classList.remove('dropping') } })
    app.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; app.classList.remove('dropping'); addFiles(e.dataTransfer.files) })
  }

  if (composer) {
    composer.addEventListener('submit', async (e) => {
      e.preventDefault()
      const submitter = e.submitter
      // (la propriete `formAction` d'un bouton sans attribut renvoie l'adresse de la PAGE, pas celle du formulaire : on lit l'attribut)
      const own = submitter && submitter.getAttribute('formaction')
      const url = own ? new URL(own, location.href).href : composer.action
      const stopping = /\/cancel$/.test(url)
      if (!stopping && textarea && !textarea.value.trim() && !stagedIds().length) return
      if (!stopping && uploading) { showError('Attends la fin du televersement des fichiers.'); return }
      showError('')
      const body = new URLSearchParams(new FormData(composer))
      try {
        const r = await fetch(url, { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { showError(j.error || 'Envoi impossible.'); return }
        if (!stopping && textarea) { textarea.value = ''; grow() }
        if (!stopping && staged) { staged.textContent = ''; syncIds() }
        toBottom()
        poll()
      } catch { showError('Connexion impossible : reessaie.') }
    })

    // Entree envoie, Maj+Entree passe a la ligne (sauf pendant une composition IME)
    const grow = () => {
      if (!textarea) return
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
    }
    if (textarea) {
      textarea.addEventListener('input', grow)
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          if (textarea.value.trim() || stagedIds().length) composer.requestSubmit(composer.querySelector('button.send'))
        }
      })
      if (!textarea.disabled) textarea.focus()
    }
  }
})()
