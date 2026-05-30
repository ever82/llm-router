#!/usr/bin/env node
/**
 * TokenDB 单元测试
 *
 * 用法:
 *   node --experimental-sqlite test.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

const TZ_OFFSET = 8 * 3600000;
function cnNow() {
  return new Date(Date.now() + TZ_OFFSET).toISOString().replace('T', ' ').slice(0, 19);
}

// ─── 工具 ────────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg}`);
  console.error(`    expected truthy, got ${cond}`);
}

function assertEq(actual, expected, msg) {
  if (actual === expected) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg}`);
  console.error(`    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++;
  console.error(`  FAIL: ${msg}`);
  console.error(`    expected ${e}`);
  console.error(`    got      ${a}`);
}

// ─── 创建临时数据库 ────────────────────────────────────────
const dbPath = join(tmpdir(), `llm-router-test-${Date.now()}.db`);
const db = new DatabaseSync(dbPath, { create: true });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS backends (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    base_url TEXT NOT NULL, model TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, backend_id INTEGER REFERENCES backends(id) ON DELETE SET NULL,
    session_id TEXT, model_actual TEXT,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 插入后端
db.prepare("INSERT INTO backends (name, base_url, model) VALUES (?, ?, ?)").run("Deepseek", "https://api.deepseek.com/anthropic", "deepseek-v4-pro[1m]");
db.prepare("INSERT INTO backends (name, base_url, model) VALUES (?, ?, ?)").run("MiniMax", "https://api.minimaxi.com/anthropic", "MiniMax-M2.7");
db.prepare("INSERT INTO backends (name, base_url, model) VALUES (?, ?, ?)").run("Kimi", "https://api.kimi.com/coding/", "k2.6");

const dsId = db.prepare("SELECT id FROM backends WHERE name = ?").get("Deepseek").id;
const mmId = db.prepare("SELECT id FROM backends WHERE name = ?").get("MiniMax").id;
const kmId = db.prepare("SELECT id FROM backends WHERE name = ?").get("Kimi").id;

// 插入请求数据（模拟历史记录）
const ts = cnNow();
function addReq(backendId, model, input, output, cache) {
  db.prepare(`INSERT INTO requests (backend_id, model_actual, input_tokens, output_tokens, cache_read_tokens, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)`).run(backendId, model, input, output, cache, ts);
}

addReq(dsId, "deepseek-v4-pro[1m]", 1000, 500, 200);   // Deepseek: total 1700
addReq(dsId, "deepseek-v4-pro[1m]", 300, 150, 50);     // Deepseek: total 500
addReq(mmId, "MiniMax-M2.7", 800, 400, 0);              // MiniMax: total 1200
addReq(mmId, "MiniMax-M2.7", 200, 100, 0);              // MiniMax: total 300
addReq(kmId, "k2.6", 600, 300, 100);                   // Kimi: total 1000

// ─── 复制 TokenDB 类（模拟 proxy.mjs 的逻辑）───────────────
class TokenDB {
  constructor(database) {
    this.startedAt = new Date().toISOString();
    this.byBackend = {};
    this.byModel = {};
    this.byDay = {};
    this._db = database;
    this._loadSummary();
  }

  _loadSummary() {
    const db = this._db;
    if (!db) return;
    try {
      // 从 requests 事实表按天聚合
      const dayRows = db.prepare(`
        SELECT strftime('%Y-%m-%d', timestamp) as day,
               SUM(input_tokens) as input, SUM(output_tokens) as output,
               SUM(cache_read_tokens) as cache_read, COUNT(*) as requests
        FROM requests GROUP BY day ORDER BY day
      `).all();
      for (const r of dayRows) {
        this.byDay[r.day] = {
          input: r.input, output: r.output,
          cache_read: r.cache_read,
          total: r.input + r.output + r.cache_read,
          requests: r.requests,
        };
      }
      if (dayRows.length > 0) {
        this.startedAt = dayRows[0].day + 'T00:00:00.000Z';
      }
      // 按后端聚合
      const backendRows = db.prepare(`
        SELECT b.name as backend_name,
               SUM(r.input_tokens) as input, SUM(r.output_tokens) as output,
               SUM(r.cache_read_tokens) as cache_read, COUNT(*) as requests
        FROM requests r JOIN backends b ON r.backend_id = b.id
        GROUP BY b.name
      `).all();
      for (const row of backendRows) {
        this.byBackend[row.backend_name] = {
          input: row.input, output: row.output,
          cache_read: row.cache_read,
          total: row.input + row.output + row.cache_read,
          requests: row.requests,
        };
      }
      // 按模型聚合
      const modelRows = db.prepare(`
        SELECT model_actual as model,
               SUM(input_tokens) as input, SUM(output_tokens) as output,
               SUM(cache_read_tokens) as cache_read, COUNT(*) as requests
        FROM requests GROUP BY model_actual
      `).all();
      for (const row of modelRows) {
        this.byModel[row.model] = {
          input: row.input, output: row.output,
          cache_read: row.cache_read,
          total: row.input + row.output + row.cache_read,
          requests: row.requests,
        };
      }
    } catch (e) {
      console.error('_loadSummary error:', e);
    }
  }

  record(backendName, model, usage, sessionId) {
    if (!usage) return;
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const total = input + output + cacheRead;
    if (total === 0) return;

    for (const store of [this.byBackend, this.byModel]) {
      const key = store === this.byBackend ? backendName : model;
      if (!store[key]) store[key] = { input: 0, output: 0, cache_read: 0, total: 0, requests: 0 };
      const b = store[key];
      b.input += input; b.output += output; b.cache_read += cacheRead; b.total += total; b.requests += 1;
    }
    const dayKey = cnNow().slice(0, 10);
    if (!this.byDay[dayKey]) this.byDay[dayKey] = { input: 0, output: 0, cache_read: 0, total: 0, requests: 0 };
    const d = this.byDay[dayKey];
    d.input += input; d.output += output; d.cache_read += cacheRead; d.total += total; d.requests += 1;

    // 写入 SQLite
    const db = this._db;
    if (!db) return;
    try {
      const tss = cnNow();
      db.prepare(`
        INSERT INTO requests (backend_id, session_id, model_actual, input_tokens, output_tokens, cache_read_tokens, timestamp)
        VALUES ((SELECT id FROM backends WHERE name = ?), ?, ?, ?, ?, ?, ?)
      `).run(backendName, sessionId || null, model, input, output, cacheRead, tss);
    } catch (err) {
      console.warn('  ⚠ DB write error:', err.message);
    }
  }

  summary() {
    const totals = { input: 0, output: 0, cache_read: 0, total: 0, requests: 0 };
    for (const d of Object.values(this.byDay)) {
      totals.input += d.input; totals.output += d.output;
      totals.cache_read += d.cache_read; totals.total += d.total; totals.requests += d.requests;
    }
    return { startedAt: this.startedAt, totals, byBackend: this.byBackend, byModel: this.byModel, byDay: this.byDay };
  }
}

// ════════════════════════════════════════════════════════════
// 测试 1: _loadSummary 从数据库恢复 byBackend
// ════════════════════════════════════════════════════════════
console.log('── 测试 1: _loadSummary 恢复 byBackend ──');

const tdb1 = new TokenDB(db);

assertDeep(tdb1.byBackend["Deepseek"],
  { input: 1300, output: 650, cache_read: 250, total: 2200, requests: 2 },
  "Deepseek backend stats loaded");
assertDeep(tdb1.byBackend["MiniMax"],
  { input: 1000, output: 500, cache_read: 0, total: 1500, requests: 2 },
  "MiniMax backend stats loaded");
assertDeep(tdb1.byBackend["Kimi"],
  { input: 600, output: 300, cache_read: 100, total: 1000, requests: 1 },
  "Kimi backend stats loaded");

// ════════════════════════════════════════════════════════════
// 测试 2: _loadSummary 从数据库恢复 byModel
// ════════════════════════════════════════════════════════════
console.log('── 测试 2: _loadSummary 恢复 byModel ──');

assertDeep(tdb1.byModel["deepseek-v4-pro[1m]"],
  { input: 1300, output: 650, cache_read: 250, total: 2200, requests: 2 },
  "Deepseek model stats loaded");
assertDeep(tdb1.byModel["MiniMax-M2.7"],
  { input: 1000, output: 500, cache_read: 0, total: 1500, requests: 2 },
  "MiniMax model stats loaded");
assertDeep(tdb1.byModel["k2.6"],
  { input: 600, output: 300, cache_read: 100, total: 1000, requests: 1 },
  "Kimi model stats loaded");

// ════════════════════════════════════════════════════════════
// 测试 3: _loadSummary 恢复 byDay
// ════════════════════════════════════════════════════════════
console.log('── 测试 3: _loadSummary 恢复 byDay ──');

const todayKey = cnNow().slice(0, 10);
assert(tdb1.byDay[todayKey] !== undefined, "today's byDay entry exists");
assertEq(tdb1.byDay[todayKey].input, 2900, "byDay input = 1000+300+800+200+600");
assertEq(tdb1.byDay[todayKey].output, 1450, "byDay output = 500+150+400+100+300");
assertEq(tdb1.byDay[todayKey].cache_read, 350, "byDay cache = 200+50+0+0+100");
assertEq(tdb1.byDay[todayKey].total, 4700, "byDay total = 2200+1500+1000");
assertEq(tdb1.byDay[todayKey].requests, 5, "byDay requests = 5");

// ════════════════════════════════════════════════════════════
// 测试 4: summary() 返回完整数据
// ════════════════════════════════════════════════════════════
console.log('── 测试 4: summary() ──');

const s = tdb1.summary();
assertEq(s.totals.input, 2900, "totals.input = 2900");
assertEq(s.totals.output, 1450, "totals.output = 1450");
assertEq(s.totals.cache_read, 350, "totals.cache_read = 350");
assertEq(s.totals.total, 4700, "totals.total = 4700");
assertEq(s.totals.requests, 5, "totals.requests = 5");
assertEq(Object.keys(s.byBackend).length, 3, "3 backends in summary");
assertEq(Object.keys(s.byModel).length, 3, "3 models in summary");

// ════════════════════════════════════════════════════════════
// 测试 5: record() 追加到已有聚合（模拟重启后新请求）
// ════════════════════════════════════════════════════════════
console.log('── 测试 5: record() 追加聚合 ──');

tdb1.record("Deepseek", "deepseek-v4-pro[1m]", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, "claude-test");

assertEq(tdb1.byBackend["Deepseek"].input, 1400, "Deepseek input after record: 1300+100");
assertEq(tdb1.byBackend["Deepseek"].total, 2350, "Deepseek total after record: 2200+150");
assertEq(tdb1.byBackend["Deepseek"].requests, 3, "Deepseek requests after record: 2+1");
assertEq(tdb1.byModel["deepseek-v4-pro[1m]"].input, 1400, "Model input after record: 1300+100");

// ════════════════════════════════════════════════════════════
// 测试 6: 非流式 token 解析 — Anthropic 格式 {usage: {...}}
// ════════════════════════════════════════════════════════════
console.log('── 测试 6: 非流式 Anthropic 格式 {usage: {...}} ──');

// 模拟 proxy.mjs 非流式路径的解析逻辑
function parseAndRecord(body, backendName, model, tokenDB) {
  const parsed = JSON.parse(body);
  const usage = parsed.usage || (parsed.input_tokens != null ? parsed : null);
  if (usage) {
    tokenDB.record(backendName, model, usage, "test-session");
    return true;
  }
  return false;
}

const tdb6 = new TokenDB(db);
const r1 = parseAndRecord('{"usage":{"input_tokens":500,"output_tokens":200}}', "MiniMax", "MiniMax-M2.7", tdb6);
assert(r1, "Anthropic format parsed and recorded");
// MiniMax had 1500 from before + 700 now = 2200
assertEq(tdb6.byBackend["MiniMax"].total, 2200, "MiniMax total after Anthropic-format record");

// ════════════════════════════════════════════════════════════
// 测试 7: 非流式 token 解析 — count_tokens 格式 {input_tokens: ...}
// ════════════════════════════════════════════════════════════
console.log('── 测试 7: count_tokens 格式 {input_tokens: ...} ──');

// tdb7 从 DB 加载时，DB 里已有 tdb1.record() 和 tdb6 写入的行
// Deepseek 原本 1300/650/250 (2次) + tdb1 追加 100/50/0 = 1400/700/250 (3次)
const tdb7 = new TokenDB(db);
const dsBefore = { ...tdb7.byBackend["Deepseek"] };
const r2 = parseAndRecord('{"input_tokens":285}', "Deepseek", "deepseek-v4-pro[1m]", tdb7);
assert(r2, "count_tokens format parsed and recorded");
assertEq(tdb7.byBackend["Deepseek"].input, dsBefore.input + 285, "Deepseek input after count_tokens record");
assertEq(tdb7.byBackend["Deepseek"].output, dsBefore.output, "Deepseek output unchanged");
assertEq(tdb7.byBackend["Deepseek"].total, dsBefore.total + 285, "Deepseek total increased by 285");

// ════════════════════════════════════════════════════════════
// 测试 8: count_tokens 响应只有 input_tokens 没有 output_tokens
// ════════════════════════════════════════════════════════════
console.log('── 测试 8: count_tokens 只有 input_tokens ──');

const tdb8 = new TokenDB(db);
const kmBefore = { ...tdb8.byBackend["Kimi"] };
const r3 = parseAndRecord('{"input_tokens":1024}', "Kimi", "k2.6", tdb8);
assert(r3, "count_tokens with 1024 parsed");
assertEq(tdb8.byBackend["Kimi"].input, kmBefore.input + 1024, "Kimi input increased by 1024");
assertEq(tdb8.byBackend["Kimi"].output, kmBefore.output, "Kimi output unchanged");
assertEq(tdb8.byBackend["Kimi"].total, kmBefore.total + 1024, "Kimi total increased by 1024");

// ════════════════════════════════════════════════════════════
// 测试 9: 空响应不崩溃
// ════════════════════════════════════════════════════════════
console.log('── 测试 9: 空/异常响应不崩溃 ──');

const tdb9 = new TokenDB(db);
const before = { ...tdb9.byBackend["Deepseek"] };
const r4 = parseAndRecord('{}', "Deepseek", "deepseek-v4-pro[1m]", tdb9);
assert(!r4, "empty object not recorded");
const r5 = parseAndRecord('{"error":{"type":"overloaded"}}', "Deepseek", "deepseek-v4-pro[1m]", tdb9);
assert(!r5, "error response not recorded");
assertDeep(tdb9.byBackend["Deepseek"], before, "Deepseek stats unchanged after empty/error responses");

// ════════════════════════════════════════════════════════════
// 测试 10: 全部为 0 的 usage 不记录
// ════════════════════════════════════════════════════════════
console.log('── 测试 10: 全零 usage 不记录 ──');

const tdb10 = new TokenDB(db);
const before10 = { ...tdb10.byBackend["MiniMax"] };
// usage 存在但 total=0：parseAndRecord 返回 true（usage 被提取到），但 record() 内部跳过
const r6 = parseAndRecord('{"usage":{"input_tokens":0,"output_tokens":0}}', "MiniMax", "MiniMax-M2.7", tdb10);
assert(r6, "zero usage still parsed (Anthropic format)");
const r7 = parseAndRecord('{"input_tokens":0}', "MiniMax", "MiniMax-M2.7", tdb10);
assert(r7, "zero input_tokens still parsed (count_tokens format)");
assertDeep(tdb10.byBackend["MiniMax"], before10, "MiniMax stats unchanged after zero-token responses");

// ════════════════════════════════════════════════════════════
// 结果
// ════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(50)}`);
console.log(`  通过: ${passed}  失败: ${failed}`);
console.log(`${'='.repeat(50)}`);

// 清理
db.close();
try { unlinkSync(dbPath); } catch {}
try { unlinkSync(dbPath + '-wal'); } catch {}
try { unlinkSync(dbPath + '-shm'); } catch {}

process.exit(failed > 0 ? 1 : 0);
