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
    if (uploaded) location.reload(); else if (zipReports.length) notice(zipReports.join(' · '))
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

  // --- suivi du tri : on interroge le Host tant que des images sont « en cours de tri », puis on recharge la page ---
  if (root.dataset.sorting === 'true') {
    const poll = async () => {
      try {
        const r = await fetch('/library/live?group=' + encodeURIComponent(root.dataset.group || 'scope'), { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
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
