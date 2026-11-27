// Rendu Markdown MINIMAL et sur des reponses de l'IA : tout le texte est echappe AVANT d'ajouter la moindre balise, donc rien venant de l'IA
// n'est jamais interprete comme du HTML. Prend en charge : titres, listes, citations, blocs de code, code en ligne, gras, italique, liens http(s), tableaux.
import { esc } from './views.ts'

const URL_OK = /^https?:\/\/[^\s<>"']+$/

// Mise en forme « en ligne » d'un texte DEJA echappe par morceaux : le code en ligne est isole d'abord pour ne pas etre mis en forme.
export function renderInline(raw: string): string {
  return raw.split(/(`[^`\n]+`)/g).map((part, i) => {
    if (i % 2 === 1) return `<code>${esc(part.slice(1, -1))}</code>`
    let s = esc(part)
    s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, label: string, url: string) => {
      const plain = url.replace(/&amp;/g, '&')
      return URL_OK.test(plain) ? `<a href="${esc(plain)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m
    })
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
    return s
  }).join('')
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-')
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export interface MarkdownOptions {
  /**
   * Rendu des blocs ```rpm-ui (apercus d'interface) : recoit le rang du bloc (0, 1, 2...) et son contenu brut, renvoie du HTML SUR (a la charge de l'appelant).
   * Numerotation identique a celle du Worker (worker/src/preview.ts, scanFences) : seuls les blocs de code de premier niveau comptent.
   */
  uiBlock?: (n: number, raw: string) => string
}

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  let uiN = 0
  const startsBlock = (l: string) => /^(```|#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?|\s*---+\s*$)/.test(l)

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    const fence = /^```([\w+-]*)[ \t]*$/.exec(line)
    if (fence) {
      const code: string[] = []
      i++
      while (i < lines.length && !/^```[ \t]*$/.test(lines[i])) code.push(lines[i++])
      i++ // fence fermante (absente : le bloc va jusqu'a la fin)
      if (fence[1] === 'rpm-ui' && opts.uiBlock) { out.push(opts.uiBlock(uiN++, code.join('\n'))); continue }
      out.push(`<pre class="code md-code"><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { const level = Math.min(6, h[1].length + 2); out.push(`<h${level} class="md-h">${renderInline(h[2])}</h${level}>`); i++; continue }
    if (/^\s*---+\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (/^>\s?/.test(line)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${q.map(renderInline).join('<br>')}</blockquote>`)
      continue
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (li) {
      const ordered = /\d/.test(li[1])
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!m || /\d/.test(m[1]) !== ordered) break
        items.push(`<li>${renderInline(m[2])}</li>`)
        i++
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++])
    out.push(`<p>${para.map(renderInline).join('<br>')}</p>`)
  }
  return out.join('\n')
}
