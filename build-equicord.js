'use strict';
// Materialize one self-contained Equicord userplugin without maintaining a codec fork.
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const out = path.join(root, 'dist', 'equicord', 'moeGuard');
const source = fs.readFileSync(path.join(root, 'src/core.js'), 'utf8');
const footer = /^if \(typeof window !== 'undefined'\) \{ window\.__MoeGuardCore = API; \}\r?\nif \(typeof module !== 'undefined' && module\.exports\) \{ module\.exports = API; \}\s*$/m;
if (!footer.test(source)) throw new Error('core export changed; inspect before packaging');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'engine.mjs'), source.replace(footer, 'export default API;\n'));
const { zipWrite } = require('./build.js');
const files = ['index.tsx', 'file-media.js', 'media.mjs', 'media.d.mts', 'attachment.mjs', 'message.mjs', 'message.d.mts', 'README.md'];
for (const f of files) fs.copyFileSync(path.join(root, 'equicord', f), path.join(out, f));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
// Allowlist source files: never ship QA screenshots, build logs, local settings or host binaries.
const version = require('./manifest.json').version;
fs.writeFileSync(path.join(out,'release.json'), JSON.stringify({name:'MoeGuard',version},null,2)+'\n');
const archive = path.join(root, 'dist', `moeguard-equicord-${version}.zip`);
zipWrite([...files, 'engine.mjs', 'LICENSE','release.json'].sort().map(f => ({name: 'moeGuard/' + f, data: fs.readFileSync(path.join(out, f))})), archive);
console.log(out + '\n' + archive);
