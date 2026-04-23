const http = require('http');
const https = require('https');

let mcpRequestIdSeq = 0;

function mcpSseConnect(record) {
  return new Promise((resolve, reject) => {
    const url = record.baseUrl;
    const headers = {
      ...record.extraHeaders,
      'Accept': 'text/event-stream',
    };

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      agent: record.httpAgent,
    };

    record.output.push({ channel: 'stdout', text: `[MCP-SSE] 连接 ${url.protocol}//${url.host}${opts.path}`, ts: Date.now() });

    const req = (url.protocol === 'https:' ? https : http).request(opts, (res) => {
      let buffer = '';

      record.output.push({ channel: 'stdout', text: `[MCP-SSE] 状态码: ${res.statusCode}`, ts: Date.now() });

      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          record.status = 'error';
          record.error = `HTTP ${res.statusCode}`;
          record.output.push({ channel: 'stderr', text: `[MCP-SSE] HTTP错误: ${body}`, ts: Date.now() });
          reject(new Error(record.error));
        });
        return;
      }

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              record.output.push({ channel: 'stdout', text: `[MCP-SSE] 连接结束`, ts: Date.now() });
              continue;
            }

            if (data.startsWith('/')) {
              record.sseEndpoint = data;
              record.sseConnected = true;
              record.output.push({ channel: 'stdout', text: `[MCP-SSE] endpoint: ${data}`, ts: Date.now() });
              resolve(data);
              continue;
            }

            try {
              const json = JSON.parse(data);
              record.output.push({ channel: 'stdout', text: `[MCP-SSE] 收到: ${JSON.stringify(json).substring(0, 80)}`, ts: Date.now() });

              if (json.id !== undefined && record.pendingRequests && record.pendingRequests.has(json.id)) {
                const pending = record.pendingRequests.get(json.id);
                record.pendingRequests.delete(json.id);
                record.output.push({ channel: 'stdout', text: `[MCP-SSE] 响应 #${json.id} method=${pending.method || 'unknown'}`, ts: Date.now() });

                if (json.error) {
                  record.status = 'error';
                  record.error = json.error.message || JSON.stringify(json.error);
                  if (pending.reject) pending.reject(new Error(record.error));
                } else {
                  if (pending.resolve) {
                    pending.resolve(json.result || json);
                  }
                }
              }
            } catch (e) {
              record.output.push({ channel: 'stderr', text: `[MCP-SSE] 解析错误: ${data.substring(0, 50)}`, ts: Date.now() });
            }
          }
        }
      });

      res.on('end', () => {
        record.sseConnected = false;
        record.output.push({ channel: 'stderr', text: `[MCP-SSE] 连接意外关闭`, ts: Date.now() });
      });

      res.on('error', (err) => {
        record.output.push({ channel: 'stderr', text: `[MCP-SSE] 错误: ${err.message}`, ts: Date.now() });
      });
    });

    req.on('error', (err) => {
      record.output.push({ channel: 'stderr', text: `[MCP-SSE] 连接错误: ${err.message}`, ts: Date.now() });
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('连接超时'));
    });

    req.end();
  });
}

function mcpSseSendRequest(record, method, params) {
  return new Promise((resolve, reject) => {
    if (!record.sseEndpoint || !record.sseConnected) {
      reject(new Error('SSE未连接'));
      return;
    }

    const requestId = ++mcpRequestIdSeq;
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params: params || {},
    };

    record.pendingRequests.set(requestId, { resolve, reject, method });
    record.output.push({ channel: 'stdout', text: `[MCP-SSE] 发送 #${requestId} ${method}`, ts: Date.now() });

    const url = new URL(record.sseEndpoint, 'https://api.kuke.ink');
    const bodyStr = JSON.stringify(request);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...record.extraHeaders,
    };

    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    const postReq = (url.protocol === 'https:' ? https : http).request(opts, (res) => {
      record.output.push({ channel: 'stdout', text: `[MCP-SSE] POST #${requestId} 响应: ${res.statusCode}`, ts: Date.now() });
    });

    postReq.on('error', (err) => {
      record.pendingRequests.delete(requestId);
      record.output.push({ channel: 'stderr', text: `[MCP-SSE] POST #${requestId} 错误: ${err.message}`, ts: Date.now() });
      reject(err);
    });

    postReq.setTimeout(30000, () => {
      postReq.destroy();
      if (record.pendingRequests.has(requestId)) {
        record.pendingRequests.delete(requestId);
        reject(new Error('请求超时'));
      }
    });

    postReq.write(bodyStr);
    postReq.end();

    setTimeout(() => {
      if (record.pendingRequests.has(requestId)) {
        record.pendingRequests.delete(requestId);
        record.output.push({ channel: 'stderr', text: `[MCP-SSE] #${requestId} 30秒超时`, ts: Date.now() });
        reject(new Error('请求超时（30秒）'));
      }
    }, 30000);
  });
}

async function mcpSseInitializeAndListTools(record) {
  record.pendingRequests = new Map();

  await mcpSseConnect(record);

  const initResult = await mcpSseSendRequest(record, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'kuke-agent', version: '1.0.0' },
  });

  record.output.push({ channel: 'stdout', text: `[MCP-SSE] initialize成功: ${JSON.stringify(initResult).substring(0, 60)}`, ts: Date.now() });

  const toolsResult = await mcpSseSendRequest(record, 'tools/list', {});

  const tools = toolsResult?.tools || [];
  record.tools = tools.map(t => ({
    name: t.name,
    description: t.description || '',
    inputSchema: t.inputSchema || { type: 'object', properties: {} },
  }));

  record.status = 'ready';
  record.output.push({ channel: 'stdout', text: `[MCP-SSE] 工具列表: ${record.tools.map(t => t.name).join(', ')}`, ts: Date.now() });

  return { success: true, data: record.tools };
}

module.exports = { mcpSseInitializeAndListTools, mcpSseConnect, mcpSseSendRequest };
