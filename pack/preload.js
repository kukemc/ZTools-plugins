const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const OpenAI = require('openai');

window.localTools = {
  // AI 聊天请求 (在 Node 端执行，避免跨域问题)
  chat: async (config, messages, tools) => {
    try {
      const openai = new OpenAI({
        apiKey: config.apiKey || 'empty',
        baseURL: config.baseURL,
      });

      const response = await openai.chat.completions.create({
        model: config.model,
        messages: messages,
        tools: tools,
        tool_choice: tools && tools.length > 0 ? 'auto' : 'none'
      });

      return { success: true, data: response.choices[0].message };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },

  // 获取可用模型列表
  getModels: async (config) => {
    try {
      const openai = new OpenAI({
        apiKey: config.apiKey || 'empty',
        baseURL: config.baseURL,
      });
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
