#!/usr/bin/env node

/**
 * Token Monitor v2 — TUI Dashboard + 悬浮球
 *
 * 用法:
 *   node monitor.mjs          # Dashboard
 *   node monitor.mjs --ball   # 悬浮球模式
 *
 * 键盘:
 *   1/2/3/4  切换周期（时/天/周/月）
 *   ←/→      翻页（上一周期/下一周期）
 *   d        打开 Dashboard（球模式下）
 *   q        退出
 */

import { spawnSync } from 'node:child_process';

if (!process.execArgv.includes('--experimental-sqlite')) {
  const result = spawnSync(process.execPath, ['--experimental-sqlite', ...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ─── 配置 ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_URL = 'http://localhost:4000';
const DB_PATH = resolve(__dirname, '..', 'proxy.db');
const POLL_MS = 3000;
const FLUSH_MS = 30000;
const BALL_MODE = process.argv.includes('--ball');

// 中国时区偏移（UTC+8，单位 ms）
const TZ_OFFSET = 8 * 60 * 60 * 1000;

// 周期配置
const PERIOD_CONFIG = {
  hour:  { maxBars: 24, label: '按小时', unit: 'h' },
  day:   { maxBars: 30, label: '按天',   unit: 'd' },
  week:  { maxBars: 52, label: '按周',   unit: 'w' },
  month: { maxBars: 12, label: '按月',   unit: 'm' },
};

// ─── SQLite ────────────────────────────────────────────
let db = null;
try {
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(DB_PATH, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
} catch {
  console.warn('  ⚠ SQLite 不可用，仅使用内存统计');
}

// ─── ANSI 工具 ─────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const clr = (s, c) => `${c}${s}${C.reset}`;
const hideCursor = () => process.stdout.write('\x1b[?25l');
const showCursor = () => process.stdout.write('\x1b[?25h');
const clearScreen = () => process.stdout.write('\x1b[2J\x1b[H');
const moveCursor = (row, col) => process.stdout.write(`\x1b[${row};${col}H`);
const eraseLine = () => process.stdout.write('\x1b[2K\r');

// ─── 中国时区日期工具 ──────────────────────────────────
function cnDate(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET);
}
function cnHourKey(d = new Date()) {
  const c = cnDate(d);
  return `${c.getUTCFullYear()}-${String(c.getUTCMonth()+1).padStart(2,'0')}-${String(c.getUTCDate()).padStart(2,'0')}T${String(c.getUTCHours()).padStart(2,'0')}`;
}
function cnDayKey(d = new Date()) {
  const c = cnDate(d);
  return `${c.getUTCFullYear()}-${String(c.getUTCMonth()+1).padStart(2,'0')}-${String(c.getUTCDate()).padStart(2,'0')}`;
}
function cnWeekKey(d = new Date()) {
  const c = cnDate(d);
  c.setUTCHours(0, 0, 0, 0);
  const dayOfWeek = c.getUTCDay();
  const monday = new Date(c);
  monday.setUTCDate(c.getUTCDate() - ((dayOfWeek + 6) % 7));
  const w1 = new Date(monday.getUTCFullYear(), 0, 4);
  const wn = 1 + Math.round(((monday - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
  return `${monday.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`;
}
function cnMonthKey(d = new Date()) {
  const c = cnDate(d);
  return `${c.getUTCFullYear()}-${String(c.getUTCMonth()+1).padStart(2,'0')}`;
}

// 将 requests 表中的 timestamp（中国时区字符串）转换为 period key
function tsToPeriodKey(ts, period) {
  // ts: '2026-04-16 09:13:17'
  if (period === 'hour') return ts.slice(0, 13).replace(' ', 'T');
  if (period === 'day') return ts.slice(0, 10);
  if (period === 'month') return ts.slice(0, 7);
  if (period === 'week') {
    const d = new Date(ts.replace(' ', 'T') + '+08:00');
    return cnWeekKey(d);
  }
  return ts;
}

// 生成连续的 key 列表（用于固定轴）
function generateKeys(period, pageOffset) {
  const keys = [];
  const now = cnDate(new Date());
  for (let i = 0; i < PERIOD_CONFIG[period].maxBars; i++) {
    const d = new Date(now.getTime() - (PERIOD_CONFIG[period].maxBars - 1 + pageOffset) * getPeriodMs(period) + i * getPeriodMs(period));
    switch (period) {
      case 'hour':  keys.push(cnHourKey(d)); break;
      case 'day':   keys.push(cnDayKey(d)); break;
      case 'week':  keys.push(cnWeekKey(d)); break;
      case 'month': keys.push(cnMonthKey(d)); break;
    }
  }
  return keys;
}

function getPeriodMs(period) {
  switch (period) {
    case 'hour':  return 3600000;
    case 'day':   return 86400000;
    case 'week':  return 7 * 86400000;
    case 'month': return 30 * 86400000;
  }
}

function formatPeriodLabel(key, period) {
  switch (period) {
    case 'hour':  return key.slice(11) + ':00';
    case 'day':   return key.slice(5);
    case 'week':  return key.slice(5);
    case 'month': return key.slice(5);
  }
  return key;
}

function periodPageLabel(period, pageOffset) {
  if (period === 'day') {
    const d = cnDate(new Date());
    d.setDate(d.getDate() + pageOffset);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  if (period === 'hour') {
    return '今天 24 小时';
  }
  if (period === 'week') {
    return '今年 52 周';
  }
  if (period === 'month') {
    return '今年 12 月';
  }
  return '';
}

// ─── 时间序列存储 ───────────────────────────────────────
class TimeSeries {
  constructor() {
    // 内存缓冲区（未刷新的实时数据）
    this.buffer = { perHour: {}, perDay: {}, perWeek: {}, perMonth: {} };
    this.speedSamples = [];
    this.lastTotals = null;
  }

  record(input, output, cache) {
    const total = input + output + cache;
    if (total <= 0) return;
    const now = new Date();
    for (const [store, key] of [
      ['perHour', cnHourKey(now)], ['perDay', cnDayKey(now)],
      ['perWeek', cnWeekKey(now)], ['perMonth', cnMonthKey(now)],
    ]) {
      if (!this.buffer[store][key]) this.buffer[store][key] = { input: 0, output: 0, cache: 0, total: 0 };
      const b = this.buffer[store][key];
      b.input += input; b.output += output; b.cache += cache; b.total += total;
    }
  }

  flushToDB() {
    // 不再写入 aggregated_stats（原表因 SQLite UNIQUE 对 NULL 的特殊处理已积累大量重复脏数据，
    // 且 requests 事实表已包含完整历史，monitor 直接按需从 requests 聚合即可）
    this.buffer = { perHour: {}, perDay: {}, perWeek: {}, perMonth: {} };
  }

  getPeriodData(period, pageOffset) {
    const keys = generateKeys(period, pageOffset);
    const results = keys.map(k => ({ key: k, label: formatPeriodLabel(k, period), input: 0, output: 0, cache: 0, total: 0 }));
    const resultMap = Object.fromEntries(results.map(r => [r.key, r]));

    if (db) {
      // 从 requests 事实表直接聚合（避免依赖已损坏的 aggregated_stats）
      const startTs = (keys[0] + (period === 'hour' ? ':00:00' : ' 00:00:00')).replace('T', ' ');
      const endTs = (keys[keys.length - 1] + (period === 'hour' ? ':59:59' : ' 23:59:59')).replace('T', ' ');
      const rows = db.prepare(`
        SELECT timestamp, input_tokens, output_tokens, cache_read_tokens
        FROM requests
        WHERE timestamp >= ? AND timestamp <= ?
      `).all(startTs, endTs);

      for (const r of rows) {
        const key = tsToPeriodKey(r.timestamp, period);
        if (resultMap[key]) {
          resultMap[key].input += r.input_tokens || 0;
          resultMap[key].output += r.output_tokens || 0;
          resultMap[key].cache += r.cache_read_tokens || 0;
        }
      }
    }

    // 合并内存缓冲区中的实时数据
    const storeKey = `per${period.charAt(0).toUpperCase() + period.slice(1)}`;
    for (const r of results) {
      const buf = this.buffer[storeKey]?.[r.key];
      if (buf) {
        r.input += buf.input;
        r.output += buf.output;
        r.cache += buf.cache;
      }
      r.total = r.input + r.output + r.cache;
    }

    return results;
  }

  updateSpeed(currentTotal) {
    const now = Date.now();
    this.speedSamples.push({ time: now, total: currentTotal });
    if (this.speedSamples.length > 40) this.speedSamples = this.speedSamples.slice(-40);
  }
  getSpeed() {
    const s = this.speedSamples;
    if (s.length < 2) return { perSec: 0, per10Sec: 0, isIdle: true };
    const last = s[s.length - 1], prev = s[s.length - 2];
    const dt = (last.time - prev.time) / 1000;
    const perSec = dt > 0 ? (last.total - prev.total) / dt : 0;
    const tenSecAgo = s.filter(x => x.time >= last.time - 12000);
    let per10Sec = 0;
    if (tenSecAgo.length >= 2) {
      const dt10 = (tenSecAgo[tenSecAgo.length - 1].time - tenSecAgo[0].time) / 1000;
      per10Sec = dt10 > 0 ? (tenSecAgo[tenSecAgo.length - 1].total - tenSecAgo[0].total) / dt10 : 0;
    }
    return { perSec: Math.round(perSec * 10) / 10, per10Sec: Math.round(per10Sec * 10) / 10, isIdle: perSec < 0.5 };
  }
  getTodayTotal() {
    const todayKey = cnDayKey();
    if (db) {
      const r = db.prepare(`
        SELECT SUM(input_tokens) as i, SUM(output_tokens) as o, SUM(cache_read_tokens) as c
        FROM requests WHERE timestamp >= ? AND timestamp <= ?
      `).get(`${todayKey} 00:00:00`, `${todayKey} 23:59:59`);
      const dbTotal = (r?.i || 0) + (r?.o || 0) + (r?.c || 0);
      const bufTotal = this.buffer.perDay[todayKey]?.total || 0;
      return dbTotal + bufTotal;
    }
    return this.buffer.perDay[todayKey]?.total || 0;
  }
}

const ts = new TimeSeries();

// ─── 代理轮询 ──────────────────────────────────────────
let proxyOnline = false;
let backends = [];

async function poll() {
  try {
    const res = await fetch(`${PROXY_URL}/proxy-status`);
    const data = await res.json();
    const totals = data.token_usage?.totals;
    backends = data.backends || [];
    if (totals) {
      const currentTotal = totals.total || 0;
      if (ts.lastTotals !== null && currentTotal >= ts.lastTotals.total) {
        const di = (totals.input || 0) - ts.lastTotals.input;
        const dout = (totals.output || 0) - ts.lastTotals.output;
        const dc = (totals.cache_read || 0) - ts.lastTotals.cache_read;
        if (di > 0 || dout > 0 || dc > 0) ts.record(di, dout, dc);
      }
      ts.lastTotals = { total: currentTotal, input: totals.input || 0, output: totals.output || 0, cache_read: totals.cache_read || 0 };
      ts.updateSpeed(currentTotal);
    }
    proxyOnline = true;
  } catch { proxyOnline = false; }
}

setInterval(poll, POLL_MS);
poll();
setInterval(() => ts.flushToDB(), FLUSH_MS);

// ─── 格式化 ────────────────────────────────────────────
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 100) return String(Math.round(n));
  if (n >= 1) return n.toFixed(1);
  return '0';
}
function fmtDate() {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

// ─── 柱状图渲染（横轴=量，纵轴=时间，水平条形图）─────────
function renderChart(period, pageOffset) {
  const data = ts.getPeriodData(period, pageOffset);
  const termW = process.stdout.columns || 120;
  const marginL = 8;  // 时间标签宽度
  const chartW = termW - marginL - 2;
  const n = data.length;

  if (n === 0) return { lines: [`  ${clr('暂无数据', C.dim)}`] };

  const maxVal = Math.max(...data.map(d => d.total || 0), 1) * 1.15;

  // 每行一个时间段，用水平条形图
  const maxRows = Math.min(n, 26); // 最多显示26行
  const visibleData = data.slice(-maxRows);

  const lines = [];

  // 标题行
  lines.push(clr(`  ${maxVal >= 1_000_000 ? (maxVal/1_000_000).toFixed(1)+'M' : maxVal >= 1_000 ? (maxVal/1_000).toFixed(0)+'K' : maxVal.toFixed(0)}`.padStart(7), C.dim) + '  ' + clr('◄ 量 ────────────────────────────────────────', C.dim));
  lines.push(' '.repeat(marginL) + '├' + '─'.repeat(chartW));

  for (const d of visibleData) {
    const label = d.label.padEnd(6);
    const total = d.total || 0;
    const input = d.input || 0;
    const output = d.output || 0;
    const cache = d.cache || 0;
    const barLen = total > 0 ? Math.max(1, Math.round((total / maxVal) * chartW)) : 0;
    const inputLen = total > 0 ? Math.round((input / maxVal) * chartW) : 0;
    const cacheLen = total > 0 ? Math.round((cache / maxVal) * chartW) : 0;
    const outputLen = barLen - inputLen - cacheLen;

    let bar = '';
    if (cacheLen > 0) bar += clr('█'.repeat(cacheLen), C.yellow);
    if (inputLen > 0) bar += clr('█'.repeat(inputLen), C.green);
    if (outputLen > 0) bar += clr('█'.repeat(outputLen), C.blue);
    bar += ' '.repeat(Math.max(0, barLen - bar.length));

    const totalStr = total > 0 ? clr(fmtTokens(total), C.dim) : clr('0', C.dim);
    lines.push(clr(label, C.cyan) + ' │ ' + bar + ' ' + totalStr);
  }

  return { lines };
}

// ─── 后端状态表 ────────────────────────────────────────
function renderBackends() {
  if (backends.length === 0) return ['  ' + clr('无法获取后端状态', C.dim)];
  return backends.map(b => {
    const name = b.name.padEnd(18);
    const req = (`${b.requests} req`).padEnd(10);
    const err = (`${b.errors} err`).padEnd(10);
    const cd = b.cooldown === '-' ? clr('  OK', C.green) : clr(`  冷却 ${b.cooldown}`, C.red);
    return `  ${name}  ${req}  ${err} ${cd}`;
  });
}

// ─── Dashboard 模式 ────────────────────────────────────
let currentPeriod = 'hour';
let pageOffset = 0;  // 翻页偏移（负数=往前翻）
const periodOrder = ['hour', 'day', 'week', 'month'];
const spinner = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
let spinIdx = 0;

function renderDashboard() {
  const speed = ts.getSpeed();
  const termW = process.stdout.columns || 120;
  const w = Math.min(termW, 120);

  clearScreen();
  const hLine = '─'.repeat(w);
  const dLine = '═'.repeat(w);

  let row = 1;

  // 头部
  const header = clr(`╔${dLine}╗`, C.dim);
  moveCursor(row++, 1); process.stdout.write(header);

  const infoLine = `  Speed: ${speed.isIdle ? clr('idle', C.dim) : clr(`${speed.perSec} t/s`, C.green)}  │  Today: ${clr(fmtTokens(ts.getTodayTotal()), C.cyan)}  │  Proxy: ${proxyOnline ? clr('Online', C.green) : clr('Offline', C.red)}  │  Backends: ${backends.length}  `;
  moveCursor(row++, 1); process.stdout.write(clr('║', C.dim) + clr('  Token Monitor', C.bold) + ' '.repeat(Math.max(1, w - 38 - fmtDate().length)) + clr(fmtDate(), C.dim) + clr('  ║', C.dim));

  moveCursor(row++, 1); process.stdout.write(clr('║', C.dim) + infoLine.padEnd(w) + clr('║', C.dim));

  // 周期选择器 + 翻页
  const periodBtns = periodOrder.map(p => {
    const label = PERIOD_CONFIG[p].label;
    const num = periodOrder.indexOf(p) + 1;
    if (p === currentPeriod) return ` [${num}]${clr(label, C.bold + C.green)} `;
    return ` [${num}]${label} `;
  }).join('');
  const pageLabel = periodPageLabel(currentPeriod, pageOffset);
  const navInfo = `  ${pageOffset < 0 ? clr('◀ 上一页', C.dim) : ''}${pageOffset === 0 ? '  当前' : ''}${pageOffset > 0 ? clr('下一页 ▶', C.dim) : ''}  ${clr(pageLabel, C.cyan)}  `;
  moveCursor(row++, 1); process.stdout.write(clr('║', C.dim) + (periodBtns + navInfo).padEnd(w) + clr('║', C.dim));

  moveCursor(row++, 1); process.stdout.write(clr('╠' + '═'.repeat(w) + '╣', C.dim));

  // 图表（水平条形图，占满宽度）
  const { lines: chartLines } = renderChart(currentPeriod, pageOffset);
  for (const line of chartLines) {
    moveCursor(row++, 1); process.stdout.write(line);
  }

  // 图例
  const legend = `  ${clr('■', C.green)} Input   ${clr('■', C.blue)} Output   ${clr('■', C.yellow)} Cache`;
  moveCursor(row++, 1); process.stdout.write(legend);

  moveCursor(row++, 1); process.stdout.write(clr(`╠${hLine}╣`, C.dim));

  // 后端状态
  moveCursor(row++, 1); process.stdout.write(clr('║', C.dim) + '  ' + clr('Backend Status:', C.bold) + ' '.repeat(w - 19) + clr('║', C.dim));
  for (const line of renderBackends()) {
    moveCursor(row++, 1);
    const padded = line.length > w - 2 ? line.slice(0, w - 2) : line.padEnd(w - 2);
    process.stdout.write(clr('║', C.dim) + padded + clr('║', C.dim));
  }

  moveCursor(row++, 1); process.stdout.write(clr(`╚${dLine}╝`, C.dim));

  // 底部提示
  const tip = `  ${spinner[spinIdx % spinner.length]}  1/2/3/4 周期  │  ←/→ 翻页  │  q 退出`;
  moveCursor(row++, 1); process.stdout.write(clr(tip, C.dim));
  spinIdx++;
}

// ─── Ball 模式 ─────────────────────────────────────────
function renderBall() {
  const speed = ts.getSpeed();
  const s = spinner[spinIdx % spinner.length];
  spinIdx++;
  const speedStr = speed.isIdle ? clr('idle', C.dim) : clr(`${speed.perSec} t/s`, C.green);
  const proxyStr = proxyOnline ? '' : clr(' PROXY OFF', C.red);
  eraseLine();
  process.stdout.write(`${clr(s, C.cyan)} ${speedStr}  │ Today: ${clr(fmtTokens(ts.getTodayTotal()), C.cyan)}  │ 10s: ${fmtTokens(speed.per10Sec)}/s${proxyStr}  ${clr('[d]ashboard [q]uit', C.dim)}`);
}

// ─── 键盘输入 ──────────────────────────────────────────
import readline from 'node:readline';

let stdinSetup = false;
function setupStdin() {
  if (stdinSetup || !process.stdin.isTTY) return;
  stdinSetup = true;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      ts.flushToDB(); showCursor(); clearScreen();
      console.log(clr('Token Monitor 已停止。统计数据已保存。', C.dim));
      process.exit(0);
    }
    if (BALL_MODE) {
      if (key.name === 'd' || key.name === 'return') {
        try {
          const script = `node "${resolve(__dirname, 'monitor.mjs')}"`;
          execSync(`osascript -e 'tell application "Terminal" to do script "${script}"'`, { stdio: 'ignore' });
        } catch {}
      }
    } else {
      if (key.name === '1') { currentPeriod = 'hour'; pageOffset = 0; renderDashboard(); }
      if (key.name === '2') { currentPeriod = 'day';   pageOffset = 0; renderDashboard(); }
      if (key.name === '3') { currentPeriod = 'week';  pageOffset = 0; renderDashboard(); }
      if (key.name === '4') { currentPeriod = 'month'; pageOffset = 0; renderDashboard(); }
      if (key.name === 'left')  { pageOffset = Math.max(pageOffset - 1, -50); renderDashboard(); }
      if (key.name === 'right') { pageOffset = Math.min(pageOffset + 1, 0);   renderDashboard(); }
    }
  });
}

// ─── 启动 ──────────────────────────────────────────────
async function main() {
  hideCursor();
  await poll();

  if (BALL_MODE) {
    console.log(clr('Token Monitor — 悬浮球模式  (按 d 开 Dashboard, q 退出)', C.dim));
    setInterval(renderBall, 2000);
    renderBall();
  } else {
    renderDashboard();
    setInterval(renderDashboard, 5000);
  }

  setupStdin();
}

main();

process.on('SIGINT', () => { ts.flushToDB(); showCursor(); process.exit(0); });
process.on('SIGTERM', () => { ts.flushToDB(); showCursor(); process.exit(0); });
process.on('SIGTSTP', () => { ts.flushToDB(); showCursor(); process.kill(process.pid, 'SIGSTOP'); });
