// 端到端测试 /logs 端点
// 启动一个临时 HTTP server，移植 handleLogs 逻辑（不依赖 proxy.mjs 的全部初始化）
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';

// ─── 内存数据库 + 假数据 ───
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE backends (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, backend_id INTEGER,
    session_id TEXT, model_actual TEXT, model_type TEXT DEFAULT 'heavy',
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    client_name TEXT, client_cwd TEXT,
    error_type TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec(`INSERT INTO backends (id, name) VALUES (1,'claude-official'),(2,'deepseek')`);

const now = new Date();
const mkTs = (m) => new Date(now.getTime() - m*60000).toISOString().replace('T',' ').slice(0,19);
const ins = db.prepare(`INSERT INTO requests (backend_id, session_id, model_actual, model_type, input_tokens, output_tokens, cache_read_tokens, client_name, client_cwd, error_type, timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const fixtures = [
  [1, 'sess-1', 'claude-sonnet-4-6',  'heavy', 100, 50, 30,  'claude-cli',   '/Users/z/projects/llm-router',     null,         mkTs(0)],
  [2, 'sess-2', 'deepseek-v4-pro',     'heavy', 200, 80,  0,   'claude-cli',   '/Users/z/projects/llm-router',     null,         mkTs(1)],
  [1, 'sess-3', 'claude-sonnet-4-6',  'heavy', 50,  20, 10,  'hermes-cli',   '/Users/z/projects/another',         'rate_limit', mkTs(2)],
  [2, 'sess-4', 'deepseek-v4-pro',     'heavy', 300, 120, 0,   'opencode',     '/home/dev/webapp',                  null,         mkTs(3)],
  [1, 'sess-5', 'claude-haiku-4-5',   'light', 80,  40, 60,  'claude-cli',   '/Users/z/projects/llm-router',     null,         mkTs(4)],
  [1, 'sess-6', 'claude-sonnet-4-6',  'heavy', 60,  30, 5,   'cursor',       '/Users/z/projects/llm-router',     null,         mkTs(5)],
  [2, 'sess-7', 'deepseek-v4-pro',     'heavy', 90,  45, 0,   'hermes-cli',   '/Users/z/projects/another',         'timeout',    mkTs(6)],
];
for (const f of fixtures) ins.run(...f);

// ─── 移植 handleLogs 的查询逻辑（简化：去掉 HTML 分支，只测 JSON）───
function buildQuery(qs) {
  const url = new URL(qs, 'http://x');
  const backend = url.searchParams.get('backend') || '';
  const client  = url.searchParams.get('client')  || '';
  const cwd     = url.searchParams.get('cwd')     || '';
  const search  = url.searchParams.get('search')  || '';
  const limit   = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
  const offset  = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  const where = [], params = [];
  if (backend) { where.push('b.name = ?');        params.push(backend); }
  if (client)  { where.push('r.client_name = ?'); params.push(client); }
  if (cwd)     { where.push('r.client_cwd = ?');  params.push(cwd); }
  if (search)  {
    where.push('(r.model_actual LIKE ? OR r.session_id LIKE ? OR r.client_cwd LIKE ? OR r.client_name LIKE ? OR r.error_type LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as c FROM requests r JOIN backends b ON r.backend_id = b.id ${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT r.id, r.timestamp, b.name as backend_name, r.model_actual, r.model_type,
           r.input_tokens, r.output_tokens, r.cache_read_tokens,
           r.client_name, r.client_cwd, r.session_id, r.error_type
    FROM requests r JOIN backends b ON r.backend_id = b.id
    ${whereSql} ORDER BY r.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const backends = db.prepare(`SELECT DISTINCT name FROM backends ORDER BY name`).all().map(r => r.name);
  const clients  = db.prepare(`SELECT DISTINCT client_name as v FROM requests WHERE client_name IS NOT NULL ORDER BY v`).all().map(r => r.v);
  const cwds     = db.prepare(`SELECT DISTINCT client_cwd  as v FROM requests WHERE client_cwd  IS NOT NULL ORDER BY v`).all().map(r => r.v);
  return { total, rows, filters: { backends, clients, cwds }, limit, offset };
}

// ─── 启 HTTP server ───
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/logs?') || req.url.startsWith('/logs?format=json')) {
    const data = buildQuery(req.url.replace('/logs', ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
console.log(`test server on :${port}`);

const get = (path) => fetch(`http://localhost:${port}${path}`).then(r => r.json());

// ─── 跑用例 ───
let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : '  ' + detail}`);
  cond ? pass++ : fail++;
};

console.log('\n── 1. 无筛选，返回全部 ──');
let d = await get('/logs?format=json');
check('total = 7',          d.total === 7,  `got ${d.total}`);
check('rows.length = 7',    d.rows.length === 7);
check('按 id DESC',         d.rows[0].id === 7 && d.rows[6].id === 1);
check('backends 列表',      JSON.stringify(d.filters.backends) === '["claude-official","deepseek"]');
check('clients 列表',       d.filters.clients.length === 4);
check('cwds 列表',          d.filters.cwds.length === 3);

console.log('\n── 2. 按后端筛选 ──');
d = await get('/logs?format=json&backend=claude-official');
check('total = 4',          d.total === 4,  `got ${d.total}`);
check('都是 claude-official', d.rows.every(r => r.backend_name === 'claude-official'));

console.log('\n── 3. 按客户端筛选 ──');
d = await get('/logs?format=json&client=hermes-cli');
check('total = 2',          d.total === 2);
check('都是 hermes-cli',    d.rows.every(r => r.client_name === 'hermes-cli'));

console.log('\n── 4. 按项目目录筛选 ──');
d = await get('/logs?format=json&cwd=/Users/z/projects/llm-router');
check('total = 4',          d.total === 4);
check('都是 llm-router',    d.rows.every(r => r.client_cwd === '/Users/z/projects/llm-router'));

console.log('\n── 5. 关键字搜索 ──');
d = await get('/logs?format=json&search=haiku');
check('搜到 haiku',         d.total === 1 && d.rows[0].model_actual === 'claude-haiku-4-5');
d = await get('/logs?format=json&search=timeout');
check('搜错误 timeout',     d.total === 1 && d.rows[0].error_type === 'timeout');
d = await get('/logs?format=json&search=llm-router');
check('搜路径',             d.total === 4);

console.log('\n── 6. 分页 ──');
d = await get('/logs?format=json&limit=3&offset=0');
check('limit=3 → 3 行',     d.rows.length === 3);
check('offset=0 拿最新 3 条', d.rows[0].id === 7 && d.rows[2].id === 5);
d = await get('/logs?format=json&limit=3&offset=3');
check('offset=3 拿接下来 3 条', d.rows[0].id === 4 && d.rows[2].id === 2);
d = await get('/logs?format=json&limit=3&offset=6');
check('offset=6 拿剩余 1 条', d.rows.length === 1 && d.rows[0].id === 1);

console.log('\n── 7. 组合筛选 ──');
d = await get('/logs?format=json&client=claude-cli&cwd=/Users/z/projects/llm-router');
check('client + cwd',       d.total === 3);
d = await get('/logs?format=json&client=claude-cli&search=llm-router');
check('client + search 交叉', d.total === 3);

console.log('\n── 8. 验证 HTML 文件存在 ──');
check('public/logs.html 存在', existsSync('public/logs.html'));

server.close();
console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 失败`} (${pass}/${pass+fail})\n`);
process.exit(fail === 0 ? 0 : 1);
