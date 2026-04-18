<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { Send, Settings, Terminal, Check, Loader2, Bot, User, X } from 'lucide-vue-next'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt()

// State
const messages = ref<any[]>([])
const input = ref('')
const isLoading = ref(false)
const showSettings = ref(false)

// Config
const config = ref({
  apiKey: localStorage.getItem('kuke_api_key') || '',
  baseURL: localStorage.getItem('kuke_base_url') || 'https://api.openai.com/v1',
  model: localStorage.getItem('kuke_model') || 'gpt-3.5-turbo',
  systemPrompt: localStorage.getItem('kuke_system') || '你是一个全能的本地 AI Agent，可以调用本地工具（如读取文件、执行终端指令）。'
})

// Save Config
const saveConfig = () => {
  localStorage.setItem('kuke_api_key', config.value.apiKey)
  localStorage.setItem('kuke_base_url', config.value.baseURL)
  localStorage.setItem('kuke_model', config.value.model)
  localStorage.setItem('kuke_system', config.value.systemPrompt)
  showSettings.value = false
}

// Auto-scroll
const chatContainer = ref<HTMLElement | null>(null)
const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

// Tool definitions for OpenAI
const tools = [
  {
    type: 'function',
    function: {
      name: 'readDir',
      description: '读取本地目录下的所有文件和文件夹列表',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: '目录的绝对路径或相对路径' }
        },
        required: ['dirPath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'readFile',
      description: '读取本地文件的内容',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件的绝对路径或相对路径' }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'writeFile',
      description: '向本地文件写入内容',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件的绝对路径或相对路径' },
          content: { type: 'string', description: '要写入的文件内容' }
        },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'execCommand',
      description: '在终端执行系统指令，如 npm install, ls, dir 等',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的终端指令' },
          cwd: { type: 'string', description: '执行指令的当前工作目录（可选）' }
        },
        required: ['command']
      }
    }
  }
]

// Chat Logic
const sendMessage = async () => {
  if (!input.value.trim() || isLoading.value) return
  
  const userMessage = input.value
  messages.value.push({ role: 'user', content: userMessage })
  input.value = ''
  isLoading.value = true
  scrollToBottom()

  try {
    // Construct conversation history
    const apiMessages: any[] = [
      { role: 'system', content: config.value.systemPrompt },
      ...messages.value.map(m => ({ role: m.role, content: m.content }))
    ]

    const response = await (window as any).localTools.chat(
      { apiKey: config.value.apiKey, baseURL: config.value.baseURL, model: config.value.model },
      apiMessages,
      tools
    )

    if (!response.success) {
      throw new Error(response.error)
    }

    const message = response.data

    if (message.tool_calls) {
      // AI decided to call a tool
      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name
        const args = JSON.parse(toolCall.function.arguments)
        
        let toolResult = ''
        
        // Notify UI about tool execution
        messages.value.push({ 
          role: 'system', 
          content: `🔧 执行工具: **${functionName}**\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
        })
        scrollToBottom()

        // Call preload.js tools
        if ((window as any).localTools && (window as any).localTools[functionName]) {
          if (functionName === 'execCommand') {
            const res = await (window as any).localTools.execCommand(args.command, args.cwd)
            toolResult = JSON.stringify(res)
          } else {
            const res = (window as any).localTools[functionName](...Object.values(args))
            toolResult = JSON.stringify(res)
          }
        } else {
          toolResult = '错误：当前环境未提供此本地工具，请确保在 ZTools 环境中运行。'
        }

        // Return tool output to AI
        apiMessages.push(message)
        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolResult
        })
        
        // Notify UI about tool result
        messages.value.push({ 
          role: 'system', 
          content: `✅ 工具执行结果:\n\`\`\`json\n${toolResult.substring(0, 500)}${toolResult.length > 500 ? '...' : ''}\n\`\`\``
        })
        scrollToBottom()
      }

      // Final response from AI
      const secondResponse = await (window as any).localTools.chat(
        { apiKey: config.value.apiKey, baseURL: config.value.baseURL, model: config.value.model },
        apiMessages,
        null // no tools on the second pass usually
      )

      if (!secondResponse.success) {
        throw new Error(secondResponse.error)
      }

      messages.value.push({ role: 'assistant', content: secondResponse.data.content || '' })
    } else {
      // Normal response
      messages.value.push({ role: 'assistant', content: message.content || '' })
    }

  } catch (error: any) {
    messages.value.push({ role: 'system', content: `❌ 请求失败: ${error.message}` })
  } finally {
    isLoading.value = false
    scrollToBottom()
  }
}

onMounted(() => {
  // Check if we're in ZTools environment
  if (!(window as any).localTools) {
    messages.value.push({ 
      role: 'system', 
      content: '⚠️ 警告: 未检测到 `localTools`，请确保您在 ZTools 插件环境中运行，否则文件和终端工具将无法使用。您可以进行常规的聊天。'
    })
  } else {
    messages.value.push({ 
      role: 'assistant', 
      content: '你好！我是你的全能本地 AI Agent。我已经连接了本地系统，你可以让我帮你读取文件、管理项目或是执行终端命令！'
    })
  }
})
</script>

<template>
  <div class="flex h-screen w-full bg-slate-50 dark:bg-slate-900 font-sans text-slate-900 dark:text-slate-100 overflow-hidden">
    
    <!-- Sidebar / Settings Overlay -->
    <div v-if="showSettings" class="absolute inset-0 z-20 bg-black/50 backdrop-blur-sm flex justify-end transition-opacity">
      <div class="w-full max-w-md h-full bg-white dark:bg-slate-800 shadow-2xl flex flex-col p-6 animate-in slide-in-from-right-8 duration-300">
        <div class="flex items-center justify-between mb-6">
          <h2 class="text-xl font-bold flex items-center gap-2">
            <Settings class="w-5 h-5" />
            模型与代理配置
          </h2>
          <button @click="showSettings = false" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-full transition">
            <X class="w-5 h-5" />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto space-y-4">
          <div>
            <label class="block text-sm font-medium mb-1">API Base URL</label>
            <input v-model="config.baseURL" type="text" class="w-full px-3 py-2 border rounded-lg dark:bg-slate-900 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none transition" placeholder="https://api.openai.com/v1" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">API Key</label>
            <input v-model="config.apiKey" type="password" class="w-full px-3 py-2 border rounded-lg dark:bg-slate-900 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none transition" placeholder="sk-..." />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Model Name</label>
            <input v-model="config.model" type="text" class="w-full px-3 py-2 border rounded-lg dark:bg-slate-900 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none transition" placeholder="gpt-4o / deepseek-chat" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">System Prompt</label>
            <textarea v-model="config.systemPrompt" rows="4" class="w-full px-3 py-2 border rounded-lg dark:bg-slate-900 dark:border-slate-700 focus:ring-2 focus:ring-blue-500 outline-none transition resize-none"></textarea>
          </div>
        </div>

        <div class="mt-6 pt-4 border-t dark:border-slate-700">
          <button @click="saveConfig" class="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg transition font-medium shadow-md shadow-blue-500/20">
            <Check class="w-4 h-4" />
            保存并应用
          </button>
        </div>
      </div>
    </div>

    <!-- Main Chat Area -->
    <div class="flex-1 flex flex-col h-full relative">
      <!-- Header -->
      <header class="h-14 shrink-0 border-b dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md flex items-center justify-between px-4 sticky top-0 z-10">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/30">
            <Bot class="w-5 h-5" />
          </div>
          <div>
            <h1 class="font-bold leading-none">Kuke Agent</h1>
            <p class="text-xs text-slate-500 mt-0.5">你的本地专属全能 AI</p>
          </div>
        </div>
        <button @click="showSettings = true" class="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition group" title="设置">
          <Settings class="w-5 h-5 text-slate-500 group-hover:text-blue-600 transition-colors" />
        </button>
      </header>

      <!-- Chat Messages -->
      <div ref="chatContainer" class="flex-1 overflow-y-auto p-4 space-y-6 scroll-smooth">
        <div v-if="messages.length === 0" class="h-full flex flex-col items-center justify-center text-slate-400 opacity-50">
          <Bot class="w-16 h-16 mb-4" />
          <p>尝试问我："读取当前目录的文件" 或 "帮我安装 tailwind"</p>
        </div>

        <div v-for="(msg, i) in messages" :key="i" class="flex items-start gap-3" :class="[msg.role === 'user' ? 'flex-row-reverse' : '']">
          <!-- Avatar -->
          <div class="w-8 h-8 rounded-full shrink-0 flex items-center justify-center shadow-sm"
               :class="[
                 msg.role === 'user' ? 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/50 dark:text-indigo-400' :
                 msg.role === 'system' ? 'bg-slate-100 text-slate-500 dark:bg-slate-800' :
                 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400'
               ]">
            <User v-if="msg.role === 'user'" class="w-4 h-4" />
            <Terminal v-else-if="msg.role === 'system'" class="w-4 h-4" />
            <Bot v-else class="w-4 h-4" />
          </div>

          <!-- Bubble -->
          <div class="max-w-[80%] rounded-2xl px-4 py-2 shadow-sm relative group"
               :class="[
                 msg.role === 'user' 
                   ? 'bg-blue-600 text-white rounded-tr-sm' 
                   : msg.role === 'system'
                     ? 'bg-slate-100 dark:bg-slate-800 text-sm font-mono text-slate-600 dark:text-slate-300 rounded-tl-sm border dark:border-slate-700'
                     : 'bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-tl-sm'
               ]">
            <!-- Render Markdown -->
            <div v-if="msg.role !== 'user'" class="prose prose-sm dark:prose-invert max-w-none" v-html="md.render(msg.content)"></div>
            <div v-else class="whitespace-pre-wrap">{{ msg.content }}</div>
          </div>
        </div>
        
        <!-- Loading State -->
        <div v-if="isLoading" class="flex items-start gap-3">
          <div class="w-8 h-8 rounded-full shrink-0 bg-blue-100 text-blue-600 dark:bg-blue-900/50 flex items-center justify-center shadow-sm">
            <Bot class="w-4 h-4" />
          </div>
          <div class="bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm flex items-center gap-2">
            <Loader2 class="w-4 h-4 animate-spin text-blue-600" />
            <span class="text-sm text-slate-500">思考或执行中...</span>
          </div>
        </div>
      </div>

      <!-- Input Area -->
      <div class="p-4 bg-white dark:bg-slate-900 border-t dark:border-slate-800">
        <form @submit.prevent="sendMessage" class="relative max-w-4xl mx-auto flex items-end gap-2 bg-slate-50 dark:bg-slate-800 p-1.5 rounded-2xl border dark:border-slate-700 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/50 transition-all">
          <textarea 
            v-model="input"
            @keydown.enter.exact.prevent="sendMessage"
            rows="1"
            class="flex-1 max-h-32 min-h-[44px] bg-transparent resize-none py-2.5 px-3 outline-none overflow-y-auto"
            placeholder="问我任何事，或让我执行终端命令..."
            style="field-sizing: content;"
          ></textarea>
          <button 
            type="submit" 
            :disabled="!input.trim() || isLoading"
            class="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center transition-all"
            :class="[
              input.trim() && !isLoading 
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md shadow-blue-500/20' 
                : 'bg-slate-200 dark:bg-slate-700 text-slate-400 cursor-not-allowed'
            ]">
            <Send class="w-5 h-5 ml-0.5" />
          </button>
        </form>
        <p class="text-center text-[10px] text-slate-400 mt-2">
          Shift + Enter 换行，Enter 发送。Agent 能够操作您的本地系统，请谨慎授予高风险指令的权限。
        </p>
      </div>
    </div>
  </div>
</template>

<style>
/* Markdown Styles Adjustments */
.prose pre {
  margin: 0.5em 0;
  padding: 0.75em;
  border-radius: 0.5rem;
  background-color: #1e293b !important;
}
.prose p {
  margin-top: 0.5em;
  margin-bottom: 0.5em;
}
.prose p:first-child {
  margin-top: 0;
}
.prose p:last-child {
  margin-bottom: 0;
}
</style>
