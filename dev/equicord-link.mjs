// Link this userplugin against the host checkout, not hand-written API shims. No install, network or app injection.
// Usage: node dev/equicord-link.mjs <official host checkout> <locked esbuild executable> <existing evidence directory>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const [host, binary, parent] = process.argv.slice(2).map(p => path.resolve(p));
if (!host || !binary || !parent) throw Error('expected host, esbuild and evidence directory');
const entry = fileURLToPath(new URL('../dist/equicord/moeGuard/index.tsx', import.meta.url));
const run = fs.mkdtempSync(path.join(parent, 'equicord-link-'));
const pkg = JSON.parse(fs.readFileSync(path.join(host,'package.json'),'utf8'));
const version = spawnSync(binary,['--version'],{encoding:'utf8'}).stdout?.trim();
const lock = fs.readFileSync(path.join(host,'pnpm-lock.yaml'),'utf8');
if (!version || !lock.split(/\r?\n/).some(line => line.trim() === `esbuild@${version}:`)) throw Error('compiler version not in host lockfile');
const external = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies), 'react','react-dom','electron','node:*','~*']);
external.delete('@vencord/discord-types');
const r = spawnSync(binary,[entry,'--bundle','--format=esm','--platform=browser','--target=es2022',
    '--jsx=transform','--jsx-factory=VencordCreateElement','--jsx-fragment=VencordFragment',
    '--inject:'+path.join(host,'scripts/build/inject/react.mjs'),'--tsconfig='+path.join(host,'tsconfig.json'),
    '--alias:@vencord/discord-types='+path.join(host,'packages/discord-types'),'--loader:.css=empty',
    ...[...external].map(id=>'--external:'+id),'--outfile='+path.join(run,'link-check.mjs'),'--metafile='+path.join(run,'meta.json')],
    {cwd:host,encoding:'utf8',env:{...process.env,TEMP:run,TMP:run}});
fs.writeFileSync(path.join(run,'compiler.log'),(r.stdout||'')+(r.stderr||''));
if(r.error || r.status!==0) throw Error(`host link failed: ${run}\n`+(r.error?.message||r.stderr));
const meta=JSON.parse(fs.readFileSync(path.join(run,'meta.json'),'utf8'));
const files=Object.keys(meta.inputs).map(s=>s.replaceAll('\\','/'));
const required=['src/api/ChatButtons.tsx','src/api/Settings.ts','src/utils/types.ts','src/webpack/common/index.ts',
    'src/webpack/common/utils.ts','scripts/build/inject/react.mjs','moeGuard/index.tsx','moeGuard/message.mjs','moeGuard/media.mjs'];
const missing=required.filter(s=>!files.some(f=>f.endsWith(s)));
fs.writeFileSync(path.join(run,'coverage.json'),JSON.stringify({hostVersion:pkg.version,esbuild:version,inputs:files.length,required,missing},null,2));
if(missing.length)throw Error('compiled without linking host sources: '+missing.join(', '));
console.log(`LINK_PASS ${files.length} source files; host ${pkg.version}, esbuild ${version}\n${run}`);
