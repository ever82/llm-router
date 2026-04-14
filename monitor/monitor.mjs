#!/usr/bin/env node

/**
 * Token Monitor — TUI Dashboard + 悬浮球
 *
 * 用法:
 *   node monitor.mjs          # 完整 Dashboard
 *   node monitor.mjs --ball   # 悬浮球模式（单行速度）
 *
 * 键盘:
 *   1/2/3/4  切换周期（小时/天/周/月）
 *   d        打开 Dashboard（球模式下）
 *   q        退出
 */

import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ─── 配置 ──────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_URL = 'http://localhost:4000';
const DATA_DIR = resolve(__dirname, '..', 'data');
const DATA_FILE = resolve(DATA_DIR, 'timeseries.json');
const POLL_MS = 3000;
const SAVE_MS = 30000;
const BALL_MODE = process.argv.includes('--ball');
const MAX_BARS = 30;
const CHART_ROWS = 18;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── ANSI 工具 ─────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m',
  bgGreen: '\x1b[42m', bgBlue: '\x1b[44m', bgYellow: '\x1b[43m',
};
const clr = (s, c) => `${c}${s}${C.reset}`;
const hideCursor = () => process.stdout.write('\x1b[?25l');
const showCursor = () => process.stdout.write('\x1b[?25h');
const clearScreen = () => process.stdout.write('\x1b[2J\x1b[H');
const moveCursor = (row, col) => process.stdout.write(`\x1b[${row};${col}H`);
const eraseLine = () => process.stdout.write('\x1b[2K\r');

// ─── 时间序列存储 ───────────────────────────────────────
class TimeSeries {
  constructor() {
    this.perHour = {};
    this.perDay = {};
    this.perWeek = {};
    this.perMonth = {};
    this.speedSamples = []; // { time, total }
    this.lastTotals = null;
    this.load();
  }

  load() {
    try {
      if (existsSync(DATA_FILE)) {
        const d = JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
        this.perHour = d.perHour || {};
        this.perDay = d.perDay || {};
        this.perWeek = d.perWeek || {};
        this.perMonth = d.perMonth || {};
      }
    } catch {}
  }

  save() {
    try {
      writeFileSync(DATA_FILE, JSON.stringify({
        perHour: this.perHour,
        perDay: this.perDay,
        perWeek: this.perWeek,
        perMonth: this.perMonth,
      }, null, 2));
    } catch {}
  }

  // 时间桶 key
  hourKey(d = new Date()) { return d.toISOString().slice(0, 13); }
  dayKey(d = new Date()) { return d.toISOString().slice(0, 10); }
  weekKey(d = new Date()) {
    const t = new Date(d);
    t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
    const w1 = new Date(t.getFullYear(), 0, 4);
    const wn = 1 + Math.round(((t - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
    return `${t.getFullYear()}-W${String(wn).padStart(2, '0')}`;
  }
  monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }

  // 记录一次增量
  record(input, output, cache) {
    const total = input + output + cache;
    if (total <= 0) return;
    const now = new Date();
    for (const [store, key] of [
      ['perHour', this.hourKey(now)],
      ['perDay', this.dayKey(now)],
      ['perWeek', this.weekKey(now)],
      ['perMonth', this.monthKey(now)],
    ]) {
      if (!this[store][key]) this[store][key] = { input: 0, output: 0, cache: 0, total: 0 };
      const b = this[store][key];
      b.input += input; b.output += output; b.cache += cache; b.total += total;
    }
  }

  // 获取指定周期的数据（最多 30 条）
  getPeriod(period) {
    let store;
    switch (period) {
      case 'hour':  store = this.perHour;  break;
      case 'day':   store = this.perDay;   break;
      case 'week':  store = this.perWeek;  break;
      case 'month': store = this.perMonth; break;
      default: return [];
    }
    const keys = Object.keys(store).sort().slice(-MAX_BARS);
    return keys.map(k => ({
      key: k,
      label: formatPeriodLabel(k, period),
      ...store[k],
    }));
  }

  // 更新速度采样
  updateSpeed(currentTotal) {
    const now = Date.now();
    this.speedSamples.push({ time: now, total: currentTotal });
    if (this.speedSamples.length > 40) this.speedSamples = this.speedSamples.slice(-40);
  }

  getSpeed() {
    const s = this.speedSamples;
    if (s.length < 2) return { perSec: 0, per10Sec: 0, isIdle: true };
    const last = s[s.length - 1];
    const prev = s[s.length - 2];
    const dt = (last.time - prev.time) / 1000;
    const perSec = dt > 0 ? (last.total - prev.total) / dt : 0;
    // 10 秒平均
    const tenSecAgo = s.filter(x => x.time >= last.time - 12000);
    let per10Sec = 0;
    if (tenSecAgo.length >= 2) {
      const dt10 = (tenSecAgo[tenSecAgo.length - 1].time - tenSecAgo[0].time) / 1000;
      per10Sec = dt10 > 0 ? (tenSecAgo[tenSecAgo.length - 1].total - tenSecAgo[0].total) / dt10 : 0;
    }
    return {
      perSec: Math.round(perSec * 10) / 10,
      per10Sec: Math.round(per10Sec * 10) / 10,
      isIdle: perSec < 0.5,
    };
  }

  getTodayTotal() {
    return this.perDay[this.dayKey()]?.total || 0;
  }
}

function formatPeriodLabel(key, period) {
  switch (period) {
    case 'hour':  return key.slice(11) + ':00'; // "17:00"
    case 'day':   return key.slice(5);           // "04-14"
    case 'week':  return key.slice(5);           // "W15"
    case 'month': return key.slice(5);           // "04"
  }
  return key;
}

const ts = new TimeSeries();

// ─── 代理轮询 ──────────────────────────────────────────
let proxyOnline = false;
let backends = [];
let lastPollTotals = null;

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
        if (di > 0 || dout > 0 || dc > 0) {
          ts.record(di, dout, dc);
        }
      }
      ts.lastTotals = {
        total: currentTotal,
        input: totals.input || 0,
        output: totals.output || 0,
        cache_read: totals.cache_read || 0,
      };
      ts.updateSpeed(currentTotal);
    }
    proxyOnline = true;
  } catch {
    proxyOnline = false;
  }
}

setInterval(poll, POLL_MS);
poll();
setInterval(() => ts.save(), SAVE_MS);

// ─── 格式化 ────────────────────────────────────────────
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  if (n >= 100) return String(Math.round(n));
  if (n >= 1) return n.toFixed(1);
  return '0';
}
function fmtDate() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

// ─── 柱状图渲染 ────────────────────────────────────────
function renderChart(period) {
  const data = ts.getPeriod(period);
  const termW = process.stdout.columns || 100;
  const marginL = 8;
  const marginR = 2;
  const chartW = termW - marginL - marginR - 2;
  const n = data.length;

  if (n === 0) {
    return `${' '.repeat(marginL)}  ${clr('暂无数据，等代理有流量后显示', C.dim)}`;
  }

  const maxVal = Math.max(...data.map(d => d.total || 0)) * 1.15 || 1;

  // 每个柱子的宽度
  const gap = Math.max(2, Math.floor(chartW / n / 4));
  const barW = Math.min(12, Math.max(4, Math.floor((chartW - gap * (n + 1)) / n)));

  const lines = [];

  for (let row = 0; row < CHART_ROWS; row++) {
    const threshold = maxVal * (CHART_ROWS - row) / CHART_ROWS;
    let line = '';

    // Y 轴标签
    const showLabel = row % Math.ceil(CHART_ROWS / 5) === 0;
    if (showLabel) {
      line += clr(fmtTokens(maxVal * (CHART_ROWS - row) / CHART_ROWS).padStart(6), C.dim) + ' ┤ ';
    } else {
      line += ' '.repeat(marginL) + '│ ';
    }

    // 柱子
    for (let i = 0; i < n; i++) {
      const d = data[i];
      const cacheH = (d.cache || 0) / maxVal * CHART_ROWS;
      const inputH = (d.input || 0) / maxVal * CHART_ROWS;
      const outputH = (d.output || 0) / maxVal * CHART_ROWS;

      const rowFromBottom = CHART_ROWS - row;
      const rowTop = rowFromBottom;
      const rowBot = rowFromBottom - 1;

      if (rowTop <= 0) {
        line += ' '.repeat(barW);
      } else if (rowTop <= cacheH) {
        line += clr('█'.repeat(barW), C.yellow);
      } else if (rowTop <= cacheH + inputH) {
        line += clr('█'.repeat(barW), C.green);
      } else if (rowTop <= cacheH + inputH + outputH) {
        line += clr('█'.repeat(barW), C.blue);
      } else {
        line += ' '.repeat(barW);
      }
      line += ' '.repeat(gap);
    }
    lines.push(line);
  }

  // X 轴线
  lines.push(' '.repeat(marginL) + '└' + '─'.repeat(chartW));

  // X 轴标签
  let labelLine = ' '.repeat(marginL + 1);
  for (let i = 0; i < n; i++) {
    const lbl = data[i].label || '';
    const pad = Math.max(0, Math.floor((barW - lbl.length) / 2));
    const truncated = lbl.length > barW ? lbl.slice(0, barW) : lbl;
    labelLine += ' '.repeat(pad) + clr(truncated, C.dim) + ' '.repeat(barW - pad - truncated.length + gap);
  }
  lines.push(labelLine);

  return lines.join('\n');
}

// ─── 后端状态表 ────────────────────────────────────────
function renderBackends() {
  if (backends.length === 0) return '  ' + clr('无法获取后端状态', C.dim);
  const termW = process.stdout.columns || 100;
  const lines = backends.map(b => {
    const name = b.name.padEnd(18);
    const req = (`${b.requests} req`).padEnd(10);
    const err = (`${b.errors} err`).padEnd(10);
    const cd = b.cooldown === '-' ? clr('  OK', C.green) : clr(`  冷却 ${b.cooldown}`, C.red);
    return `  ${name}  ${req}  ${err} ${cd}`;
  });
  return lines.join('\n');
}

// ─── Dashboard 模式 ────────────────────────────────────
let currentPeriod = 'hour';
const periodNames = { hour: '按小时', day: '按天', week: '按周', month: '按月' };
const periodOrder = ['hour', 'day', 'week', 'month'];
const spinner = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
let spinIdx = 0;

function renderDashboard() {
  const speed = ts.getSpeed();
  const termW = process.stdout.columns || 100;
  const w = Math.min(termW, 100);

  clearScreen();
  const hLine = '─'.repeat(w);
  const dLine = '═'.repeat(w);

  // 头部
  console.log(clr(`╔${dLine}╗`, C.dim));
  console.log(clr('║', C.dim) + clr('  Token Monitor', C.bold) + ' '.repeat(w - 38) + clr(fmtDate(), C.dim) + clr('  ║', C.dim));
  const speedStr = speed.isIdle
    ? clr('idle', C.dim)
    : clr(`${speed.perSec} t/s`, C.green);
  const proxyStr = proxyOnline ? clr('Online', C.green) : clr('Offline', C.red);
  const todayStr = fmtTokens(ts.getTodayTotal());
  console.log(clr('║', C.dim) + `  Speed: ${speedStr}  │  Today: ${clr(todayStr, C.cyan)}  │  Proxy: ${proxyStr}  │  Backends: ${backends.length}  `.padEnd(w + 1) + clr('║', C.dim));
  console.log(clr(`╠${dLine}╣`, C.dim));

  // 周期选择器
  const periodBtns = periodOrder.map(p => {
    const label = periodNames[p];
    const num = periodOrder.indexOf(p) + 1;
    if (p === currentPeriod) return ` [${num}]${clr(label, C.bold + C.green)} `;
    return ` [${num}]${label} `;
  }).join('');
  console.log(clr('║', C.dim) + periodBtns.padEnd(w) + clr('║', C.dim));
  console.log(clr('╠', C.dim) + hLine + clr('╣', C.dim));

  // 图表
  const chartLines = renderChart(currentPeriod);
  for (const line of chartLines.split('\n')) {
    const padded = line.length > w ? line.slice(0, w) : line.padEnd(w);
    console.log(clr('║', C.dim) + ' ' + padded + clr('║', C.dim));
  }

  // 图例
  const legend = `  ${clr('■', C.green)} Input   ${clr('■', C.blue)} Output   ${clr('■', C.yellow)} Cache`;
  console.log(clr('║', C.dim) + legend.padEnd(w) + clr('║', C.dim));
  console.log(clr('╠', C.dim) + hLine + clr('╣', C.dim));

  // 后端状态
  console.log(clr('║', C.dim) + '  ' + clr('Backend Status:', C.bold) + ' '.repeat(w - 19) + clr('║', C.dim));
  for (const line of renderBackends().split('\n')) {
    const padded = line.length > w ? line.slice(0, w) : line.padEnd(w);
    console.log(clr('║', C.dim) + padded + clr('║', C.dim));
  }

  console.log(clr(`╚${dLine}╝`, C.dim));
  console.log(clr(`  ${spinner[spinIdx % spinner.length]}  按 1/2/3/4 切换周期  │  q 退出`, C.dim));
  spinIdx++;
}

// ─── Ball 模式 ─────────────────────────────────────────
function renderBall() {
  const speed = ts.getSpeed();
  const s = spinner[spinIdx % spinner.length];
  spinIdx++;

  const speedStr = speed.isIdle ? clr('idle', C.dim) : clr(`${speed.perSec} t/s`, C.green);
  const proxyStr = proxyOnline ? '' : clr(' PROXY OFF', C.red);
  const todayStr = fmtTokens(ts.getTodayTotal());

  eraseLine();
  process.stdout.write(
    `${clr(s, C.cyan)} ${speedStr}  │ Today: ${clr(todayStr, C.cyan)}  │ 10s avg: ${fmtTokens(speed.per10Sec)}/s${proxyStr}  ${clr('[d]ashboard [q]uit', C.dim)}`
  );
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
      ts.save();
      showCursor();
      clearScreen();
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
      if (key.name === '1') { currentPeriod = 'hour'; renderDashboard(); }
      if (key.name === '2') { currentPeriod = 'day'; renderDashboard(); }
      if (key.name === '3') { currentPeriod = 'week'; renderDashboard(); }
      if (key.name === '4') { currentPeriod = 'month'; renderDashboard(); }
    }
  });
}

// ─── 启动 ──────────────────────────────────────────────
async function main() {
  hideCursor();

  // 先完成第一次轮询
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

// 优雅退出
process.on('SIGINT', () => { ts.save(); showCursor(); process.exit(0); });
process.on('SIGTERM', () => { ts.save(); showCursor(); process.exit(0); });
process.on('SIGTSTP', () => { ts.save(); showCursor(); process.kill(process.pid, 'SIGSTOP'); });
