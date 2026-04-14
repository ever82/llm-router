#!/usr/bin/env node

/**
 * LLM Reverse Proxy v2 - 带 mid-stream 错误检测和自动 fallback
 */

import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
const STATS_FILE = resolve(__dirname, 'stats.json');
const STATS_SAVE_INTERVAL = 30_000;

// ─── 可重试的错误类型 ────────────────────────────────────────
const RETRYABLE_ERROR_TYPES = new Set([
  'terminated', 'timeout', 'rate_limit', 'overloaded',
  'api_error', 'server_error', 'connection_error',
  'internal_error', 'capacity_limit',
]);

// ─── Token 统计 ──────────────────────────────────────────────
class TokenTracker {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.byBackend = {};
    this.byModel = {};
    this.byDay = {};
  }
  record(backendName, model, usage) {
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
    const day = new Date().toISOString().slice(0, 10);
    if (!this.byDay[day]) this.byDay[day] = { input: 0, output: 0, cache_read: 0, total: 0, requests: 0 };
    const d = this.byDay[day];
    d.input += input; d.output += output; d.cache_read += cacheRead; d.total += total; d.requests += 1;
  }
  summary() {
    const totals = { input: 0, output: 0, cache_read: 0, total: 0, requests: 0 };
    for (const b of Object.values(this.byBackend)) {
      totals.input += b.input; totals.output += b.output;
      totals.cache_read += b.cache_read; totals.total += b.total; totals.requests += b.requests;
    }
    return { startedAt: this.startedAt, totals, byBackend: this.byBackend, byModel: this.byModel, byDay: this.byDay };
  }
  save() { try { writeFileSync(STATS_FILE, JSON.stringify(this.summary(), null, 2)); } catch {} }
  static load() {
    try {
      if (existsSync(STATS_FILE)) {
        const data = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
        const t = new TokenTracker(); t.startedAt = data.startedAt;
        t.byBackend = data.byBackend || {}; t.byModel = data.byModel || {}; t.byDay = data.byDay || {};
        return t;
      }
    } catch {}
    return new TokenTracker();
  }
}
const tokenTracker = TokenTracker.load();
setInterval(() => tokenTracker.save(), STATS_SAVE_INTERVAL);

// ─── SSE 流处理器：提取 token + 检测错误 ─────────────────────
class StreamProcessor extends Transform {
  constructor(backendName, model) {
    super();
    this.backendName = backendName;
    this.model = model;
    this.buffer = '';
    this.usageFromStart = null;
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
            tokenTracker.record(this.backendName, this.model, usage);
            const total = usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens;
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
          tokenTracker.record(this.backendName, this.model, usage);
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
async function handleRequest(req, res) {
  const body = await readBody(req);
  const maxAttempts = pool.backends.length;

  let requestModel = null;
  let isStream = false;
  try {
    const parsed = JSON.parse(body);
    requestModel = parsed.model || null;
    isStream = parsed.stream || false;
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
    if (requestModel && backend.model) {
      const mappedModel = modelMap[requestModel] || backend.model;
      actualModel = mappedModel;
      finalBody = body.replace(`"model":"${requestModel}"`, `"model":"${mappedModel}"`);
      finalBody = finalBody.replace(`"model": "${requestModel}"`, `"model": "${mappedModel}"`);
    }
    delete fwdHeaders['host'];
    delete fwdHeaders['content-length'];
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
        res.writeHead(status, backendRes.headers);
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
        res.writeHead(backendRes.statusCode, backendRes.headers);
        for (const chunk of buffered) {
          res.write(chunk);
        }
        const processor = new StreamProcessor(backend.name, actualModel);
        backendRes.pipe(processor).pipe(res);

        // 流结束后检测 mid-stream 错误，冷却后端
        processor.on('finish', () => {
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
            tokenTracker.record(backend.name, actualModel, parsed.usage);
            const u = parsed.usage;
            const total = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0);
            console.log(`    📊 tokens: in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache=${u.cache_read_input_tokens || 0} total=${total}`);
          }
        } catch {}
        res.writeHead(backendRes.statusCode, backendRes.headers);
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
  res.end(JSON.stringify({ status: 'ok', backends: pool.stats(), routing: pool.routingStats(), token_usage: tokenTracker.summary() }, null, 2));
}
function handleStats(req, res) {
  const s = tokenTracker.summary();
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

function shutdown() { console.log('\n保存统计数据...'); tokenTracker.save(); console.log('已保存。再见！'); process.exit(0); }
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
