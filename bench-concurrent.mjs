#!/usr/bin/env node
/**
 * 并发请求测试：同时发 N 个请求，看各自的速度
 * 用法: node bench-concurrent.mjs [并发数]
 */

const CONCURRENCY = parseInt(process.argv[2], 10) || 2;
const PROXY_URL = 'http://localhost:4000/v1/messages';
const AUTH_TOKEN = 'sk-proxy-local-llm-router';

const prompt = '用100字总结一下Python的GIL机制。';

function makeRequest(id) {
  return new Promise(async (resolve) => {
    const startTime = performance.now();
    let firstChunkMs = null;
    let outputTokens = 0;
    let textLength = 0;
    let chunkCount = 0;

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    });

    try {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstChunkMs) firstChunkMs = performance.now() - startTime;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const data = JSON.parse(jsonStr);
            chunkCount++;
            if (data.type === 'content_block_delta' && data.delta?.text) {
              textLength += data.delta.text.length;
            }
            if (data.type === 'message_delta' && data.usage) {
              outputTokens = data.usage.output_tokens || outputTokens;
            }
          } catch {}
        }
      }

      const totalMs = performance.now() - startTime;
      resolve({
        id,
        ok: true,
        firstChunkMs,
        totalMs,
        outputTokens,
        textLength,
        chunkCount,
      });
    } catch (err) {
      resolve({ id, ok: false, error: err.message });
    }
  });
}

async function main() {
  console.log(`并发测试: ${CONCURRENCY} 个请求同时发送\n`);
  const promises = Array.from({ length: CONCURRENCY }, (_, i) => makeRequest(i + 1));
  const results = await Promise.all(promises);

  console.log('╔════╦═════════╦════════════╦════════════╦═════════╦══════════════╗');
  console.log('║  # ║ 状态    ║ 首字节(ms) ║ 总耗时(ms) ║ tokens  ║ 速度(tok/s)  ║');
  console.log('╠════╬═════════╬════════════╬════════════╬═════════╬══════════════╣');

  for (const r of results) {
    if (r.ok) {
      const speed = r.totalMs > 0 && r.outputTokens > 0
        ? (r.outputTokens / (r.totalMs / 1000)).toFixed(1)
        : 'N/A';
      console.log(
        `║ ${String(r.id).padStart(2)} ║ 成功    ║ ${String(r.firstChunkMs.toFixed(0)).padStart(10)} ║ ${String(r.totalMs.toFixed(0)).padStart(10)} ║ ${String(r.outputTokens).padStart(7)} ║ ${String(speed).padStart(12)} ║`
      );
    } else {
      console.log(`║ ${String(r.id).padStart(2)} ║ 失败    ║ ${r.error.slice(0, 40).padStart(10)} ║`);
    }
  }
  console.log('╚════╩═════════╩════════════╩════════════╩═════════╩══════════════╝');

  const okResults = results.filter(r => r.ok);
  if (okResults.length > 0) {
    const avgSpeed = okResults.reduce((s, r) => s + (r.outputTokens / (r.totalMs / 1000)), 0) / okResults.length;
    const totalTokens = okResults.reduce((s, r) => s + r.outputTokens, 0);
    const totalTime = okResults.reduce((s, r) => s + r.totalMs, 0) / okResults.length;
    console.log(`\n平均单请求速度: ${avgSpeed.toFixed(1)} tok/s`);
    console.log(`总输出 tokens:  ${totalTokens}`);
    console.log(`平均耗时:       ${totalTime.toFixed(0)} ms`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
