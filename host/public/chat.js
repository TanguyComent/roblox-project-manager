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
      messages.innerHTML = j.thread
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

  if (composer) {
    composer.addEventListener('submit', async (e) => {
      e.preventDefault()
      const submitter = e.submitter
      // (la propriete `formAction` d'un bouton sans attribut renvoie l'adresse de la PAGE, pas celle du formulaire : on lit l'attribut)
      const own = submitter && submitter.getAttribute('formaction')
      const url = own ? new URL(own, location.href).href : composer.action
      const stopping = /\/cancel$/.test(url)
      if (!stopping && textarea && !textarea.value.trim()) return
      showError('')
      const body = new URLSearchParams(new FormData(composer))
      try {
        const r = await fetch(url, { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { showError(j.error || 'Envoi impossible.'); return }
        if (!stopping && textarea) { textarea.value = ''; grow() }
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
          if (textarea.value.trim()) composer.requestSubmit(composer.querySelector('button.send'))
        }
      })
      if (!textarea.disabled) textarea.focus()
    }
  }
})()
