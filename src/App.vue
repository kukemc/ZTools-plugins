<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Bot,
  Check,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Terminal,
  Trash2,
  User,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Image as ImageIcon
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
const activeSettingsTab = ref('providers')
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
const hasMessages = computed(() => messages.value.length > 0)
const headerTitle = computed(() => (!isSidebarOpen.value && activeSession.value ? activeSession.value.title : 'Kuke Agent'))
const headerTitleKey = computed(() => (!isSidebarOpen.value && activeSession.value ? activeSession.value.id : 'brand'))

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

const formatSessionTime = (value: number) => {
  const date = new Date(value)
  const today = new Date()
  const isToday = date.toDateString() === today.toDateString()

  return new Intl.DateTimeFormat('zh-CN', isToday ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' }).format(date)
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

onBeforeUnmount(() => {
  if (noticeTimer) {
    clearTimeout(noticeTimer)
  }
})
</script>

<template>
  <div class="app-root relative flex h-screen w-screen overflow-hidden bg-white text-zinc-900 font-sans">
    <Transition name="overlay-fade">
      <div
        v-if="isSidebarOpen"
        class="motion-overlay absolute inset-0 z-20 bg-zinc-900/28 backdrop-blur-md md:hidden"
        @click="isSidebarOpen = false"
      ></div>
    </Transition>

    <!-- Sidebar -->
    <aside
      :class="[
        'sidebar-drawer absolute inset-y-0 left-0 z-30 flex w-[260px] flex-col border-r border-zinc-200 bg-zinc-50/75 md:static md:z-auto',
        isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:w-0 md:border-none'
      ]"
    >
      <div class="flex h-full w-[260px] flex-shrink-0 flex-col">
        <!-- Sidebar Header: New Chat & Toggle -->
        <div class="p-3 flex items-center gap-2">
          <button
            class="motion-surface flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-900"
            @click="createNewSession"
          >
            <Plus class="h-4 w-4" />
            新对话
          </button>
          <button
            class="motion-surface flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm hover:bg-zinc-50 hover:text-zinc-900"
            @click="isSidebarOpen = false"
            title="关闭侧边栏"
          >
            <PanelLeftClose class="h-4 w-4" />
          </button>
        </div>

        <!-- Search Bar -->
        <div class="px-3 pb-3">
          <div class="relative">
            <input
              type="text"
              placeholder="搜索会话..."
              class="motion-field h-8 w-full rounded-md border border-zinc-200 bg-white pl-3 pr-3 text-sm text-zinc-700 placeholder-zinc-400 focus:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-100"
            />
          </div>
        </div>

        <!-- Session List -->
        <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-1 custom-scrollbar">
          <TransitionGroup name="list-stagger" tag="div" class="space-y-1">
            <div
              v-for="session in sessions"
              :key="session.id"
              role="button"
              tabindex="0"
              class="motion-list-item group relative flex w-full cursor-pointer flex-col rounded-lg px-3 py-2.5 text-left"
              :class="currentSessionId === session.id ? 'bg-zinc-200/70 shadow-sm ring-1 ring-white/70' : 'hover:bg-zinc-200/40'"
              @click="switchSession(session.id)"
              @keydown.enter="switchSession(session.id)"
            >
              <div class="flex w-full items-center justify-between">
                <span class="truncate pr-4 text-sm font-medium text-zinc-800" :class="currentSessionId === session.id ? 'text-zinc-900' : ''">{{ session.title }}</span>
                <button
                  class="motion-icon absolute right-2 rounded-md p-1 text-zinc-400 opacity-0 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                  @click.stop="deleteSession(session.id, $event)"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </div>
              <span class="mt-0.5 text-[11px] text-zinc-400">{{ formatSessionTime(session.updatedAt) }}</span>
            </div>
          </TransitionGroup>
        </div>
        
        <!-- Settings Footer (Optional but good for config) -->
        <div class="p-3 border-t border-zinc-200/80">
          <button 
            class="motion-list-item flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900"
            @click="showSettings = true"
          >
            <Settings class="h-4 w-4" />
            设置
          </button>
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="relative flex-1 flex flex-col min-w-0 bg-white">
      <!-- Header -->
      <header class="h-14 flex items-center justify-between px-4 border-b border-zinc-100 flex-shrink-0 bg-white/80 backdrop-blur-md z-10 sticky top-0">
        <div class="flex items-center gap-3">
          <button
            v-if="!isSidebarOpen"
            class="motion-icon flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            @click="isSidebarOpen = true"
          >
            <PanelLeftOpen class="h-5 w-5" />
          </button>
          <Transition name="title-fade" mode="out-in">
            <div :key="headerTitleKey" class="header-title-wrap min-w-0">
              <h2 class="max-w-[200px] truncate text-sm font-semibold text-zinc-800 sm:max-w-xs">
                {{ headerTitle }}
              </h2>
            </div>
          </Transition>
        </div>
        <div class="flex items-center gap-2">
          <span class="motion-chip rounded-md border border-zinc-200/50 bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-600">{{ currentProvider.name }}</span>
          <span class="motion-chip rounded-md border border-zinc-200/50 bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-600">{{ selectedModel }}</span>
        </div>
      </header>

      <!-- Chat Area -->
      <div ref="chatContainer" class="flex-1 overflow-y-auto px-4 py-6 sm:px-6 custom-scrollbar scroll-smooth">
        <div class="max-w-3xl mx-auto flex flex-col h-full">
          <Transition name="content-switch" mode="out-in">
            <div :key="hasMessages ? 'messages' : 'empty'" class="flex min-h-0 flex-1 flex-col">
              <!-- Empty State -->
              <div v-if="!hasMessages" class="empty-state flex flex-1 flex-col items-center justify-center text-zinc-400">
                <div class="empty-state-icon mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50 shadow-sm">
                  <Bot class="h-6 w-6 text-zinc-400" />
                </div>
                <p class="text-[15px] font-medium text-zinc-500">有什么我可以帮您的？</p>
              </div>

              <!-- Message List -->
              <div v-else class="flex flex-col gap-8 pb-4">
                <TransitionGroup name="message-stack" tag="div" class="flex flex-col gap-8">
                  <article
                    v-for="(message, index) in messages"
                    :key="`${message.createdAt}-${message.role}-${index}`"
                    class="message-row group flex gap-4"
                    :class="message.role === 'user' ? 'flex-row-reverse' : 'flex-row'"
                  >
                    <!-- Avatar -->
                    <div
                      class="message-avatar-shell mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full shadow-sm"
                      :class="[
                        message.role === 'user' ? 'bg-zinc-100 text-zinc-600 border border-zinc-200/50' : 
                        message.role === 'system' ? 'bg-amber-50 text-amber-500 border border-amber-200/50' : 'bg-zinc-900 text-zinc-50'
                      ]"
                    >
                      <User v-if="message.role === 'user'" class="h-4 w-4" />
                      <Terminal v-else-if="message.role === 'system'" class="h-4 w-4" />
                      <Bot v-else class="h-4 w-4" />
                    </div>

                    <!-- Content -->
                    <div class="flex max-w-[85%] flex-col gap-1 sm:max-w-[80%]" :class="message.role === 'user' ? 'items-end' : 'items-start'">
                      <div
                        class="message-bubble-shell text-[15px] leading-relaxed"
                        :class="[
                          message.role === 'user'
                            ? 'rounded-2xl rounded-tr-sm bg-zinc-100 px-4 py-2.5 text-zinc-900'
                            : message.role === 'system'
                              ? 'rounded-2xl rounded-tl-sm border border-amber-100 bg-amber-50/30 px-4 py-2.5 font-mono text-xs text-zinc-600'
                              : 'py-1 text-zinc-800'
                        ]"
                      >
                        <div
                          v-if="message.role !== 'user'"
                          class="markdown-body prose prose-sm prose-zinc max-w-none"
                          v-html="md.render(message.content)"
                        ></div>
                        <div v-else class="whitespace-pre-wrap">{{ message.content }}</div>
                      </div>
                    </div>
                  </article>
                </TransitionGroup>

                <Transition name="message-appear">
                  <article v-if="isLoading" class="loading-row flex gap-4">
                    <div class="message-avatar-shell mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-zinc-900 text-zinc-50 shadow-sm">
                      <Bot class="h-4 w-4" />
                    </div>
                    <div class="flex items-center gap-2 py-2.5 text-zinc-800">
                      <span class="loading-dot"></span>
                      <span class="loading-dot" style="animation-delay: 0.14s"></span>
                      <span class="loading-dot" style="animation-delay: 0.28s"></span>
                    </div>
                  </article>
                </Transition>
              </div>
            </div>
          </Transition>
        </div>
      </div>

      <!-- Composer -->
      <div class="px-4 pb-6 pt-2 bg-gradient-to-t from-white via-white to-transparent">
        <div class="max-w-3xl mx-auto relative">
          <form
            class="motion-surface relative flex items-end overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50/50 shadow-sm focus-within:border-zinc-300 focus-within:bg-white focus-within:ring-4 focus-within:ring-zinc-100"
            @submit.prevent="sendMessage"
          >
            <textarea
              ref="textareaRef"
              v-model="input"
              rows="1"
              class="w-full max-h-[200px] min-h-[52px] py-3.5 pl-4 pr-24 bg-transparent border-0 focus:ring-0 resize-none text-[15px] leading-relaxed placeholder-zinc-400 custom-scrollbar"
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              @keydown.enter.exact.prevent="sendMessage"
              style="field-sizing: content;"
            ></textarea>
            
            <div class="absolute right-2 bottom-2 flex items-center gap-1.5">
              <button
                type="button"
                class="motion-icon rounded-xl p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                title="上传图片"
              >
                <ImageIcon class="h-5 w-5" />
              </button>
              <button
                type="submit"
                class="motion-surface flex items-center justify-center rounded-xl p-2 shadow-sm"
                :class="input.trim() && !isLoading ? 'bg-zinc-900 text-zinc-50 hover:bg-zinc-800' : 'bg-zinc-200 text-zinc-400 cursor-not-allowed'"
                :disabled="!input.trim() || isLoading"
              >
                <Send class="h-4 w-4" />
              </button>
            </div>
          </form>
          <div class="text-center mt-2.5">
            <span class="text-[11px] text-zinc-400">Agent 可以调用本地系统能力。执行命令前请确认路径、权限与潜在副作用。</span>
          </div>
        </div>
      </div>
    </main>

    <!-- Settings Modal -->
    <Transition name="modal-fade">
      <div
        v-if="showSettings"
        class="settings-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/24 p-4 backdrop-blur-md"
        @click.self="showSettings = false"
      >
        <div class="settings-modal-panel flex h-[600px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-100 bg-white shadow-2xl">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-4 border-b border-zinc-100 flex-shrink-0">
          <h3 class="text-base font-semibold text-zinc-800">设置</h3>
          <button @click="showSettings = false" class="motion-icon rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
            <X class="h-5 w-5" />
          </button>
        </div>
        
        <!-- Body -->
        <div class="flex flex-1 overflow-hidden">
          <!-- Settings Sidebar -->
          <div class="w-[180px] border-r border-zinc-100 bg-zinc-50/30 p-3 flex flex-col gap-1">
            <button 
              class="motion-list-item w-full rounded-lg px-3 py-2 text-left text-sm font-medium"
              :class="activeSettingsTab === 'general' ? 'bg-white shadow-sm text-zinc-900 border border-zinc-200' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'"
              @click="activeSettingsTab = 'general'"
            >
              通用设置
            </button>
            <button 
              class="motion-list-item w-full rounded-lg px-3 py-2 text-left text-sm font-medium"
              :class="activeSettingsTab === 'providers' ? 'bg-white shadow-sm text-zinc-900 border border-zinc-200' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'"
              @click="activeSettingsTab = 'providers'"
            >
              模型供应商
            </button>
          </div>

          <!-- Settings Content -->
          <div class="flex-1 flex flex-col bg-white overflow-hidden">
            <Transition name="tab-panel" mode="out-in">
              <!-- General Tab -->
              <div v-if="activeSettingsTab === 'general'" key="general" class="p-6 flex-1 overflow-y-auto custom-scrollbar">
                <h4 class="text-sm font-semibold text-zinc-800 mb-4">基础配置</h4>
                <div>
                  <label class="block text-sm font-medium text-zinc-700 mb-1.5">System Prompt</label>
                  <p class="text-xs text-zinc-500 mb-3">用于定义 Agent 的默认角色、工具权限边界与输出风格。</p>
                  <textarea v-model="systemPrompt" rows="6" class="motion-field custom-scrollbar w-full resize-none rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-800 focus:bg-white focus:border-zinc-400 focus:outline-none focus:ring-4 focus:ring-zinc-100"></textarea>
                </div>
              </div>

              <!-- Providers Tab -->
              <div v-else key="providers" class="flex flex-1 overflow-hidden">
                <!-- Providers List -->
                <div class="flex w-[220px] flex-col border-r border-zinc-100 bg-zinc-50/50">
                  <div class="flex items-center justify-between border-b border-zinc-100 p-3">
                    <span class="text-xs font-semibold uppercase tracking-wider text-zinc-500">供应商列表</span>
                    <button @click="addNewProvider" class="motion-icon rounded-md p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900" title="添加供应商">
                      <Plus class="h-4 w-4" />
                    </button>
                  </div>
                  <div class="custom-scrollbar flex-1 overflow-y-auto p-2 space-y-1">
                    <TransitionGroup name="list-stagger" tag="div" class="space-y-1">
                      <div
                        v-for="p in providers"
                        :key="p.id"
                        role="button"
                        tabindex="0"
                        class="motion-list-item group flex w-full cursor-pointer items-center justify-between rounded-lg border border-transparent px-3 py-2.5 text-left text-sm"
                        :class="selectedProviderId === p.id ? 'border-zinc-200 bg-white font-medium text-zinc-900 shadow-sm' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'"
                        @click="selectProvider(p.id)"
                        @keydown.enter="selectProvider(p.id)"
                      >
                        <span class="truncate pr-2">{{ p.name }}</span>
                        <button
                          class="motion-icon rounded-md p-1 text-zinc-400 opacity-0 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100"
                          @click.stop="removeProvider(p.id)"
                        >
                          <Trash2 class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </TransitionGroup>
                  </div>
                </div>

                <!-- Provider Editor -->
                <div class="custom-scrollbar flex-1 overflow-y-auto p-6">
                  <div v-if="currentProvider" class="max-w-md space-y-5">
                    <div>
                      <label class="block text-sm font-medium text-zinc-700 mb-1.5">供应商名称</label>
                      <input v-model="currentProvider.name" type="text" class="motion-field h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-800 focus:bg-white focus:border-zinc-400 focus:outline-none focus:ring-4 focus:ring-zinc-100" />
                    </div>
                    
                    <div>
                      <label class="block text-sm font-medium text-zinc-700 mb-1.5">API Base URL</label>
                      <input v-model="currentProvider.baseURL" type="text" class="motion-field h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm font-mono text-zinc-800 focus:bg-white focus:border-zinc-400 focus:outline-none focus:ring-4 focus:ring-zinc-100" />
                    </div>
                    
                    <div>
                      <label class="block text-sm font-medium text-zinc-700 mb-1.5">API Key</label>
                      <input v-model="currentProvider.apiKey" type="password" class="motion-field h-9 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm font-mono text-zinc-800 focus:bg-white focus:border-zinc-400 focus:outline-none focus:ring-4 focus:ring-zinc-100" />
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-zinc-700 mb-1.5">默认模型</label>
                      <div class="flex gap-2">
                        <select v-model="selectedModel" class="motion-field h-9 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-800 focus:bg-white focus:border-zinc-400 focus:outline-none focus:ring-4 focus:ring-zinc-100">
                          <option v-for="m in currentProvider.models" :key="m" :value="m">{{ m }}</option>
                        </select>
                        <button @click="fetchModels" :disabled="isFetchingModels" class="motion-surface flex h-9 items-center justify-center rounded-lg border border-zinc-200 px-3 text-zinc-600 shadow-sm hover:bg-zinc-50 hover:text-zinc-900" title="同步模型">
                          <RefreshCw class="h-4 w-4" :class="{ 'spin-gentle': isFetchingModels }" />
                        </button>
                      </div>
                    </div>

                    <div>
                      <label class="block text-sm font-medium text-zinc-700 mb-1.5">手动添加模型</label>
                      <div class="flex gap-2">
                        <input
                          v-model="manualModelInput"
                          type="text"
                          class="motion-field h-9 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm text-zinc-800 focus:bg-white focus:border-zinc-400 focus:outline-none focus:ring-4 focus:ring-zinc-100"
                          placeholder="输入模型名称"
                          @keydown.enter.prevent="addManualModel"
                        />
                        <button type="button" class="motion-surface h-9 rounded-lg border border-zinc-200 px-4 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 hover:text-zinc-900" @click="addManualModel">
                          添加
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Transition>
          </div>
        </div>

        <div class="px-5 py-4 border-t border-zinc-100 bg-zinc-50 flex justify-end gap-3 flex-shrink-0">
          <button type="button" @click="showSettings = false" class="motion-list-item rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-200/50 hover:text-zinc-900">取消</button>
          <button type="button" @click="saveConfig" class="motion-surface flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 shadow-sm hover:bg-zinc-800">
            <Check class="h-4 w-4" />
            保存配置
          </button>
        </div>
      </div>
      </div>
    </Transition>

    <!-- Notice -->
    <Transition name="notice-float">
      <div v-if="notice" class="fixed top-4 right-4 z-50">
        <div class="notice-card-glass flex items-center gap-2 rounded-xl border px-4 py-3 shadow-lg"
             :class="notice.type === 'success' ? 'border-emerald-200 text-emerald-800 bg-emerald-50' : notice.type === 'error' ? 'border-red-200 text-red-800 bg-red-50' : 'border-blue-200 text-blue-800 bg-blue-50'">
          <span class="text-sm font-medium">{{ notice.text }}</span>
        </div>
      </div>
    </Transition>

  </div>
</template>
