-- LLM Proxy SQLite Schema
-- 所有时间戳使用 UTC，中国时区 (UTC+8) 在写入时处理

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ─── 后端配置 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backends (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,        -- 后端名称
    base_url        TEXT NOT NULL,               -- API 地址
    model           TEXT NOT NULL,               -- 目标模型
    auth_header     TEXT DEFAULT NULL,           -- 自定义认证头
    weight          REAL DEFAULT 1.0,            -- 路由权重
    cooldown_secs   INTEGER DEFAULT 60,          -- 默认冷却秒数
    total_requests  INTEGER DEFAULT 0,           -- 累计请求数
    total_errors    INTEGER DEFAULT 0,           -- 累计错误数
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
);

-- ─── 请求记录（事实表） ────────────────────────────────────
CREATE TABLE IF NOT EXISTS requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    backend_id      INTEGER REFERENCES backends(id) ON DELETE SET NULL,
    session_id      TEXT REFERENCES sessions(session_id),

    model_requested TEXT,                        -- 客户端请求的模型
    model_actual    TEXT,                        -- 实际使用的模型
    status_code     INTEGER,                     -- HTTP 状态码
    attempt         INTEGER DEFAULT 1,           -- 第几次尝试（fallback 重试递增）

    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,

    error_type      TEXT DEFAULT NULL,           -- 错误类型（成功为 NULL）
    is_fallback     INTEGER DEFAULT 0,           -- 是否由 fallback 路由而来
    duration_ms     INTEGER DEFAULT NULL,        -- 请求耗时（毫秒）

    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),  -- 中国时区时间

    created_at      TEXT DEFAULT (datetime('now'))
);

-- ─── 会话追踪（粘性路由） ──────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,            -- 如 "claude-1"
    backend_id      INTEGER REFERENCES backends(id) ON DELETE SET NULL,  -- 粘性绑定后端
    first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
    request_count   INTEGER DEFAULT 0,
    total_tokens    INTEGER DEFAULT 0
);

-- ─── 错误事件 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS errors (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id      INTEGER REFERENCES requests(id) ON DELETE SET NULL,
    backend_id      INTEGER REFERENCES backends(id) ON DELETE SET NULL,
    error_type      TEXT NOT NULL,               -- rate_limit / timeout / server_error 等
    error_message   TEXT DEFAULT NULL,
    attempt         INTEGER DEFAULT 1,           -- 第几次尝试时发生
    is_retryable    INTEGER DEFAULT 1,           -- 是否可重试
    timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 聚合统计（预计算，加速 Dashboard 查询） ───────────────
CREATE TABLE IF NOT EXISTS aggregated_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type     TEXT NOT NULL,               -- 'hour' / 'day' / 'week' / 'month'
    period_key      TEXT NOT NULL,               -- 如 '2026-04-15T10' / '2026-04-15'
    backend_id      INTEGER REFERENCES backends(id) ON DELETE SET NULL,  -- NULL 表示全局
    model           TEXT DEFAULT NULL,           -- NULL 表示所有模型

    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    request_count   INTEGER DEFAULT 0,

    UNIQUE(period_type, period_key, backend_id, model)
);

-- ─── 索引 ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_requests_backend_id ON requests(backend_id);
CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model_actual);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS idx_errors_timestamp ON errors(timestamp);
CREATE INDEX IF NOT EXISTS idx_errors_backend ON errors(backend_id);
CREATE INDEX IF NOT EXISTS idx_errors_type ON errors(error_type);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
CREATE INDEX IF NOT EXISTS idx_aggregated_lookup ON aggregated_stats(period_type, period_key, backend_id, model);
CREATE INDEX IF NOT EXISTS idx_requests_timestamp_tokens ON requests(timestamp, input_tokens, output_tokens, cache_read_tokens);
