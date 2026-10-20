// CSP guard: the gateway serves `script-src 'self'`, so any inline <script>
// or on*= handler in web/ is dead code in production. Fails CI if found.
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../web/', import.meta.url);
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) files.push(p);
  }
};
walk(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let bad = 0;
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)];
  const handlers = [...html.matchAll(/\son[a-z]+\s*=/gi)];
  const jsHref = [...html.matchAll(/href\s*=\s*["']javascript:/gi)];
  for (const m of inline) { console.error(`${f}: inline <script> (blocked by CSP) at offset ${m.index}`); bad++; }
  for (const m of handlers) { console.error(`${f}: inline event handler ${m[0].trim()} (blocked by CSP)`); bad++; }
  for (const m of jsHref) { console.error(`${f}: javascript: URL at offset ${m.index}`); bad++; }
  // every referenced local asset must exist
  for (const m of html.matchAll(/(?:src|href)=["'](\/assets\/[^"'?]+)(\?[^"']*)?["']/g)) {
    const rel = path.join(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), m[1]);
    if (!fs.existsSync(rel)) { console.error(`${f}: missing asset ${m[1]}`); bad++; }
    // Cloudflare/browsers cache /assets for hours — every reference must carry a version
    if (!m[2] || !m[2].startsWith('?v=')) { console.error(`${f}: asset ${m[1]} lacks a ?v= cache-buster`); bad++; }
  }
}
console.log(`${files.length} html file(s) checked — ${bad ? `${bad} problem(s)` : 'CSP-clean'}`);
process.exit(bad ? 1 : 0);
