import { contextBridge, ipcRenderer } from 'electron';

// Expose API to renderer process
contextBridge.exposeInMainWorld('pocketAgent', {
  // Chat
  send: (message: string) => ipcRenderer.invoke('agent:send', message),
  getHistory: (limit?: number) => ipcRenderer.invoke('agent:history', limit),
  getStats: () => ipcRenderer.invoke('agent:stats'),
  clearConversation: () => ipcRenderer.invoke('agent:clear'),

  // Facts
  listFacts: () => ipcRenderer.invoke('facts:list'),
  searchFacts: (query: string) => ipcRenderer.invoke('facts:search', query),
  getFactCategories: () => ipcRenderer.invoke('facts:categories'),

  // Cron
  getCronJobs: () => ipcRenderer.invoke('cron:list'),
  createCronJob: (name: string, schedule: string, prompt: string, channel: string) =>
    ipcRenderer.invoke('cron:create', name, schedule, prompt, channel),
  deleteCronJob: (name: string) => ipcRenderer.invoke('cron:delete', name),
  toggleCronJob: (name: string, enabled: boolean) => ipcRenderer.invoke('cron:toggle', name, enabled),
  runCronJob: (name: string) => ipcRenderer.invoke('cron:run', name),
  getCronHistory: (limit?: number) => ipcRenderer.invoke('cron:history', limit),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  deleteSetting: (key: string) => ipcRenderer.invoke('settings:delete', key),
  getSettingsSchema: (category?: string) => ipcRenderer.invoke('settings:schema', category),
  isFirstRun: () => ipcRenderer.invoke('settings:isFirstRun'),
  validateAnthropicKey: (key: string) => ipcRenderer.invoke('settings:validateAnthropic', key),
  validateOpenAIKey: (key: string) => ipcRenderer.invoke('settings:validateOpenAI', key),
  validateTelegramToken: (token: string) => ipcRenderer.invoke('settings:validateTelegram', token),
  restartAgent: () => ipcRenderer.invoke('agent:restart'),
  openSettings: () => ipcRenderer.invoke('app:openSettings'),
  startOAuth: () => ipcRenderer.invoke('auth:startOAuth'),
  completeOAuth: (code: string) => ipcRenderer.invoke('auth:completeOAuth', code),
  cancelOAuth: () => ipcRenderer.invoke('auth:cancelOAuth'),
  isOAuthPending: () => ipcRenderer.invoke('auth:isOAuthPending'),
});

// Type declarations for renderer
declare global {
  interface Window {
    pocketAgent: {
      send: (message: string) => Promise<{ success: boolean; response?: string; error?: string; tokensUsed?: number }>;
      getHistory: (limit?: number) => Promise<Array<{ role: string; content: string; timestamp: string }>>;
      getStats: () => Promise<{ messageCount: number; factCount: number; estimatedTokens: number } | null>;
      clearConversation: () => Promise<{ success: boolean }>;
      listFacts: () => Promise<Array<{ id: number; category: string; subject: string; content: string }>>;
      searchFacts: (query: string) => Promise<Array<{ category: string; subject: string; content: string }>>;
      getFactCategories: () => Promise<string[]>;
      getCronJobs: () => Promise<Array<{ id: number; name: string; schedule: string; prompt: string; channel: string; enabled: boolean }>>;
      createCronJob: (name: string, schedule: string, prompt: string, channel: string) => Promise<{ success: boolean }>;
      deleteCronJob: (name: string) => Promise<{ success: boolean }>;
      toggleCronJob: (name: string, enabled: boolean) => Promise<{ success: boolean }>;
      runCronJob: (name: string) => Promise<{ jobName: string; response: string; success: boolean; error?: string } | null>;
      getCronHistory: (limit?: number) => Promise<Array<{ jobName: string; response: string; success: boolean; timestamp: string }>>;
      // Settings
      getSettings: () => Promise<Record<string, string>>;
      getSetting: (key: string) => Promise<string>;
      setSetting: (key: string, value: string) => Promise<{ success: boolean }>;
      deleteSetting: (key: string) => Promise<{ success: boolean }>;
      getSettingsSchema: (category?: string) => Promise<Array<{ key: string; defaultValue: string; encrypted: boolean; category: string; label: string; description?: string; type: string }>>;
      isFirstRun: () => Promise<boolean>;
      validateAnthropicKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateOpenAIKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateTelegramToken: (token: string) => Promise<{ valid: boolean; error?: string; botInfo?: any }>;
      restartAgent: () => Promise<{ success: boolean }>;
      openSettings: () => Promise<void>;
      startOAuth: () => Promise<{ success: boolean; error?: string }>;
      completeOAuth: (code: string) => Promise<{ success: boolean; error?: string }>;
      cancelOAuth: () => Promise<{ success: boolean }>;
      isOAuthPending: () => Promise<boolean>;
    };
  }
}
