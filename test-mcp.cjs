const http = require('http');
const https = require('https');

const AUTH_TOKEN = 'RXfcqSQdjlbzEOqvuDBJG61F2VeQcuXX';

let mcpRequestIdSeq = 0;
let pendingRequests = new Map();

async function testMcp() {
  console.log('=== MCP SSE 完整流程测试 ===\n');

  // 保持 SSE 连接，等待获取 endpoint
  const sseConn = await connectSse();
  console.log('\n获取到 endpoint:', sseConn.endpoint);

  console.log('\n=== 发送 initialize ===');
  const initResult = await sendRequest(sseConn, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'test', version: '1.0.0' },
  });
  console.log('Initialize 结果:', JSON.stringify(initResult, null, 2));

  console.log('\n=== 发送 tools/list ===');
  const toolsResult = await sendRequest(sseConn, 'tools/list', {});
  console.log('Tools/list 结果:', JSON.stringify(toolsResult, null, 2));

  console.log('\n=== 测试完成 ===');
  if (toolsResult.result && toolsResult.result.tools) {
    console.log('工具数量:', toolsResult.result.tools.length);
    console.log('工具:', toolsResult.result.tools.map(t => t.name));
  }

  sseConn.req.destroy();
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

    console.log('[1] 连接 SSE...');
    const req = https.request(opts, (res) => {
      console.log('[2] SSE 状态码:', res.statusCode);

      let cookie = '';
      if (res.headers['set-cookie']) {
        cookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
        console.log('[3] Cookie:', cookie);
      }

      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            console.log('[4] SSE 数据:', data.substring(0, 100));

            // 检查是否是 endpoint 路径
            if (data.startsWith('/')) {
              console.log('[5] Endpoint 确定:', data);
              // 返回连接对象
              resolve({
                endpoint: data,
                cookie,
                req,
                res,
              });
            } else {
              // JSON 响应
              try {
                const json = JSON.parse(data);
                if (json.id !== undefined && pendingRequests.has(json.id)) {
                  console.log(`[6] 收到响应 #${json.id}`);
                  const pending = pendingRequests.get(json.id);
                  pendingRequests.delete(json.id);
                  pending.resolve(json);
                }
              } catch (e) {
                // ignore
              }
            }
          }
        }
      });

      res.on('end', () => {
        console.log('[SSE 连接结束]');
      });

      res.on('error', (err) => {
        console.log('[SSE 错误]', err.message);
      });
    });

    req.on('error', (err) => {
      console.log('[连接错误]', err.message);
      reject(err);
    });

    req.setTimeout(30000, () => {
      console.log('[连接超时]');
      req.destroy();
      reject(new Error('连接超时'));
    });

    req.end();
  });
}

function sendRequest(sseConn, method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++mcpRequestIdSeq;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    };

    pendingRequests.set(requestId, { resolve, reject, method });

    const url = new URL(sseConn.endpoint, 'https://api.kuke.ink');
    const body = JSON.stringify(request);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    };

    if (sseConn.cookie) {
      headers['Cookie'] = sseConn.cookie;
    }

    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    console.log(`[发送请求 #${requestId}] ${method} -> ${url.href}`);

    const postReq = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        console.log(`[请求 #${requestId}] HTTP 响应: ${res.statusCode}`);
      });
    });

    postReq.on('error', (err) => {
      console.log(`[请求 #${requestId}] 错误:`, err.message);
      pendingRequests.delete(requestId);
      reject(err);
    });

    postReq.setTimeout(30000, () => {
      console.log(`[请求 #${requestId}] 超时`);
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

testMcp()
  .then(() => {
    console.log('\n=== 测试成功 ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n=== 测试失败 ===', err.message);
    process.exit(1);
  });