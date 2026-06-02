// 测试客户端识别（client_name / client_cwd）+ 写入 SQLite
// 用 :memory: 数据库，不污染真实 proxy.db
import { DatabaseSync } from 'node:sqlite';

// ─── 复制自 proxy.mjs 的两个工具函数（避免 import 触发 server 启动）──
function extractClientName(req) {
  const ua = (req.headers['user-agent'] || '').trim();
  if (!ua) return 'unknown';
  const first = ua.split(/[\s,()]+/)[0] || '';
  const product = first.split(/[\/v]/)[0] || first;
  return product.toLowerCase() || 'unknown';
}

function extractClientCwd(req, parsed) {
  const headers = req.headers || {};
  const hdrCwd = headers['x-client-cwd'] || headers['x-cwd'] || headers['x-project-cwd'];
  if (hdrCwd && typeof hdrCwd === 'string' && hdrCwd.trim()) {
    return hdrCwd.trim();
  }
  const metaUid = parsed && parsed.metadata && parsed.metadata.user_id;
  if (typeof metaUid === 'string' && metaUid.includes('/')) {
    return metaUid;
  }
  if (parsed && parsed.system) {
    const sysText = Array.isArray(parsed.system)
      ? parsed.system.map(s => (typeof s === 'string' ? s : (s?.text || ''))).join('\n')
      : (typeof parsed.system === 'string' ? parsed.system : '');
    const m = sysText.match(/\/(?:Users|home|root|workspace|project|repo)\/[^\s'"<>)\]]+/);
    if (m) return m[0].replace(/[.,;:]+$/, '');
  }
  return null;
}

// ─── 工具 ───
let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) console.log(`      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  ok ? pass++ : fail++;
}
function mockReq(headers = {}, parsed = null) {
  return { headers };
}

// ═══ 1. extractClientName ═══
console.log('\n─── 1. extractClientName ───');
check('Claude Code',          extractClientName(mockReq({ 'user-agent': 'claude-cli/1.0.27 (darwin; arm64)' })), 'claude-cli');
check('Hermes CLI',           extractClientName(mockReq({ 'user-agent': 'hermes-cli/0.4.2' })),            'hermes-cli');
check('OpenCode',             extractClientName(mockReq({ 'user-agent': 'OpenCode/0.5.0' })),              'opencode');
check('Cursor',               extractClientName(mockReq({ 'user-agent': 'cursor-sh-agent/2024.12' })),     'cursor-sh-agent');
check('curl',                 extractClientName(mockReq({ 'user-agent': 'curl/8.7.1' })),                  'curl');
check('无 UA → unknown',      extractClientName(mockReq({})),                                              'unknown');
check('UA 是空串',            extractClientName(mockReq({ 'user-agent': '   ' })),                         'unknown');

// ═══ 2. extractClientCwd 三层兜底 ═══
console.log('\n─── 2. extractClientCwd ───');
check('优先: X-Client-Cwd header',
  extractClientCwd(mockReq({ 'x-client-cwd': '/Users/z/projects/llm-router' }), { system: 'cwd is /Users/z/fake' }),
  '/Users/z/projects/llm-router');
check('次选: X-Cwd header',
  extractClientCwd(mockReq({ 'x-cwd': '/home/me/proj' }), null),
  '/home/me/proj');
check('再次: metadata.user_id',
  extractClientCwd(mockReq({}), { metadata: { user_id: 'account_xyz/proj-foo' } }),
  'account_xyz/proj-foo');
check('兜底: system string 含路径',
  extractClientCwd(mockReq({}), { system: 'You are in /Users/z/projects/llm-router.\nHelp the user.' }),
  '/Users/z/projects/llm-router');
check('兜底: system array 含路径',
  extractClientCwd(mockReq({}), { system: [{ type: 'text', text: 'Working dir: /home/dev/myapp' }] }),
  '/home/dev/myapp');
check('兜底: /root/... 也能匹配',
  extractClientCwd(mockReq({}), { system: 'cd /root/sandbox && run' }),
  '/root/sandbox');
check('都无 → null',
  extractClientCwd(mockReq({}), { system: 'no path here' }),
  null);
check('parsed=null 且无 header → null',
  extractClientCwd(mockReq({}), null),
  null);
check('system 末尾有句号也能去标点',
  extractClientCwd(mockReq({}), { system: 'Current dir: /Users/z/proj.' }),
  '/Users/z/proj');

// ═══ 3. 写入 SQLite 验证 ═══
console.log('\n─── 3. 写库验证（:memory:）───');
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE backends (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, backend_id INTEGER,
    session_id TEXT, model_actual TEXT, model_type TEXT DEFAULT 'heavy',
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    client_name TEXT, client_cwd TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO backends (id, name) VALUES (1, 'test-backend');
`);

const cases = [
  { name: 'claude code + header',   client: 'claude-cli', cwd: '/Users/z/projects/llm-router' },
  { name: 'hermes + system 提取',   client: 'hermes-cli', cwd: '/Users/z/proj-b' },
  { name: 'opencode + 全部缺失',    client: 'opencode',   cwd: null },
];
const insert = db.prepare(`
  INSERT INTO requests (backend_id, session_id, model_actual, input_tokens, output_tokens, cache_read_tokens, client_name, client_cwd)
  VALUES (1, ?, ?, 100, 50, 20, ?, ?)
`);
for (const c of cases) {
  insert.run('sess-' + c.client, 'claude-sonnet-4-6', c.client, c.cwd);
}

const rows = db.prepare('SELECT client_name, client_cwd FROM requests ORDER BY id').all();
console.log('  写入的行：');
for (const r of rows) console.log('   ', r);

check('3 行全部落库',           rows.length, 3);
check('第 1 行 client_name',    rows[0].client_name, 'claude-cli');
check('第 1 行 client_cwd',     rows[0].client_cwd,  '/Users/z/projects/llm-router');
check('第 2 行 client_name',    rows[1].client_name, 'hermes-cli');
check('第 2 行 client_cwd',     rows[1].client_cwd,  '/Users/z/proj-b');
check('第 3 行 client_cwd null',rows[2].client_cwd,  null);

// ═══ 汇总 ═══
console.log(`\n${fail === 0 ? '✓ 全部通过' : `✗ ${fail} 个失败`} (${pass} passed, ${fail} failed)\n`);
process.exit(fail === 0 ? 0 : 1);
