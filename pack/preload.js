const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const OpenAI = require('openai');

function createOpenAIClient(config = {}) {
  return new OpenAI({
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
    console.warn('[KukeAgent] chat stream handler error:', error);
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
  const normalizedMessage = {
    ...message,
  };
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

async function createChatResponse(openai, config, messages, tools, handlers = {}) {
  const useStream = typeof handlers.onEvent === 'function';

  if (!useStream) {
    const response = await openai.chat.completions.create({
      model: config.model,
      messages: messages,
      tools: tools,
      tool_choice: tools && tools.length > 0 ? 'auto' : 'none',
      stream: false,
    });

    return normalizeAssistantMessage(response.choices[0].message);
  }

  const stream = await openai.chat.completions.create({
    model: config.model,
    messages: messages,
    tools: tools,
    tool_choice: tools && tools.length > 0 ? 'auto' : 'none',
    stream: true,
  });

  const finalMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [],
  };

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta || {};

    if (delta.role) {
      finalMessage.role = delta.role;
    }

    const deltaText = extractContentText(delta.content);
    if (deltaText) {
      finalMessage.content += deltaText;
      emitChatEvent(handlers, { type: 'content_delta', delta: deltaText });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        mergeToolCallDelta(finalMessage, toolCallDelta);
      }

      emitChatEvent(handlers, {
        type: 'tool_calls_delta',
        toolCalls: finalMessage.tool_calls,
      });
    }

    if (choice?.finish_reason) {
      emitChatEvent(handlers, { type: 'finish', finishReason: choice.finish_reason });
    }
  }

  if (finalMessage.tool_calls.length && !finalMessage.content.trim()) {
    finalMessage.content = null;
  }

  return normalizeAssistantMessage(finalMessage);
}

window.localTools = {
  // AI 聊天请求 (在 Node 端执行，避免跨域问题)
  chat: async (config, messages, tools, handlers) => {
    try {
      const openai = createOpenAIClient(config);
      const response = await createChatResponse(openai, config, messages, tools, handlers);
      return { success: true, data: response };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // 获取可用模型列表
  getModels: async (config) => {
    try {
      const openai = createOpenAIClient(config);
      const response = await openai.models.list();
      return { success: true, data: response.data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // 读取目录
  readDir: (dirPath) => {
    try {
      const targetPath = path.resolve(dirPath);
      const files = fs.readdirSync(targetPath, { withFileTypes: true });
      return {
        success: true,
        data: files.map(f => ({
          name: f.name,
          isDirectory: f.isDirectory(),
          path: path.join(targetPath, f.name)
        }))
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  
  // 读取文件内容
  readFile: (filePath) => {
    try {
      const data = fs.readFileSync(path.resolve(filePath), 'utf-8');
      return { success: true, data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // 写入文件
  writeFile: (filePath, content) => {
    try {
      const targetPath = path.resolve(filePath);
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(targetPath, content, 'utf-8');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // 执行终端指令
  execCommand: (command, cwd) => {
    return new Promise((resolve) => {
      exec(command, { cwd: cwd || process.cwd() }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, error: error.message, stderr });
        } else {
          resolve({ success: true, stdout, stderr });
        }
      });
    });
  }
};
