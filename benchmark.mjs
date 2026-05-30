#!/usr/bin/env node
/**
 * 测试 LLM Proxy / LM Studio 的流式 token 输出速度
 * 用法: node benchmark.mjs
 */

const PROXY_URL = 'http://localhost:4000/v1/messages';
const AUTH_TOKEN = 'sk-proxy-local-llm-router';

const prompt = '请详细介绍一下tokenization的原理和常见算法，包括BPE、WordPiece和SentencePiece的区别和演进过程。请尽可能详细地展开说明。';

async function benchmark() {
  const startTime = performance.now();
  const firstChunkTime = { value: null };

  let outputTokens = 0;
  let inputTokens = 0;
  let chunkCount = 0;
  let textLength = 0;

  const chunkTimeline = []; // { idx, timeMs, deltaMs, textLen }

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    stream: true,
    messages: [{ role: 'user', content: prompt }],
  });

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`HTTP ${res.status}: ${text}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (!firstChunkTime.value) {
      firstChunkTime.value = performance.now() - startTime;
    }

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

        const now = performance.now() - startTime;
        const lastTime = chunkTimeline.length > 0 ? chunkTimeline[chunkTimeline.length - 1].timeMs : 0;
        const deltaMs = now - lastTime;
        let thisTextLen = 0;

        // 统计内容块
        if (data.type === 'content_block_delta' && data.delta?.text) {
          thisTextLen = data.delta.text.length;
          textLength += thisTextLen;
        }

        // 也支持 OpenAI 格式 delta
        if (data.choices && data.choices[0]?.delta?.content) {
          thisTextLen = data.choices[0].delta.content.length;
          textLength += thisTextLen;
        }

        // message_start 中获取输入 token
        if (data.type === 'message_start' && data.message?.usage) {
          inputTokens = data.message.usage.input_tokens || 0;
        }

        // message_delta 中获取输出 token（通常在最后）
        if (data.type === 'message_delta' && data.usage) {
          outputTokens = data.usage.output_tokens || outputTokens;
        }

        chunkTimeline.push({ idx: chunkCount, timeMs: now, deltaMs, textLen: thisTextLen });
      } catch {}
    }
  }

  const endTime = performance.now();
  const totalMs = endTime - startTime;
  const totalSeconds = totalMs / 1000;

  // 如果 message_delta 没有给出 usage，用估算
  // 中文字符约 1.5 token，英文约 1 token。这里混合文本，粗略按字符数估算
  const estimatedTokens = outputTokens || Math.round(textLength * 1.5); // 中文为主，保守估计

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║          流式速度测试结果                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  首字节延迟 (TTFT): ${firstChunkTime.value.toFixed(2)} ms`);
  console.log(`  总耗时:            ${totalSeconds.toFixed(2)} s`);
  console.log(`  SSE 事件数:        ${chunkCount}`);
  console.log(`  输入 tokens:       ${inputTokens}`);
  console.log(`  输出 tokens (报告): ${outputTokens || 'N/A'}`);
  console.log(`  输出字符数:        ${textLength}`);
  console.log(`  估算输出 tokens:   ~${estimatedTokens}`);
  console.log('');
  console.log(`  输出速度 (基于估算 tokens):  ${estimatedTokens > 0 ? (estimatedTokens / totalSeconds).toFixed(1) : 'N/A'} tokens/s`);
  if (outputTokens > 0) {
    console.log(`  输出速度 (基于报告 tokens):  ${(outputTokens / totalSeconds).toFixed(1)} tokens/s`);
  }
  console.log(`  字符速度:                    ${(textLength / totalSeconds).toFixed(1)} chars/s`);
  console.log('');

  // 逐 chunk 时间线
  console.log('╔══════════════════════════════════════════╗');
  console.log('║          逐 Chunk 时间线                 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  const showChunks = chunkTimeline.slice(0, 10);
  for (const c of showChunks) {
    console.log(`  chunk #${String(c.idx).padStart(3)}  绝对时间 ${c.timeMs.toFixed(1).padStart(8)}ms  间隔 ${c.deltaMs.toFixed(1).padStart(8)}ms  文本长度 ${String(c.textLen).padStart(4)}`);
  }
  if (chunkTimeline.length > 10) {
    console.log(`  ... 共 ${chunkTimeline.length} 个 chunk，省略中间部分`);
    const last = chunkTimeline[chunkTimeline.length - 1];
    console.log(`  chunk #${String(last.idx).padStart(3)}  绝对时间 ${last.timeMs.toFixed(1).padStart(8)}ms  间隔 ${last.deltaMs.toFixed(1).padStart(8)}ms  文本长度 ${String(last.textLen).padStart(4)}`);
  }

  // chunk 间隔统计
  const intervals = chunkTimeline.map(c => c.deltaMs).filter(d => d > 0);
  if (intervals.length > 0) {
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const minInterval = Math.min(...intervals);
    const maxInterval = Math.max(...intervals);
    console.log('');
    console.log(`  chunk 间隔统计: 平均 ${avgInterval.toFixed(1)}ms / 最小 ${minInterval.toFixed(1)}ms / 最大 ${maxInterval.toFixed(1)}ms`);
  }
  console.log('');
}

benchmark().catch(err => {
  console.error('测试失败:', err.message);
  process.exit(1);
});
