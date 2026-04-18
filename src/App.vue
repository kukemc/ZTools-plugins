<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  Bot,
  Check,
  ChevronDown,
  Loader2,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Terminal,
  Trash2,
  User,
  X,
} from 'lucide-vue-next'
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  breaks: true,
  linkify: true,
})

type MessageRole = 'assistant' | 'user' | 'system'

interface ChatMessage {
  role: MessageRole
  content: string
  createdAt: number
}

interface Provider {
  id: string
  name: string
  baseURL: string
  apiKey: string
  models: string[]
}

interface ChatSession {
  id: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
}

const createMessage = (role: MessageRole, content: string): ChatMessage => ({
  role,
  content,
  createdAt: Date.now(),
})

const normalizeMessages = (value: unknown): ChatMessage[] => {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter(Boolean)
    .map((message, index) => {
      const current = message as Partial<ChatMessage>
      return {
        role: (current.role ?? 'system') as MessageRole,
        content: String(current.content ?? ''),
        createdAt: Number(current.createdAt ?? Date.now() + index),
      }
    })
}

const createDefaultProviders = (): Provider[] => [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    models: ['gpt-3.5-turbo', 'gpt-4o', 'gpt-4-turbo'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    models: ['deepseek-chat', 'deepseek-coder'],
  },
]

const loadProviders = (): Provider[] => {
  const stored = localStorage.getItem('kuke_providers')
  if (!stored) {
    return createDefaultProviders()
  }

  try {
    const parsed = JSON.parse(stored)
    return Array.isArray(parsed) && parsed.length ? parsed : createDefaultProviders()
  } catch {
    return createDefaultProviders()
  }
}

const messages = ref<ChatMessage[]>([])
const input = ref('')
const manualModelInput = ref('')
const isLoading = ref(false)
const showSettings = ref(false)
const isSidebarOpen = ref(true)
const isFetchingModels = ref(false)
const environmentReady = ref(false)
const chatContainer = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const notice = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
const providers = ref<Provider[]>(loadProviders())
const selectedProviderId = ref(localStorage.getItem('kuke_provider_id') || providers.value[0]?.id || 'openai')
const selectedModel = ref(localStorage.getItem('kuke_model') || providers.value[0]?.models[0] || '')
const systemPrompt = ref(
  localStorage.getItem('kuke_system') ||
    '你是一个全能的本地 AI Agent，可以调用本地工具（如读取文件、执行终端指令）。',
)
const sessions = ref<ChatSession[]>([])
const currentSessionId = ref('')

let noticeTimer: ReturnType<typeof setTimeout> | undefined

const currentProvider = computed(
  () => providers.value.find((provider) => provider.id === selectedProviderId.value) || providers.value[0],
)
const activeSession = computed(
  () => sessions.value.find((session) => session.id === currentSessionId.value) || null,
)
const sessionCount = computed(() => sessions.value.length)
const messageCount = computed(() => messages.value.filter((message) => message.role !== 'system').length)
const environmentLabel = computed(() => (environmentReady.value ? '插件环境已连接' : '浏览器预览模式'))
const composerPlaceholder = computed(() =>
  environmentReady.value ? '描述你的任务，或让 Agent 读取文件、执行命令…' : '输入问题或提示词…',
)

const suggestedPrompts = [
  {
    title: '分析当前项目结构',
    description: '扫描目录并总结关键入口、依赖与风险点。',
    prompt: '请先读取当前项目结构，并总结关键入口文件、依赖和潜在问题。',
    icon: Terminal,
  },
  {
    title: '优化本地插件体验',
    description: '聚焦界面布局、交互层级与配置流程。',
    prompt: '请审查当前插件界面，并给出可执行的 UI/UX 优化建议。',
    icon: Settings,
  },
  {
    title: '生成执行方案',
    description: '把复杂目标拆解成清晰步骤后再开始。',
    prompt: '请根据我的需求先生成分步骤执行方案，再开始实现。',
    icon: Bot,
  },
]

const tools = [
  {
    type: 'function',
    function: {
      name: 'readDir',
      description: '读取本地目录下的所有文件和文件夹列表',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: '目录的绝对路径或相对路径' },
        },
        required: ['dirPath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readFile',
      description: '读取本地文件的内容',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件的绝对路径或相对路径' },
        },
        required: ['filePath'],
      },
    },
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
          content: { type: 'string', description: '要写入的文件内容' },
        },
        required: ['filePath', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execCommand',
      description: '在终端执行系统指令，如 npm install、dir 等',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的终端指令' },
          cwd: { type: 'string', description: '执行指令的当前工作目录（可选）' },
        },
        required: ['command'],
      },
    },
  },
]

const showNotice = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
  notice.value = { text, type }
  if (noticeTimer) {
    clearTimeout(noticeTimer)
  }
  noticeTimer = setTimeout(() => {
    notice.value = null
  }, 3200)
}

const ensureProviderSelection = () => {
  if (!providers.value.length) {
    providers.value = createDefaultProviders()
  }

  if (!providers.value.some((provider) => provider.id === selectedProviderId.value)) {
    selectedProviderId.value = providers.value[0].id
  }

  const provider = providers.value.find((item) => item.id === selectedProviderId.value)
  if (!provider) {
    return
  }

  if (!provider.models.includes(selectedModel.value)) {
    selectedModel.value = provider.models[0] || ''
  }
}

const persistConfig = () => {
  localStorage.setItem('kuke_providers', JSON.stringify(providers.value))
  localStorage.setItem('kuke_provider_id', selectedProviderId.value)
  localStorage.setItem('kuke_model', selectedModel.value)
  localStorage.setItem('kuke_system', systemPrompt.value)
}

const saveConfig = () => {
  ensureProviderSelection()
  persistConfig()
  showSettings.value = false
  showNotice('模型配置已保存并应用。', 'success')
}

const focusComposer = () => {
  nextTick(() => {
    textareaRef.value?.focus()
  })
}

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

const formatTimestamp = (value: number) =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))

const formatSessionTime = (value: number) => {
  const date = new Date(value)
  const today = new Date()
  const isToday = date.toDateString() === today.toDateString()

  return new Intl.DateTimeFormat('zh-CN', isToday ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' }).format(date)
}

const roleLabel = (role: MessageRole) => {
  if (role === 'user') return '你'
  if (role === 'system') return '系统'
  return 'Kuke Agent'
}

const buildSessionTitle = (content: string) => {
  const summary = content.replace(/\s+/g, ' ').trim()
  if (!summary) {
    return '新对话'
  }
  return summary.length > 18 ? `${summary.slice(0, 18)}…` : summary
}

const saveSessionsToStorage = () => {
  localStorage.setItem('kuke_sessions', JSON.stringify(sessions.value))
}

const updateCurrentSession = () => {
  const session = sessions.value.find((item) => item.id === currentSessionId.value)
  if (!session) {
    return
  }

  session.messages = [...messages.value]
  session.updatedAt = Date.now()

  const firstUserMessage = messages.value.find((message) => message.role === 'user')
  if (firstUserMessage) {
    session.title = buildSessionTitle(firstUserMessage.content)
  }

  sessions.value.sort((a, b) => b.updatedAt - a.updatedAt)
  saveSessionsToStorage()
}

const switchSession = (id: string) => {
  const session = sessions.value.find((item) => item.id === id)
  if (!session) {
    return
  }

  currentSessionId.value = id
  messages.value = normalizeMessages(session.messages)

  if (window.innerWidth < 768) {
    isSidebarOpen.value = false
  }

  scrollToBottom()
}

const createNewSession = () => {
  const newSession: ChatSession = {
    id: Date.now().toString(),
    title: '新对话',
    messages: [],
    updatedAt: Date.now(),
  }

  sessions.value.unshift(newSession)
  switchSession(newSession.id)
  saveSessionsToStorage()
  focusComposer()
}

const deleteSession = (id: string, event: Event) => {
  event.stopPropagation()
  sessions.value = sessions.value.filter((session) => session.id !== id)

  if (!sessions.value.length) {
    createNewSession()
    return
  }

  if (currentSessionId.value === id) {
    switchSession(sessions.value[0].id)
  }

  saveSessionsToStorage()
}

const loadSessionsFromStorage = () => {
  const stored = localStorage.getItem('kuke_sessions')

  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      sessions.value = Array.isArray(parsed)
        ? parsed.map((session) => ({
            ...session,
            messages: normalizeMessages((session as Partial<ChatSession>).messages),
          }))
        : []
    } catch {
      sessions.value = []
    }
  }

  if (!sessions.value.length) {
    createNewSession()
    return
  }

  sessions.value.sort((a, b) => b.updatedAt - a.updatedAt)
  switchSession(sessions.value[0].id)
}

const selectProvider = (id: string) => {
  selectedProviderId.value = id
  ensureProviderSelection()
}

const addManualModel = () => {
  const nextModel = manualModelInput.value.trim()
  if (!nextModel) {
    return
  }

  if (!currentProvider.value.models.includes(nextModel)) {
    currentProvider.value.models = [...currentProvider.value.models, nextModel].sort()
    showNotice('已添加自定义模型。', 'success')
  }

  selectedModel.value = nextModel
  manualModelInput.value = ''
}

const addNewProvider = () => {
  const newId = `provider_${Date.now()}`
  providers.value.push({
    id: newId,
    name: '新供应商',
    baseURL: 'https://',
    apiKey: '',
    models: ['default-model'],
  })
  selectedProviderId.value = newId
  selectedModel.value = 'default-model'
  manualModelInput.value = ''
}

const removeProvider = (id: string) => {
  if (providers.value.length <= 1) {
    showNotice('至少保留一个供应商。', 'error')
    return
  }

  providers.value = providers.value.filter((provider) => provider.id !== id)

  if (selectedProviderId.value === id) {
    selectedProviderId.value = providers.value[0].id
    selectedModel.value = providers.value[0].models[0] || ''
  }
}

const fetchModels = async () => {
  if (!currentProvider.value.baseURL || !currentProvider.value.apiKey) {
    showNotice('请先填写完整的 Base URL 与 API Key。', 'error')
    return
  }

  const modelFetcher = (window as any).localTools?.getModels
  if (typeof modelFetcher !== 'function') {
    showNotice('当前环境不支持获取模型列表。', 'error')
    return
  }

  isFetchingModels.value = true
  try {
    const response = await modelFetcher({
      apiKey: currentProvider.value.apiKey,
      baseURL: currentProvider.value.baseURL,
    })

    if (!response.success || !response.data) {
      throw new Error(response.error || '未返回模型数据')
    }

    const fetchedModels = response.data.map((model: { id: string }) => model.id)
    currentProvider.value.models = Array.from(new Set([...currentProvider.value.models, ...fetchedModels])).sort()

    if (!currentProvider.value.models.includes(selectedModel.value)) {
      selectedModel.value = currentProvider.value.models[0] || ''
    }

    showNotice('模型列表已同步。', 'success')
  } catch (error) {
    const message = error instanceof Error ? error.message : '获取模型失败'
    showNotice(message, 'error')
  } finally {
    isFetchingModels.value = false
  }
}

const applyPrompt = (prompt: string) => {
  input.value = prompt
  focusComposer()
}

const sendMessage = async () => {
  const content = input.value.trim()
  if (!content || isLoading.value) {
    return
  }

  const chat = (window as any).localTools?.chat
  if (typeof chat !== 'function') {
    showNotice('未检测到插件运行环境，当前无法发起聊天请求。', 'error')
    return
  }

  messages.value.push(createMessage('user', content))
  input.value = ''
  isLoading.value = true
  updateCurrentSession()
  scrollToBottom()

  try {
    const apiMessages: any[] = [
      { role: 'system', content: systemPrompt.value },
      ...messages.value
        .filter((message) => message.role !== 'system')
        .map(({ role, content: messageContent }) => ({ role, content: messageContent })),
    ]

    const response = await chat(
      {
        apiKey: currentProvider.value.apiKey,
        baseURL: currentProvider.value.baseURL,
        model: selectedModel.value,
      },
      apiMessages,
      tools,
    )

    if (!response.success) {
      throw new Error(response.error || '请求失败')
    }

    const message = response.data

    if (message.tool_calls?.length) {
      apiMessages.push(message)

      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name
        const args = JSON.parse(toolCall.function.arguments || '{}')
        const availableTool = (window as any).localTools?.[functionName]

        messages.value.push(
          createMessage(
            'system',
            `工具调用：**${functionName}**\n\n\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``,
          ),
        )
        scrollToBottom()

        let toolResult = ''

        if (typeof availableTool === 'function') {
          if (functionName === 'execCommand') {
            const result = await availableTool(args.command, args.cwd)
            toolResult = JSON.stringify(result)
          } else {
            const result = await availableTool(...Object.values(args))
            toolResult = JSON.stringify(result)
          }
        } else {
          toolResult = '错误：当前环境未提供此本地工具。'
        }

        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolResult,
        })

        messages.value.push(
          createMessage(
            'system',
            `工具结果：\n\n\`\`\`json\n${toolResult.substring(0, 1000)}${toolResult.length > 1000 ? '...' : ''}\n\`\`\``,
          ),
        )
        scrollToBottom()
      }

      const secondResponse = await chat(
        {
          apiKey: currentProvider.value.apiKey,
          baseURL: currentProvider.value.baseURL,
          model: selectedModel.value,
        },
        apiMessages,
        null,
      )

      if (!secondResponse.success) {
        throw new Error(secondResponse.error || '工具调用后续响应失败')
      }

      messages.value.push(createMessage('assistant', secondResponse.data.content || ''))
    } else {
      messages.value.push(createMessage('assistant', message.content || ''))
    }

    updateCurrentSession()
  } catch (error) {
    const message = error instanceof Error ? error.message : '请求失败'
    messages.value.push(createMessage('system', `请求失败：${message}`))
    showNotice(message, 'error')
  } finally {
    isLoading.value = false
    scrollToBottom()
  }
}

onMounted(() => {
  ensureProviderSelection()
  loadSessionsFromStorage()
  environmentReady.value = Boolean((window as any).localTools?.chat)

  if (!environmentReady.value) {
    showNotice('当前处于浏览器预览模式，聊天与本地工具需在插件环境中使用。', 'info')
  }

  focusComposer()
})
</script>

<template>
  <div class="relative flex h-screen overflow-hidden p-3 sm:p-4">
    <div class="pointer-events-none absolute inset-0 overflow-hidden">
      <div class="ambient-orb ambient-orb-primary"></div>
      <div class="ambient-orb ambient-orb-secondary"></div>
      <div class="ambient-grid"></div>
    </div>

    <div class="app-shell">
      <button
        v-if="isSidebarOpen"
        type="button"
        class="absolute inset-0 z-20 bg-slate-950/30 backdrop-blur-sm md:hidden"
        aria-label="关闭侧边栏"
        @click="isSidebarOpen = false"
      ></button>

      <div
        v-if="showSettings"
        class="absolute inset-0 z-40 flex items-center justify-center p-3 sm:p-6"
      >
        <button
          type="button"
          class="absolute inset-0 bg-slate-950/45 backdrop-blur-md"
          aria-label="关闭设置"
          @click="showSettings = false"
        ></button>

        <section class="settings-shell">
          <aside class="settings-sidebar">
            <div class="settings-sidebar-header">
              <div>
                <p class="eyebrow">配置中心</p>
                <h2 class="text-lg font-semibold">模型供应商</h2>
              </div>
              <button type="button" class="ui-icon-btn" aria-label="添加供应商" @click="addNewProvider">
                <Plus class="h-4 w-4" />
              </button>
            </div>

            <div class="custom-scrollbar flex-1 space-y-2 overflow-y-auto px-3 pb-3">
              <div
                v-for="provider in providers"
                :key="provider.id"
                role="button"
                tabindex="0"
                class="provider-item"
                :class="{ 'provider-item-active': selectedProviderId === provider.id }"
                @click="selectProvider(provider.id)"
                @keydown.enter.prevent="selectProvider(provider.id)"
                @keydown.space.prevent="selectProvider(provider.id)"
              >
                <div class="min-w-0 flex-1 text-left">
                  <p class="truncate text-sm font-medium">{{ provider.name }}</p>
                  <p class="truncate text-xs text-[var(--text-muted)]">{{ provider.baseURL || '未配置地址' }}</p>
                </div>
                <button
                  type="button"
                  class="provider-item-delete"
                  aria-label="删除供应商"
                  @click.stop="removeProvider(provider.id)"
                >
                  <Trash2 class="h-4 w-4" />
                </button>
              </div>
            </div>
          </aside>

          <div class="flex min-h-0 flex-1 flex-col">
            <div class="settings-main-header">
              <div>
                <p class="eyebrow">细节设置</p>
                <h3 class="text-xl font-semibold">{{ currentProvider.name }}</h3>
                <p class="mt-1 text-sm text-[var(--text-muted)]">统一管理接口地址、鉴权与默认模型。</p>
              </div>
              <button type="button" class="ui-icon-btn" aria-label="关闭设置" @click="showSettings = false">
                <X class="h-4 w-4" />
              </button>
            </div>

            <div class="custom-scrollbar flex-1 overflow-y-auto p-4 sm:p-6">
              <div class="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                <section class="surface-panel p-5 sm:p-6">
                  <div class="space-y-5">
                    <div>
                      <label class="ui-label" for="provider-name">供应商名称</label>
                      <input id="provider-name" v-model="currentProvider.name" type="text" class="ui-input" placeholder="例如 OpenAI 或自定义网关" />
                    </div>

                    <div>
                      <label class="ui-label" for="provider-url">API Base URL</label>
                      <input id="provider-url" v-model="currentProvider.baseURL" type="text" class="ui-input ui-input-mono" placeholder="https://api.openai.com/v1" />
                    </div>

                    <div>
                      <label class="ui-label" for="provider-key">API Key</label>
                      <input id="provider-key" v-model="currentProvider.apiKey" type="password" class="ui-input ui-input-mono" placeholder="sk-..." />
                    </div>
                  </div>
                </section>

                <section class="surface-panel p-5 sm:p-6">
                  <div class="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <p class="eyebrow">模型策略</p>
                      <h4 class="text-base font-semibold">默认模型与同步</h4>
                    </div>
                    <button
                      type="button"
                      class="ui-icon-btn"
                      :disabled="isFetchingModels"
                      aria-label="获取模型列表"
                      @click="fetchModels"
                    >
                      <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': isFetchingModels }" />
                    </button>
                  </div>

                  <div class="space-y-4">
                    <div class="relative">
                      <label class="ui-label" for="default-model">默认使用模型</label>
                      <select id="default-model" v-model="selectedModel" class="ui-select">
                        <option v-for="model in currentProvider.models" :key="model" :value="model">{{ model }}</option>
                      </select>
                      <ChevronDown class="pointer-events-none absolute right-4 top-[2.85rem] h-4 w-4 text-[var(--text-muted)]" />
                    </div>

                    <div>
                      <label class="ui-label" for="manual-model">手动添加模型</label>
                      <div class="flex gap-3">
                        <input
                          id="manual-model"
                          v-model="manualModelInput"
                          type="text"
                          class="ui-input"
                          placeholder="输入模型名称后回车或点击添加"
                          @keydown.enter.prevent="addManualModel"
                        />
                        <button type="button" class="ui-btn-secondary px-4" @click="addManualModel">添加</button>
                      </div>
                    </div>
                  </div>
                </section>
              </div>

              <section class="surface-panel mt-4 p-5 sm:p-6">
                <div class="mb-4">
                  <p class="eyebrow">对话基线</p>
                  <h4 class="text-base font-semibold">System Prompt</h4>
                  <p class="mt-1 text-sm text-[var(--text-muted)]">用于定义 Agent 的默认角色、工具权限边界与输出风格。</p>
                </div>
                <textarea
                  v-model="systemPrompt"
                  rows="6"
                  class="ui-textarea"
                  placeholder="描述 Agent 的角色、目标与约束…"
                ></textarea>
              </section>
            </div>

            <div class="settings-footer">
              <button type="button" class="ui-btn-secondary px-5" @click="showSettings = false">取消</button>
              <button type="button" class="ui-btn-primary px-5" @click="saveConfig">
                <Check class="h-4 w-4" />
                保存配置
              </button>
            </div>
          </div>
        </section>
      </div>

      <aside
        :class="[
          'absolute inset-y-0 left-0 z-30 flex w-[304px] max-w-[88vw] flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface-elevated)]/95 backdrop-blur-2xl transition-all duration-300 md:static md:z-auto md:max-w-none',
          isSidebarOpen ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0 md:w-0 md:border-r-0',
        ]"
      >
        <div class="p-4">
          <section class="surface-panel p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="eyebrow">桌面 AI 工作台</p>
                <h1 class="text-xl font-semibold tracking-tight">Kuke Agent</h1>
                <p class="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                  面向本地工具协作的极简 Agent 界面，聚焦会话、执行与配置一致性。
                </p>
              </div>
              <div class="brand-mark">
                <Bot class="h-5 w-5" />
              </div>
            </div>

            <div class="mt-4 grid grid-cols-3 gap-3">
              <div class="stat-card">
                <span class="stat-label">会话</span>
                <strong class="stat-value">{{ sessionCount }}</strong>
              </div>
              <div class="stat-card">
                <span class="stat-label">消息</span>
                <strong class="stat-value">{{ messageCount }}</strong>
              </div>
              <div class="stat-card">
                <span class="stat-label">环境</span>
                <strong class="stat-value text-xs">{{ environmentReady ? '已连接' : '预览' }}</strong>
              </div>
            </div>

            <button type="button" class="ui-btn-primary mt-4 w-full" @click="createNewSession">
              <Plus class="h-4 w-4" />
              新建会话
            </button>
          </section>
        </div>

        <div class="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <div class="mb-3 flex items-center justify-between px-1">
            <p class="eyebrow">最近会话</p>
            <span class="text-xs text-[var(--text-subtle)]">{{ sessions.length }} 条</span>
          </div>

          <div class="custom-scrollbar flex-1 space-y-2 overflow-y-auto pr-1">
            <div
              v-for="session in sessions"
              :key="session.id"
              role="button"
              tabindex="0"
              class="session-item"
              :class="{ 'session-item-active': currentSessionId === session.id }"
              @click="switchSession(session.id)"
              @keydown.enter.prevent="switchSession(session.id)"
              @keydown.space.prevent="switchSession(session.id)"
            >
              <div class="flex min-w-0 items-start gap-3">
                <div class="session-item-icon">
                  <MessageSquare class="h-4 w-4" />
                </div>
                <div class="min-w-0 flex-1 text-left">
                  <p class="truncate text-sm font-medium">{{ session.title }}</p>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">
                    {{ session.messages.length }} 条消息 · {{ formatSessionTime(session.updatedAt) }}
                  </p>
                </div>
              </div>
              <button
                type="button"
                class="session-delete"
                aria-label="删除会话"
                @click="(event) => deleteSession(session.id, event)"
              >
                <Trash2 class="h-4 w-4" />
              </button>
            </div>
          </div>

          <section class="surface-muted mt-4 p-4">
            <p class="eyebrow">能力概览</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <span class="ui-chip">本地文件</span>
              <span class="ui-chip">终端命令</span>
              <span class="ui-chip">多模型</span>
              <span class="ui-chip">Markdown</span>
            </div>
          </section>
        </div>
      </aside>

      <main class="relative z-10 flex min-w-0 flex-1 flex-col">
        <header class="px-3 pb-3 pt-3 sm:px-4 sm:pb-4 sm:pt-4">
          <div class="surface-panel flex items-center justify-between gap-3 px-4 py-3">
            <div class="flex min-w-0 items-center gap-3">
              <button type="button" class="ui-icon-btn" aria-label="切换侧边栏" @click="isSidebarOpen = !isSidebarOpen">
                <Menu class="h-4 w-4" />
              </button>

              <div class="min-w-0">
                <p class="eyebrow">当前会话</p>
                <h2 class="truncate text-base font-semibold sm:text-lg">
                  {{ activeSession?.title || '新对话' }}
                </h2>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <span class="status-chip" :class="environmentReady ? 'status-chip-success' : 'status-chip-muted'">
                {{ environmentLabel }}
              </span>
              <span class="status-chip hidden lg:inline-flex">{{ currentProvider.name }}</span>
              <span class="status-chip hidden xl:inline-flex">{{ selectedModel }}</span>
              <button type="button" class="ui-icon-btn" aria-label="打开设置" @click="showSettings = true">
                <Settings class="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>

        <section class="relative min-h-0 flex-1 px-3 sm:px-4">
          <div ref="chatContainer" class="chat-scroll custom-scrollbar surface-panel min-h-0 flex-1 px-4 py-4 sm:px-6 sm:py-6">
            <div v-if="messages.length === 0" class="mx-auto flex min-h-full max-w-5xl items-center">
              <div class="grid w-full gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                <section class="surface-panel-strong p-6 sm:p-8">
                  <div class="inline-flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-white/70 px-3 py-1 text-xs font-medium text-[var(--text-muted)] dark:bg-white/10">
                    <Bot class="h-3.5 w-3.5" />
                    现代极简工作台
                  </div>
                  <h3 class="mt-5 max-w-2xl text-3xl font-semibold tracking-tight sm:text-4xl">
                    用统一、清晰且高信噪比的界面管理你的本地 AI Agent。
                  </h3>
                  <p class="mt-4 max-w-2xl text-sm leading-7 text-[var(--text-muted)] sm:text-base">
                    左侧聚焦会话与能力概览，右侧集中处理消息流、工具执行与模型配置，让复杂操作更易读、更稳、更可控。
                  </p>

                  <div class="mt-6 flex flex-wrap gap-2">
                    <span class="status-chip">{{ currentProvider.name }}</span>
                    <span class="status-chip">{{ selectedModel }}</span>
                    <span class="status-chip" :class="environmentReady ? 'status-chip-success' : 'status-chip-muted'">
                      {{ environmentLabel }}
                    </span>
                  </div>

                  <div class="mt-8 grid gap-3 sm:grid-cols-3">
                    <div class="feature-tile">
                      <Terminal class="h-5 w-5" />
                      <div>
                        <p class="font-medium">执行命令</p>
                        <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">支持终端指令与结果回传。</p>
                      </div>
                    </div>
                    <div class="feature-tile">
                      <MessageSquare class="h-5 w-5" />
                      <div>
                        <p class="font-medium">结构化会话</p>
                        <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">自动保留历史并按最近活动排序。</p>
                      </div>
                    </div>
                    <div class="feature-tile">
                      <Settings class="h-5 w-5" />
                      <div>
                        <p class="font-medium">集中配置</p>
                        <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">统一管理网关、模型与 Prompt。</p>
                      </div>
                    </div>
                  </div>
                </section>

                <section class="space-y-3">
                  <button
                    v-for="item in suggestedPrompts"
                    :key="item.title"
                    type="button"
                    class="prompt-card"
                    @click="applyPrompt(item.prompt)"
                  >
                    <component :is="item.icon" class="h-5 w-5 text-[var(--accent-strong)]" />
                    <div class="min-w-0 flex-1 text-left">
                      <p class="text-sm font-medium">{{ item.title }}</p>
                      <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">{{ item.description }}</p>
                    </div>
                  </button>
                </section>
              </div>
            </div>

            <div v-else class="mx-auto flex max-w-5xl flex-col gap-5">
              <article
                v-for="(message, index) in messages"
                :key="`${message.createdAt}-${index}`"
                class="flex gap-4"
                :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
              >
                <div
                  v-if="message.role !== 'user'"
                  class="message-avatar"
                  :class="message.role === 'assistant' ? 'message-avatar-assistant' : 'message-avatar-system'"
                >
                  <Bot v-if="message.role === 'assistant'" class="h-5 w-5" />
                  <Terminal v-else class="h-5 w-5" />
                </div>

                <div class="flex max-w-[86%] flex-col gap-2 sm:max-w-[74%]" :class="message.role === 'user' ? 'items-end' : 'items-start'">
                  <div class="message-meta" :class="message.role === 'user' ? 'text-right' : ''">
                    <span>{{ roleLabel(message.role) }}</span>
                    <span>·</span>
                    <span>{{ formatTimestamp(message.createdAt) }}</span>
                  </div>

                  <div
                    class="message-bubble"
                    :class="[
                      message.role === 'user'
                        ? 'message-bubble-user'
                        : message.role === 'system'
                          ? 'message-bubble-system'
                          : 'message-bubble-assistant',
                    ]"
                  >
                    <div
                      v-if="message.role !== 'user'"
                      class="markdown-body prose prose-sm max-w-none sm:prose-base"
                      v-html="md.render(message.content)"
                    ></div>
                    <div v-else class="whitespace-pre-wrap text-sm leading-7 sm:text-[15px]">{{ message.content }}</div>
                  </div>
                </div>

                <div v-if="message.role === 'user'" class="message-avatar message-avatar-user">
                  <User class="h-5 w-5" />
                </div>
              </article>

              <article v-if="isLoading" class="flex gap-4">
                <div class="message-avatar message-avatar-assistant">
                  <Bot class="h-5 w-5" />
                </div>
                <div class="flex max-w-[86%] flex-col gap-2 sm:max-w-[74%]">
                  <div class="message-meta">
                    <span>Kuke Agent</span>
                    <span>·</span>
                    <span>处理中</span>
                  </div>
                  <div class="message-bubble message-bubble-assistant flex items-center gap-3">
                    <Loader2 class="h-4 w-4 animate-spin text-[var(--accent-strong)]" />
                    <span class="text-sm text-[var(--text-muted)]">正在思考或执行工具链…</span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        <footer class="px-3 pb-3 pt-3 sm:px-4 sm:pb-4 sm:pt-4">
          <div class="surface-panel p-3 sm:p-4">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="status-chip">{{ currentProvider.name }}</span>
                <span class="status-chip">{{ selectedModel }}</span>
              </div>
              <p class="text-xs text-[var(--text-subtle)]">Enter 发送，Shift + Enter 换行</p>
            </div>

            <form class="composer-shell" @submit.prevent="sendMessage">
              <textarea
                ref="textareaRef"
                v-model="input"
                rows="1"
                class="ui-textarea min-h-[120px] border-0 bg-transparent px-0 py-0 shadow-none focus:ring-0"
                :placeholder="composerPlaceholder"
                style="field-sizing: content"
                @keydown.enter.exact.prevent="sendMessage"
              ></textarea>

              <div class="mt-4 flex items-center justify-between gap-3">
                <p class="max-w-2xl text-xs leading-6 text-[var(--text-subtle)]">
                  Agent 可以调用本地系统能力。执行命令前请确认路径、权限与潜在副作用。
                </p>
                <button
                  type="submit"
                  class="ui-btn-primary min-w-[108px]"
                  :disabled="!input.trim() || isLoading"
                >
                  <Send class="h-4 w-4" />
                  发送
                </button>
              </div>
            </form>
          </div>
        </footer>
      </main>

      <transition name="fade-slide">
        <div v-if="notice" class="notice-wrap">
          <div class="notice-card" :class="`notice-${notice.type}`">
            <span class="text-sm font-medium">{{ notice.text }}</span>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>
