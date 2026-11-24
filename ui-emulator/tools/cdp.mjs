// Pilote l'emulateur dans un Edge/Chrome sans fenetre via le protocole CDP (aucune dependance).
//   node tools/cdp.mjs run  [--shots <dossier>] [--only <sous-chaine>] [--wait 800] [--vp Desktop|Tablette|Telephone]
//   node tools/cdp.mjs shot <story> <fichier.png> [--vp Desktop]
// Base de l'emulateur : EMU_URL (defaut http://127.0.0.1:5174).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// `.env` du dossier de l'outil (EMU_URL, EDGE, EMU_DPR...). Une variable deja definie dans l'environnement reste prioritaire.
try {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
  if (fs.existsSync(envFile)) {
    for (const raw of fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      if (raw.trim().startsWith('#')) continue
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = /^(['"]).*\1$/.test(m[2]) ? m[2].slice(1, -1) : m[2]
    }
  }
} catch { /* .env illisible : on continue avec l'environnement */ }

const EDGE = process.env.EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = process.env.EMU_URL ?? 'http://127.0.0.1:5174'
const PORT = 9333 + Math.floor(Math.random() * 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def }

async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json() } catch {}
    await sleep(250)
  }
  throw new Error('navigateur non joignable: ' + url)
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const waiters = []
  const listeners = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method) { for (const l of listeners) l(m.method, m.params) }
    if (m.method) { for (const w of waiters.filter((x) => x.method === m.method)) { waiters.splice(waiters.indexOf(w), 1); w.res(m.params) } }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
  }
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) }),
      onEvent: (fn) => listeners.push(fn),
      waitEvent: (method, ms) => new Promise((res, rej) => { waiters.push({ method, res }); setTimeout(() => rej(new Error('pas d\'evenement ' + method)), ms) }),
      close: () => ws.close(),
    })
    ws.onerror = reject
  })
}

async function evalJs(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) + '')
  return r.result.value
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emu-edge-'))
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--window-size=1800,1100', 'about:blank'], { stdio: 'ignore' })
  const cleanup = () => { try { child.kill() } catch {} ; try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  process.on('exit', cleanup)
  const hardStop = setTimeout(() => { console.error('delai global depasse'); cleanup(); process.exit(3) }, 900000)
  try {
    const targets = await waitJson(`http://127.0.0.1:${PORT}/json/list`)
    const page = targets.find((t) => t.type === 'page')
    const c = await connect(page.webSocketDebuggerUrl)
    await c.send('Page.enable')
    await c.send('Runtime.enable')
    await c.send('Debugger.enable') // doit etre actif AVANT un gel pour pouvoir interrompre une boucle infinie
    c.onEvent((method, p) => {
      if (method === 'Runtime.exceptionThrown') console.log('  EXC', String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).split('\n').slice(0, 3).join(' | ').slice(0, 400))
      if (method === 'Runtime.consoleAPICalled') { const t = p.args?.map((a) => a.value ?? a.description ?? '').join(' '); if (/^\[trace\]/.test(t) || p.type === 'error' || argv.includes('--verbose')) console.log('  console.' + p.type + ':', String(t).slice(0, 200)) } })
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1100, deviceScaleFactor: Number(process.env.EMU_DPR ?? 1), mobile: false }) // EMU_DPR=4 : captures haute resolution (mesures precises)
    const vp = opt('vp', '')
    const extra = process.env.EMU_QS ? '&' + process.env.EMU_QS : ''
    await c.send('Page.navigate', { url: `${BASE}/?fit=0${vp ? '&vp=' + vp : ''}${extra}` })
    for (let i = 0; i < 60; i++) { if (await evalJs(c, 'typeof window.__select === "function"').catch(() => false)) break; await sleep(500) }

    const shotsDir = opt('shots')
    if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true })
    const shot = async (file) => {
      const r = JSON.parse(await evalJs(c, 'JSON.stringify(document.getElementById("viewport").getBoundingClientRect())'))
      const { data } = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 } })
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
    }
    const wait = Number(opt('wait', 800))
    const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('HANG: ' + label)), ms))])
    const recover = async () => {
      await c.send('Page.navigate', { url: `${BASE}/?fit=0${vp ? '&vp=' + vp : ''}` })
      for (let i = 0; i < 60; i++) { if (await evalJs(c, 'typeof window.__select === "function"').catch(() => false)) break; await sleep(500) }
    }
    const one = async (name) => {
      try {
        await withTimeout(evalJs(c, 'window.__missing(true), 0'), 8000, 'missing')
        await withTimeout(evalJs(c, `window.__select(${JSON.stringify(name)}).then(() => 1)`), Number(opt('timeout', 12000)), name)
        await sleep(wait)
        return await readState(name)
      } catch (e) {
        if (/HANG/.test(e.message)) {
          // page figee (boucle infinie) : on l'interrompt pour savoir ou elle boucle
          console.log(`HANG ${name} : page figee, diagnostic...`)
          try {
            const paused = c.waitEvent('Debugger.paused', 15000)
            c.send('Debugger.pause').catch(() => {})
            const ev = await paused
            for (const f of ev.callFrames.slice(0, 8)) console.log('   at', f.functionName || '(anonyme)', f.url.replace(/^.*\/dont-fish-at-night\/src\//, '~/').replace(/^.*127\.0\.0\.1:5174/, ''), `:${f.location.lineNumber + 1}`)
          } catch (d) { console.log('   diagnostic impossible:', d.message) }
          process.exit(4)
        }
        await recover().catch(() => {})
        return { story: name, nodes: 0, errors: [String(e.message).slice(0, 200)], missing: [] }
      }
    }
    const readState = async (name) => {
      return JSON.parse(await withTimeout(evalJs(c, `JSON.stringify({
        story: ${JSON.stringify(name)},
        nodes: document.querySelectorAll('#viewport .rbx').length,
        errors: [...new Set(window.__report.errors.map(e => e.split('\\n').slice(0, 3).map(s => s.trim().replace(/http:\\/\\/127.0.0.1:5174\\/@fs\\/C:\\/Users\\/tangu\\/Documents\\/ROBLOX\\/Code\\/boilr\\/dont-fish-at-night\\/src\\//, '~/')).join(' | ').slice(0, 420)))],
        missing: window.__missing(false)
      })`), 8000, 'etat'))
    }

    if (cmd === 'act') {
      // node tools/cdp.mjs act <story> '<json>' : rend la story puis rejoue des gestes de souris reels (CDP Input.dispatchMouseEvent).
      // Etapes : {"move":[x,y]} {"down":[x,y]} {"up":[x,y]} {"click":[x,y]} {"wheel":[x,y,dy]} {"drag":[x1,y1,x2,y2]} {"wait":ms} {"eval":"js"} {"shot":"fichier"}
      // Coordonnees relatives a l'apercu (viewport de la story).
      await one(argv[1])
      const steps = JSON.parse(argv[2].startsWith('@') ? fs.readFileSync(argv[2].slice(1), 'utf8') : argv[2]) // '@fichier.json' : evite les soucis de guillemets du shell
      const off = JSON.parse(await evalJs(c, 'JSON.stringify((r => ({ x: r.left, y: r.top }))(document.getElementById("viewport").getBoundingClientRect()))'))
      const mouse = (type, x, y, extra = {}) => c.send('Input.dispatchMouseEvent', { type, x: x + off.x, y: y + off.y, button: 'left', buttons: type === 'mouseMoved' ? 0 : 1, clickCount: 1, ...extra })
      for (const st of steps) {
        if (st.move) await mouse('mouseMoved', ...st.move)
        else if (st.down) { await mouse('mouseMoved', ...st.down); await mouse('mousePressed', ...st.down) }
        else if (st.up) await mouse('mouseReleased', ...st.up)
        else if (st.click) { await mouse('mouseMoved', ...st.click); await mouse('mousePressed', ...st.click); await mouse('mouseReleased', ...st.click) }
        else if (st.wheel) { await mouse('mouseMoved', st.wheel[0], st.wheel[1]); await mouse('mouseWheel', st.wheel[0], st.wheel[1], { deltaX: 0, deltaY: st.wheel[2], buttons: 0 }) }
        else if (st.drag) {
          const [x1, y1, x2, y2] = st.drag
          await mouse('mouseMoved', x1, y1); await mouse('mousePressed', x1, y1)
          for (let i = 1; i <= 8; i++) await mouse('mouseMoved', x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8)
          await mouse('mouseReleased', x2, y2)
        } else if (st.wait) await sleep(st.wait)
        else if (st.eval) console.log('EVAL ' + JSON.stringify(await evalJs(c, st.eval)))
        else if (st.shot) await shot(st.shot)
        await sleep(60)
      }
    } else if (cmd === 'eval') {
      // node tools/cdp.mjs eval <story> "<js>" : rend la story puis evalue du JS dans la page (aide au diagnostic)
      await one(argv[1])
      console.log('RESULT ' + JSON.stringify(await evalJs(c, argv[2])))
    } else if (cmd === 'perf') {
      // Temps de rendu d'une story : 1er passage (modules a charger) puis 2e passage (a chaud), jusqu'a 2 images dessinees.
      const all = JSON.parse(await evalJs(c, 'JSON.stringify([...document.querySelectorAll("#side a")].map(a => a.textContent))'))
      const names = (opt('only') ? all.filter((n) => n.includes(opt('only'))) : all)
      const timeIt = (n) => evalJs(c, `(async () => { const t = performance.now(); await window.__select(${JSON.stringify(n)}); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return Math.round(performance.now() - t) })()`)
      const rows = []
      for (const n of names) {
        try {
          const cold = await withTimeout(timeIt(n), 20000, n)
          const warm = await withTimeout(timeIt(n), 20000, n)
          const nodes = await evalJs(c, 'document.querySelectorAll("#viewport .rbx").length')
          rows.push({ n, cold, warm, nodes })
          console.log(`${n.padEnd(34)} 1er=${String(cold).padStart(5)} ms   a chaud=${String(warm).padStart(4)} ms   noeuds=${nodes}`)
        } catch (e) { console.log(`${n.padEnd(34)} ECHEC ${String(e.message).slice(0, 60)}`); await recover().catch(() => {}) }
      }
      const w = rows.map((r) => r.warm).sort((a, b) => a - b)
      if (w.length) console.log(`\nA chaud : mediane ${w[Math.floor(w.length / 2)]} ms, max ${w[w.length - 1]} ms sur ${w.length} stories`)
    } else if (cmd === 'shot') {
      const r = await one(argv[1])
      console.log(JSON.stringify(r).slice(0, 1500))
      await shot(argv[2])
      if (argv.includes('--tree')) console.log('ARBRE ' + (await evalJs(c, 'JSON.stringify(window.__tree(3))')))
    } else {
      const all = JSON.parse(await evalJs(c, 'JSON.stringify([...document.querySelectorAll("#side a")].map(a => a.textContent))'))
      const only = opt('only')
      const names = only ? all.filter((n) => n.includes(only)) : all
      const out = []
      for (const n of names) {
        const r = await one(n)
        out.push(r)
        const ok = r.errors.length === 0 && r.nodes > 1
        console.log(`${ok ? 'OK ' : 'ERR'} ${n.padEnd(34)} n=${String(r.nodes).padEnd(3)} ${r.errors[0] ?? ''}${r.missing.length ? '  [manquants: ' + r.missing.slice(0, 3).join(', ') + ']' : ''}`)
        if (shotsDir) { try { await shot(path.join(shotsDir, n.replace(/[\\/]/g, '__') + '.png')) } catch (e) { console.log('   (pas de capture: ' + String(e.message).slice(0, 60) + ')') } }
      }
      fs.writeFileSync(path.join(shotsDir ?? '.', 'report.json'), JSON.stringify(out, null, 1))
      console.log(`\n${out.filter((r) => r.errors.length === 0 && r.nodes > 1).length}/${out.length} stories rendues sans erreur`)
    }
    c.close()
  } finally {
    clearTimeout(hardStop)
    cleanup()
  }
}
main().then(() => process.exit(0), (e) => { console.error('ECHEC:', e.message); process.exit(1) })
