<script setup lang="ts">
import { ref, onMounted, nextTick, computed } from 'vue'
import { Send, Settings, Terminal, Check, Loader2, Bot, User, X, MessageSquare, Plus, Trash2, RefreshCw, ChevronDown } from 'lucide-vue-next'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt()

// State
const messages = ref<any[]>([])
const input = ref('')
const isLoading = ref(false)
const showSettings = ref(false)
const isSidebarOpen = ref(true)

// Config Data Types
interface Provider {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: string[]
}

const defaultProviders: Provider[] = [
  { id: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: '', models: ['gpt-3.5-turbo', 'gpt-4o', 'gpt-4-turbo'] },
  { id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: '', models: ['deepseek-chat', 'deepseek-coder'] }
]

const loadProviders = (): Provider[] => {
  const stored = localStorage.getItem('kuke_providers')
  if (stored) {
    try { return JSON.parse(stored) } catch(e) { return defaultProviders }
  }
  return defaultProviders
}

const providers = ref<Provider[]>(loadProviders())
const selectedProviderId = ref(localStorage.getItem('kuke_provider_id') || providers.value[0].id)
const selectedModel = ref(localStorage.getItem('kuke_model') || providers.value[0].models[0])
const systemPrompt = ref(localStorage.getItem('kuke_system') || '你是一个全能的本地 AI Agent，可以调用本地工具（如读取文件、执行终端指令）。')

// Computed config based on selected provider
const currentProvider = computed(() => providers.value.find(p => p.id === selectedProviderId.value) || providers.value[0])

const saveConfig = () => {
  localStorage.setItem('kuke_providers', JSON.stringify(providers.value))
  localStorage.setItem('kuke_provider_id', selectedProviderId.value)
  localStorage.setItem('kuke_model', selectedModel.value)
  localStorage.setItem('kuke_system', systemPrompt.value)
  showSettings.value = false
}

// Provider Management Methods
const addNewProvider = () => {
  const newId = 'provider_' + Date.now()
  providers.value.push({
    id: newId,
    name: 'New Provider',
    baseURL: 'https://',
    apiKey: '',
    models: ['default-model']
  })
  selectedProviderId.value = newId
}

const removeProvider = (id: string) => {
  if (providers.value.length <= 1) return alert('至少保留一个供应商')
  providers.value = providers.value.filter(p => p.id !== id)
  if (selectedProviderId.value === id) {
    selectedProviderId.value = providers.value[0].id
    selectedModel.value = providers.value[0].models[0]
  }
}

// Fetch Models for current provider
const isFetchingModels = ref(false)
const fetchModels = async () => {
  if (!currentProvider.value.baseURL || !currentProvider.value.apiKey) {
    return alert('请先填写完整的 Base URL 和 API Key')
  }
  isFetchingModels.value = true
  try {
    const res = await (window as any).localTools.getModels({
      apiKey: currentProvider.value.apiKey,
      baseURL: currentProvider.value.baseURL
    })
    if (res.success && res.data) {
      const fetchedModels = res.data.map((m: any) => m.id)
      const combined = new Set([...currentProvider.value.models, ...fetchedModels])
      currentProvider.value.models = Array.from(combined).sort()
      if (!currentProvider.value.models.includes(selectedModel.value)) {
        selectedModel.value = currentProvider.value.models[0]
      }
      alert('获取模型列表成功！')
    } else {
      alert(`获取失败: ${res.error}`)
    }
  } catch (error: any) {
    alert(`请求出错: ${error.message}`)
  } finally {
    isFetchingModels.value = false
  }
}

// Session Management
interface ChatSession {
  id: string
  title: string
  messages: any[]
  updatedAt: number
}

const sessions = ref<ChatSession[]>([])
const currentSessionId = ref<string>('')

const saveSessionsToStorage = () => {
  localStorage.setItem('kuke_sessions', JSON.stringify(sessions.value))
}

const loadSessionsFromStorage = () => {
  const stored = localStorage.getItem('kuke_sessions')
  if (stored) {
    try {
      sessions.value = JSON.parse(stored)
    } catch (e) {
      sessions.value = []
    }
  }
  if (sessions.value.length === 0) {
    createNewSession()
  } else {
    // Load most recent
    sessions.value.sort((a, b) => b.updatedAt - a.updatedAt)
    switchSession(sessions.value[0].id)
  }
}

const createNewSession = () => {
  const newSession: ChatSession = {
    id: Date.now().toString(),
    title: '新对话',
    messages: [],
    updatedAt: Date.now()
  }
  sessions.value.unshift(newSession)
  switchSession(newSession.id)
  saveSessionsToStorage()
}

const switchSession = (id: string) => {
  const session = sessions.value.find(s => s.id === id)
  if (session) {
    currentSessionId.value = id
    messages.value = session.messages || []
    setTimeout(() => scrollToBottom(), 100)
  }
}

const deleteSession = (id: string, event: Event) => {
  event.stopPropagation()
  sessions.value = sessions.value.filter(s => s.id !== id)
  if (sessions.value.length === 0) {
    createNewSession()
  } else if (currentSessionId.value === id) {
    switchSession(sessions.value[0].id)
  }
  saveSessionsToStorage()
}

const updateCurrentSession = () => {
  const session = sessions.value.find(s => s.id === currentSessionId.value)
  if (session) {
    session.messages = messages.value
    session.updatedAt = Date.now()
    // Auto generate title based on first user message if title is default
    if (session.title === '新对话' && messages.value.length > 0) {
      const firstUserMsg = messages.value.find(m => m.role === 'user')
      if (firstUserMsg) {
        session.title = firstUserMsg.content.substring(0, 15) + (firstUserMsg.content.length > 15 ? '...' : '')
      }
    }
    // Re-sort
    sessions.value.sort((a, b) => b.updatedAt - a.updatedAt)
    saveSessionsToStorage()
  }
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
      { role: 'system', content: systemPrompt.value },
      ...messages.value.map(m => ({ role: m.role, content: m.content }))
    ]

    const response = await (window as any).localTools.chat(
      { apiKey: currentProvider.value.apiKey, baseURL: currentProvider.value.baseURL, model: selectedModel.value },
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
        { apiKey: currentProvider.value.apiKey, baseURL: currentProvider.value.baseURL, model: selectedModel.value },
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

    updateCurrentSession()

  } catch (error: any) {
    messages.value.push({ role: 'system', content: `❌ 请求失败: ${error.message}` })
  } finally {
    isLoading.value = false
    scrollToBottom()
  }
}

onMounted(() => {
  loadSessionsFromStorage()

  // Check if we're in ZTools environment
  if (!(window as any).localTools) {
    if (messages.value.length === 0) {
      messages.value.push({ 
        role: 'system', 
        content: '⚠️ 警告: 未检测到 `localTools`，请确保您在 ZTools 插件环境中运行，否则文件和终端工具将无法使用。您可以进行常规的聊天。'
      })
    }
  } else {
    if (messages.value.length === 0) {
      messages.value.push({ 
        role: 'assistant', 
        content: '你好！我是你的全能本地 AI Agent。我已经连接了本地系统，你可以让我帮你读取文件、管理项目或是执行终端命令！'
      })
    }
  }
  updateCurrentSession()
})
</script>

<template>
  <div class="flex h-screen w-full bg-slate-100 dark:bg-slate-900 font-sans text-slate-900 dark:text-slate-100 overflow-hidden relative bg-[url('https://images.unsplash.com/photo-1557672172-298e090bd0f1?q=80&w=2564&auto=format&fit=crop')] bg-cover bg-center">
    <!-- Backdrop Blur overlay for the whole app -->
    <div class="absolute inset-0 bg-white/40 dark:bg-slate-900/60 backdrop-blur-3xl"></div>
    
    <!-- Settings Overlay (Glassmorphism Dual Pane) -->
    <div v-if="showSettings" class="absolute inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center transition-opacity p-4 md:p-8">
      <div class="w-full max-w-4xl h-[85vh] bg-white/70 dark:bg-slate-800/70 backdrop-blur-2xl shadow-2xl flex rounded-3xl overflow-hidden animate-in zoom-in-95 duration-300 border border-white/40 dark:border-white/10">
        
        <!-- Left Pane: Provider List -->
        <div class="w-64 border-r border-white/30 dark:border-white/5 bg-white/30 dark:bg-slate-900/30 flex flex-col">
          <div class="p-5 border-b border-white/20 dark:border-white/5 shrink-0 flex justify-between items-center">
            <h3 class="font-bold text-lg drop-shadow-sm">模型供应商</h3>
            <button @click="addNewProvider" class="p-1.5 bg-blue-600/10 text-blue-600 hover:bg-blue-600/20 dark:bg-blue-400/10 dark:text-blue-400 dark:hover:bg-blue-400/20 rounded-lg transition" title="添加供应商">
              <Plus class="w-4 h-4" />
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
            <div v-for="p in providers" :key="p.id"
                 @click="selectedProviderId = p.id"
                 class="group relative flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all duration-200 border"
                 :class="[
                   selectedProviderId === p.id 
                     ? 'bg-white/80 dark:bg-slate-800/80 border-white/60 dark:border-white/10 shadow-sm text-blue-700 dark:text-blue-400 font-bold' 
                     : 'bg-transparent border-transparent hover:bg-white/50 dark:hover:bg-white/10 text-slate-600 dark:text-slate-400 font-medium'
                 ]">
              <span class="truncate pr-6">{{ p.name }}</span>
              <button @click.stop="removeProvider(p.id)" class="absolute right-3 opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-opacity">
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        <!-- Right Pane: Provider Details -->
        <div class="flex-1 flex flex-col relative bg-gradient-to-br from-white/40 to-white/10 dark:from-slate-800/40 dark:to-slate-900/10">
          <div class="absolute top-4 right-4 z-10">
            <button @click="showSettings = false" class="p-2 bg-white/50 dark:bg-slate-800/50 hover:bg-white/80 dark:hover:bg-slate-700/80 rounded-full transition shadow-sm border border-white/40 dark:border-white/10 backdrop-blur-md">
              <X class="w-5 h-5 text-slate-600 dark:text-slate-300" />
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-8 custom-scrollbar">
            <div class="max-w-xl mx-auto space-y-6">
              <div class="mb-8">
                <h2 class="text-2xl font-bold flex items-center gap-2 drop-shadow-sm">
                  <Settings class="w-6 h-6 text-blue-600 dark:text-blue-400" />
                  配置详情
                </h2>
                <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">管理您当前选中的供应商及其参数。</p>
              </div>

              <!-- Provider Details Form -->
              <div class="space-y-5 bg-white/40 dark:bg-slate-900/40 p-6 rounded-3xl border border-white/40 dark:border-white/5 shadow-sm backdrop-blur-xl">
                <div>
                  <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2 ml-1">供应商名称</label>
                  <input v-model="currentProvider.name" type="text" class="w-full px-4 py-3 bg-white/70 dark:bg-slate-800/70 border border-white/50 dark:border-white/10 rounded-2xl focus:ring-2 focus:ring-blue-500/50 outline-none transition shadow-inner backdrop-blur-md font-medium text-base" placeholder="例如：OpenAI" />
                </div>
                <div>
                  <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2 ml-1">API Base URL</label>
                  <input v-model="currentProvider.baseURL" type="text" class="w-full px-4 py-3 bg-white/70 dark:bg-slate-800/70 border border-white/50 dark:border-white/10 rounded-2xl focus:ring-2 focus:ring-blue-500/50 outline-none transition shadow-inner backdrop-blur-md font-mono text-sm" placeholder="https://api.openai.com/v1" />
                </div>
                <div>
                  <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2 ml-1">API Key</label>
                  <input v-model="currentProvider.apiKey" type="password" class="w-full px-4 py-3 bg-white/70 dark:bg-slate-800/70 border border-white/50 dark:border-white/10 rounded-2xl focus:ring-2 focus:ring-blue-500/50 outline-none transition shadow-inner backdrop-blur-md font-mono text-sm tracking-widest" placeholder="sk-..." />
                </div>
                
                <div class="pt-5 mt-3 border-t border-slate-200/50 dark:border-slate-700/50">
                  <div class="flex items-end gap-3">
                    <div class="flex-1 relative">
                      <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2 ml-1">默认使用模型</label>
                      <select v-model="selectedModel" class="w-full pl-4 pr-10 py-3 bg-white/70 dark:bg-slate-800/70 border border-white/50 dark:border-white/10 rounded-2xl focus:ring-2 focus:ring-blue-500/50 outline-none transition appearance-none shadow-inner backdrop-blur-md font-medium text-base text-blue-700 dark:text-blue-400">
                        <option v-for="model in currentProvider.models" :key="model" :value="model">{{ model }}</option>
                      </select>
                      <ChevronDown class="w-5 h-5 absolute right-4 top-9 text-blue-500 pointer-events-none" />
                    </div>
                    <button @click="fetchModels" :disabled="isFetchingModels" class="p-3.5 shrink-0 bg-white/80 dark:bg-slate-700/80 hover:bg-white dark:hover:bg-slate-600 rounded-2xl transition border border-white/50 dark:border-white/20 shadow-sm backdrop-blur-md flex items-center justify-center" title="一键获取可用模型列表">
                      <RefreshCw :class="['w-5 h-5 text-blue-600 dark:text-blue-400', isFetchingModels ? 'animate-spin' : '']" />
                    </button>
                  </div>
                  <div class="mt-4">
                    <label class="block text-[11px] font-bold uppercase tracking-wide mb-2 ml-1 text-slate-500 dark:text-slate-400">手动添加模型 (输入后回车)</label>
                    <input v-model="selectedModel" @keydown.enter.prevent="currentProvider.models.includes(selectedModel) ? null : currentProvider.models.push(selectedModel)" type="text" class="w-full px-4 py-2.5 bg-white/40 dark:bg-slate-800/40 border border-white/40 dark:border-white/10 rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none transition shadow-inner backdrop-blur-md text-sm font-medium" placeholder="手动输入模型名称..." />
                  </div>
                </div>

                <div class="pt-5 mt-3 border-t border-slate-200/50 dark:border-slate-700/50">
                  <label class="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-2 ml-1">System Prompt</label>
                  <textarea v-model="systemPrompt" rows="4" class="w-full px-4 py-3 bg-white/70 dark:bg-slate-800/70 border border-white/50 dark:border-white/10 rounded-2xl focus:ring-2 focus:ring-blue-500/50 outline-none transition resize-none shadow-inner backdrop-blur-md text-sm leading-relaxed font-medium"></textarea>
                </div>
              </div>
            </div>
          </div>

          <div class="p-6 border-t border-white/20 dark:border-white/5 bg-white/30 dark:bg-slate-900/30 backdrop-blur-xl shrink-0 flex justify-end">
            <button @click="saveConfig" class="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-8 py-3 rounded-2xl transition font-bold shadow-xl shadow-blue-600/30 backdrop-blur-md border border-blue-400/50 transform hover:-translate-y-0.5">
              <Check class="w-5 h-5" />
              保存并应用配置
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Sidebar -->
    <aside :class="[
      'relative z-20 bg-white/40 dark:bg-slate-900/40 backdrop-blur-2xl border-r border-white/20 dark:border-white/5 transition-all duration-300 flex flex-col shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)]',
      isSidebarOpen ? 'w-72' : 'w-0 border-r-0 opacity-0'
    ]">
      <div class="p-4 flex items-center justify-between border-b border-white/20 dark:border-white/5 h-16 shrink-0 whitespace-nowrap">
        <span class="font-bold text-lg tracking-tight pl-1 drop-shadow-sm" v-show="isSidebarOpen">会话历史</span>
        <button @click="createNewSession" class="p-2 hover:bg-white/60 dark:hover:bg-white/10 rounded-xl transition shadow-sm border border-transparent hover:border-white/20" title="新建对话">
          <Plus class="w-5 h-5" />
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-3 space-y-1.5 custom-scrollbar">
        <div v-for="session in sessions" :key="session.id"
             @click="switchSession(session.id)"
             :class="[
               'group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all duration-200 border',
               currentSessionId === session.id 
                 ? 'bg-white/80 dark:bg-slate-800/80 border-white/60 dark:border-white/10 shadow-sm text-blue-700 dark:text-blue-400 font-medium' 
                 : 'bg-transparent border-transparent hover:bg-white/40 dark:hover:bg-white/5 hover:border-white/20 dark:hover:border-white/5 text-slate-600 dark:text-slate-400'
             ]">
          <div class="flex items-center gap-3 overflow-hidden">
            <div :class="['p-1.5 rounded-lg', currentSessionId === session.id ? 'bg-blue-100 dark:bg-blue-900/50' : 'bg-slate-200/50 dark:bg-slate-800/50']">
              <MessageSquare class="w-4 h-4 shrink-0" />
            </div>
            <span class="text-sm truncate">{{ session.title }}</span>
          </div>
          <button @click="(e) => deleteSession(session.id, e)" class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-900/30 rounded-lg transition-all">
            <Trash2 class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <div class="flex-1 flex flex-col h-full relative min-w-0 z-10">
      <!-- Header -->
      <header class="h-16 shrink-0 border-b border-white/20 dark:border-white/5 bg-white/30 dark:bg-slate-900/30 backdrop-blur-2xl flex items-center justify-between px-4 sticky top-0 z-10 shadow-sm">
        <div class="flex items-center gap-3">
          <button @click="isSidebarOpen = !isSidebarOpen" class="p-2 hover:bg-white/50 dark:hover:bg-white/10 rounded-xl transition border border-transparent hover:border-white/20">
            <Menu class="w-5 h-5 text-slate-600 dark:text-slate-300" />
          </button>
          <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/30 border border-white/20">
            <Bot class="w-5 h-5 drop-shadow-md" />
          </div>
          <div class="flex flex-col justify-center">
            <h1 class="font-bold text-lg leading-none tracking-tight drop-shadow-sm">Kuke Agent</h1>
            <div class="flex items-center gap-1 mt-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-white/40 dark:bg-slate-800/40 px-1.5 py-0.5 rounded-md border border-white/20 dark:border-white/5">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              {{ currentProvider.name }} / {{ selectedModel }}
            </div>
          </div>
        </div>
        <button @click="showSettings = true" class="p-2 hover:bg-white/50 dark:hover:bg-white/10 rounded-xl transition border border-transparent hover:border-white/20 group shadow-sm bg-white/20 dark:bg-slate-800/20" title="设置">
          <Settings class="w-5 h-5 text-slate-600 dark:text-slate-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" />
        </button>
      </header>

      <!-- Chat Messages -->
      <div ref="chatContainer" class="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth custom-scrollbar">
        <div v-if="messages.length === 0" class="h-full flex flex-col items-center justify-center text-slate-400 dark:text-slate-500 opacity-60">
          <div class="w-20 h-20 bg-white/50 dark:bg-slate-800/50 rounded-3xl flex items-center justify-center shadow-xl shadow-black/5 border border-white/40 dark:border-white/10 backdrop-blur-xl mb-6 transform rotate-3">
            <Bot class="w-10 h-10 text-slate-400 transform -rotate-3" />
          </div>
          <p class="text-sm font-medium tracking-wide">尝试问我："读取当前目录的文件" 或 "帮我安装 tailwind"</p>
        </div>

        <div v-for="(msg, i) in messages" :key="i" class="flex items-start gap-4 animate-in slide-in-from-bottom-2 duration-300" :class="[msg.role === 'user' ? 'flex-row-reverse' : '']">
          <!-- Avatar -->
          <div class="w-10 h-10 rounded-2xl shrink-0 flex items-center justify-center shadow-md border border-white/20 dark:border-white/5 backdrop-blur-md"
               :class="[
                 msg.role === 'user' ? 'bg-gradient-to-br from-indigo-100 to-indigo-50 text-indigo-600 dark:from-indigo-900/80 dark:to-indigo-800/50 dark:text-indigo-300' :
                 msg.role === 'system' ? 'bg-gradient-to-br from-slate-100 to-slate-50 text-slate-500 dark:from-slate-800 dark:to-slate-900' :
                 'bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-blue-500/20'
               ]">
            <User v-if="msg.role === 'user'" class="w-5 h-5 drop-shadow-sm" />
            <Terminal v-else-if="msg.role === 'system'" class="w-5 h-5 drop-shadow-sm" />
            <Bot v-else class="w-5 h-5 drop-shadow-sm" />
          </div>

          <!-- Bubble -->
          <div class="max-w-[85%] md:max-w-[75%] rounded-3xl px-5 py-3.5 shadow-sm relative group backdrop-blur-md border border-white/20 dark:border-white/5"
               :class="[
                 msg.role === 'user' 
                   ? 'bg-blue-600/90 text-white rounded-tr-sm shadow-blue-500/10' 
                   : msg.role === 'system'
                     ? 'bg-white/40 dark:bg-slate-800/40 text-sm font-mono text-slate-600 dark:text-slate-300 rounded-tl-sm'
                     : 'bg-white/80 dark:bg-slate-800/80 rounded-tl-sm shadow-lg shadow-black/5'
               ]">
            <!-- Render Markdown -->
            <div v-if="msg.role !== 'user'" class="prose prose-sm md:prose-base dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-slate-900/80 prose-pre:backdrop-blur-md prose-pre:border prose-pre:border-white/10" v-html="md.render(msg.content)"></div>
            <div v-else class="whitespace-pre-wrap leading-relaxed">{{ msg.content }}</div>
          </div>
        </div>
        
        <!-- Loading State -->
        <div v-if="isLoading" class="flex items-start gap-4 animate-in fade-in duration-300">
          <div class="w-10 h-10 rounded-2xl shrink-0 bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-blue-500/20 border border-white/20 backdrop-blur-md">
            <Bot class="w-5 h-5 drop-shadow-sm" />
          </div>
          <div class="bg-white/80 dark:bg-slate-800/80 border border-white/20 dark:border-white/5 rounded-3xl rounded-tl-sm px-5 py-4 shadow-lg shadow-black/5 backdrop-blur-md flex items-center gap-3">
            <Loader2 class="w-5 h-5 animate-spin text-blue-600" />
            <span class="text-sm font-medium text-slate-500 bg-clip-text text-transparent bg-gradient-to-r from-slate-500 to-slate-400 animate-pulse">正在思考或执行操作...</span>
          </div>
        </div>
      </div>

      <!-- Input Area -->
      <div class="p-4 md:p-6 bg-white/30 dark:bg-slate-900/30 border-t border-white/20 dark:border-white/5 backdrop-blur-2xl">
        <form @submit.prevent="sendMessage" class="relative max-w-4xl mx-auto flex items-end gap-2 bg-white/60 dark:bg-slate-800/60 p-1.5 rounded-3xl border border-white/40 dark:border-white/10 shadow-lg shadow-black/5 backdrop-blur-xl focus-within:ring-4 focus-within:ring-blue-500/20 focus-within:border-blue-500/50 transition-all duration-300">
          <textarea 
            v-model="input"
            @keydown.enter.exact.prevent="sendMessage"
            rows="1"
            class="flex-1 max-h-32 min-h-[52px] bg-transparent resize-none py-3.5 px-4 outline-none overflow-y-auto font-medium"
            placeholder="问我任何事，或让我执行终端命令..."
            style="field-sizing: content;"
          ></textarea>
          <button 
            type="submit" 
            :disabled="!input.trim() || isLoading"
            class="shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-300 m-0.5"
            :class="[
              input.trim() && !isLoading 
                ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/30 transform hover:-translate-y-0.5' 
                : 'bg-slate-200/50 dark:bg-slate-700/50 text-slate-400 cursor-not-allowed'
            ]">
            <Send class="w-5 h-5 ml-0.5" />
          </button>
        </form>
        <p class="text-center text-xs font-medium text-slate-400 dark:text-slate-500 mt-3 drop-shadow-sm">
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
