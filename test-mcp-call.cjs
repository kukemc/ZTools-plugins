const http = require('http');
const https = require('https');

const AUTH_TOKEN = 'RXfcqSQdjlbzEOqvuDBJG61F2VeQcuXX';

let mcpRequestIdSeq = 0;
let pendingRequests = new Map();

async function testMcpToolCall() {
  console.log('=== MCP SSE 完整流程测试（包含工具调用）===\n');

  // 1. 连接 SSE
  console.log('【步骤1】连接 SSE...');
  const { endpoint, cookie } = await connectSse();
  console.log('endpoint:', endpoint);

  // 2. 初始化
  console.log('\n【步骤2】发送 initialize...');
  const initResult = await sendRequest(endpoint, cookie, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  console.log('initialize 成功:', !!initResult.result);

  // 3. 获取工具列表
  console.log('\n【步骤3】发送 tools/list...');
  const toolsResult = await sendRequest(endpoint, cookie, 'tools/list', {});
  console.log('tools/list 原始响应:', JSON.stringify(toolsResult, null, 2));
  const tools = toolsResult.result?.tools || [];
  console.log('工具数量:', tools.length);
  console.log('工具:', tools.map(t => t.name));

  if (tools.length > 0) {
    // 4. 调用工具
    console.log('\n【步骤4】调用工具 send_qq_message...');
    const callResult = await sendRequest(endpoint, cookie, 'tools/call', {
      name: 'send_qq_message',
      arguments: {
        message: '测试消息 from MCP SSE 测试',
        target_id: ['581661416'],
      },
    });
    console.log('call 结果:', JSON.stringify(callResult, null, 2));
  }

  process.exit(0);
}

function connectSse() {
  return new Promise((resolve, reject) => {
    const url = new URL('https://api.kuke.ink/mcp/sse');
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Accept': 'text/event-stream',
      },
    };

    const req = https.request(opts, (res) => {
      let buffer = '';
      let cookie = '';
      if (res.headers['set-cookie']) {
        cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      }

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data.startsWith('/')) {
              console.log('[SSE] endpoint:', data);
              resolve({ endpoint: data, cookie, req, res });
            } else {
              try {
                const json = JSON.parse(data);
                if (json.id !== undefined && pendingRequests.has(json.id)) {
                  const pending = pendingRequests.get(json.id);
                  pendingRequests.delete(json.id);
                  pending.resolve(json);
                }
              } catch (e) {}
            }
          }
        }
      });

      res.on('end', () => {
        console.log('[SSE] 连接结束');
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('连接超时'));
    });
    req.end();
  });
}

function sendRequest(endpoint, cookie, method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++mcpRequestIdSeq;
    const request = { jsonrpc: '2.0', id: requestId, method, params };
    pendingRequests.set(requestId, { resolve, reject, method });

    const url = new URL(endpoint, 'https://api.kuke.ink');
    const body = JSON.stringify(request);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    };
    if (cookie) headers['Cookie'] = cookie;

    const opts = { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST', headers };

    const postReq = https.request(opts, (res) => {
      console.log(`[请求 #${requestId}] ${method} HTTP 响应: ${res.statusCode}`);
    });

    postReq.on('error', (err) => {
      pendingRequests.delete(requestId);
      reject(err);
    });

    postReq.setTimeout(30000, () => {
      postReq.destroy();
      pendingRequests.delete(requestId);
      reject(new Error('请求超时'));
    });

    postReq.write(body);
    postReq.end();

    // 30秒超时
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('请求超时（30秒）'));
      }
    }, 30000);
  });
}

testMcpToolCall().catch(err => {
  console.error('错误:', err.message);
  process.exit(1);
});
