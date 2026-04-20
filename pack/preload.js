const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { exec, spawn } = require('node:child_process');
const OpenAIImport = require('openai');
const { tavily } = require('@tavily/core');

const OpenAIClient = OpenAIImport?.OpenAI || OpenAIImport;
const MAX_DEBUG_LOGS = 800;

// Default workspace: plugin-owned folder under user home to avoid polluting project directories
// Falls back to os.tmpdir() if home is unavailable
function getDefaultWorkspaceRoot() {
  try {
    var homeDir = os.homedir();
    var pluginDataDir = path.join(homeDir, '.kukeagent', 'workspaces');
    if (!fs.existsSync(pluginDataDir)) {
      fs.mkdirSync(pluginDataDir, { recursive: true });
    }
    return pluginDataDir;
  } catch (e) {
    try {
      var tmpDir = os.tmpdir();
      var fallbackDir = path.join(tmpDir, 'kukeagent-workspaces');
      if (!fs.existsSync(fallbackDir)) {
        fs.mkdirSync(fallbackDir, { recursive: true });
      }
      return fallbackDir;
    } catch (fallbackErr) {
      return process.cwd();
    }
  }
}

const DEFAULT_WORKSPACE_ROOT = getDefaultWorkspaceRoot();
const debugLogs = [];
const activeChatControllers = new Map();
const activeBashProcesses = new Map();
let bashIdSeq = 0;
const BASH_OUTPUT_BUFFER_CAP = 8 * 1024 * 1024;
const BASH_DEFAULT_TIMEOUT_MS = 120 * 1000;
const BASH_MAX_TIMEOUT_MS = 10 * 60 * 1000;
const BASH_RETURN_BYTE_LIMIT = 40 * 1024;
const BASH_RETURN_HEAD_LINES = 80;
const BASH_RETURN_TAIL_LINES = 320;

function trimBashOutput(rawText, channel = 'output') {
  if (typeof rawText !== 'string' || !rawText) {
    return {
      text: rawText || '',
      truncated: false,
      originalBytes: 0,
      originalLines: rawText ? 1 : 0,
    };
  }
  const originalBytes = Buffer.byteLength(rawText, 'utf-8');
  const lines = rawText.split(/\r?\n/);
  const originalLines = lines.length;
  const lineBudget = BASH_RETURN_HEAD_LINES + BASH_RETURN_TAIL_LINES;
  const withinByteBudget = originalBytes <= BASH_RETURN_BYTE_LIMIT;
  const withinLineBudget = originalLines <= lineBudget;
  if (withinByteBudget && withinLineBudget) {
    return { text: rawText, truncated: false, originalBytes, originalLines };
  }
  const head = lines.slice(0, BASH_RETURN_HEAD_LINES);
  const tail = lines.slice(-BASH_RETURN_TAIL_LINES);
  const omittedLines = Math.max(0, originalLines - head.length - tail.length);
  const banner = `... [${channel} truncated: 略过 ${omittedLines} 行 / 原始 ${originalBytes} 字节，共 ${originalLines} 行；显示首 ${head.length} + 末 ${tail.length}] ...`;
  return {
    text: [...head, banner, ...tail].join('\n'),
    truncated: true,
    originalBytes,
    originalLines,
  };
}

let electronWebUtils = null;
try {
  const electronModule = require('electron');
  electronWebUtils = electronModule?.webUtils || null;
} catch {
  electronWebUtils = null;
}

function resolveFileLocalPath(file) {
  if (!file) return '';
  const direct = typeof file.path === 'string' ? file.path.trim() : '';
  if (direct) return direct;
  if (electronWebUtils && typeof electronWebUtils.getPathForFile === 'function') {
    try {
      const resolved = electronWebUtils.getPathForFile(file);
      return typeof resolved === 'string' ? resolved.trim() : '';
    } catch {
      return '';
    }
  }
  return '';
}

const SNAPSHOT_ROOT = path.join(os.tmpdir(), 'kuke_agent_snapshots');
const UPLOAD_ROOT = path.join(os.tmpdir(), 'kuke_agent_uploads');
const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

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

function sanitizePathInput(input) {
  const rawValue = String(input ?? '').trim();
  const quotedMatch = rawValue.match(/^(['"`])(.*)\1$/);
  return quotedMatch ? quotedMatch[2].trim() : rawValue;
}

function resolveLocalPath(inputPath, fieldName = 'path') {
  const normalizedInput = sanitizePathInput(inputPath);
  if (!normalizedInput) {
    throw new Error(`${fieldName} 不能为空`);
  }

  if (/^file:\/\//i.test(normalizedInput)) {
    return path.resolve(fileURLToPath(normalizedInput));
  }

  return path.resolve(normalizedInput);
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
  const hasStructuredToolCalls = Array.isArray(normalizedMessage.tool_calls) && normalizedMessage.tool_calls.length > 0;

  if (hasStructuredToolCalls) {
    // Filter out null/invalid entries from tool_calls array
    var validToolCalls = [];
    for (var nti = 0; nti < normalizedMessage.tool_calls.length; nti++) {
      var tc = normalizedMessage.tool_calls[nti];
      if (tc !== null && tc !== undefined && tc !== '' && tc.function && tc.function.name && tc.function.name.trim()) {
        validToolCalls.push(tc);
      }
    }
    normalizedMessage.tool_calls = validToolCalls;

    // Clean up content
    if (normalizedMessage.content == null) {
      normalizedMessage.content = null;
    } else if (typeof normalizedMessage.content === 'string' && !normalizedMessage.content.trim()) {
      normalizedMessage.content = null;
    } else if (Array.isArray(normalizedMessage.content) && normalizedMessage.content.length === 0) {
      normalizedMessage.content = null;
    }
  } else {
    // No structured tool_calls, attempt to parse text-based tool calls from content
    const content = typeof normalizedMessage.content === 'string' ? normalizedMessage.content : '';
    const parsed = parseTextBasedToolCalls(content);
    if (parsed && parsed.toolCalls.length > 0) {
      normalizedMessage.tool_calls = parsed.toolCalls;
      normalizedMessage.content = parsed.cleanedContent;
    } else {
      delete normalizedMessage.tool_calls;
    }
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

var TEXT_TOOL_CALL_ID_COUNTER = 0;

function nextTextToolCallId() {
  TEXT_TOOL_CALL_ID_COUNTER += 1;
  return 'textcall_' + TEXT_TOOL_CALL_ID_COUNTER;
}

function parseTextBasedToolCalls(content) {
  if (typeof content !== 'string' || !content.trim()) {
    return null;
  }

  var toolCalls = [];
  var cleanedContent = content;

  // Pattern 1: <function_calls>...</function_calls> wrapping <invoke> blocks
  // This covers Minimax and Anthropic legacy XML tool call format
  var functionCallsRegex = /<function_calls>([\s\S]*?)<\/function_calls>/g;
  var fcMatch;
  var hasFcWrapper = false;

  while ((fcMatch = functionCallsRegex.exec(content)) !== null) {
    hasFcWrapper = true;
    var inner = fcMatch[1];
    var invokeRegex = /<invoke>\s*<tool_name>([\s\S]*?)<\/tool_name>\s*<parameters>([\s\S]*?)<\/parameters>\s*<\/invoke>/g;
    var invMatch;
    while ((invMatch = invokeRegex.exec(inner)) !== null) {
      var name = invMatch[1].trim();
      var paramsXml = invMatch[2];
      var args = {};
      var paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
      var pm;
      while ((pm = paramRegex.exec(paramsXml)) !== null) {
        var rawValue = pm[2];
        var trimmed = rawValue.trim();
        var parsedValue = rawValue;
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            parsedValue = JSON.parse(trimmed);
          } catch (e) {
            // keep as string
          }
        }
        args[pm[1]] = parsedValue;
      }
      toolCalls.push({
        id: nextTextToolCallId(),
        type: 'function',
        function: {
          name: name,
          arguments: JSON.stringify(args),
        },
      });
    }
  }

  if (hasFcWrapper) {
    cleanedContent = content.replace(functionCallsRegex, '').trim();
  }

  // Pattern 2: Standalone <invoke> blocks (not wrapped in <function_calls>)
  if (!hasFcWrapper) {
    var standaloneInvokeRegex = /<invoke>\s*<tool_name>([\s\S]*?)<\/tool_name>\s*<parameters>([\s\S]*?)<\/parameters>\s*<\/invoke>/g;
    var siMatch;
    var hasStandaloneInvoke = false;

    while ((siMatch = standaloneInvokeRegex.exec(content)) !== null) {
      hasStandaloneInvoke = true;
      var sName = siMatch[1].trim();
      var sParamsXml = siMatch[2];
      var sArgs = {};
      var sParamRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
      var spm;
      while ((spm = sParamRegex.exec(sParamsXml)) !== null) {
        var rawVal = spm[2];
        var trimmedVal = rawVal.trim();
        var parsedVal = rawVal;
        if (trimmedVal.startsWith('[') || trimmedVal.startsWith('{')) {
          try {
            parsedVal = JSON.parse(trimmedVal);
          } catch (e) {
            // keep as string
          }
        }
        sArgs[spm[1]] = parsedVal;
      }
      toolCalls.push({
        id: nextTextToolCallId(),
        type: 'function',
        function: {
          name: sName,
          arguments: JSON.stringify(sArgs),
        },
      });
    }

    if (hasStandaloneInvoke) {
      cleanedContent = content.replace(standaloneInvokeRegex, '').trim();
    }
  }

  // Pattern 3: <invoke name="..."> with <parameter name="..."> sub-tags
  // e.g. <invoke name="TodoWriteTool"><parameter name="todos">[...]</parameter></invoke>
  if (toolCalls.length === 0) {
    var invokeNameRegex = /<invoke\s+name\s*=\s*"([^"]+)">([\s\S]*?)<\/invoke>/g;
    var inMatch;
    var hasInvokeName = false;

    while ((inMatch = invokeNameRegex.exec(content)) !== null) {
      hasInvokeName = true;
      var iName = inMatch[1].trim();
      var iParamBody = inMatch[2];
      var iArgs = {};
      var iParamRegex = /<parameter\s+name\s*=\s*"([^"]+)">([\s\S]*?)<\/parameter>/g;
      var ipm;
      while ((ipm = iParamRegex.exec(iParamBody)) !== null) {
        var rawParamValue = ipm[2];
        // Try to parse as JSON if it looks like an array or object
        var parsedParamValue = rawParamValue;
        var trimmed = rawParamValue.trim();
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            parsedParamValue = JSON.parse(trimmed);
          } catch (e) {
            // keep as string
          }
        }
        iArgs[ipm[1]] = parsedParamValue;
      }
      toolCalls.push({
        id: nextTextToolCallId(),
        type: 'function',
        function: {
          name: iName,
          arguments: JSON.stringify(iArgs),
        },
      });
    }

    if (hasInvokeName) {
      invokeNameRegex.lastIndex = 0;
      cleanedContent = content.replace(/<invoke\s+name\s*=\s*"([^"]+)">([\s\S]*?)<\/invoke>/g, '').trim();
    }
  }

  if (toolCalls.length === 0) {
    return null;
  }

  return {
    toolCalls: toolCalls,
    cleanedContent: cleanedContent || null,
  };
}

function isAbortError(error) {
  if (!error) {
    return false;
  }
  const message = safeErrorMessage(error).toLowerCase();
  return error.name === 'AbortError' || message.includes('abort') || message.includes('canceled');
}

async function createChatResponse(
  openai,
  config,
  messages,
  tools,
  handlers = {},
  traceId = createTraceId('chat'),
  signal,
) {
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
      signal,
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
    signal,
  });

  const finalMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [],
  };

var contentDeltaCount = 0;
  var toolDeltaCount = 0;
  var finishReason = null;

  for await (const chunk of stream) {
    if (signal?.aborted) {
      const abortError = new Error('request aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
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
        if (!toolCallDelta || typeof toolCallDelta !== 'object') continue;
        appendDebugLog('chat.stream', 'tool_call_delta_raw', { index: toolCallDelta.index, hasId: !!toolCallDelta.id, hasFunction: !!toolCallDelta.function, functionName: toolCallDelta.function?.name, argsPreview: String(toolCallDelta.function?.arguments ?? '').substring(0, 100) });
        mergeToolCallDelta(finalMessage, toolCallDelta);
        toolDeltaCount += 1;
      }

      appendDebugLog('chat.stream', 'tool_calls_delta', { toolDeltaCount, accumulatedToolCalls: finalMessage.tool_calls.length, toolCalls: finalMessage.tool_calls.map(function(tc) { return { id: tc.id, type: tc.type, hasFunction: !!tc.function, name: tc.function?.name, argsLen: (tc.function?.arguments || '').length }; }) });
      emitChatEvent(handlers, {
        type: 'tool_calls_delta',
        toolCalls: finalMessage.tool_calls,
      });
    }

    if (choice?.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  // After streaming completes, check for text-based tool calls in the content.
  // Some models (e.g. Minimax, Anthropic legacy) emit tool calls as XML text
  // rather than structured tool_calls. Also handle cases where structured
  // tool_calls are present but malformed (missing function.name or function.arguments).
  var hasMalformedToolCalls = false;
  if (finalMessage.tool_calls.length > 0) {
    for (var mti = 0; mti < finalMessage.tool_calls.length; mti++) {
      var tc = finalMessage.tool_calls[mti];
      if (tc === null || tc === undefined) {
        hasMalformedToolCalls = true;
        appendDebugLog('chat.stream', 'malformed_tool_call_detected', { index: mti, reason: 'null_entry', toolCall: null });
        break;
      }
      if (!tc.function || !tc.function.name || tc.function.name === '') {
        hasMalformedToolCalls = true;
        appendDebugLog('chat.stream', 'malformed_tool_call_detected', { index: mti, reason: 'empty_function_name', toolCall: JSON.stringify(tc).substring(0, 200) });
        break;
      }
    }
  }

  var parsed = null;
  if (finalMessage.tool_calls.length === 0 || hasMalformedToolCalls) {
    parsed = parseTextBasedToolCalls(finalMessage.content || '');
    if (parsed && parsed.toolCalls.length > 0) {
      if (hasMalformedToolCalls) {
        appendDebugLog('chat.stream', 'text_tool_calls_replace_malformed', { oldCount: finalMessage.tool_calls.length, newCount: parsed.toolCalls.length });
        finalMessage.tool_calls = parsed.toolCalls;
      } else {
        finalMessage.tool_calls = parsed.toolCalls;
      }
      var cleaned = parsed.cleanedContent || '';
      if (cleaned !== finalMessage.content) {
        finalMessage.content = cleaned || null;
        emitChatEvent(handlers, { type: 'content_replace', content: cleaned });
        emitChatEvent(handlers, {
          type: 'tool_calls_delta',
          toolCalls: finalMessage.tool_calls,
        });
      }
    }
  }

  if (finalMessage.tool_calls.length && !finalMessage.content?.trim?.()) {
    finalMessage.content = null;
  }

  // Emit finish event after all post-processing
  if (finishReason) {
    emitChatEvent(handlers, { type: 'finish', finishReason });
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

function normalizeHttpUrl(rawUrl) {
  const input = String(rawUrl ?? '').trim();
  if (!input) {
    throw new Error('url 不能为空');
  }
  const candidate = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('仅支持 http 或 https 协议');
  }
  return parsed.toString();
}

function decodeHtmlEntities(text) {
  const value = String(text ?? '');
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    const normalized = String(code).toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos' || normalized === '#39') return "'";
    if (normalized === 'nbsp') return ' ';
    if (normalized.startsWith('#x')) {
      const parsed = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCharCode(parsed) : entity;
    }
    if (normalized.startsWith('#')) {
      const parsed = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCharCode(parsed) : entity;
    }
    return entity;
  });
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|main|header|footer|aside|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
}

function truncateText(text, maxLength = 20000) {
  const value = String(text ?? '');
  if (value.length <= maxLength) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, maxLength)}\n\n...[内容已截断，共 ${value.length} 字符]`,
    truncated: true,
  };
}

function compactSearchText(text, maxLength = 320) {
  const normalized = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[#>*_|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function decodeSearchResultUrl(rawUrl) {
  const input = String(rawUrl ?? '').trim();
  if (!input) {
    return input;
  }
  try {
    const parsed = new URL(input, 'https://duckduckgo.com');
    const redirectTarget = parsed.searchParams.get('uddg');
    return redirectTarget ? decodeURIComponent(redirectTarget) : parsed.toString();
  } catch {
    return input;
  }
}

async function fetchWithFallback(urls, options = {}) {
  const attempts = [];

  for (const targetUrl of urls) {
    try {
      if (typeof fetch !== 'function') {
        throw new Error('当前环境不支持 fetch');
      }
      const response = await fetch(targetUrl, options);
      if (!response || !response.ok) {
        throw new Error(`HTTP ${response?.status || 'request_failed'}`);
      }
      return { response, url: targetUrl, attempts };
    } catch (error) {
      attempts.push({
        url: targetUrl,
        message: safeErrorMessage(error),
      });
    }
  }

  const summary = attempts.map((item) => `${item.url}: ${item.message}`).join(' | ');
  throw new Error(summary || '请求失败');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DIFF_MAX_CELLS = 5_000_000;
const DIFF_MAX_TEXT_LENGTH = 64 * 1024;
const DIFF_CONTEXT_LINES = 3;

function splitForDiff(text) {
  if (text === '' || text == null) return [];
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && String(text).endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function computeLineDiff(oldText, newText) {
  const oldLines = splitForDiff(oldText);
  const newLines = splitForDiff(newText);

  // Trim common prefix / suffix so the LCS only runs on the hunk of change.
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const m = oldMid.length;
  const n = newMid.length;

  let ops = [];
  let tooLarge = false;

  if (m === 0 && n === 0) {
    // pure identity — no changes at all
  } else if ((m + 1) * (n + 1) > DIFF_MAX_CELLS) {
    // avoid O(m*n) memory blow-up on huge rewrites
    tooLarge = true;
    for (let k = 0; k < m; k += 1) ops.push({ type: '-', content: oldMid[k] });
    for (let k = 0; k < n; k += 1) ops.push({ type: '+', content: newMid[k] });
  } else {
    const dp = new Uint32Array((m + 1) * (n + 1));
    const width = n + 1;
    for (let i = 1; i <= m; i += 1) {
      for (let j = 1; j <= n; j += 1) {
        if (oldMid[i - 1] === newMid[j - 1]) {
          dp[i * width + j] = dp[(i - 1) * width + (j - 1)] + 1;
        } else {
          const up = dp[(i - 1) * width + j];
          const left = dp[i * width + (j - 1)];
          dp[i * width + j] = up >= left ? up : left;
        }
      }
    }
    let i = m;
    let j = n;
    const rev = [];
    while (i > 0 && j > 0) {
      if (oldMid[i - 1] === newMid[j - 1]) {
        rev.push({ type: ' ', content: oldMid[i - 1] });
        i -= 1;
        j -= 1;
      } else if (dp[(i - 1) * width + j] >= dp[i * width + (j - 1)]) {
        rev.push({ type: '-', content: oldMid[i - 1] });
        i -= 1;
      } else {
        rev.push({ type: '+', content: newMid[j - 1] });
        j -= 1;
      }
    }
    while (i > 0) {
      rev.push({ type: '-', content: oldMid[i - 1] });
      i -= 1;
    }
    while (j > 0) {
      rev.push({ type: '+', content: newMid[j - 1] });
      j -= 1;
    }
    ops = rev.reverse();
  }

  let addedLines = 0;
  let removedLines = 0;
  for (const op of ops) {
    if (op.type === '+') addedLines += 1;
    else if (op.type === '-') removedLines += 1;
  }

  // Build hunks around the mid region, translating indices back by `prefix`.
  // Each hunk starts at an index that is either the very first change or DIFF_CONTEXT_LINES
  // lines after the previous hunk's last change.
  const hunks = [];
  if (ops.length > 0 && addedLines + removedLines > 0) {
    let oldLine = prefix + 1;
    let newLine = prefix + 1;
    let current = null;
    let trailingContext = 0;

    const flush = () => {
      if (!current) return;
      // trim trailing pure-context runs longer than DIFF_CONTEXT_LINES
      while (
        current.lines.length > 0
        && current.lines[current.lines.length - 1].type === ' '
        && trailingContext > DIFF_CONTEXT_LINES
      ) {
        current.lines.pop();
        current.oldLines -= 1;
        current.newLines -= 1;
        trailingContext -= 1;
      }
      hunks.push(current);
      current = null;
      trailingContext = 0;
    };

    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index];
      if (op.type === ' ') {
        if (current) {
          if (trailingContext < DIFF_CONTEXT_LINES * 2 + 1) {
            current.lines.push({ type: ' ', content: op.content, oldLineNumber: oldLine, newLineNumber: newLine });
            current.oldLines += 1;
            current.newLines += 1;
            trailingContext += 1;
          } else {
            flush();
          }
        }
        oldLine += 1;
        newLine += 1;
      } else {
        if (!current) {
          // seed hunk with up to DIFF_CONTEXT_LINES of leading context
          const leading = [];
          let backIndex = index - 1;
          let backOld = oldLine - 1;
          let backNew = newLine - 1;
          while (backIndex >= 0 && leading.length < DIFF_CONTEXT_LINES) {
            const prev = ops[backIndex];
            if (prev.type !== ' ') break;
            leading.unshift({ type: ' ', content: prev.content, oldLineNumber: backOld, newLineNumber: backNew });
            backIndex -= 1;
            backOld -= 1;
            backNew -= 1;
          }
          current = {
            oldStart: leading.length ? leading[0].oldLineNumber : oldLine,
            newStart: leading.length ? leading[0].newLineNumber : newLine,
            oldLines: leading.length,
            newLines: leading.length,
            lines: leading,
          };
          trailingContext = 0;
        }
        if (op.type === '-') {
          current.lines.push({ type: '-', content: op.content, oldLineNumber: oldLine });
          current.oldLines += 1;
          oldLine += 1;
        } else {
          current.lines.push({ type: '+', content: op.content, newLineNumber: newLine });
          current.newLines += 1;
          newLine += 1;
        }
        trailingContext = 0;
      }
    }
    flush();
  }

  // Emit unified-style text
  const diffLines = [];
  for (const hunk of hunks) {
    diffLines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      diffLines.push(`${line.type}${line.content}`);
    }
  }
  let diffText = diffLines.join('\n');
  let diffTruncated = false;
  if (diffText.length > DIFF_MAX_TEXT_LENGTH) {
    diffText = `${diffText.slice(0, DIFF_MAX_TEXT_LENGTH)}\n... [diff truncated]`;
    diffTruncated = true;
  }

  return {
    addedLines,
    removedLines,
    diffText,
    hunks,
    tooLarge,
    diffTruncated,
  };
}

function buildToolDiffMeta(filePath, oldText, newText) {
  try {
    const diff = computeLineDiff(oldText ?? '', newText ?? '');
    return {
      filePath,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
      diffText: diff.diffText,
      tooLarge: diff.tooLarge,
      diffTruncated: diff.diffTruncated,
    };
  } catch (error) {
    appendDebugLog('diff', 'compute_error', {
      filePath,
      message: safeErrorMessage(error),
    }, 'error');
    return null;
  }
}

function globToRegExp(pattern) {
  const normalized = String(pattern || '**/*').replace(/\\/g, '/');
  let expression = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];

    if (current === '*') {
      if (next === '*') {
        if (afterNext === '/') {
          expression += '(?:.*\\/)?';
          index += 2;
        } else {
          expression += '.*';
          index += 1;
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }

    if (current === '?') {
      expression += '[^/]';
      continue;
    }

    expression += escapeRegExp(current);
  }

  return new RegExp(`^${expression}$`);
}

function shouldTreatAsTextFile(targetPath) {
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.7z', '.rar',
    '.mp3', '.mp4', '.mov', '.avi', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.class', '.jar',
    '.exe', '.dll', '.so', '.dylib', '.bin',
  ]);
  const extension = path.extname(targetPath).toLowerCase();
  if (binaryExtensions.has(extension)) {
    return false;
  }
  try {
    const stats = fs.statSync(targetPath);
    return stats.size <= 2 * 1024 * 1024;
  } catch {
    return false;
  }
}

function walkEntries(rootPath, options = {}) {
  const includeDirectories = Boolean(options.includeDirectories);
  const maxEntries = Math.min(Math.max(Number(options.maxEntries) || 2000, 1), 50000);
  const startPath = resolveLocalPath(rootPath || process.cwd(), 'path');
  const queue = [startPath];
  const results = [];

  while (queue.length && results.length < maxEntries) {
    const currentPath = queue.shift();
    const stats = fs.statSync(currentPath);

    if (!stats.isDirectory()) {
      results.push({ path: currentPath, type: 'file' });
      continue;
    }

    const items = fs.readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

    for (const item of items) {
      const fullPath = path.join(currentPath, item.name);
      if (item.isDirectory()) {
        if (includeDirectories) {
          results.push({ path: fullPath, type: 'directory' });
        }
        queue.push(fullPath);
      } else {
        results.push({ path: fullPath, type: 'file' });
      }

      if (results.length >= maxEntries) {
        break;
      }
    }
  }

  return { startPath, results };
}

function listDirectory(dirPath) {
  const traceId = createTraceId('read_dir');
  const startAt = now();
  let targetPath = '';
  try {
    targetPath = resolveLocalPath(dirPath, 'dirPath');
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
}

function readFileContent(filePath) {
  const traceId = createTraceId('read_file');
  const startAt = now();
  let targetPath = '';
  try {
    targetPath = resolveLocalPath(filePath, 'filePath');
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
}

const FILE_READ_DEFAULT_LIMIT = 2000;
const FILE_READ_LINE_CHAR_CAP = 2000;
const FILE_READ_IMAGE_SIZE_CAP = 10 * 1024 * 1024;

const GREP_TYPE_EXTENSIONS = {
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  jsx: ['.jsx', '.tsx'],
  py: ['.py', '.pyi'],
  go: ['.go'],
  rust: ['.rs'],
  rs: ['.rs'],
  java: ['.java'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
  cs: ['.cs'],
  rb: ['.rb'],
  php: ['.php'],
  vue: ['.vue'],
  svelte: ['.svelte'],
  md: ['.md', '.mdx', '.markdown'],
  json: ['.json', '.jsonc'],
  yaml: ['.yml', '.yaml'],
  toml: ['.toml'],
  sh: ['.sh', '.bash', '.zsh', '.fish'],
  ps: ['.ps1'],
  sql: ['.sql'],
  html: ['.html', '.htm'],
  css: ['.css', '.scss', '.less'],
  lua: ['.lua'],
  kt: ['.kt', '.kts'],
  swift: ['.swift'],
};

function buildGrepTypeFilter(rawTypes) {
  if (!rawTypes) return null;
  const list = Array.isArray(rawTypes)
    ? rawTypes.map((item) => String(item || '').toLowerCase().trim()).filter(Boolean)
    : String(rawTypes)
        .split(',')
        .map((item) => item.toLowerCase().trim())
        .filter(Boolean);
  if (!list.length) return null;
  const exts = new Set();
  for (const key of list) {
    const mapping = GREP_TYPE_EXTENSIONS[key];
    if (mapping) {
      mapping.forEach((ext) => exts.add(ext));
    } else if (key.startsWith('.')) {
      exts.add(key);
    }
  }
  return exts.size ? exts : null;
}

function compileGrepRegex(pattern, flags) {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`pattern 不是合法正则：${safeErrorMessage(error)}`);
  }
}

function runGrep(options = {}) {
  const traceId = createTraceId('grep');
  const startAt = now();
  try {
    const pattern = String(options?.pattern ?? '').trim();
    if (!pattern) {
      throw new Error('pattern 不能为空');
    }

    const outputMode = ['content', 'files_with_matches', 'count'].includes(options?.outputMode)
      ? options.outputMode
      : 'files_with_matches';
    const isRegex = options?.isRegex === undefined ? true : Boolean(options.isRegex);
    const caseSensitive = Boolean(options?.caseSensitive);
    const multiline = Boolean(options?.multiline);
    const showLineNumbers = options?.showLineNumbers !== false;
    const headLimit = Math.max(1, Math.min(Number(options?.headLimit) || 250, 10000));
    const offset = Math.max(0, Number(options?.offset) || 0);
    const contextArg = Number(options?.context);
    const beforeContext = Math.max(0, Number(options?.beforeContext) || (Number.isFinite(contextArg) ? contextArg : 0));
    const afterContext = Math.max(0, Number(options?.afterContext) || (Number.isFinite(contextArg) ? contextArg : 0));

    const globPattern = String(options?.glob ?? options?.filePattern ?? '').trim();
    const typeFilter = buildGrepTypeFilter(options?.type);

    const searchBase = options?.path ? resolveLocalPath(options.path, 'path') : process.cwd();
    let singleFileStats = null;
    try {
      singleFileStats = fs.statSync(searchBase);
    } catch (error) {
      throw new Error(`无法访问路径：${safeErrorMessage(error)}`);
    }

    let targetFiles;
    let startPath;
    if (singleFileStats.isFile()) {
      targetFiles = [{ path: searchBase, type: 'file' }];
      startPath = path.dirname(searchBase);
    } else {
      const walked = walkEntries(searchBase, {
        includeDirectories: false,
        maxEntries: 20000,
      });
      targetFiles = walked.results;
      startPath = walked.startPath;
    }

    const globMatcher = globPattern ? globToRegExp(globPattern) : null;
    const matchFileByRelativePath = globPattern.includes('/') || globPattern.includes('\\');

    const baseFlags = `${caseSensitive ? '' : 'i'}${multiline ? 's' : ''}${isRegex ? 'g' : 'g'}`;
    const regexSource = isRegex ? pattern : escapeRegExp(pattern);
    const lineRegex = compileGrepRegex(regexSource, `${caseSensitive ? '' : 'i'}${multiline ? 's' : ''}`);
    const globalMultilineRegex = multiline ? compileGrepRegex(regexSource, baseFlags) : null;

    const perFileMatches = [];
    const perFileCounts = [];
    const matchedFilePaths = [];
    let scannedFiles = 0;
    let collectedMatches = 0;

    for (const entry of targetFiles) {
      if (entry.type !== 'file') continue;
      if (!shouldTreatAsTextFile(entry.path)) continue;

      if (typeFilter) {
        const ext = path.extname(entry.path).toLowerCase();
        if (!typeFilter.has(ext)) continue;
      }

      if (globMatcher) {
        const candidate = matchFileByRelativePath
          ? path.relative(startPath, entry.path).replace(/\\/g, '/')
          : path.basename(entry.path);
        if (!globMatcher.test(candidate)) continue;
      }

      scannedFiles += 1;

      let content = '';
      try {
        content = fs.readFileSync(entry.path, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const fileMatches = [];
      let fileMatchCount = 0;

      if (multiline && globalMultilineRegex) {
        globalMultilineRegex.lastIndex = 0;
        let match;
        while ((match = globalMultilineRegex.exec(content)) !== null) {
          fileMatchCount += 1;
          if (outputMode === 'content') {
            const upto = content.slice(0, match.index);
            const lineNumber = (upto.match(/\n/g) || []).length + 1;
            const snippet = match[0].split(/\r?\n/)[0].slice(0, 500);
            fileMatches.push({
              lineNumber,
              line: snippet,
              beforeContext: beforeContext > 0
                ? lines
                    .slice(Math.max(0, lineNumber - 1 - beforeContext), lineNumber - 1)
                    .map((line, idx) => ({
                      lineNumber: lineNumber - beforeContext + idx,
                      line: line.slice(0, 500),
                    }))
                : [],
              afterContext: afterContext > 0
                ? lines
                    .slice(lineNumber, lineNumber + afterContext)
                    .map((line, idx) => ({
                      lineNumber: lineNumber + 1 + idx,
                      line: line.slice(0, 500),
                    }))
                : [],
            });
          }
          if (match.index === globalMultilineRegex.lastIndex) {
            globalMultilineRegex.lastIndex += 1;
          }
        }
      } else {
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          lineRegex.lastIndex = 0;
          const matched = lineRegex.test(line);
          lineRegex.lastIndex = 0;
          if (!matched) continue;
          fileMatchCount += 1;
          if (outputMode === 'content') {
            fileMatches.push({
              lineNumber: index + 1,
              line: line.slice(0, 500),
              beforeContext: beforeContext > 0
                ? lines
                    .slice(Math.max(0, index - beforeContext), index)
                    .map((contextLine, contextIndex) => ({
                      lineNumber: Math.max(1, index - beforeContext + contextIndex + 1),
                      line: contextLine.slice(0, 500),
                    }))
                : [],
              afterContext: afterContext > 0
                ? lines
                    .slice(index + 1, index + 1 + afterContext)
                    .map((contextLine, contextIndex) => ({
                      lineNumber: index + 1 + contextIndex + 1,
                      line: contextLine.slice(0, 500),
                    }))
                : [],
            });
          }
        }
      }

      if (fileMatchCount === 0) continue;

      matchedFilePaths.push(entry.path);
      if (outputMode === 'count') {
        perFileCounts.push({ path: entry.path, matchCount: fileMatchCount });
      }
      if (outputMode === 'content') {
        for (const match of fileMatches) {
          perFileMatches.push({
            path: entry.path,
            ...match,
            showLineNumbers,
          });
          collectedMatches += 1;
        }
      }

      if (outputMode === 'files_with_matches' && matchedFilePaths.length >= offset + headLimit) break;
      if (outputMode === 'count' && perFileCounts.length >= offset + headLimit) break;
      if (outputMode === 'content' && collectedMatches >= offset + headLimit) break;
    }

    appendDebugLog('file.grep', 'success', {
      traceId,
      durationMs: now() - startAt,
      pattern,
      startPath,
      outputMode,
      scannedFiles,
      matchedFiles: matchedFilePaths.length,
      collectedMatches,
    });

    if (outputMode === 'files_with_matches') {
      const paginated = matchedFilePaths.slice(offset, offset + headLimit);
      return {
        success: true,
        data: {
          outputMode,
          paths: paginated,
          totalFiles: matchedFilePaths.length,
          scannedFiles,
          offset,
          headLimit,
        },
      };
    }

    if (outputMode === 'count') {
      perFileCounts.sort((a, b) => b.matchCount - a.matchCount);
      const paginated = perFileCounts.slice(offset, offset + headLimit);
      return {
        success: true,
        data: {
          outputMode,
          counts: paginated,
          totalFiles: perFileCounts.length,
          totalMatches: perFileCounts.reduce((acc, item) => acc + item.matchCount, 0),
          scannedFiles,
          offset,
          headLimit,
        },
      };
    }

    const paginatedMatches = perFileMatches.slice(offset, offset + headLimit);
    return {
      success: true,
      data: {
        outputMode,
        matches: paginatedMatches,
        totalMatches: perFileMatches.length,
        totalFiles: matchedFilePaths.length,
        scannedFiles,
        offset,
        headLimit,
      },
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    appendDebugLog('file.grep', 'error', {
      traceId,
      durationMs: now() - startAt,
      pattern: options?.pattern || '',
      path: options?.path || '',
      message,
    }, 'error');
    return { success: false, error: message };
  }
}

function formatNumberedLines(lines, startOffset) {
  const width = Math.max(6, String(startOffset + lines.length).length);
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = startOffset + index + 1;
    const prefix = String(lineNumber).padStart(width, ' ');
    let text = lines[index];
    let lineTruncated = false;
    if (text.length > FILE_READ_LINE_CHAR_CAP) {
      text = `${text.slice(0, FILE_READ_LINE_CHAR_CAP)}... [line truncated]`;
      lineTruncated = true;
    }
    out.push(`${prefix}\t${text}`);
    if (lineTruncated) {
      // no-op; the marker already lives in the line
    }
  }
  return out.join('\n');
}

function parseNotebookForRead(targetPath) {
  const raw = fs.readFileSync(targetPath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`无法解析 notebook：${safeErrorMessage(error)}`);
  }
  const cells = Array.isArray(parsed?.cells) ? parsed.cells : [];
  const lines = [];
  cells.forEach((cell, index) => {
    const source = Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source ?? '');
    const cellId = String(cell?.id ?? `idx_${index}`);
    const cellType = String(cell?.cell_type ?? 'unknown');
    lines.push(`=== cell ${index} | type=${cellType} | id=${cellId} ===`);
    lines.push(source);
    lines.push('');
  });
  return {
    content: lines.join('\n'),
    totalCells: cells.length,
    language: parsed?.metadata?.language_info?.name || 'unknown',
  };
}

function readFileRich(options = {}) {
  const traceId = createTraceId('read_file_rich');
  const startAt = now();
  let targetPath = '';
  try {
    const rawPath = options?.filePath ?? options?.path ?? options?.file;
    targetPath = resolveLocalPath(rawPath, 'filePath');
    if (!fs.existsSync(targetPath)) {
      throw new Error('文件不存在');
    }
    const stats = fs.statSync(targetPath);
    if (stats.isDirectory()) {
      throw new Error('目标是目录，使用 GlobTool 列出内容');
    }
    const ext = path.extname(targetPath).toLowerCase();

    if (IMAGE_MIME_BY_EXT[ext]) {
      if (stats.size > FILE_READ_IMAGE_SIZE_CAP) {
        return { success: false, error: `图片大小超过 ${FILE_READ_IMAGE_SIZE_CAP} 字节，无法直接读取` };
      }
      const mimeType = IMAGE_MIME_BY_EXT[ext];
      const buffer = fs.readFileSync(targetPath);
      const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
      appendDebugLog('file.read_rich', 'image', {
        traceId,
        durationMs: now() - startAt,
        resolvedPath: targetPath,
        mimeType,
        bytes: stats.size,
      });
      return {
        success: true,
        data: {
          filePath: targetPath,
          kind: 'image',
          mimeType,
          size: stats.size,
          dataUrl,
        },
      };
    }

    if (ext === '.pdf') {
      return {
        success: false,
        error: 'PDF 暂未支持直接解析文本。可使用 BashTool 执行 pdftotext / poppler / python 脚本后再读取。',
      };
    }

    if (ext === '.ipynb') {
      const parsed = parseNotebookForRead(targetPath);
      const lines = parsed.content.split(/\r?\n/);
      const offset = Math.max(0, Number(options?.offset) || 0);
      const limit = Math.max(1, Math.min(Number(options?.limit) || FILE_READ_DEFAULT_LIMIT, 50000));
      const sliced = lines.slice(offset, offset + limit);
      const truncated = offset + sliced.length < lines.length;
      return {
        success: true,
        data: {
          filePath: targetPath,
          kind: 'notebook',
          language: parsed.language,
          totalCells: parsed.totalCells,
          totalLines: lines.length,
          offset,
          linesReturned: sliced.length,
          truncated,
          content: formatNumberedLines(sliced, offset),
        },
      };
    }

    if (!shouldTreatAsTextFile(targetPath) && stats.size > 2 * 1024 * 1024) {
      return { success: false, error: '文件过大或疑似二进制文件（>2MB），未读取' };
    }

    const raw = fs.readFileSync(targetPath, 'utf-8');
    const rawLines = raw.split(/\r?\n/);
    // If the file ends with a trailing newline, split yields an empty last element — drop it for counting
    const hasTrailingNewline = raw.endsWith('\n');
    const totalLines = hasTrailingNewline && rawLines[rawLines.length - 1] === ''
      ? rawLines.length - 1
      : rawLines.length;
    const offset = Math.max(0, Number(options?.offset) || 0);
    const limit = Math.max(1, Math.min(Number(options?.limit) || FILE_READ_DEFAULT_LIMIT, 50000));
    const sliced = rawLines.slice(offset, offset + limit);
    // If trailing empty line sneaks in at the tail of the full file, strip from the slice tail too
    while (sliced.length > 0 && sliced[sliced.length - 1] === '' && offset + sliced.length >= rawLines.length) {
      sliced.pop();
    }
    const truncated = offset + sliced.length < totalLines;
    const content = formatNumberedLines(sliced, offset);

    appendDebugLog('file.read_rich', 'text', {
      traceId,
      durationMs: now() - startAt,
      resolvedPath: targetPath,
      totalLines,
      offset,
      linesReturned: sliced.length,
      truncated,
    });

    return {
      success: true,
      data: {
        filePath: targetPath,
        kind: 'text',
        totalLines,
        offset,
        linesReturned: sliced.length,
        truncated,
        content,
      },
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    appendDebugLog('file.read_rich', 'error', {
      traceId,
      durationMs: now() - startAt,
      resolvedPath: targetPath,
      message,
    }, 'error');
    return { success: false, error: message };
  }
}

function writeFileContent(filePath, content) {
  const traceId = createTraceId('write_file');
  const startAt = now();
  let targetPath = '';
  try {
    targetPath = resolveLocalPath(filePath, 'filePath');
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const normalizedContent = typeof content === 'string' ? content : String(content ?? '');
    let previousContent = '';
    let previouslyExisted = false;
    try {
      if (fs.existsSync(targetPath)) {
        previouslyExisted = true;
        previousContent = fs.readFileSync(targetPath, 'utf-8');
      }
    } catch {
      previousContent = '';
    }
    fs.writeFileSync(targetPath, normalizedContent, 'utf-8');
    const diff = buildToolDiffMeta(targetPath, previousContent, normalizedContent);
    appendDebugLog('file.write_file', 'success', {
      traceId,
      durationMs: now() - startAt,
      inputPath: filePath,
      resolvedPath: targetPath,
      bytes: Buffer.byteLength(normalizedContent, 'utf-8'),
      previouslyExisted,
      addedLines: diff?.addedLines ?? 0,
      removedLines: diff?.removedLines ?? 0,
    });
    return {
      success: true,
      data: {
        filePath: targetPath,
        previouslyExisted,
        diff,
      },
    };
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
}

function clampBashTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return BASH_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(parsed), 1000), BASH_MAX_TIMEOUT_MS);
}

function executeShellCommand(command, cwd, options = {}) {
  const traceId = createTraceId('exec');
  const startAt = now();
  let resolvedCwd = process.cwd();
  try {
    resolvedCwd = cwd ? resolveLocalPath(cwd, 'cwd') : process.cwd();
  } catch (error) {
    const message = safeErrorMessage(error);
    appendDebugLog('exec', 'cwd_error', {
      traceId,
      command,
      cwd,
      message,
    }, 'error');
    return Promise.resolve({ success: false, error: message });
  }

  const timeoutMs = clampBashTimeout(options?.timeoutMs);
  const description = typeof options?.description === 'string' ? options.description.trim() : '';

  appendDebugLog('exec', 'start', {
    traceId,
    command,
    cwd: resolvedCwd,
    timeoutMs,
    description,
  });

  return new Promise((resolve) => {
    exec(
      String(command || ''),
      {
        cwd: resolvedCwd,
        windowsHide: true,
        shell: true,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const durationMs = now() - startAt;
        const trimmedStdout = trimBashOutput(stdout, 'stdout');
        const trimmedStderr = trimBashOutput(stderr, 'stderr');
        if (error) {
          appendDebugLog('exec', 'error', {
            traceId,
            durationMs,
            command,
            cwd: resolvedCwd,
            message: safeErrorMessage(error),
            stderrLength: trimmedStderr.originalBytes,
            stdoutLength: trimmedStdout.originalBytes,
            stdoutTruncated: trimmedStdout.truncated,
            stderrTruncated: trimmedStderr.truncated,
          }, 'error');
          resolve({
            success: false,
            error: error.message,
            stderr: trimmedStderr.text,
            stdout: trimmedStdout.text,
            stdoutTruncated: trimmedStdout.truncated,
            stderrTruncated: trimmedStderr.truncated,
            stdoutOriginalBytes: trimmedStdout.originalBytes,
            stderrOriginalBytes: trimmedStderr.originalBytes,
            stdoutOriginalLines: trimmedStdout.originalLines,
            stderrOriginalLines: trimmedStderr.originalLines,
            timedOut: Boolean(error.killed && error.signal === 'SIGTERM'),
            durationMs,
          });
          return;
        }

        appendDebugLog('exec', 'success', {
          traceId,
          durationMs,
          command,
          cwd: resolvedCwd,
          stdoutLength: trimmedStdout.originalBytes,
          stderrLength: trimmedStderr.originalBytes,
          stdoutTruncated: trimmedStdout.truncated,
          stderrTruncated: trimmedStderr.truncated,
        });
        resolve({
          success: true,
          stdout: trimmedStdout.text,
          stderr: trimmedStderr.text,
          stdoutTruncated: trimmedStdout.truncated,
          stderrTruncated: trimmedStderr.truncated,
          stdoutOriginalBytes: trimmedStdout.originalBytes,
          stderrOriginalBytes: trimmedStderr.originalBytes,
          stdoutOriginalLines: trimmedStdout.originalLines,
          stderrOriginalLines: trimmedStderr.originalLines,
          durationMs,
        });
      },
    );
  });
}

function appendToRingBuffer(record, chunk, channel) {
  if (!chunk) return;
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  if (!text) return;
  record.output.push({ channel, text, at: Date.now() });
  record.totalBytes += Buffer.byteLength(text, 'utf-8');
  while (record.totalBytes > BASH_OUTPUT_BUFFER_CAP && record.output.length > 1) {
    const dropped = record.output.shift();
    record.totalBytes -= Buffer.byteLength(dropped.text, 'utf-8');
    record.droppedCount += 1;
  }
}

function startBackgroundBash(command, cwd, options = {}) {
  const traceId = createTraceId('bash_bg');
  const startAt = now();
  let resolvedCwd = process.cwd();
  try {
    resolvedCwd = cwd ? resolveLocalPath(cwd, 'cwd') : process.cwd();
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }

  const normalizedCommand = String(command || '').trim();
  if (!normalizedCommand) {
    return { success: false, error: 'command 不能为空' };
  }

  bashIdSeq += 1;
  const bashId = `bash_${bashIdSeq}_${Date.now().toString(36)}`;

  let child;
  try {
    child = spawn(normalizedCommand, {
      cwd: resolvedCwd,
      shell: true,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }

  const record = {
    bashId,
    command: normalizedCommand,
    cwd: resolvedCwd,
    description: typeof options?.description === 'string' ? options.description.trim() : '',
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: startAt,
    endedAt: null,
    pid: child.pid || null,
    proc: child,
    output: [],
    totalBytes: 0,
    droppedCount: 0,
    cursor: 0,
  };
  activeBashProcesses.set(bashId, record);

  child.stdout?.setEncoding('utf-8');
  child.stderr?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk) => appendToRingBuffer(record, chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => appendToRingBuffer(record, chunk, 'stderr'));

  child.on('error', (error) => {
    if (record.status === 'running') {
      record.status = 'error';
    }
    record.endedAt = Date.now();
    appendToRingBuffer(record, `\n[error] ${safeErrorMessage(error)}\n`, 'stderr');
    appendDebugLog('bash.bg', 'child_error', { bashId, message: safeErrorMessage(error) }, 'error');
  });

  child.on('close', (code, signal) => {
    if (record.status === 'running') {
      record.status = code === 0 ? 'completed' : 'exited';
    }
    record.exitCode = code == null ? null : code;
    record.signal = signal || null;
    record.endedAt = Date.now();
    appendDebugLog('bash.bg', 'closed', {
      bashId,
      exitCode: record.exitCode,
      signal: record.signal,
      durationMs: record.endedAt - record.startedAt,
      status: record.status,
    });
  });

  appendDebugLog('bash.bg', 'started', {
    traceId,
    bashId,
    command: normalizedCommand,
    cwd: resolvedCwd,
    pid: record.pid,
    description: record.description,
  });

  return {
    success: true,
    data: {
      bashId,
      pid: record.pid,
      cwd: resolvedCwd,
      command: normalizedCommand,
      startedAt: record.startedAt,
      description: record.description,
    },
  };
}

function readBackgroundBashOutput(options = {}) {
  const bashId = String(options?.bashId || '').trim();
  if (!bashId) {
    return { success: false, error: 'bashId 不能为空' };
  }
  const record = activeBashProcesses.get(bashId);
  if (!record) {
    return { success: false, error: `bashId 不存在或已清理：${bashId}` };
  }

  const filterRaw = typeof options?.filter === 'string' ? options.filter.trim() : '';
  let filterRegex = null;
  if (filterRaw) {
    try {
      filterRegex = new RegExp(filterRaw);
    } catch (error) {
      return { success: false, error: `filter 不是合法正则：${safeErrorMessage(error)}` };
    }
  }

  const newChunks = record.output.slice(record.cursor);
  record.cursor = record.output.length;

  let stdout = '';
  let stderr = '';
  for (const chunk of newChunks) {
    const text = filterRegex
      ? chunk.text
          .split(/\r?\n/)
          .filter((line) => filterRegex.test(line))
          .join('\n')
      : chunk.text;
    if (!text) continue;
    if (chunk.channel === 'stdout') {
      stdout += text;
      if (filterRegex && !stdout.endsWith('\n')) stdout += '\n';
    } else {
      stderr += text;
      if (filterRegex && !stderr.endsWith('\n')) stderr += '\n';
    }
  }

  const trimmedStdout = trimBashOutput(stdout, 'stdout');
  const trimmedStderr = trimBashOutput(stderr, 'stderr');

  return {
    success: true,
    data: {
      bashId,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      pid: record.pid,
      command: record.command,
      cwd: record.cwd,
      stdout: trimmedStdout.text,
      stderr: trimmedStderr.text,
      stdoutTruncated: trimmedStdout.truncated,
      stderrTruncated: trimmedStderr.truncated,
      stdoutOriginalBytes: trimmedStdout.originalBytes,
      stderrOriginalBytes: trimmedStderr.originalBytes,
      stdoutOriginalLines: trimmedStdout.originalLines,
      stderrOriginalLines: trimmedStderr.originalLines,
      newChunks: newChunks.length,
      droppedCount: record.droppedCount,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: (record.endedAt || Date.now()) - record.startedAt,
    },
  };
}

function killBackgroundBash(options = {}) {
  const bashId = String(options?.bashId || '').trim();
  if (!bashId) {
    return { success: false, error: 'bashId 不能为空' };
  }
  const record = activeBashProcesses.get(bashId);
  if (!record) {
    return { success: false, error: `bashId 不存在：${bashId}` };
  }

  if (record.status !== 'running') {
    return {
      success: true,
      data: {
        bashId,
        status: record.status,
        exitCode: record.exitCode,
        signal: record.signal,
        alreadyStopped: true,
      },
    };
  }

  try {
    record.proc.kill('SIGTERM');
  } catch (error) {
    appendDebugLog('bash.bg', 'kill_error', { bashId, message: safeErrorMessage(error) }, 'error');
  }
  setTimeout(() => {
    if (record.status === 'running') {
      try {
        record.proc.kill('SIGKILL');
      } catch {
        // best effort
      }
    }
  }, 500);
  record.status = 'killed';
  record.endedAt = Date.now();
  appendDebugLog('bash.bg', 'kill_requested', { bashId, pid: record.pid });
  return {
    success: true,
    data: {
      bashId,
      status: record.status,
      pid: record.pid,
    },
  };
}

function listBackgroundBashes() {
  const items = [];
  for (const [, record] of activeBashProcesses.entries()) {
    items.push({
      bashId: record.bashId,
      status: record.status,
      command: record.command,
      description: record.description,
      pid: record.pid,
      cwd: record.cwd,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      bufferedBytes: record.totalBytes,
      droppedCount: record.droppedCount,
    });
  }
  return { success: true, data: { shells: items } };
}

function sanitizeContextKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96);
}

function snapshotDirFor(sessionId, messageId) {
  const sessionKey = sanitizeContextKey(sessionId) || 'default';
  const messageKey = sanitizeContextKey(messageId);
  if (!messageKey) {
    return '';
  }
  return path.join(SNAPSHOT_ROOT, `${sessionKey}__${messageKey}`);
}

function encodeSnapshotSlot(filePath) {
  return Buffer.from(String(filePath), 'utf-8').toString('base64url').slice(0, 180);
}

function readSnapshotMeta(dir) {
  const metaPath = path.join(dir, '__meta.json');
  if (!fs.existsSync(metaPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSnapshotMeta(dir, entries) {
  const metaPath = path.join(dir, '__meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2), 'utf-8');
}

function snapshotFileBefore(context, targetFilePath) {
  const sessionId = context?.sessionId;
  const messageId = context?.messageId ?? context?.userMessageId;
  const dir = snapshotDirFor(sessionId, messageId);
  if (!dir || !targetFilePath) {
    return { success: false, error: 'snapshot context 不完整' };
  }
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entries = readSnapshotMeta(dir);
    if (entries.some((item) => item && item.filePath === targetFilePath)) {
      return { success: true, data: { skipped: true, reason: 'already_snapshotted' } };
    }

    const slotName = `${entries.length}_${encodeSnapshotSlot(targetFilePath)}`;
    const existedBefore = fs.existsSync(targetFilePath);
    let savedBytes = 0;
    let isDirectory = false;
    if (existedBefore) {
      const stats = fs.statSync(targetFilePath);
      if (stats.isDirectory()) {
        isDirectory = true;
        fs.cpSync(targetFilePath, path.join(dir, slotName), { recursive: true });
      } else {
        fs.copyFileSync(targetFilePath, path.join(dir, slotName));
        savedBytes = stats.size;
      }
    }

    entries.push({
      filePath: targetFilePath,
      slotName: existedBefore ? slotName : null,
      existedBefore,
      isDirectory,
      capturedAt: Date.now(),
      bytes: savedBytes,
    });
    writeSnapshotMeta(dir, entries);

    appendDebugLog('snapshot', 'captured', {
      sessionId,
      messageId,
      filePath: targetFilePath,
      existedBefore,
      isDirectory,
      bytes: savedBytes,
    });
    return { success: true, data: { filePath: targetFilePath, existedBefore, isDirectory } };
  } catch (error) {
    const message = safeErrorMessage(error);
    appendDebugLog('snapshot', 'capture_error', {
      sessionId,
      messageId,
      filePath: targetFilePath,
      message,
    }, 'error');
    return { success: false, error: message };
  }
}

function restoreFileSnapshots(sessionId, messageId) {
  const dir = snapshotDirFor(sessionId, messageId);
  if (!dir || !fs.existsSync(dir)) {
    return { success: true, data: { entries: [], total: 0, restored: 0, deleted: 0, failed: 0 } };
  }

  const entries = readSnapshotMeta(dir);
  const results = [];
  let restored = 0;
  let deleted = 0;
  let failed = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || !entry.filePath) {
      continue;
    }
    try {
      if (entry.existedBefore && entry.slotName) {
        const slotPath = path.join(dir, entry.slotName);
        if (!fs.existsSync(slotPath)) {
          failed += 1;
          results.push({ filePath: entry.filePath, action: 'failed', error: 'snapshot_missing' });
          continue;
        }
        const parentDir = path.dirname(entry.filePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        if (entry.isDirectory) {
          if (fs.existsSync(entry.filePath)) {
            fs.rmSync(entry.filePath, { recursive: true, force: true });
          }
          fs.cpSync(slotPath, entry.filePath, { recursive: true });
        } else {
          fs.copyFileSync(slotPath, entry.filePath);
        }
        restored += 1;
        results.push({ filePath: entry.filePath, action: 'restored' });
      } else {
        if (fs.existsSync(entry.filePath)) {
          const stats = fs.statSync(entry.filePath);
          if (stats.isDirectory()) {
            fs.rmSync(entry.filePath, { recursive: true, force: true });
            deleted += 1;
            results.push({ filePath: entry.filePath, action: 'deleted' });
          } else if (stats.isFile()) {
            fs.unlinkSync(entry.filePath);
            deleted += 1;
            results.push({ filePath: entry.filePath, action: 'deleted' });
          } else {
            results.push({ filePath: entry.filePath, action: 'skipped', reason: 'not_a_file_or_directory' });
          }
        } else {
          results.push({ filePath: entry.filePath, action: 'skipped', reason: 'already_absent' });
        }
      }
    } catch (error) {
      failed += 1;
      results.push({ filePath: entry.filePath, action: 'failed', error: safeErrorMessage(error) });
    }
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }

  appendDebugLog('snapshot', 'restored', {
    sessionId,
    messageId,
    total: entries.length,
    restored,
    deleted,
    failed,
  });

  return {
    success: failed === 0,
    data: {
      entries: results,
      total: entries.length,
      restored,
      deleted,
      failed,
    },
  };
}

function listSnapshotsForSession(sessionId) {
  if (!fs.existsSync(SNAPSHOT_ROOT)) {
    return { success: true, data: { messageIds: [] } };
  }
  const sessionKey = sanitizeContextKey(sessionId) || 'default';
  const prefix = `${sessionKey}__`;
  try {
    const items = fs.readdirSync(SNAPSHOT_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name.slice(prefix.length));
    return { success: true, data: { messageIds: items } };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function clearSnapshotsForSession(sessionId) {
  if (!fs.existsSync(SNAPSHOT_ROOT)) {
    return { success: true, data: { cleared: 0 } };
  }
  const sessionKey = sanitizeContextKey(sessionId) || 'default';
  const prefix = `${sessionKey}__`;
  let cleared = 0;
  try {
    const items = fs.readdirSync(SNAPSHOT_ROOT, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory() || !item.name.startsWith(prefix)) {
        continue;
      }
      fs.rmSync(path.join(SNAPSHOT_ROOT, item.name), { recursive: true, force: true });
      cleared += 1;
    }
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
  appendDebugLog('snapshot', 'cleared_session', { sessionId, cleared });
  return { success: true, data: { cleared } };
}

function clearSnapshotForMessage(sessionId, messageId) {
  const dir = snapshotDirFor(sessionId, messageId);
  if (!dir || !fs.existsSync(dir)) {
    return { success: true, data: { cleared: false } };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { success: true, data: { cleared: true } };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function statLocalPath(inputPath) {
  try {
    const targetPath = resolveLocalPath(inputPath, 'path');
    if (!fs.existsSync(targetPath)) {
      return { success: true, data: { exists: false, path: targetPath } };
    }
    const stats = fs.statSync(targetPath);
    return {
      success: true,
      data: {
        exists: true,
        path: targetPath,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        size: stats.size,
        modifiedAt: stats.mtimeMs,
      },
    };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function guessImageMimeFromExtension(extension) {
  const normalized = String(extension || '').toLowerCase();
  const withDot = normalized.startsWith('.') ? normalized : `.${normalized}`;
  return IMAGE_MIME_BY_EXT[withDot] || 'image/png';
}

function guessImageExtensionFromMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  for (const [ext, mime] of Object.entries(IMAGE_MIME_BY_EXT)) {
    if (mime === normalized) {
      return ext;
    }
  }
  return '.png';
}

function saveClipboardImage(dataUrl, preferredExtension) {
  try {
    const raw = String(dataUrl || '').trim();
    if (!raw) {
      throw new Error('dataUrl 不能为空');
    }
    const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) {
      throw new Error('仅支持 base64 dataUrl');
    }
    const mime = match[1];
    const base64 = match[2];
    const ext = preferredExtension
      ? (String(preferredExtension).startsWith('.') ? String(preferredExtension) : `.${preferredExtension}`)
      : guessImageExtensionFromMime(mime);
    if (!fs.existsSync(UPLOAD_ROOT)) {
      fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    }
    const fileName = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const targetPath = path.join(UPLOAD_ROOT, fileName);
    fs.writeFileSync(targetPath, Buffer.from(base64, 'base64'));
    return {
      success: true,
      data: {
        path: targetPath,
        name: fileName,
        mime,
        size: Buffer.byteLength(base64, 'base64'),
      },
    };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function sanitizeUploadFileName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  return raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160);
}

function saveUploadedFile(options = {}) {
  try {
    const dataUrl = String(options?.dataUrl || '').trim();
    if (!dataUrl) {
      throw new Error('dataUrl 不能为空');
    }
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) {
      throw new Error('仅支持 base64 dataUrl');
    }
    const mime = match[1];
    const base64 = match[2];
    const original = sanitizeUploadFileName(options?.name);
    const ext = original && path.extname(original)
      ? ''
      : (mime.startsWith('image/') ? guessImageExtensionFromMime(mime) : '.bin');
    const baseName = original || `upload${ext}`;
    const uniquePrefix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_`;
    if (!fs.existsSync(UPLOAD_ROOT)) {
      fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    }
    const targetPath = path.join(UPLOAD_ROOT, `${uniquePrefix}${baseName}`);
    fs.writeFileSync(targetPath, Buffer.from(base64, 'base64'));
    return {
      success: true,
      data: {
        path: targetPath,
        name: baseName,
        mime,
        size: Buffer.byteLength(base64, 'base64'),
      },
    };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function readFileAsDataURL(filePath) {
  try {
    const targetPath = resolveLocalPath(filePath, 'filePath');
    if (!fs.existsSync(targetPath)) {
      return { success: false, error: '文件不存在' };
    }
    const stats = fs.statSync(targetPath);
    if (!stats.isFile()) {
      return { success: false, error: '目标不是文件' };
    }
    if (stats.size > 12 * 1024 * 1024) {
      return { success: false, error: '文件过大（> 12MB），无法转换为 dataURL' };
    }
    const extension = path.extname(targetPath).toLowerCase();
    const mimeType = guessImageMimeFromExtension(extension);
    const buffer = fs.readFileSync(targetPath);
    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    return {
      success: true,
      data: {
        path: targetPath,
        dataUrl,
        mimeType,
        size: stats.size,
      },
    };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function cleanupStaleUploads(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(UPLOAD_ROOT)) {
      return { success: true, data: { removed: 0 } };
    }
    const now = Date.now();
    let removed = 0;
    const items = fs.readdirSync(UPLOAD_ROOT, { withFileTypes: true });
    for (const item of items) {
      if (!item.isFile()) {
        continue;
      }
      const fullPath = path.join(UPLOAD_ROOT, item.name);
      try {
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
          removed += 1;
        }
      } catch {
        // ignore
      }
    }
    return { success: true, data: { removed } };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function setWorkspaceRoot(targetPath) {
  try {
    // If path is empty or undefined, use the default workspace root
    var resolved = targetPath ? resolveLocalPath(targetPath, 'path') : DEFAULT_WORKSPACE_ROOT;
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      throw new Error('目标不是目录');
    }
    process.chdir(resolved);
    appendDebugLog('workspace', 'changed', { cwd: process.cwd(), source: targetPath ? 'user' : 'default' });
    return { success: true, data: { cwd: process.cwd() } };
  } catch (error) {
    const message = safeErrorMessage(error);
    appendDebugLog('workspace', 'change_error', { targetPath, message }, 'error');
    return { success: false, error: message };
  }
}

function getWorkspaceRoot() {
  try {
    var current = process.cwd();
    // Ensure workspace exists
    if (!fs.existsSync(current)) {
      process.chdir(DEFAULT_WORKSPACE_ROOT);
      current = DEFAULT_WORKSPACE_ROOT;
    }
    return { success: true, data: { cwd: current } };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

function generateCellId() {
  return `cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function editNotebookCells(options = {}) {
  const traceId = createTraceId('notebook_edit');
  const startAt = now();
  let targetPath = '';
  try {
    const notebookPath = options?.notebookPath ?? options?.filePath ?? options?.path;
    targetPath = resolveLocalPath(notebookPath, 'notebookPath');
    if (!fs.existsSync(targetPath)) {
      throw new Error('notebook 文件不存在');
    }
    if (path.extname(targetPath).toLowerCase() !== '.ipynb') {
      throw new Error('目标不是 .ipynb 文件');
    }

    const context = options?.__context || null;
    if (context) {
      snapshotFileBefore(context, targetPath);
    }

    const editMode = ['replace', 'insert', 'delete'].includes(options?.editMode)
      ? options.editMode
      : 'replace';
    const cellId = options?.cellId != null ? String(options.cellId) : '';
    const newSource = typeof options?.newSource === 'string' ? options.newSource : '';
    const cellType = options?.cellType === 'markdown' ? 'markdown' : options?.cellType === 'code' ? 'code' : null;

    const raw = fs.readFileSync(targetPath, 'utf-8');
    let notebook;
    try {
      notebook = JSON.parse(raw);
    } catch (error) {
      throw new Error(`解析 notebook 失败：${safeErrorMessage(error)}`);
    }
    if (!notebook || typeof notebook !== 'object') {
      throw new Error('notebook 内容无效');
    }
    notebook.cells = Array.isArray(notebook.cells) ? notebook.cells : [];

    const findIndex = (id) => {
      if (!id) return -1;
      const byId = notebook.cells.findIndex((cell) => String(cell?.id ?? '') === id);
      if (byId !== -1) return byId;
      const asIndex = Number.parseInt(id, 10);
      if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < notebook.cells.length) {
        return asIndex;
      }
      return -1;
    };

    let affectedCellId = '';

    if (editMode === 'replace') {
      const index = findIndex(cellId);
      if (index === -1) {
        throw new Error(`找不到 cellId=${cellId} 的 cell`);
      }
      const cell = notebook.cells[index];
      if (cellType) {
        cell.cell_type = cellType;
      }
      cell.source = newSource.split(/(?<=\n)/);
      if (cell.cell_type === 'code' && !Array.isArray(cell.outputs)) {
        cell.outputs = [];
      }
      if (cell.cell_type === 'code' && cell.execution_count === undefined) {
        cell.execution_count = null;
      }
      if (!cell.metadata) cell.metadata = {};
      affectedCellId = String(cell.id ?? '');
    } else if (editMode === 'insert') {
      if (!cellType) {
        throw new Error('insert 模式必须指定 cellType (code | markdown)');
      }
      const newCell = {
        id: generateCellId(),
        cell_type: cellType,
        source: newSource.split(/(?<=\n)/),
        metadata: {},
      };
      if (cellType === 'code') {
        newCell.outputs = [];
        newCell.execution_count = null;
      }
      if (!cellId) {
        notebook.cells.unshift(newCell);
      } else {
        const index = findIndex(cellId);
        if (index === -1) {
          throw new Error(`找不到 cellId=${cellId} 的 cell`);
        }
        notebook.cells.splice(index + 1, 0, newCell);
      }
      affectedCellId = newCell.id;
    } else if (editMode === 'delete') {
      const index = findIndex(cellId);
      if (index === -1) {
        throw new Error(`找不到 cellId=${cellId} 的 cell`);
      }
      const removed = notebook.cells.splice(index, 1)[0];
      affectedCellId = String(removed?.id ?? cellId);
    }

    fs.writeFileSync(targetPath, JSON.stringify(notebook, null, 2), 'utf-8');
    const afterRaw = fs.readFileSync(targetPath, 'utf-8');
    const diff = buildToolDiffMeta(targetPath, raw, afterRaw);

    appendDebugLog('notebook.edit', 'success', {
      traceId,
      durationMs: now() - startAt,
      notebookPath: targetPath,
      editMode,
      cellId: cellId || null,
      cellType: cellType || null,
      affectedCellId,
      totalCells: notebook.cells.length,
      addedLines: diff?.addedLines ?? 0,
      removedLines: diff?.removedLines ?? 0,
    });

    return {
      success: true,
      data: {
        notebookPath: targetPath,
        filePath: targetPath,
        editMode,
        affectedCellId,
        totalCells: notebook.cells.length,
        diff,
      },
    };
  } catch (error) {
    const message = safeErrorMessage(error);
    appendDebugLog('notebook.edit', 'error', {
      traceId,
      durationMs: now() - startAt,
      notebookPath: targetPath,
      message,
    }, 'error');
    return { success: false, error: message };
  }
}

function runTodoWrite(options = {}) {
  const traceId = createTraceId('todo_write');
  try {
    const raw = Array.isArray(options?.todos) ? options.todos : [];
    if (!raw.length) {
      return {
        success: true,
        data: {
          todos: [],
          updatedAt: Date.now(),
          summary: { pending: 0, in_progress: 0, completed: 0 },
        },
      };
    }
    const normalized = [];
    let inProgressCount = 0;
    const summary = { pending: 0, in_progress: 0, completed: 0 };
    for (const item of raw) {
      const content = String(item?.content ?? '').trim();
      const activeForm = String(item?.activeForm ?? item?.active_form ?? '').trim();
      const status = ['pending', 'in_progress', 'completed'].includes(item?.status)
        ? item.status
        : 'pending';
      if (!content) continue;
      if (status === 'in_progress') inProgressCount += 1;
      summary[status] += 1;
      normalized.push({
        content,
        activeForm: activeForm || content,
        status,
      });
    }
    if (inProgressCount > 1) {
      return {
        success: false,
        error: '同一时间只能有一个 in_progress 任务，请先把其他在途任务标记为 pending 或 completed。',
      };
    }
    appendDebugLog('todo', 'updated', {
      traceId,
      total: normalized.length,
      summary,
    });
    return {
      success: true,
      data: {
        todos: normalized,
        updatedAt: Date.now(),
        summary,
      },
    };
  } catch (error) {
    return { success: false, error: safeErrorMessage(error) };
  }
}

const SYSTEM_DIR_HINTS = [
  /\\system32(\\|$)/i,
  /\\syswow64(\\|$)/i,
  /\\windows(\\|$)/i,
  /\\program files(?: \(x86\))?(\\|$)/i,
];

function looksLikeSystemCwd(cwd) {
  if (!cwd) return false;
  const normalized = String(cwd);
  if (normalized === '/' || normalized === '\\') return true;
  if (/^[a-z]:\\?$/i.test(normalized)) return true; // C:\ / D:\ 等裸盘符
  if (normalized === '/usr/bin' || normalized === '/sbin' || normalized === '/bin') return true;
  return SYSTEM_DIR_HINTS.some((pattern) => pattern.test(normalized));
}

function normalizeInitialWorkingDirectory() {
  try {
    const originalCwd = process.cwd();
    if (!looksLikeSystemCwd(originalCwd)) return;
    const home = os.homedir();
    if (!home || !fs.existsSync(home)) return;
    process.chdir(home);
    appendDebugLog('workspace', 'auto_chdir_from_system', {
      from: originalCwd,
      to: home,
      reason: 'preload 启动时检测到 cwd 位于系统目录，自动切到用户目录避免误操作',
    });
  } catch (error) {
    appendDebugLog('workspace', 'auto_chdir_failed', {
      message: safeErrorMessage(error),
    }, 'error');
  }
}

normalizeInitialWorkingDirectory();

let pendingLaunchPayload = null;
const launchPayloadSubscribers = new Set();

const notifyLaunchPayload = (payload) => {
  if (!payload || typeof payload !== 'string' || !payload.trim()) {
    return;
  }
  const value = payload.trim();
  if (launchPayloadSubscribers.size === 0) {
    pendingLaunchPayload = value;
    return;
  }
  for (const callback of launchPayloadSubscribers) {
    try {
      callback(value);
    } catch (error) {
      appendDebugLog('launch', 'subscriber_error', {
        message: safeErrorMessage(error),
      }, 'error');
    }
  }
};

if (typeof window !== 'undefined' && window.ztools) {
  window.ztools.onMainPush(
    (queryData) => {
      const query = typeof queryData === 'string' ? queryData : (queryData?.payload ?? '');
      if (!query || typeof query !== 'string' || !query.trim()) {
        return [];
      }
      return [
        {
          label: 'Kuke AI Agent',
          description: `向 Kuke Agent 提问：${query.slice(0, 60)}${query.length > 60 ? '...' : ''}`,
          icon: 'bot',
          data: { query: query.trim() },
        },
      ];
    },
    (selectData) => {
      if (selectData?.data?.query) {
        notifyLaunchPayload(selectData.data.query);
      }
      return true;
    }
  );

  window.ztools.onPluginEnter((param) => {
    if (param?.payload) {
      const raw = typeof param.payload === 'string' ? param.payload : (param.payload?.query ?? null);
      if (raw) {
        notifyLaunchPayload(raw);
      }
    }
  });
}

window.localTools = {
  getPendingLaunchPayload: () => {
    const payload = pendingLaunchPayload;
    pendingLaunchPayload = null;
    return payload;
  },

  onLaunchPayload: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    launchPayloadSubscribers.add(callback);
    if (pendingLaunchPayload) {
      const payload = pendingLaunchPayload;
      pendingLaunchPayload = null;
      try {
        callback(payload);
      } catch (error) {
        appendDebugLog('launch', 'subscriber_error', {
          message: safeErrorMessage(error),
        }, 'error');
      }
    }
    return () => {
      launchPayloadSubscribers.delete(callback);
    };
  },

  chat: async (config, messages, tools, handlers, options = {}) => {
    const requestId = options?.requestId || createTraceId('chat_request');
    const traceId = createTraceId(`chat_${requestId}`);
    const startAt = now();
    const controller = new AbortController();
    activeChatControllers.set(requestId, controller);
    try {
      const openai = createOpenAIClient(config);
      const response = await createChatResponse(
        openai,
        config,
        messages,
        tools,
        handlers,
        traceId,
        controller.signal,
      );
      appendDebugLog('chat', 'success', { traceId, requestId, durationMs: now() - startAt });
      return { success: true, data: response };
    } catch (error) {
      if (isAbortError(error)) {
        appendDebugLog('chat', 'aborted', { traceId, requestId, durationMs: now() - startAt });
        return { success: false, aborted: true, error: '请求已中断' };
      }
      const message = safeErrorMessage(error);
      appendDebugLog('chat', 'error', { traceId, requestId, durationMs: now() - startAt, message }, 'error');
      return { success: false, error: message };
    } finally {
      activeChatControllers.delete(requestId);
    }
  },

  cancelChat: (requestId) => {
    const normalizedRequestId = String(requestId || '').trim();
    if (!normalizedRequestId) {
      return { success: false, error: 'requestId 不能为空' };
    }
    const controller = activeChatControllers.get(normalizedRequestId);
    if (!controller) {
      return { success: true, aborted: false };
    }
    controller.abort();
    activeChatControllers.delete(normalizedRequestId);
    appendDebugLog('chat', 'cancel_requested', { requestId: normalizedRequestId });
    return { success: true, aborted: true };
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

  BashTool: (optionsOrCommand, maybeCwd) => {
    if (typeof optionsOrCommand === 'string') {
      return executeShellCommand(optionsOrCommand, maybeCwd);
    }
    const opts = optionsOrCommand || {};
    const command = String(opts.command ?? '');
    const cwd = opts.cwd ? String(opts.cwd) : undefined;
    const description = typeof opts.description === 'string' ? opts.description : '';
    const runInBackground = Boolean(opts.runInBackground);
    const timeoutMs = opts.timeout != null ? Number(opts.timeout) : undefined;
    if (runInBackground) {
      return startBackgroundBash(command, cwd, { description });
    }
    return executeShellCommand(command, cwd, { timeoutMs, description });
  },

  BashOutputTool: (options) => readBackgroundBashOutput(options || {}),
  KillShellTool: (options) => killBackgroundBash(options || {}),
  listBackgroundBashes: () => listBackgroundBashes(),

  NotebookEditTool: (options) => editNotebookCells(options || {}),
  TodoWriteTool: (options) => runTodoWrite(options || {}),

  WebFetchTool: async (optionsOrUrl) => {
    const traceId = createTraceId('web_fetch');
    const startAt = now();
    const opts = typeof optionsOrUrl === 'string' ? { url: optionsOrUrl } : (optionsOrUrl || {});
    const rawUrl = opts.url;
    const prompt = String(opts.prompt ?? '').trim();
    const llmConfig = opts.llmConfig || null;
    let normalizedUrl = '';
    try {
      normalizedUrl = normalizeHttpUrl(rawUrl);
      const parsedUrl = new URL(normalizedUrl);
      const hostname = parsedUrl.hostname.toLowerCase();
      const isPrivateIpv4 = /^10\./.test(hostname)
        || /^127\./.test(hostname)
        || /^192\.168\./.test(hostname)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
        || /^169\.254\./.test(hostname);
      const isLocalHost = hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1' || hostname === '[::1]';
      if (isLocalHost || isPrivateIpv4 || hostname.endsWith('.local')) {
        throw new Error('禁止访问本地或内网地址');
      }
      const { response } = await fetchWithFallback([normalizedUrl], {
        redirect: 'follow',
        headers: {
          'user-agent': 'KukeAgent/1.0',
        },
      });
      const rawText = await response.text();
      const contentType = response.headers.get('content-type') || 'unknown';
      const plainText = contentType.includes('html') ? htmlToPlainText(rawText) : rawText;
      const { text, truncated } = truncateText(plainText, 50000);

      let analysis = null;
      let analysisError = null;
      if (prompt && llmConfig && llmConfig.apiKey && llmConfig.model) {
        try {
          const analysisClient = createOpenAIClient(llmConfig);
          const analysisController = new AbortController();
          const timeoutHandle = setTimeout(() => analysisController.abort(), 45_000);
          try {
            const analysisResponse = await analysisClient.chat.completions.create(
              {
                model: llmConfig.model,
                messages: [
                  {
                    role: 'system',
                    content: '你是网页摘要助手。根据用户 prompt 从给定网页内容中抽取关键信息，如果 prompt 是提问请直接回答。回答要精准、结构清晰，避免复述整个页面。',
                  },
                  {
                    role: 'user',
                    content: `网页 URL: ${response.url || normalizedUrl}\n\n网页正文（已做纯文本提取，可能截断）:\n${text}\n\n用户 prompt: ${prompt}`,
                  },
                ],
                stream: false,
              },
              { signal: analysisController.signal },
            );
            analysis = analysisResponse.choices?.[0]?.message?.content || '';
          } finally {
            clearTimeout(timeoutHandle);
          }
        } catch (error) {
          analysisError = safeErrorMessage(error);
        }
      } else if (prompt && (!llmConfig || !llmConfig.apiKey || !llmConfig.model)) {
        analysisError = '缺少 LLM 配置（apiKey / model），已跳过 prompt 摘要。';
      }

      appendDebugLog('web.fetch', 'success', {
        traceId,
        durationMs: now() - startAt,
        url: normalizedUrl,
        finalUrl: response.url,
        status: response.status,
        contentType,
        truncated,
        analyzed: Boolean(analysis),
        analysisError,
      });
      return {
        success: true,
        data: {
          url: response.url || normalizedUrl,
          status: response.status,
          contentType,
          content: text,
          truncated,
          prompt: prompt || null,
          analysis: analysis || null,
          analysisError: analysisError || null,
        },
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('web.fetch', 'error', {
        traceId,
        durationMs: now() - startAt,
        url: normalizedUrl || String(rawUrl || ''),
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  WebSearchTool: async (queryOrOptions, count, apiKey) => {
    const traceId = createTraceId('web_search');
    const startAt = now();
    let normalizedQuery = '';
    let resultLimit = 5;
    let normalizedApiKey = '';
    let allowedDomains = [];
    let blockedDomains = [];
    if (typeof queryOrOptions === 'object' && queryOrOptions !== null) {
      normalizedQuery = String(queryOrOptions.query ?? '').trim();
      resultLimit = Math.min(Math.max(Number(queryOrOptions.count) || 5, 1), 10);
      normalizedApiKey = String(queryOrOptions.apiKey ?? '').trim();
      allowedDomains = Array.isArray(queryOrOptions.allowedDomains)
        ? queryOrOptions.allowedDomains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
        : [];
      blockedDomains = Array.isArray(queryOrOptions.blockedDomains)
        ? queryOrOptions.blockedDomains.map((d) => String(d || '').trim().toLowerCase()).filter(Boolean)
        : [];
    } else {
      normalizedQuery = String(queryOrOptions ?? '').trim();
      resultLimit = Math.min(Math.max(Number(count) || 5, 1), 10);
      normalizedApiKey = String(apiKey ?? '').trim();
    }
    if (!normalizedQuery) {
      return { success: false, error: 'query 不能为空' };
    }
    if (!normalizedApiKey) {
      return { success: false, error: '请先在设置中配置 Tavily API Key' };
    }

    try {
      const client = tavily({ apiKey: normalizedApiKey });
      const response = await client.search(normalizedQuery, {
        searchDepth: 'advanced',
        maxResults: Math.max(resultLimit, 10),
      });
      const rawResults = Array.isArray(response?.results) ? response.results : [];
      const matchHost = (hostname, pattern) => {
        if (!hostname || !pattern) return false;
        const host = hostname.toLowerCase();
        if (pattern.startsWith('*.')) {
          const tail = pattern.slice(1);
          return host === tail.slice(1) || host.endsWith(tail);
        }
        return host === pattern || host.endsWith(`.${pattern}`);
      };

      const filtered = [];
      let filteredOut = 0;
      for (const item of rawResults) {
        const urlString = String(item?.url ?? '').trim();
        if (!urlString) continue;
        let host = '';
        try {
          host = new URL(urlString).hostname.toLowerCase();
        } catch {
          host = '';
        }
        if (blockedDomains.length && blockedDomains.some((pattern) => matchHost(host, pattern))) {
          filteredOut += 1;
          continue;
        }
        if (allowedDomains.length && !allowedDomains.some((pattern) => matchHost(host, pattern))) {
          filteredOut += 1;
          continue;
        }
        filtered.push({
          rank: filtered.length + 1,
          title: compactSearchText(item?.title, 120),
          url: urlString,
          snippet: compactSearchText(item?.content, 360),
          score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
        });
        if (filtered.length >= resultLimit) break;
      }
      const answer = compactSearchText(response?.answer, 500);

      appendDebugLog('web.search', 'success', {
        traceId,
        durationMs: now() - startAt,
        query: normalizedQuery,
        requestedCount: resultLimit,
        resultCount: filtered.length,
        filteredOut,
        provider: 'tavily',
      });
      return {
        success: true,
        data: {
          query: normalizedQuery,
          provider: 'Tavily',
          answer: answer || null,
          results: filtered,
          filteredOut,
          allowedDomains,
          blockedDomains,
          responseTime: Number(response?.response_time ?? 0) || null,
          requestId: String(response?.request_id ?? ''),
        },
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('web.search', 'error', {
        traceId,
        durationMs: now() - startAt,
        query: normalizedQuery,
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  FileReadTool: (optionsOrPath) => {
    if (typeof optionsOrPath === 'string') {
      return readFileRich({ filePath: optionsOrPath });
    }
    return readFileRich(optionsOrPath || {});
  },

  FileEditTool: (options = {}) => {
    const traceId = createTraceId('file_edit');
    const startAt = now();
    let targetPath = '';
    try {
      const filePath = options?.filePath;
      targetPath = resolveLocalPath(filePath, 'filePath');
      const context = options?.__context || null;
      if (context) {
        snapshotFileBefore(context, targetPath);
      }
      const currentContent = fs.readFileSync(targetPath, 'utf-8');
      const normalizedEdits = Array.isArray(options?.edits) && options.edits.length
        ? options.edits
        : [options];

      let nextContent = currentContent;
      const appliedEdits = [];

      for (const edit of normalizedEdits) {
        const search = edit?.oldText ?? edit?.old_string ?? edit?.search;
        if (typeof search !== 'string' || !search) {
          throw new Error('FileEditTool 需要提供 oldText / old_string / search');
        }
        const replaceValue = edit?.newText ?? edit?.new_string ?? edit?.replace ?? '';
        const replaceAll = Boolean(edit?.replaceAll);
        if (!nextContent.includes(search)) {
          throw new Error(`未找到要替换的文本: ${search.slice(0, 80)}`);
        }

        const occurrenceCount = nextContent.split(search).length - 1;
        if (!replaceAll && occurrenceCount > 1) {
          throw new Error(`替换文本命中 ${occurrenceCount} 处，请使用更精确的 oldText/search 或开启 replaceAll`);
        }
        nextContent = replaceAll
          ? nextContent.split(search).join(String(replaceValue))
          : nextContent.replace(search, String(replaceValue));

        appliedEdits.push({
          searchPreview: search.slice(0, 120),
          replaceAll,
          occurrenceCount,
        });
      }

      if (nextContent !== currentContent) {
        fs.writeFileSync(targetPath, nextContent, 'utf-8');
      }

      const diff = buildToolDiffMeta(targetPath, currentContent, nextContent);

      appendDebugLog('file.edit', 'success', {
        traceId,
        durationMs: now() - startAt,
        filePath: targetPath,
        editCount: appliedEdits.length,
        changed: nextContent !== currentContent,
        addedLines: diff?.addedLines ?? 0,
        removedLines: diff?.removedLines ?? 0,
      });
      return {
        success: true,
        data: {
          filePath: targetPath,
          changed: nextContent !== currentContent,
          appliedEdits,
          diff,
        },
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('file.edit', 'error', {
        traceId,
        durationMs: now() - startAt,
        filePath: targetPath,
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  FileWriteTool: (filePath, content) => writeFileContent(filePath, content),

  FileDeleteTool: (options = {}) => {
    const traceId = createTraceId('file_delete');
    const startAt = now();
    let targetPath = '';
    try {
      const filePath = options?.filePath;
      targetPath = resolveLocalPath(filePath, 'filePath');
      const recursive = Boolean(options?.recursive);
      const context = options?.__context || null;
      if (!fs.existsSync(targetPath)) {
        throw new Error('目标不存在');
      }
      const stats = fs.statSync(targetPath);
      const isDirectory = stats.isDirectory();
      if (isDirectory && !recursive) {
        throw new Error('目标是目录，需要设置 recursive: true 才能删除。');
      }
      if (context) {
        snapshotFileBefore(context, targetPath);
      }
      let diff = null;
      let deletedFileCount = 0;
      let totalRemovedLines = 0;
      if (isDirectory) {
        // Walk the directory to sum removed line counts from text files.
        const stack = [targetPath];
        while (stack.length) {
          const current = stack.pop();
          let currentStats;
          try {
            currentStats = fs.statSync(current);
          } catch {
            continue;
          }
          if (currentStats.isDirectory()) {
            try {
              const entries = fs.readdirSync(current);
              for (const entry of entries) {
                stack.push(path.join(current, entry));
              }
            } catch {
              // ignore
            }
          } else if (currentStats.isFile()) {
            deletedFileCount += 1;
            if (shouldTreatAsTextFile(current)) {
              try {
                const content = fs.readFileSync(current, 'utf-8');
                totalRemovedLines += splitForDiff(content).length;
              } catch {
                // ignore
              }
            }
          }
        }
        fs.rmSync(targetPath, { recursive: true, force: true });
        diff = {
          filePath: targetPath,
          addedLines: 0,
          removedLines: totalRemovedLines,
          diffText: `@@ deleted directory (${deletedFileCount} files) @@`,
          tooLarge: deletedFileCount > 50,
          diffTruncated: false,
        };
      } else {
        let previousContent = '';
        if (shouldTreatAsTextFile(targetPath)) {
          try {
            previousContent = fs.readFileSync(targetPath, 'utf-8');
          } catch {
            previousContent = '';
          }
        }
        fs.unlinkSync(targetPath);
        diff = buildToolDiffMeta(targetPath, previousContent, '');
        deletedFileCount = 1;
      }
      appendDebugLog('file.delete', 'success', {
        traceId,
        durationMs: now() - startAt,
        filePath: targetPath,
        isDirectory,
        recursive,
        deletedFileCount,
        removedLines: diff?.removedLines ?? 0,
      });
      return {
        success: true,
        data: {
          filePath: targetPath,
          isDirectory,
          recursive,
          deletedFileCount,
          diff,
        },
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('file.delete', 'error', {
        traceId,
        durationMs: now() - startAt,
        filePath: targetPath,
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  GlobTool: (options = {}) => {
    const traceId = createTraceId('glob');
    const startAt = now();
    try {
      const pattern = String(options?.pattern ?? '').trim();
      if (!pattern) {
        throw new Error('pattern 不能为空');
      }

      const includeDirectories = Boolean(options?.includeDirectories);
      const limit = Math.max(1, Math.min(Number(options?.limit) || 200, 5000));
      const { startPath, results } = walkEntries(options?.path || process.cwd(), {
        includeDirectories,
        maxEntries: 10000,
      });
      const matcher = globToRegExp(pattern);
      const matchRelativePath = pattern.replace(/\\/g, '/').includes('/');
      const matches = [];
      for (const entry of results) {
        if (!includeDirectories && entry.type === 'directory') {
          continue;
        }
        const candidate = matchRelativePath
          ? path.relative(startPath, entry.path).replace(/\\/g, '/')
          : path.basename(entry.path);
        if (!matcher.test(candidate)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(entry.path).mtimeMs || 0;
        } catch {
          mtimeMs = 0;
        }
        matches.push({ path: entry.path, type: entry.type, mtimeMs });
      }
      matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const limited = matches.slice(0, limit);

      appendDebugLog('file.glob', 'success', {
        traceId,
        durationMs: now() - startAt,
        pattern,
        startPath,
        resultCount: limited.length,
        totalMatched: matches.length,
      });
      return {
        success: true,
        data: limited,
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      appendDebugLog('file.glob', 'error', {
        traceId,
        durationMs: now() - startAt,
        pattern: options?.pattern || '',
        path: options?.path || '',
        message,
      }, 'error');
      return { success: false, error: message };
    }
  },

  GrepTool: (options = {}) => runGrep(options),

  readDir: (dirPath) => listDirectory(dirPath),
  readFile: (filePath) => readFileContent(filePath),
  writeFile: (filePath, content) => writeFileContent(filePath, content),
  execCommand: (command, cwd) => executeShellCommand(command, cwd),

  snapshotFile: (context, filePath) => {
    try {
      const normalized = resolveLocalPath(filePath, 'filePath');
      return snapshotFileBefore(context || {}, normalized);
    } catch (error) {
      return { success: false, error: safeErrorMessage(error) };
    }
  },
  restoreSnapshot: (options = {}) => {
    const sessionId = options?.sessionId;
    const messageId = options?.messageId ?? options?.userMessageId;
    if (!messageId) {
      return { success: false, error: 'messageId 不能为空' };
    }
    return restoreFileSnapshots(sessionId, messageId);
  },
  listSessionSnapshots: (sessionId) => listSnapshotsForSession(sessionId),
  clearSessionSnapshots: (sessionId) => clearSnapshotsForSession(sessionId),
  clearMessageSnapshot: (options = {}) => {
    const sessionId = options?.sessionId;
    const messageId = options?.messageId ?? options?.userMessageId;
    return clearSnapshotForMessage(sessionId, messageId);
  },

  statPath: (p) => statLocalPath(p),
  getPathForFile: (file) => {
    try {
      const resolved = resolveFileLocalPath(file);
      return {
        success: true,
        data: {
          path: resolved,
          hasElectronWebUtils: Boolean(electronWebUtils && typeof electronWebUtils.getPathForFile === 'function'),
        },
      };
    } catch (error) {
      return { success: false, error: safeErrorMessage(error) };
    }
  },
  saveClipboardImage: (dataUrl, ext) => saveClipboardImage(dataUrl, ext),
  saveUploadedFile: (options) => saveUploadedFile(options),
  readFileAsDataURL: (filePath) => readFileAsDataURL(filePath),
  cleanupUploads: (maxAgeMs) => cleanupStaleUploads(maxAgeMs),
  setWorkspaceRoot: (p) => setWorkspaceRoot(p),
  getWorkspaceRoot: () => getWorkspaceRoot(),
  SetWorkspaceRootTool: (options = {}) => {
    const rawPath = typeof options === 'string' ? options : (options?.path ?? options?.cwd ?? options?.root);
    if (!rawPath) {
      return { success: false, error: 'path 不能为空' };
    }
    return setWorkspaceRoot(String(rawPath));
  },
  GetWorkspaceRootTool: () => getWorkspaceRoot(),

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

  getEnvironment: () => {
    try {
      let username = '';
      try {
        username = os.userInfo().username || '';
      } catch {
        username = '';
      }
      let timezone = '';
      try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      } catch {
        timezone = '';
      }
      return {
        success: true,
        data: {
          platform: process.platform,
          osType: os.type(),
          osRelease: os.release(),
          arch: process.arch,
          cwd: process.cwd(),
          homedir: os.homedir(),
          hostname: os.hostname(),
          user: username,
          nodeVersion: process.versions.node,
          timezone,
          locale:
            (typeof process.env.LANG === 'string' && process.env.LANG)
            || (typeof process.env.LC_ALL === 'string' && process.env.LC_ALL)
            || '',
        },
      };
    } catch (error) {
      return { success: false, error: safeErrorMessage(error) };
    }
  },
};
