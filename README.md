# LLM Router

一个 Node.js 编写的 LLM 反向代理，支持多后端自动 failover、粘性路由、token 用量统计。

## 功能特性

- **多后端自动 failover**：请求失败自动切换到下一个后端
- **粘性加权路由**：同来源请求尽量路由到同一后端，支持权重配置
- **Token 用量统计**：按后端/模型/天统计输入/输出/缓存 tokens
- **流式错误检测**：mid-stream 错误也能触发 fallback
- **会话追踪**：基于 TCP 连接识别 Claude Code 进程

## 快速开始

### 1. 配置

```bash
cp config.example.json config.json
# 编辑 config.json，填入你的 API keys 和后端地址
```

### 2. 启动

```bash
./start.sh        # 前台运行
./start.sh bg     # 后台运行
```

### 3. 配合 Claude Code 使用

编辑 `~/.claude/settings.json`，将 API 请求指向本代理：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-proxy-change-me",
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air"
  }
}
```

| 配置项 | 说明 |
|--------|------|
| `ANTHROPIC_AUTH_TOKEN` | 对应 config.json 中的 `proxy_auth_token` |
| `ANTHROPIC_BASE_URL` | 代理地址，默认 `http://localhost:4000` |
| `ANTHROPIC_DEFAULT_*_MODEL` | 模型映射，通过 config.json 的 `model_map` 转发到后端 |

> **提示**：也可以通过环境变量设置，效果相同：
> ```bash
> export ANTHROPIC_BASE_URL=http://localhost:4000
> export ANTHROPIC_AUTH_TOKEN=sk-proxy-change-me
> ```

## 配置说明

```json
{
  "port": 4000,
  "proxy_auth_token": "sk-proxy-change-me-to-anything",
  "cooldown_duration": 60000,
  "light_models": ["claude-haiku-4-5-20251001"],
  "model_map": {
    "claude-sonnet-4-20250514": "glm-5.1"
  },
  "backends": [
    {
      "name": "Z.AI-GLM",
      "base_url": "https://api.z.ai/api/anthropic",
      "api_key": "你的API-KEY",
      "model": "glm-5.1",
      "light_model": "glm-4.5-air",
      "cooldown_duration": 60000
    }
  ]
}
```

| 配置项 | 说明 |
|--------|------|
| `port` | 代理监听端口 |
| `proxy_auth_token` | 访问代理的认证 token |
| `light_models` | 轻量模型列表，匹配到的请求将使用各后端的 `light_model` |
| `model_map` | 模型名称映射，将请求的模型名转换为后端接受的模型名 |
| `backends[].light_model` | 轻量模型名称，当请求命中 `light_models` 时替代 `model` 发送给上游 |
| `backends[].cooldown_duration` | 后端失败后冷却时间（毫秒） |
| `backends[].is_available` | 是否启用该后端，设为 `false` 可暂停（不路由、不分配新会话），默认 `true` |

### LM Studio 本地模型

在 LM Studio 的 **Developer → Server** 设置中，将 **API** 格式切换为 **Anthropic**，然后在 `config.json` 中添加：

```json
{
  "name": "LM-Studio",
  "base_url": "http://localhost:1234",
  "api_key": "lm-studio",
  "model": "local",
  "light_model": "local",
  "medium_model": "local",
  "cooldown_duration": 30000,
  "is_available": true
}
```

> `base_url` 不要带 `/v1` 后缀，proxy 会自动拼接 Anthropic 的请求路径 `/v1/messages`。

## API 端点

| 端点 | 说明 |
|------|------|
| `POST /` | 代理请求（需要 Bearer token 认证） |
| `GET /proxy-status` | 后端状态和路由统计 |
| `GET /proxy-stats` | Token 用量详情（文本格式） |

## 监控面板

### 启动 Dashboard

```bash
cd monitor
node monitor.mjs          # TUI Dashboard
```

Dashboard 显示 token 用量的柱状图和实时速率，支持键盘切换周期（1=时, 2=天, 3=周, 4=月）。

### 启动桌面悬浮球

```bash
cd monitor
./float.sh                # macOS 用 Swift，其他平台用 Python/Tkinter
```

悬浮球显示实时输入/输出速率，交互方式：

| 操作 | 说明 |
|------|------|
| **单击**（不拖拽） | 打开 Dashboard |
| **双击** | 打开 Dashboard |
| **拖拽** | 移动位置 |
| **右键** | 退出 / 菜单 |

悬浮球和 Dashboard 是独立的，可以同时运行。

## 数据库

统计数据存储在 `proxy.db`（SQLite）。首次运行会自动创建表结构。

历史数据迁移：
```bash
node init-db.mjs --migrate
```
这会从旧的 `stats.json` 和 `data/timeseries.json` 迁移到 SQLite。

## 目录结构

```
├── proxy.mjs        # 主代理程序
├── init-db.mjs      # 数据库初始化工具
├── config.json      # 配置文件（需创建）
├── config.example.json
├── schema.sql       # 数据库表结构
├── proxy.db         # SQLite 数据库
├── start.sh         # 启动脚本
└── stop.sh          # 停止脚本
```