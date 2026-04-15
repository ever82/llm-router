#!/usr/bin/env node

/**
 * 初始化 SQLite 数据库并迁移现有数据
 *
 * 用法:
 *   node init-db.mjs                    # 初始化空数据库
 *   node init-db.mjs --migrate          # 初始化 + 迁移 stats.json 和 timeseries.json
 *   node init-db.mjs --db path/to.db    # 指定数据库路径
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 参数解析 ──────────────────────────────────────────────
const args = process.argv.slice(2);
const shouldMigrate = args.includes('--migrate');
const dbPathIdx = args.indexOf('--db');
const dbPath = dbPathIdx >= 0 ? args[dbPathIdx + 1] : resolve(__dirname, 'proxy.db');

const schemaPath = resolve(__dirname, 'schema.sql');
const statsPath = resolve(__dirname, 'stats.json');
const timeseriesPath = resolve(__dirname, 'data', 'timeseries.json');
const configPath = resolve(__dirname, 'config.json');

// ─── 主流程 ────────────────────────────────────────────────
console.log(`数据库路径: ${dbPath}`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 1. 创建表
console.log('\n1. 创建数据表...');
const schema = readFileSync(schemaPath, 'utf-8');
db.exec(schema);
console.log('   ✓ 表已创建');

// 2. 加载后端配置
console.log('\n2. 加载后端配置...');
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const routingWeights = config.routing?.weights || config.backends.map(() => 1);

  const insertBackend = db.prepare(`
    INSERT OR IGNORE INTO backends (name, base_url, model, weight, cooldown_secs)
    VALUES (?, ?, ?, ?, ?)
  `);

  config.backends.forEach((b, i) => {
    insertBackend.run(b.name, b.base_url, b.model, routingWeights[i] ?? 1, b.cooldown_duration ? b.cooldown_duration / 1000 : (config.cooldown_duration || 60000) / 1000);
    console.log(`   ✓ ${b.name} → ${b.model} (weight: ${routingWeights[i] ?? 1})`);
  });
} else {
  console.log('   ⚠ config.json 不存在，跳过后端配置');
}

// 3. 迁移数据
if (shouldMigrate) {
  console.log('\n3. 迁移历史数据...');

  // 3a. 迁移 stats.json 的 byDay 数据到 requests（按天批量插入汇总记录）
  if (existsSync(statsPath)) {
    const stats = JSON.parse(readFileSync(statsPath, 'utf-8'));
    console.log(`   统计起始时间: ${stats.startedAt}`);

    // 迁移 byDay 数据 → aggregated_stats (day 级别)
    const insertDayStat = db.prepare(`
      INSERT OR REPLACE INTO aggregated_stats
        (period_type, period_key, backend_id, model, input_tokens, output_tokens, cache_read_tokens, request_count)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
    `);

    for (const [day, data] of Object.entries(stats.byDay || {})) {
      const key = day; // '2026-04-14'
      insertDayStat.run('day', key, data.input, data.output, data.cache_read, data.requests);
      console.log(`   ✓ ${day}: ${data.requests} req, ${data.total.toLocaleString()} tokens`);
    }

    // 迁移 byBackend 数据 → aggregated_stats + backends 累计统计
    const updateBackendStats = db.prepare(`
      UPDATE backends SET total_requests = ?, total_errors = 0 WHERE name = ?
    `);
    const insertBackendStat = db.prepare(`
      INSERT OR REPLACE INTO aggregated_stats
        (period_type, period_key, backend_id, model, input_tokens, output_tokens, cache_read_tokens, request_count)
      VALUES ('alltime', 'total', (SELECT id FROM backends WHERE name = ?), NULL, ?, ?, ?, ?)
    `);

    for (const [name, data] of Object.entries(stats.byBackend || {})) {
      updateBackendStats.run(data.requests, name);
      insertBackendStat.run(name, data.input, data.output, data.cache_read, data.requests);
      console.log(`   ✓ backend ${name}: ${data.requests} req`);
    }

    // 迁移 byModel 数据
    const insertModelStat = db.prepare(`
      INSERT OR REPLACE INTO aggregated_stats
        (period_type, period_key, backend_id, model, input_tokens, output_tokens, cache_read_tokens, request_count)
      VALUES ('alltime', 'total', NULL, ?, ?, ?, ?, ?)
    `);

    for (const [model, data] of Object.entries(stats.byModel || {})) {
      insertModelStat.run(model, data.input, data.output, data.cache_read, data.requests);
      console.log(`   ✓ model ${model}: ${data.requests} req`);
    }
  } else {
    console.log('   ⚠ stats.json 不存在，跳过统计迁移');
  }

  // 3b. 迁移 timeseries.json
  if (existsSync(timeseriesPath)) {
    const ts = JSON.parse(readFileSync(timeseriesPath, 'utf-8'));
    const insertTsStat = db.prepare(`
      INSERT OR REPLACE INTO aggregated_stats
        (period_type, period_key, backend_id, model, input_tokens, output_tokens, cache_read_tokens, request_count)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, 0)
    `);

    let tsCount = 0;
    for (const [key, data] of Object.entries(ts.perHour || {})) {
      insertTsStat.run('hour', key, data.input, data.output, data.cache);
      tsCount++;
    }
    for (const [key, data] of Object.entries(ts.perDay || {})) {
      insertTsStat.run('day', key, data.input, data.output, data.cache);
      tsCount++;
    }
    for (const [key, data] of Object.entries(ts.perWeek || {})) {
      insertTsStat.run('week', key, data.input, data.output, data.cache);
      tsCount++;
    }
    for (const [key, data] of Object.entries(ts.perMonth || {})) {
      insertTsStat.run('month', key, data.input, data.output, data.cache);
      tsCount++;
    }
    console.log(`   ✓ 迁移 ${tsCount} 条时序统计数据`);
  } else {
    console.log('   ⚠ timeseries.json 不存在，跳过时序迁移');
  }
}

// 4. 验证
console.log('\n4. 数据库验证:');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
for (const t of tables) {
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get();
  console.log(`   ${t.name}: ${count.cnt} 行`);
}

// 5. 关闭
db.close();
console.log(`\n✓ 数据库初始化完成: ${dbPath}`);
if (shouldMigrate) {
  console.log('  历史数据已迁移。原有的 stats.json 和 timeseries.json 文件保留，可手动删除。');
}
