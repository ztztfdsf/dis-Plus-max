/* git-receive-pack 走不通 (机场节点把 POST /info/refs?service=git-receive-pack 卡死),
 * 但 api.github.com 的 POST 正常 → 用 Git Data API 把这一个提交推上去。
 * 只处理「改动文件少 + 单个提交」的情形, 通用推送仍该走 git。 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const REPO = 'ztztfdsf/dis-Plus-max';
const TOK = fs.readFileSync(process.env.TEMP + '/gh_tok.txt', 'utf8').trim();
const H = {
  authorization: 'Bearer ' + TOK,
  'user-agent': 'pi',
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
};
const sha = (s) => s.trim();
const localCommit = sha(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname + '/../..', encoding: 'utf8' }));
const localTree = sha(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: __dirname + '/../..', encoding: 'utf8' }));
const msg = execFileSync('git', ['log', '-1', '--pretty=%B', localCommit], { cwd: __dirname + '/../..', encoding: 'utf8' });
const files = execFileSync('git', ['diff', '--name-only', process.env.RESET_TO || 'HEAD~1', 'HEAD'], { cwd: __dirname + '/../..', encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);
const ROOT = __dirname + '/../..';

const api = async (method, path, body) => {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + JSON.stringify(j).slice(0, 250));
  return j;
};

(async () => {
  console.log('本地 commit', localCommit.slice(0, 8), '| tree', localTree.slice(0, 8), '| 改动', files.length, '个文件');
  if (process.env.RESET_TO) {
    const rr = await api('PATCH', '/git/refs/heads/main', { sha: process.env.RESET_TO, force: true });
    console.log('先回退 main →', (rr.object && rr.object.sha || '').slice(0, 8));
  }
  const ref = await api('GET', '/git/ref/heads/main');
  const baseSha = ref.object.sha;
  console.log('远端 main =', baseSha.slice(0, 8));
  if (baseSha === localCommit) { console.log('已经一致, 不用推'); return; }

  const baseCommit = await api('GET', '/git/commits/' + baseSha);
  /* 全量 tree: 直接把本地 HEAD 的所有文件原样搬上去。tree sha 由内容决定,
   * 所以只要 blob 一致, 远端 tree 就能与本地 HEAD^{tree} 逐字节相等 ——
   * 这比 base_tree 增量好: 增量会把没改过的文件留在远端旧版本上。 */
  const all = execFileSync('git', ['ls-tree', '-r', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })    .split(/\r?\n/).filter(Boolean).map((l) => {
      const m = /^(\S+) blob ([0-9a-f]{40})\t(.+)$/.exec(l);
      return m ? { mode: m[1], sha: m[2], path: m[3] } : null;
    }).filter(Boolean);
  const remote = new Map(((await api('GET', '/git/trees/' + baseCommit.tree.sha + '?recursive=1')).tree || [])
    .filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));
  const tree = [];
  let reused = 0, posted = 0;
  for (const item of all) {
    /* 远端已有同一个 blob 就直接引用, 不重传 */
    if (remote.get(item.path) === item.sha) { reused++; tree.push({ path: item.path, mode: item.mode, type: 'blob', sha: item.sha }); continue; }
    /* 必须从 git 对象库取 (cat-file), 不能读工作区 —— core.autocrlf 会把工作区
     * 文件变成 CRLF 而库里存 LF, 读工作区会推出行尾不同的 blob (实跑踩过)。 */
    const localBlob = execFileSync('git', ['cat-file', 'blob', item.sha], { cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    const b = await api('POST', '/git/blobs', { content: localBlob.toString('base64'), encoding: 'base64' });
    posted++;
    tree.push({ path: item.path, mode: item.mode, type: 'blob', sha: b.sha });
    console.log('  blob', item.path, localBlob.length + 'B', b.sha.slice(0, 8), b.sha === item.sha ? '' : '✗ 与本地 blob 不同!');
  }
  console.log('  引用远端已有', reused, '个 | 新传', posted, '个 | 共', all.length, '个文件');
  const nt = await api('POST', '/git/trees', { tree });
  console.log('新 tree =', nt.sha.slice(0, 8), nt.sha === localTree ? '✓ 与本地 tree 完全一致' : '✗ 与本地 tree 不同!');
  const nc = await api('POST', '/git/commits', {
    message: msg, parents: [baseSha], tree: nt.sha,
    author: { name: 'ztztfdsf', email: 'ztztfdsf@users.noreply.github.com', date: new Date().toISOString() },
    committer: { name: 'ztztfdsf', email: 'ztztfdsf@users.noreply.github.com', date: new Date().toISOString() },
  });
  console.log('新 commit =', nc.sha.slice(0, 8));
  const up = await api('PATCH', '/git/refs/heads/main', { sha: nc.sha, force: false });
  console.log('✓ main →', (up.object && up.object.sha || '').slice(0, 8));
  console.log('TREE_MATCH=' + (nc.tree.sha === localTree));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });