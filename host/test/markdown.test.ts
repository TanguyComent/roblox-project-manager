import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMarkdown, renderInline } from '../src/markdown.ts'

test('mise en forme courante', () => {
  assert.equal(renderInline('un **gras**, un *italique* et du `code`'), 'un <strong>gras</strong>, un <em>italique</em> et du <code>code</code>')
  assert.equal(renderInline('2 * 3 * 4'), '2 * 3 * 4', 'des etoiles isolees ne font pas d\'italique')
  assert.equal(renderInline('`**pas gras**`'), '<code>**pas gras**</code>', 'pas de mise en forme dans le code')
  assert.match(renderMarkdown('# Titre\n\ntexte'), /<h3 class="md-h">Titre<\/h3>\n<p>texte<\/p>/)
  assert.match(renderMarkdown('- un\n- deux'), /<ul><li>un<\/li><li>deux<\/li><\/ul>/)
  assert.match(renderMarkdown('1. un\n2) deux'), /<ol><li>un<\/li><li>deux<\/li><\/ol>/)
  assert.match(renderMarkdown('> cite'), /<blockquote>cite<\/blockquote>/)
  assert.match(renderMarkdown('ligne 1\nligne 2'), /<p>ligne 1<br>ligne 2<\/p>/)
  assert.match(renderMarkdown('```lua\nlocal x = 1 < 2\n```'), /<pre class="code md-code"><code>local x = 1 &lt; 2<\/code><\/pre>/)
  assert.match(renderMarkdown('```\nsans fin'), /<code>sans fin<\/code>/, 'bloc de code non ferme')
  assert.match(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/)
  assert.equal(renderMarkdown(''), '')
})

test('liens : http(s) seulement', () => {
  assert.match(renderInline('[doc](https://example.com/a?b=1&c=2)'), /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">doc<\/a>/)
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'ftp://x/y']) {
    assert.ok(!renderInline(`[x](${bad})`).includes('<a '), bad)
  }
})

test('aucun HTML venant du texte n\'est interprete', () => {
  const evil = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '**<b>x</b>**', '[<img src=x onerror=1>](https://a.b)',
    '[x](https://a.b" onmouseover="alert(1))', '`<script>`', '```\n<script>alert(1)</script>\n```', '# <svg onload=alert(1)>',
    '| <a> | b |\n|---|---|\n| <iframe> | 2 |', '> <script>', '- <style>x</style>', '"><script>alert(1)</script>',
  ]
  // On retire uniquement les balises que NOUS produisons (avec leurs seuls attributs prevus) : il ne doit plus rester un seul « < ».
  const ours = /<\/?(strong|em|code|pre|p|ul|ol|li|h[3-6]|blockquote|table|thead|tbody|tr|th|td|div|br|hr)( class="[a-z -]+")?>|<a href="[^"<>]*" target="_blank" rel="noopener noreferrer">|<\/a>/g
  for (const src of evil) {
    const html = renderMarkdown(src)
    assert.ok(!html.replace(ours, '').includes('<'), `balise etrangere dans : ${src} -> ${html}`)
    assert.ok(!/<a [^>]*\son\w+=/i.test(html), src)
  }
})
