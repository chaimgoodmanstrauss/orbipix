#!/usr/bin/env python3
"""Write a cache-busting copy of index.html for deploy (Cloudflare and browsers cache .js/.css for 4 h).
Every .js under js/ and vendor/ gets an import-map entry "./path" -> "./path?v=<content hash>", merged with
the existing map; the main script and the stylesheet get ?v= too. Usage: version-index.py <out.html>"""
import hashlib, json, pathlib, re, sys
root = pathlib.Path(__file__).resolve().parent.parent
h = lambda p: hashlib.sha1((root / p).read_bytes()).hexdigest()[:10]
html = (root / 'index.html').read_text()
m = re.search(r'(<script type="importmap">)(.*?)(</script>)', html, re.S)
imap = json.loads(m.group(2))
imports = {}
for p in sorted(list((root / 'js').rglob('*.js')) + list((root / 'vendor').rglob('*.js'))):
    rel = p.relative_to(root).as_posix()
    imports['./' + rel] = './' + rel + '?v=' + h(rel)
for k, v in imap.get('imports', {}).items():          # keep existing redirects, pointing at the versioned target
    imports[k] = imports.get(v, v)
imap['imports'] = imports
html = html[:m.start(2)] + '\n' + json.dumps(imap, indent=1) + '\n' + html[m.end(2):]
html = html.replace('src="js/main.js"', 'src="js/main.js?v=%s"' % h('js/main.js'))
html = html.replace('href="css/orbipix.css"', 'href="css/orbipix.css?v=%s"' % h('css/orbipix.css'))
pathlib.Path(sys.argv[1]).write_text(html)
