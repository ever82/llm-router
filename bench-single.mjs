#!/usr/bin/env node
const PROXY_URL = 'http://localhost:4000/v1/messages';
const AUTH_TOKEN = 'sk-proxy-local-llm-router';
const prompt = '用100字总结一下Python的GIL机制。';

async function run() {
  const start = performance.now();
  let firstChunk = null;
  let outputTokens = 0;

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 256, stream: true, messages: [{ role: 'user', content: prompt }] }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstChunk) firstChunk = performance.now() - start;
    buf += decoder.decode(value, { stream: true });
    for (const line of buf.split('\n')) {
      if (!line.trim().startsWith('data:')) continue;
      const s = line.trim().slice(5).trim();
      if (s === '[DONE]') continue;
      try {
        const d = JSON.parse(s);
        if (d.type === 'message_delta' && d.usage) outputTokens = d.usage.output_tokens;
      } catch {}
    }
  }

  const total = performance.now() - start;
  console.log(`单请求: ${outputTokens} tokens / ${(total/1000).toFixed(2)}s = ${(outputTokens/(total/1000)).toFixed(1)} tok/s, TTFT=${firstChunk?.toFixed(0)}ms`);
}
run();
