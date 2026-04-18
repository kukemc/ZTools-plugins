const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const OpenAIImport = require('openai');

const OpenAIClient = OpenAIImport?.OpenAI || OpenAIImport;
const MAX_DEBUG_LOGS = 800;
const debugLogs = [];

const now = () => Date.now();
const createTraceId = (scope = 'trace') =>
  `${scope}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const safeErrorMessage = (error) =>
  error instanceof Error ? error.message : String(error || 'unknown error');

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function appendDebugLog(scope, event, payload = {}, level = 'info') {
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    scope,
    event,
    payload,
  };

  debugLogs.push(entry);
  if (debugLogs.length > MAX_DEBUG_LOGS) {
    debugLogs.splice(0, debugLogs.length - MAX_DEBUG_LOGS);
  }

  const printable = `[KukeAgent][${entry.level}][${scope}] ${event} ${safeStringify(payload)}`;
  if (level === 'error') {
    console.error(printable);
  } else {
    console.log(printable);
  }
}

function createOpenAIClient(config = {}) {
  return new OpenAIClient({
    apiKey: config.apiKey || 'empty',
    baseURL: config.baseURL,
    dangerouslyAllowBrowser: true,
  });
}

function emitChatEvent(handlers, event) {
  if (!handlers || typeof handlers.onEvent !== 'function') {
    return;
  }

  try {
    handlers.onEvent(event);
  } catch (error) {
    appendDebugLog('chat.stream', 'handler_error', { message: safeErrorMessage(error) }, 'error');
  }
}

function extractContentTextPart(part) {
  if (typeof part === 'string') {
    return part;
  }
  if (!part || typeof part !== 'object') {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.text?.value === 'string') {
    return part.text.value;
  }
  if (typeof part.content === 'string') {
    return part.content;
  }
  return '';
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => extractContentTextPart(part)).join('');
  }
  return extractContentTextPart(content);
}

function normalizeAssistantMessage(message) {
  const normalizedMessage = { ...message };
  const hasToolCalls = Array.isArray(normalizedMessage.tool_calls) && normalizedMessage.tool_calls.length > 0;

  if (hasToolCalls) {
    if (normalizedMessage.content == null) {
      normalizedMessage.content = null;
    } else if (typeof normalizedMessage.content === 'string' && !normalizedMessage.content.trim()) {
      normalizedMessage.content = null;
    } else if (Array.isArray(normalizedMessage.content) && normalizedMessage.content.length === 0) {
      normalizedMessage.content = null;
    }
  } else if (!Array.isArray(normalizedMessage.tool_calls) || !normalizedMessage.tool_calls.length) {
    delete normalizedMessage.tool_calls;
  }

  return normalizedMessage;
}

function mergeToolCallDelta(targetMessage, toolCallDelta) {
  const toolCallIndex = toolCallDelta.index ?? 0;
  const existingToolCall = targetMessage.tool_calls[toolCallIndex] || {
    id: '',
    type: 'function',
    function: {
      name: '',
      arguments: '',
    },
  };

  if (toolCallDelta.id) {
    existingToolCall.id = toolCallDelta.id;
  }
  if (toolCallDelta.type) {
    existingToolCall.type = toolCallDelta.type;
  }
  if (toolCallDelta.function?.name) {
    existingToolCall.function.name += toolCallDelta.function.name;
  }
  if (toolCallDelta.function?.arguments) {
    existingToolCall.function.arguments += toolCallDelta.function.arguments;
  }

  targetMessage.tool_calls[toolCallIndex] = existingToolCall;
}

async function createChatResponse(openai, config, messages, tools, handlers = {}, traceId = createTraceId('chat')) {
  const useStream = typeof handlers.onEvent === 'function';
  appendDebugLog('chat', 'request_start', {
    traceId,
    model: config?.model,
    messageCount: Array.isArray(messages) ? messages.length : 0,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    stream: useStream,
  });

  if (!useStream) {
    const response = await openai.chat.completions.create({
      model: config.model,
      messages,
      tools,
      tool_choice: tools && tools.length > 0 ? 'auto' : 'none',
      stream: false,
    });

    appendDebugLog('chat', 'request_finish', {
      traceId,
      mode: 'non_stream',
      finishReason: response.choices?.[0]?.finish_reason || null,
    });
    return normalizeAssistantMessage(response.choices[0].message);
  }

  const stream = await openai.chat.completions.create({
    model: config.model,
    messages,
    tools,
    tool_choice: tools && tools.length > 0 ? 'auto' : 'none',
    stream: true,
  });

  const finalMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [],
  };

  let contentDeltaCount = 0;
  let toolDeltaCount = 0;
  let finishReason = null;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};

    if (delta.role) {
      finalMessage.role = delta.role;
    }

    const deltaText = extractContentText(delta.content);
    if (deltaText) {
      contentDeltaCount += 1;
      finalMessage.content += deltaText;
      emitChatEvent(handlers, { type: 'content_delta', delta: deltaText });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        mergeToolCallDelta(finalMessage, toolCallDelta);
        toolDeltaCount += 1;
      }

      emitChatEvent(handlers, {
        type: 'tool_calls_delta',
        toolCalls: finalMessage.tool_calls,
      });
    }

    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
      emitChatEvent(handlers, { type: 'finish', finishReason });
    }
  }

  if (finalMessage.tool_calls.length && !finalMessage.content.trim()) {
    finalMessage.content = null;
  }

  appendDebugLog('chat', 'request_finish', {
    traceId,
    mode: 'stream',
    contentDeltaCount,
    toolDeltaCount,
    finalToolCalls: finalMessage.tool_calls.length,
    finishReason,
  });

  return normalizeAssistantMessage(finalMessage);
}

window.localTools = {
  chat: async (config, messages, tools, handlers) => {
    const traceId = createTraceId('chat');
    const startAt = now();
    try {
      const openai = createOpenAIClient(config);
      const response = await createChatResponse(openai, config, messages, tools, handlers, traceId);
      appendDebugLog('chat', 'success', { traceId, durationMs: now() - startAt });
      return { success: true, data: response };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('chat', 'error', { traceId, durationMs: now() - startAt, message }, 'error');
      return { success: false, error: message };
    }
  },

  getModels: async (config) => {
    const traceId = createTraceId('models');
    const startAt = now();
    try {
      const openai = createOpenAIClient(config);
      const response = await openai.models.list();
      appendDebugLog('models', 'success', {
        traceId,
        durationMs: now() - startAt,
        total: Array.isArray(response?.data) ? response.data.length : 0,
      });
      return { success: true, data: response.data };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('models', 'error', { traceId, durationMs: now() - startAt, message }, 'error');
      return { success: false, error: message };
    }
  },

  readDir: (dirPath) => {
    const traceId = createTraceId('read_dir');
    const startAt = now();
    const targetPath = path.resolve(String(dirPath || ''));
    try {
      const files = fs.readdirSync(targetPath, { withFileTypes: true });
      const data = files.map((file) => ({
        name: file.name,
        isDirectory: file.isDirectory(),
        path: path.join(targetPath, file.name),
      }));
      appendDebugLog('file.read_dir', 'success', {
        traceId,
        durationMs: now() - startAt,
        inputPath: dirPath,
        resolvedPath: targetPath,
        items: data.length,
      });
      return { success: true, data };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('file.read_dir', 'error', {
        traceId,
        durationMs: now() - startAt,
        inputPath: dirPath,
        resolvedPath: targetPath,
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  readFile: (filePath) => {
    const traceId = createTraceId('read_file');
    const startAt = now();
    const targetPath = path.resolve(String(filePath || ''));
    try {
      const data = fs.readFileSync(targetPath, 'utf-8');
      appendDebugLog('file.read_file', 'success', {
        traceId,
        durationMs: now() - startAt,
        inputPath: filePath,
        resolvedPath: targetPath,
        bytes: Buffer.byteLength(data, 'utf-8'),
      });
      return { success: true, data };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('file.read_file', 'error', {
        traceId,
        durationMs: now() - startAt,
        inputPath: filePath,
        resolvedPath: targetPath,
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  writeFile: (filePath, content) => {
    const traceId = createTraceId('write_file');
    const startAt = now();
    const targetPath = path.resolve(String(filePath || ''));
    try {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const normalizedContent = typeof content === 'string' ? content : String(content ?? '');
      fs.writeFileSync(targetPath, normalizedContent, 'utf-8');
      appendDebugLog('file.write_file', 'success', {
        traceId,
        durationMs: now() - startAt,
        inputPath: filePath,
        resolvedPath: targetPath,
        bytes: Buffer.byteLength(normalizedContent, 'utf-8'),
      });
      return { success: true };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('file.write_file', 'error', {
        traceId,
        durationMs: now() - startAt,
        inputPath: filePath,
        resolvedPath: targetPath,
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  execCommand: (command, cwd) => {
    const traceId = createTraceId('exec');
    const startAt = now();
    const resolvedCwd = cwd ? path.resolve(String(cwd)) : process.cwd();

    appendDebugLog('exec', 'start', {
      traceId,
      command,
      cwd: resolvedCwd,
    });

    return new Promise((resolve) => {
      exec(
        String(command || ''),
        {
          cwd: resolvedCwd,
          windowsHide: true,
          shell: true,
          timeout: 5 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const durationMs = now() - startAt;
          if (error) {
            appendDebugLog('exec', 'error', {
              traceId,
              durationMs,
              command,
              cwd: resolvedCwd,
              message: safeErrorMessage(error),
              stderrLength: stderr?.length || 0,
              stdoutLength: stdout?.length || 0,
            }, 'error');
            resolve({ success: false, error: error.message, stderr, stdout });
            return;
          }

          appendDebugLog('exec', 'success', {
            traceId,
            durationMs,
            command,
            cwd: resolvedCwd,
            stdoutLength: stdout?.length || 0,
            stderrLength: stderr?.length || 0,
          });
          resolve({ success: true, stdout, stderr });
        },
      );
    });
  },

  getDebugLogs: (limit = 300) => {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), MAX_DEBUG_LOGS);
    return {
      success: true,
      data: debugLogs.slice(-normalizedLimit),
    };
  },

  clearDebugLogs: () => {
    debugLogs.splice(0, debugLogs.length);
    appendDebugLog('debug', 'cleared', {}, 'info');
    return { success: true };
  },
};
