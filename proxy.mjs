#!/usr/bin/env node

/**
 * LLM Reverse Proxy v2 - 带 mid-stream 错误检测和自动 fallback
 */

import { spawnSync } from 'node:child_process';

if (!process.execArgv.includes('--experimental-sqlite')) {
  const result = spawnSync(process.execPath, ['--experimental-sqlite', ...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 配置加载 ────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] || resolve(__dirname, 'config.json');
if (!existsSync(configPath)) {
  console.error(`配置文件不存在: ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf-8'));
const PORT = config.port || 4000;
const PROXY_AUTH_TOKEN = config.proxy_auth_token || 'sk-proxy-change-me';

// ─── 可重试的错误类型 ────────────────────────────────────────
const RETRYABLE_ERROR_TYPES = new Set([
  'terminated', 'timeout', 'rate_limit', 'overloaded',
  'api_error', 'server_error', 'connection_error',
  'internal_error', 'capacity_limit',
]);

// ─── Token 统计 → SQLite ──────────────────────────────────
const DB_PATH = resolve(__dirname, 'proxy.db');
let db = null;

async function initDB() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(DB_PATH, { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    // 确保表存在（支持首次运行无 schema 的情况）
    db.exec(`
      CREATE TABLE IF NOT EXISTS backends (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
        base_url TEXT NOT NULL, model TEXT NOT NULL, auth_header TEXT DEFAULT NULL,
        weight REAL DEFAULT 1.0, cooldown_secs INTEGER DEFAULT 60,
        total_requests INTEGER DEFAULT 0, total_errors INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, backend_id INTEGER REFERENCES backends(id) ON DELETE SET NULL,
        session_id TEXT, model_requested TEXT, model_actual TEXT,
        status_code INTEGER, attempt INTEGER DEFAULT 1,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
        error_type TEXT DEFAULT NULL, is_fallback INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, backend_id INTEGER REFERENCES backends(id) ON DELETE SET NULL,
        first_seen TEXT NOT NULL DEFAULT (datetime('now')), last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        request_count INTEGER DEFAULT 0, total_tokens INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER REFERENCES requests(id) ON DELETE SET NULL,
        backend_id INTEGER REFERENCES backends(id) ON DELETE SET NULL,
        error_type TEXT NOT NULL, error_message TEXT DEFAULT NULL,
        attempt INTEGER DEFAULT 1, is_retryable INTEGER DEFAULT 1,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS aggregated_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT, period_type TEXT NOT NULL, period_key TEXT NOT NULL,
        backend_id INTEGER REFERENCES backends(id) ON DELETE SET NULL, model TEXT DEFAULT NULL,
        input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
        request_count INTEGER DEFAULT 0,
        UNIQUE(period_type, period_key, backend_id, model)
      );
      CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
      CREATE INDEX IF NOT EXISTS idx_requests_backend_id ON requests(backend_id);
      CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model_actual);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
      CREATE INDEX IF NOT EXISTS idx_aggregated_lookup ON aggregated_stats(period_type, period_key, backend_id, model);
    `);
    console.log('  📦 SQLite 数据库已就绪');
  } catch (err) {
    console.warn('  ⚠ SQLite 初始化失败，统计将仅存于内存:', err.message);
    db = null;
  }
}
await initDB();

function cnNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

// ─── TokenDB：写入 SQLite + 内存聚合（兼容 /proxy-status）─
class TokenDB {
  constructor() {
    this.startedAt = new Date().toISOString();
    // 内存聚合（用于 /proxy-status 快速响应）
    this.byBackend = {};
    this.byModel = {};
    this.byDay = {};
    // 加载已有统计
    this._loadSummary();
  }

  _loadSummary() {
    if (!db) return;
    try {
      // 从 requests 事实表直接按天聚合（aggregated_stats 曾因 NULL 问题积累大量重复脏数据）
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
    } catch {}
  }

  record(backendName, model, usage, sessionId) {
    if (!usage) return;
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const total = input + output + cacheRead;
    if (total === 0) return;

    // 内存聚合
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
    if (!db) return;
    try {
      const ts = cnNow();
      const insertRequest = db.prepare(`
        INSERT INTO requests (backend_id, session_id, model_actual, input_tokens, output_tokens, cache_read_tokens, timestamp)
        VALUES ((SELECT id FROM backends WHERE name = ?), ?, ?, ?, ?, ?, ?)
      `);
      insertRequest.run(backendName, sessionId || null, model, input, output, cacheRead, ts);

      // 更新 aggregated_stats（day 级别）
      // 使用 INSERT OR REPLACE 避免 SQLite UNIQUE 对 NULL 的特殊处理导致重复插入
      const existingDay = db.prepare(`
        SELECT id, input_tokens, output_tokens, cache_read_tokens, request_count
        FROM aggregated_stats
        WHERE period_type = 'day' AND period_key = ? AND backend_id IS NULL AND model IS NULL
        LIMIT 1
      `).get(dayKey);
      db.prepare(`
        INSERT OR REPLACE INTO aggregated_stats
          (id, period_type, period_key, backend_id, model, input_tokens, output_tokens, cache_read_tokens, request_count)
        VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
      `).run(
        existingDay?.id || null, 'day', dayKey,
        (existingDay?.input_tokens || 0) + input,
        (existingDay?.output_tokens || 0) + output,
        (existingDay?.cache_read_tokens || 0) + cacheRead,
        (existingDay?.request_count || 0) + 1
      );
    } catch (err) {
      console.warn('  ⚠ DB write error:', err.message);
    }
  }

  recordError(backendName, errorType, errorMessage, attempt, sessionId) {
    if (!db) return;
    try {
      const ts = cnNow();
      const insertError = db.prepare(`
        INSERT INTO errors (backend_id, error_type, error_message, attempt, is_retryable, timestamp)
        VALUES ((SELECT id FROM backends WHERE name = ?), ?, ?, ?, 1, ?)
      `);
      insertError.run(backendName, errorType, errorMessage || null, attempt || 1, ts);
    } catch {}
  }

  upsertSession(sessionId, backendName, tokens) {
    if (!db) return;
    try {
      const ts = cnNow();
      const upsert = db.prepare(`
        INSERT INTO sessions (session_id, backend_id, last_seen, request_count, total_tokens)
        VALUES (?, (SELECT id FROM backends WHERE name = ?), ?, 1, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          backend_id = (SELECT id FROM backends WHERE name = ?),
          last_seen = ?, request_count = request_count + 1, total_tokens = total_tokens + ?
      `);
      upsert.run(sessionId, backendName, ts, tokens, backendName, ts, tokens);
    } catch {}
  }

  getBackendId(name) {
    if (!db) return null;
    try {
      const r = db.prepare('SELECT id FROM backends WHERE name = ?').get(name);
      return r?.id || null;
    } catch { return null; }
  }

  summary() {
    const totals = { input: 0, output: 0, cache_read: 0, total: 0, requests: 0 };
    // 从 byDay 聚合 totals（包含重启前已加载的历史数据）
    for (const d of Object.values(this.byDay)) {
      totals.input += d.input; totals.output += d.output;
      totals.cache_read += d.cache_read; totals.total += d.total; totals.requests += d.requests;
    }
    // byBackend / byModel 仅用于明细展示，不重复累加到 totals
    return { startedAt: this.startedAt, totals, byBackend: this.byBackend, byModel: this.byModel, byDay: this.byDay };
  }
}
const tokenDB = new TokenDB();

// ─── SSE 流处理器：提取 token + 检测错误 ─────────────────────
class StreamProcessor extends Transform {
  constructor(backendName, model, sessionId) {
    super();
    this.backendName = backendName;
    this.model = model;
    this.sessionId = sessionId;
    this.buffer = '';
    this.usageFromStart = null;
    this.totalTokens = 0;
    this.hadError = false;
    this.errorType = null;
    this.errorMessage = null;
  }

  _transform(chunk, encoding, callback) {
    this.push(chunk);
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          // 检测错误事件
          if (data.type === 'error') {
            this.hadError = true;
            this.errorType = data.error?.type || 'unknown';
            this.errorMessage = data.error?.message || '';
            console.log(`    ⚠ stream error: ${this.errorType}: ${this.errorMessage}`);
          }
          if (data.type === 'message_start' && data.message?.usage) {
            this.usageFromStart = data.message.usage;
          } else if (data.type === 'message_delta' && data.usage) {
            const usage = {
              input_tokens: data.usage.input_tokens || this.usageFromStart?.input_tokens || 0,
              output_tokens: data.usage.output_tokens || 0,
              cache_read_input_tokens: data.usage.cache_read_input_tokens || this.usageFromStart?.cache_read_input_tokens || 0,
            };
            tokenDB.record(this.backendName, this.model, usage, this.sessionId);
            const total = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens;
            this.totalTokens += total;
            console.log(`    📊 tokens: in=${usage.input_tokens} out=${usage.output_tokens} cache=${usage.cache_read_input_tokens} total=${total}`);
          }
        } catch {}
      }
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer.startsWith('data: ')) {
      try {
        const data = JSON.parse(this.buffer.slice(6));
        if (data.type === 'error') {
          this.hadError = true;
          this.errorType = data.error?.type || 'unknown';
        }
        if (data.type === 'message_delta' && data.usage) {
          const usage = {
            input_tokens: data.usage.input_tokens || this.usageFromStart?.input_tokens || 0,
            output_tokens: data.usage.output_tokens || 0,
            cache_read_input_tokens: data.usage.cache_read_input_tokens || this.usageFromStart?.cache_read_input_tokens || 0,
          };
          tokenDB.record(this.backendName, this.model, usage);
        }
      } catch {}
    }
    this.buffer = '';
    callback();
  }
}

// ─── 会话追踪：基于 TCP 连接识别 Claude 进程 ────────────────
// 每个 Claude Code 进程有独立的 TCP 连接，HTTP keep-alive 复用同一连接
let sessionCounter = 0;
const socketSessions = new WeakMap(); // socket → sessionId

function getSessionId(req) {
  const socket = req.socket;
  if (!socketSessions.has(socket)) {
    sessionCounter++;
    const sid = `claude-${sessionCounter}`;
    socketSessions.set(socket, sid);
    console.log(`  🔗 新会话 ${sid} (port ${socket.remotePort})`);
    // 持久化到 SQLite
    if (db) {
      try {
        const ts = cnNow();
        db.prepare('INSERT OR IGNORE INTO sessions (session_id, last_seen) VALUES (?, ?)').run(sid, ts);
      } catch {}
    }
  }
  return socketSessions.get(socket);
}
// ─── 后端管理 + 粘性加权路由 ──────────────────────────────────
class BackendPool {
  constructor(backends, routing) {
    this.backends = backends.map((b, i) => ({
      ...b, id: i, cooldownUntil: 0, failCount: 0, totalRequests: 0, totalErrors: 0,
    }));
    this.weights = routing?.weights || backends.map(() => 1);
    // 粘性路由：sourceId → backendId
    this.sourceMap = new Map();
    // 每个来源的错误记录：sourceId → Set<backendId>
    this.sourceErrors = new Map();
    this.errorTTL = 120_000; // 来源错误记录 2 分钟后清除
    this.routeStats = {
      assigned: {}, // backendId → count of sources assigned
    };
    this.weights.forEach((_, i) => { this.routeStats.assigned[i] = 0; });
    // 从 SQLite 恢复粘性路由
    this._loadSourceMap();
  }

  _loadSourceMap() {
    if (!db) return;
    try {
      const rows = db.prepare(`
        SELECT s.session_id, b.name as backend_name
        FROM sessions s JOIN backends b ON s.backend_id = b.id
        WHERE s.backend_id IS NOT NULL
      `).all();
      for (const r of rows) {
        const backendIdx = this.backends.findIndex(b => b.name === r.backend_name);
        if (backendIdx >= 0) {
          this.sourceMap.set(r.session_id, backendIdx);
          this.routeStats.assigned[backendIdx] = (this.routeStats.assigned[backendIdx] || 0) + 1;
        }
      }
      if (rows.length > 0) console.log(`  🔗 从数据库恢复 ${rows.length} 个会话路由`);
    } catch {}
  }

  // 获取可用后端（未被冷却的）
  isAvailable(backendId) {
    return this.backends[backendId]?.cooldownUntil <= Date.now() ?? false;
  }

  // 粘性路由选择：同一来源固定一个后端
  pick(sourceId, excludeIds = new Set()) {
    const now = Date.now();

    // 清理过期的来源错误记录
    if (Math.random() < 0.05) this._cleanSourceErrors();

    // 优先检查来源是否有分配的后端
    const preferredId = this.sourceMap.get(sourceId);
    if (preferredId !== undefined && !excludeIds.has(preferredId)) {
      const preferred = this.backends[preferredId];
      if (preferred.cooldownUntil <= now) {
        // 检查是否被来源标记为错误
        const errors = this.sourceErrors.get(sourceId);
        if (!errors?.has(preferredId)) {
          return preferred;
        }
      }
    }

    // 需要分配新后端
    const sourceErrors = this.sourceErrors.get(sourceId);

    // 过滤可用后端
    const available = this.backends.filter(b =>
      !excludeIds.has(b.id) &&
      b.cooldownUntil <= now &&
      !sourceErrors?.has(b.id)
    );

    if (available.length === 0) {
      // 放宽错误过滤
      const available2 = this.backends.filter(b =>
        !excludeIds.has(b.id) && b.cooldownUntil <= now
      );
      if (available2.length === 0) {
        // 全部在冷却，选冷却最短的
        const sorted = [...this.backends].filter(b => !excludeIds.has(b.id)).sort((a, b) => a.cooldownUntil - b.cooldownUntil);
        return sorted[0] || null;
      }
      return this._weightedSelect(available2);
    }

    // 优先选当前未被任何来源占用的后端（实现负载均衡）
    const assignedIds = new Set(this.sourceMap.values());
    const unassigned = available.filter(b => !assignedIds.has(b.id));
    if (unassigned.length > 0) {
      const picked = this._weightedSelect(unassigned);
      this.sourceMap.set(sourceId, picked.id);
      this.routeStats.assigned[picked.id] = (this.routeStats.assigned[picked.id] || 0) + 1;
      return picked;
    }

    // 所有后端都被占用，按权重选一个
    const picked = this._weightedSelect(available);
    if (this.sourceMap.get(sourceId) !== picked.id) {
      this.sourceMap.set(sourceId, picked.id);
    }
    return picked;
  }

  // 加权随机选择
  _weightedSelect(backends) {
    const totalWeight = backends.reduce((sum, b) => sum + (this.weights[b.id] || 1), 0);
    let r = Math.random() * totalWeight;
    for (const b of backends) {
      r -= (this.weights[b.id] || 1);
      if (r <= 0) return b;
    }
    return backends[backends.length - 1];
  }

  // 标记来源在后端上的错误
  markSourceError(sourceId, backendId) {
    if (!this.sourceErrors.has(sourceId)) this.sourceErrors.set(sourceId, new Set());
    this.sourceErrors.get(sourceId).add(backendId);
  }

  // 清除来源错误记录
  clearSourceErrors(sourceId) {
    this.sourceErrors.delete(sourceId);
  }

  _cleanSourceErrors() {
    const now = Date.now();
    for (const [sourceId, errors] of this.sourceErrors) {
      // 如果没有正在冷却的后端，清除错误记录
      let hasCooldown = false;
      for (const backendId of errors) {
        if (this.backends[backendId]?.cooldownUntil > now) {
          hasCooldown = true;
          break;
        }
      }
      if (!hasCooldown) this.sourceErrors.delete(sourceId);
    }
  }

  cooldown(backend, durationMs) {
    backend.cooldownUntil = Date.now() + durationMs;
    backend.failCount++;
    console.log(`  ⏳ [${backend.name}] 冷却 ${durationMs / 1000}s`);
  }
  success(backend) {
    backend.failCount = 0;
  }
  stats() {
    return this.backends.map(b => ({
      name: b.name, url: b.base_url, model: b.model,
      requests: b.totalRequests, errors: b.totalErrors,
      cooldown: b.cooldownUntil > Date.now() ? Math.ceil((b.cooldownUntil - Date.now()) / 1000) + 's' : '-',
    }));
  }
  routingStats() {
    const sourceCounts = {};
    for (const [sourceId, backendId] of this.sourceMap) {
      const name = this.backends[backendId]?.name || '?';
      sourceCounts[name] = (sourceCounts[name] || 0) + 1;
    }
    return {
      strategy: 'sticky_weighted',
      weights: this.weights,
      activeSources: this.sourceMap.size,
      assigned: Object.fromEntries(
        this.backends.map(b => [b.name, sourceCounts[b.name] || 0])
      ),
    };
  }
}

const pool = new BackendPool(config.backends, config.routing);

// ─── 请求转发 ────────────────────────────────────────────────
function forwardRequest(targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST', headers: { ...headers, host: url.host }, timeout: 600_000,
    }, (res) => { resolve(res); });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Backend request timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── 检测响应体中的错误（非流式）──────────────────────────────
function isRetriableBody(bodyStr) {
  try {
    const parsed = JSON.parse(bodyStr);
    if (parsed.type === 'error' && parsed.error) {
      const errType = parsed.error.type || '';
      if (RETRYABLE_ERROR_TYPES.has(errType) || /rate|limit|timeout|overload|capacity|terminat/i.test(errType)) {
        return { retryable: true, type: errType, message: parsed.error.message || '' };
      }
    }
  } catch {}
  return { retryable: false };
}

// ─── 判断 HTTP 状态码是否可重试 ───────────────────────────────
function isRetryableStatus(statusCode) {
  // 429 限速
  if (statusCode === 429) return true;
  // 400 可能是某些提供商的错误格式（如 terminated）
  if (statusCode === 400 || statusCode === 408) return true;
  // 5xx 服务端错误
  if (statusCode >= 500) return true;
  return false;
}

// ─── 主请求处理 ──────────────────────────────────────────────
// ─── 修复 thinking 模式下缺失 reasoning_content 的问题 ─────────
function fixThinkingMessages(parsed) {
  if (!parsed.thinking && !parsed.thinking_config) return false;
  if (!Array.isArray(parsed.messages)) return false;

  let fixed = false;
  for (const msg of parsed.messages) {
    if (msg.role !== 'assistant') continue;
    // content 为字符串时跳过（无法插入 thinking block）
    if (typeof msg.content === 'string') continue;
    if (!Array.isArray(msg.content)) continue;
    // 已有 thinking 或 reasoning_content 块则跳过
    const hasThinking = msg.content.some(b => b && (b.type === 'thinking'));
    if (hasThinking) continue;
    // 在 content 开头插入一个最小 thinking 块
    msg.content.unshift({ type: 'thinking', thinking: '.' });
    fixed = true;
  }
  return fixed;
}

async function handleRequest(req, res) {
  const body = await readBody(req);
  const maxAttempts = pool.backends.length;

  let requestModel = null;
  let isStream = false;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
    requestModel = parsed.model || null;
    isStream = parsed.stream || false;
    // 自动补全缺失的 thinking 内容块，防止 400 错误
    if (fixThinkingMessages(parsed)) {
      console.log('  ℹ 已为 assistant 消息补全 thinking 块');
    }
  } catch {}
  const modelMap = config.model_map || {};
  const triedIds = new Set();
  // 来源识别：基于 TCP 连接（同一 Claude 进程的多个请求用同一连接）
  const sourceId = getSessionId(req);
  let currentBackend = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const backend = pool.pick(sourceId, triedIds);
    if (!backend) {
      sendError(res, 503, 'all_backends_down', '所有后端都不可用，请稍后重试');
      return;
    }

    triedIds.add(backend.id);
    backend.totalRequests++;

    const targetUrl = `${backend.base_url}${req.url}`;
    const fwdHeaders = { ...req.headers };
    fwdHeaders['authorization'] = `Bearer ${backend.api_key}`;
    delete fwdHeaders['x-api-key'];
    if (backend.auth_header) {
      delete fwdHeaders['authorization'];
      fwdHeaders[backend.auth_header] = backend.api_key;
    }

    let finalBody = body;
    let actualModel = requestModel;
    if (parsed && backend.model) {
      if (requestModel) {
        const mappedModel = modelMap[requestModel] || backend.model;
        actualModel = mappedModel;
        parsed.model = mappedModel;
      }
      finalBody = JSON.stringify(parsed);
    } else if (requestModel && backend.model) {
      const mappedModel = modelMap[requestModel] || backend.model;
      actualModel = mappedModel;
      finalBody = body.replace(`"model":"${requestModel}"`, `"model":"${mappedModel}"`);
      finalBody = finalBody.replace(`"model": "${requestModel}"`, `"model": "${mappedModel}"`);
    }
    delete fwdHeaders['host'];
    delete fwdHeaders['content-length'];
    // 不转发压缩头，让后端返回未压缩数据，避免流式传输时解压错误
    delete fwdHeaders['accept-encoding'];
    fwdHeaders['content-length'] = Buffer.byteLength(finalBody);

    console.log(`  → [${backend.name}] ${req.method} ${req.url} model=${actualModel} stream=${isStream} (attempt ${attempt + 1}/${maxAttempts} src=${sourceId})`);

    try {
      currentBackend = backend;
      const backendRes = await forwardRequest(targetUrl, fwdHeaders, finalBody);
      const status = backendRes.statusCode;

      // ─── HTTP 级别错误 → fallback ─────────────────────
      if (status === 429) {
        backend.totalErrors++;
        pool.cooldown(backend, backend.cooldown_duration || config.cooldown_duration || 60_000);
        pool.markSourceError(sourceId, backend.id);
        consumeBody(backendRes);
        console.log(`  ✗ [${backend.name}] 429 Rate Limited → fallback`);
        continue;
      }

      if (status === 401 || status === 403) {
        backend.totalErrors++;
        pool.cooldown(backend, 300_000);
        pool.markSourceError(sourceId, backend.id);
        consumeBody(backendRes);
        console.log(`  ✗ [${backend.name}] ${status} Auth Error → fallback`);
        continue;
      }

      if (status === 400 || status === 408) {
        // 400 可能包含 terminated 等可重试错误
        const respBody = await readBody(backendRes);
        const check = isRetriableBody(respBody);
        if (check.retryable) {
          backend.totalErrors++;
          pool.cooldown(backend, 30_000);
          pool.markSourceError(sourceId, backend.id);
          console.log(`  ✗ [${backend.name}] ${status} ${check.type}: ${check.message} → fallback`);
          continue;
        }
        // 不可重试的 400 直接透传给客户端
        const fwdHeaders = { ...backendRes.headers };
        delete fwdHeaders['content-encoding'];
        delete fwdHeaders['transfer-encoding'];
        res.writeHead(status, fwdHeaders);
        res.end(respBody);
        return;
      }

      if (status >= 500) {
        backend.totalErrors++;
        pool.cooldown(backend, 30_000);
        pool.markSourceError(sourceId, backend.id);
        consumeBody(backendRes);
        console.log(`  ✗ [${backend.name}] ${status} Server Error → fallback`);
        continue;
      }

      // ─── 成功响应 ─────────────────────────────────────
      pool.success(backend);
      pool.clearSourceErrors(sourceId);
      console.log(`  ✓ [${backend.name}] ${status} src=${sourceId}`);

      if (isStream) {
        // 流式：先缓冲前几个事件检测错误，再决定转发还是 fallback
        const buffered = [];
        let bufferDone = false;
        let streamError = null;

        const checkFirstEvents = new Promise((resolve) => {
          let eventCount = 0;
          const onReadable = () => {
            while (true) {
              const chunk = backendRes.read();
              if (!chunk) break;
              if (!bufferDone) {
                buffered.push(chunk);
                // 解析已缓冲的数据，检查是否有错误事件
                const text = Buffer.concat(buffered).toString();
                for (const line of text.split('\n')) {
                  if (line.startsWith('data: ')) {
                    eventCount++;
                    try {
                      const data = JSON.parse(line.slice(6));
                      if (data.type === 'error') {
                        streamError = data.error?.type || 'unknown';
                        bufferDone = true;
                        resolve();
                        return;
                      }
                    } catch {}
                  }
                }
                // 收到 3 个事件或 message_start 后认为连接正常
                if (eventCount >= 3 || text.includes('content_block_start')) {
                  bufferDone = true;
                  resolve();
                  return;
                }
              }
            }
          };
          backendRes.on('readable', onReadable);
          backendRes.on('end', () => { bufferDone = true; resolve(); });
          // 最多等 5 秒
          setTimeout(() => { bufferDone = true; resolve(); }, 5000);
        });

        await checkFirstEvents;

        if (streamError) {
          // 流开头就报错了，可以 fallback
          backend.totalErrors++;
          pool.cooldown(backend, 30_000);
          pool.markSourceError(sourceId, backend.id);
          backendRes.destroy();
          console.log(`  ✗ [${backend.name}] stream error: ${streamError} → fallback`);
          continue;
        }

        // 正常：转发缓冲数据 + 后续流
        const fwdHeaders = { ...backendRes.headers };
        delete fwdHeaders['content-encoding']; // 防止客户端解压错误
        delete fwdHeaders['transfer-encoding'];  // 避免分块编码问题
        res.writeHead(backendRes.statusCode, fwdHeaders);
        for (const chunk of buffered) {
          res.write(chunk);
        }
        const processor = new StreamProcessor(backend.name, actualModel, sourceId);
        backendRes.pipe(processor).pipe(res);

        // 流结束后检测 mid-stream 错误，冷却后端
        processor.on('finish', () => {
          tokenDB.upsertSession(sourceId, backend.name, processor.totalTokens || 0);
          if (processor.hadError && RETRYABLE_ERROR_TYPES.has(processor.errorType)) {
            backend.totalErrors++;
            pool.cooldown(backend, 15_000);
            pool.markSourceError(sourceId, backend.id);
            console.log(`  ⚠ [${backend.name}] mid-stream error: ${processor.errorType} → 冷却 15s`);
          }
        });
        return;

      } else {
        // 非流式：检查响应体是否有错误
        const respBody = await readBody(backendRes);
        const check = isRetriableBody(respBody);
        if (check.retryable) {
          backend.totalErrors++;
          pool.cooldown(backend, 30_000);
          console.log(`  ✗ [${backend.name}] body error: ${check.type} → fallback`);
          continue;
        }
        // 记录 token
        try {
          const parsed = JSON.parse(respBody);
          if (parsed.usage) {
            const u = parsed.usage;
            const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0);
            tokenDB.record(backend.name, actualModel, parsed.usage, sourceId);
            tokenDB.upsertSession(sourceId, backend.name, total);
            console.log(`    📊 tokens: in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache=${u.cache_read_input_tokens || 0} total=${total}`);
          }
        } catch {}
        const fwdHeaders = { ...backendRes.headers };
        delete fwdHeaders['content-encoding'];
        delete fwdHeaders['transfer-encoding'];
        res.writeHead(backendRes.statusCode, fwdHeaders);
        res.end(respBody);
        return;
      }

    } catch (err) {
      backend.totalErrors++;
      pool.cooldown(backend, 30_000);
      pool.markSourceError(sourceId, backend.id);
      console.log(`  ✗ [${backend.name}] Network Error: ${err.message} → fallback`);
      continue;
    }
  }

  sendError(res, 503, 'all_backends_failed', '所有后端均请求失败，请稍后重试');
}

// ─── 辅助函数 ────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
function consumeBody(res) { res.resume(); }
function sendError(res, status, type, message) {
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// ─── 管理端点 ────────────────────────────────────────────────
function handleStatus(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', backends: pool.stats(), routing: pool.routingStats(), token_usage: tokenDB.summary() }, null, 2));
}
function handleStats(req, res) {
  const s = tokenDB.summary();
  const today = new Date().toISOString().slice(0, 10);
  let text = '';
  text += `═══ Token 用量统计 (从 ${s.startedAt} 起) ═══\n\n`;
  text += `【总用量】\n`;
  text += `  请求次数: ${s.totals.requests}\n`;
  text += `  输入 tokens: ${s.totals.input.toLocaleString()}\n`;
  text += `  输出 tokens: ${s.totals.output.toLocaleString()}\n`;
  text += `  缓存命中:   ${s.totals.cache_read.toLocaleString()}\n`;
  text += `  合计:       ${s.totals.total.toLocaleString()}\n\n`;
  text += `【按后端】\n`;
  for (const [name, b] of Object.entries(s.byBackend)) {
    text += `  ${name}: in=${b.input.toLocaleString()} out=${b.output.toLocaleString()} cache=${b.cache_read.toLocaleString()} total=${b.total.toLocaleString()} (${b.requests}次)\n`;
  }
  text += `\n【按模型】\n`;
  for (const [model, m] of Object.entries(s.byModel)) {
    text += `  ${model}: in=${m.input.toLocaleString()} out=${m.output.toLocaleString()} cache=${m.cache_read.toLocaleString()} total=${m.total.toLocaleString()} (${m.requests}次)\n`;
  }
  text += `\n【按天】\n`;
  for (const day of Object.keys(s.byDay).sort().reverse()) {
    const d = s.byDay[day];
    const marker = day === today ? ' ← 今天' : '';
    text += `  ${day}: in=${d.input.toLocaleString()} out=${d.output.toLocaleString()} total=${d.total.toLocaleString()} (${d.requests}次)${marker}\n`;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ─── 主服务器 ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/proxy-status') return handleStatus(req, res);
  if (req.url === '/proxy-stats') return handleStats(req, res);
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const token = authHeader.replace('Bearer ', '').replace('bearer ', '');
  if (token !== PROXY_AUTH_TOKEN) { sendError(res, 401, 'authentication_error', 'Invalid proxy auth token'); return; }
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', proxy: 'llm-proxy', version: '2.0' }));
    return;
  }
  try { await handleRequest(req, res); }
  catch (err) { console.error('Unhandled error:', err); sendError(res, 500, 'internal_error', err.message); }
});

function shutdown() { console.log('\n保存统计数据...'); db?.close(); console.log('已保存。再见！'); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     LLM Reverse Proxy v2.0 已启动         ║');
  console.log(`║     http://localhost:${PORT}                ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('后端列表:');
  pool.backends.forEach((b, i) => { console.log(`  ${i + 1}. [${b.name}] ${b.base_url} → ${b.model}`); });
  console.log('');
  console.log(`状态面板:   http://localhost:${PORT}/proxy-status`);
  console.log(`Token 统计: http://localhost:${PORT}/proxy-stats`);
  console.log('按 Ctrl+C 停止');
  console.log('');
});
