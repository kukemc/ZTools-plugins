const http = require('http');
const https = require('https');
const { mcpSseInitializeAndListTools } = require('./mcp-sse.cjs');

const AUTH_TOKEN = 'RXfcqSQdjlbzEOqvuDBJG61F2VeQcuXX';

const record = {
  baseUrl: new URL('https://api.kuke.ink/mcp/sse'),
  extraHeaders: {
    'Authorization': `Bearer ${AUTH_TOKEN}`,
  },
  httpAgent: https.globalAgent,
  pendingRequests: new Map(),
  output: [],
  sseEndpoint: null,
  sseConnected: false,
  status: 'connecting',
  error: null,
  tools: [],
};

async function test() {
  console.log('=== 测试 mcpSseInitializeAndListTools ===\n');

  try {
    const result = await mcpSseInitializeAndListTools(record);
    console.log('\n=== 结果 ===');
    console.log('success:', result.success);
    console.log('工具数量:', result.data?.length);
    console.log('工具:', result.data?.map(t => t.name));
    console.log('\n输出日志:');
    record.output.forEach(o => {
      console.log(`  [${o.channel}] ${o.text}`);
    });
  } catch (err) {
    console.error('\n=== 错误 ===', err.message);
    console.log('\n输出日志:');
    record.output.forEach(o => {
      console.log(`  [${o.channel}] ${o.text}`);
    });
  }
}

test();
