// Bibliotheque d'images : ajout (bouton, glisser-deposer, collage), suivi du tri en direct. Sans ce script, la page reste consultable (formulaires classiques).
(() => {
  const root = document.getElementById('library')
  if (!root) return
  const csrf = root.dataset.csrf
  const grid = document.getElementById('lib-grid')
  const errorBox = document.getElementById('lib-error')
  const input = document.getElementById('lib-input')
  const addBtn = document.getElementById('lib-add')
  const drop = document.getElementById('lib-drop')

  const showError = (msg) => {
    errorBox.textContent = ''
    if (!msg) return
    const p = document.createElement('p')
    p.className = 'alert error'
    p.setAttribute('role', 'alert')
    p.textContent = msg
    errorBox.append(p)
  }

  // --- envoi des fichiers, un par un ---
  let uploading = 0
  let uploaded = 0
  const zipReports = []
  const isZip = (f) => /\.zip$/i.test(f.name || '') || f.type === 'application/zip' || f.type === 'application/x-zip-compressed'
  const notice = (msg) => { errorBox.textContent = ''; const p = document.createElement('p'); p.className = 'alert ok'; p.setAttribute('role', 'status'); p.textContent = msg; errorBox.append(p) }
  const upload = (file) => new Promise((resolve) => {
    uploading++
    const zip = isZip(file)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', zip ? '/library/upload-zip' : '/library/upload')
    xhr.setRequestHeader('X-CSRF', csrf)
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'image'))
    const done = (err) => {
      uploading--
      if (err) showError(`${file.name || 'image'} : ${err}`); else uploaded++
      addBtn.textContent = uploading ? `Envoi… (${uploading})` : 'Ajouter des images ou un pack (.zip)'
      resolve()
    }
    xhr.onerror = () => done('connexion impossible.')
    xhr.onload = () => {
      let j = {}
      try { j = JSON.parse(xhr.responseText) } catch { /* pas du JSON */ }
      if (xhr.status === 200 && zip && typeof j.added === 'number') {
        zipReports.push(`${file.name} : ${j.added} image(s) ajoutee(s)${j.duplicates ? `, ${j.duplicates} doublon(s) ignore(s)` : ''}${j.ignored ? `, ${j.ignored} fichier(s) qui ne sont pas des images ignore(s)` : ''}${j.rejected ? `, ${j.rejected} image(s) refusee(s)` : ''}${j.stopped ? ` — arret : ${j.stopped}` : ''}`)
        if (j.added) uploaded++
        uploading--; addBtn.textContent = uploading ? `Envoi… (${uploading})` : 'Ajouter des images ou un pack (.zip)'; resolve()
      } else if (xhr.status === 200 && j.id) done(null); else done(j.error || (xhr.status === 413 ? 'trop gros.' : 'envoi impossible.'))
    }
    addBtn.textContent = `Envoi… (${uploading})`
    xhr.send(file)
  })
  const addFiles = async (files) => {
    showError('')
    uploaded = 0
    zipReports.length = 0
    for (const f of Array.from(files)) await upload(f)
    if (zipReports.length) sessionStorage.setItem('lib-notice', zipReports.join('\n'))
    if (uploaded) location.href = '/library?view=pending'; else if (zipReports.length) notice(zipReports.join(' · '))
  }
  const saved = sessionStorage.getItem('lib-notice')
  if (saved) { sessionStorage.removeItem('lib-notice'); notice(saved.split('\n').join(' · ')) }
  addBtn.addEventListener('click', () => input.click())
  input.addEventListener('change', () => { const fl = Array.from(input.files || []); input.value = ''; addFiles(fl) })
  document.addEventListener('paste', (e) => {
    if (e.target instanceof Element && e.target.closest('input, textarea')) return
    const fl = Array.from((e.clipboardData && e.clipboardData.files) || [])
    if (fl.length) { e.preventDefault(); addFiles(fl) }
  })
  let depth = 0
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); depth++; drop.hidden = false } })
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault() })
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; drop.hidden = true } })
  document.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; drop.hidden = true; addFiles(e.dataTransfer.files) })

  // --- recherche par description : l'IA cherche, la page suit l'etat de la tache ---
  const findForm = document.getElementById('lib-find-form')
  const findOut = document.getElementById('lib-find-out')
  if (findForm && findOut) {
    const csrfFind = document.getElementById('lib-find').dataset.csrf
    const btn = document.getElementById('lib-find-btn')
    const say = (text, cls) => { findOut.textContent = ''; const p = document.createElement('p'); p.className = cls || 'muted'; p.textContent = text; findOut.append(p) }
    let token = 0
    findForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const query = document.getElementById('lib-find-q').value.trim()
      if (query.length < 3) { say('Decris l\'image que tu cherches.', 'alert error'); return }
      const mine = ++token
      btn.disabled = true
      say('Recherche en cours : l\'IA parcourt tes images triees…')
      try {
        const r = await fetch('/library/find', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, credentials: 'same-origin', body: new URLSearchParams({ csrf: csrfFind, query }) })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { say(j.error || 'Recherche impossible.', 'alert error'); return }
        const started = Date.now()
        for (;;) {
          await new Promise((res) => setTimeout(res, 1800))
          if (mine !== token) return
          const s = await fetch('/library/find/' + j.jobId, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
          const st = await s.json().catch(() => ({}))
          if (st.state === 'done') { findOut.innerHTML = st.html; return }
          if (st.state === 'failed') { say(st.error || 'La recherche a echoue.', 'alert error'); return }
          if (!s.ok) { say(st.error || 'Recherche perdue.', 'alert error'); return }
          if (Date.now() - started > 8 * 60 * 1000) { say('La recherche prend trop de temps : reessaie plus tard.', 'alert error'); return }
          say('Recherche en cours : l\'IA parcourt tes images triees… (' + Math.round((Date.now() - started) / 1000) + ' s)')
        }
      } catch { say('Connexion impossible : reessaie.', 'alert error') } finally { if (mine === token) btn.disabled = false }
    })
  }

  // --- estimation du cout du tri (lots de 40, environ 0,15 $ par lot) ---
  const count = document.getElementById('lib-count')
  const estimate = document.getElementById('lib-estimate')
  if (count && estimate) {
    const update = () => {
      const n = Number.parseInt(count.value, 10) || Number.parseInt(count.max, 10) || 0
      const lots = Math.ceil(Math.min(n, Number.parseInt(count.max, 10) || n) / 40)
      estimate.textContent = lots ? `${lots} lot(s) de 40 au plus · environ ${(lots * 0.15).toFixed(2).replace('.', ',')} $` : ''
    }
    count.addEventListener('input', update)
    update()
  }

  // --- suivi du tri : on interroge le Host tant que des images sont « en cours de tri », puis on recharge la page ---
  if (root.dataset.sorting === 'true') {
    const poll = async () => {
      try {
        const r = await fetch('/library/live' + location.search, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
        if (r.status === 401 || r.redirected) { location.reload(); return }
        const j = await r.json()
        if (!j.counts.sorting) { location.reload(); return }
        if (grid.innerHTML !== j.html) grid.innerHTML = j.html
      } catch { /* on reessaie */ }
      window.setTimeout(poll, document.hidden ? 15000 : 2500)
    }
    window.setTimeout(poll, 2500)
  }
})()
