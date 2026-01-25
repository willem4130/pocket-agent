import { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, Notification } from 'electron';
import path from 'path';
import { AgentManager } from '../agent';
import { MemoryManager } from '../memory';
import { createScheduler, getScheduler, CronScheduler } from '../scheduler';
import { createTelegramBot, getTelegramBot, TelegramBot } from '../channels/telegram';
import { SettingsManager } from '../settings';

let tray: Tray | null = null;
let memory: MemoryManager | null = null;
let scheduler: CronScheduler | null = null;
let telegramBot: TelegramBot | null = null;
let chatWindow: BrowserWindow | null = null;
let cronWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;

// ============ Tray Setup ============

async function createTray(): Promise<void> {
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = createDefaultIcon();
    }
  } catch {
    icon = createDefaultIcon();
  }

  tray = new Tray(icon);
  tray.setToolTip('Pocket Agent');

  // Double-click opens chat
  tray.on('double-click', () => {
    openChatWindow();
  });

  updateTrayMenu();
}

function createDefaultIcon(): Electron.NativeImage {
  // Create a simple 16x16 icon
  return nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0x80));
}

function updateTrayMenu(): void {
  if (!tray) return;

  const stats = AgentManager.getStats();
  const schedulerStats = scheduler?.getStats();
  const telegramEnabled = SettingsManager.getBoolean('telegram.enabled');

  const statusText = AgentManager.isInitialized()
    ? `Messages: ${stats?.messageCount || 0} | Facts: ${stats?.factCount || 0}`
    : 'Not initialized';

  const telegramStatus = telegramEnabled
    ? (getTelegramBot()?.isRunning ? '✓ Connected' : '✗ Disconnected')
    : 'Disabled';

  const cronStatus = schedulerStats
    ? `${schedulerStats.activeJobs} active`
    : 'Not running';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Pocket Agent',
      enabled: false,
      icon: createDefaultIcon(),
    },
    { type: 'separator' },
    {
      label: 'Open Chat',
      click: () => openChatWindow(),
      accelerator: 'CmdOrCtrl+Shift+P',
    },
    { type: 'separator' },
    {
      label: statusText,
      enabled: false,
    },
    {
      label: `Telegram: ${telegramStatus}`,
      enabled: false,
    },
    {
      label: `Cron Jobs: ${cronStatus}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Cron Jobs',
      submenu: buildCronSubmenu(),
    },
    {
      label: 'Settings...',
      click: () => openSettingsWindow(),
      accelerator: 'CmdOrCtrl+,',
    },
    { type: 'separator' },
    {
      label: 'Clear Conversation',
      click: () => {
        AgentManager.clearConversation();
        updateTrayMenu();
        showNotification('Pocket Agent', 'Conversation cleared');
      },
    },
    {
      label: 'Restart Agent',
      click: async () => {
        await restartAgent();
        showNotification('Pocket Agent', 'Agent restarted');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
      accelerator: 'CmdOrCtrl+Q',
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function buildCronSubmenu(): Electron.MenuItemConstructorOptions[] {
  const jobs = scheduler?.getAllJobs() || [];

  if (jobs.length === 0) {
    return [
      { label: 'No jobs configured', enabled: false },
      { type: 'separator' },
      { label: 'Manage Jobs...', click: () => openCronWindow() },
    ];
  }

  const items: Electron.MenuItemConstructorOptions[] = jobs.map(job => ({
    label: `${job.enabled ? '✓' : '✗'} ${job.name}`,
    sublabel: job.schedule,
    submenu: [
      {
        label: job.enabled ? 'Disable' : 'Enable',
        click: () => {
          scheduler?.setJobEnabled(job.name, !job.enabled);
          updateTrayMenu();
        },
      },
      {
        label: 'Run Now',
        click: async () => {
          const result = await scheduler?.runJobNow(job.name);
          if (result) {
            showNotification(`Job: ${job.name}`, result.success ? 'Completed' : `Failed: ${result.error}`);
          }
        },
      },
      {
        label: 'Delete',
        click: () => {
          scheduler?.deleteJob(job.name);
          updateTrayMenu();
        },
      },
    ],
  }));

  items.push({ type: 'separator' });
  items.push({ label: 'Manage Jobs...', click: () => openCronWindow() });

  return items;
}

// ============ Windows ============

function openChatWindow(): void {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return;
  }

  chatWindow = new BrowserWindow({
    width: 600,
    height: 800,
    title: 'Pocket Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  chatWindow.loadFile(path.join(__dirname, '../../ui/chat.html'));

  chatWindow.once('ready-to-show', () => {
    chatWindow?.show();
  });

  chatWindow.on('closed', () => {
    chatWindow = null;
  });
}

function openCronWindow(): void {
  if (cronWindow && !cronWindow.isDestroyed()) {
    cronWindow.focus();
    return;
  }

  cronWindow = new BrowserWindow({
    width: 700,
    height: 500,
    title: 'Cron Jobs - Pocket Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  cronWindow.loadFile(path.join(__dirname, '../../ui/cron.html'));

  cronWindow.once('ready-to-show', () => {
    cronWindow?.show();
  });

  cronWindow.on('closed', () => {
    cronWindow = null;
  });
}

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 700,
    height: 600,
    title: 'Settings - Pocket Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  settingsWindow.loadFile(path.join(__dirname, '../../ui/settings.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function openSetupWindow(): void {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 550,
    height: 500,
    title: 'Welcome to Pocket Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    resizable: false,
    minimizable: false,
    closable: true,
  });

  setupWindow.loadFile(path.join(__dirname, '../../ui/setup.html'));

  setupWindow.once('ready-to-show', () => {
    setupWindow?.show();
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
    // After setup is closed, check if we can initialize
    if (SettingsManager.hasRequiredKeys() && !AgentManager.isInitialized()) {
      initializeAgent();
    }
  });
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ============ IPC Handlers ============

function setupIPC(): void {
  // Chat messages
  ipcMain.handle('agent:send', async (_, message: string) => {
    try {
      const result = await AgentManager.processMessage(message, 'desktop');
      updateTrayMenu();
      return { success: true, response: result.response, tokensUsed: result.tokensUsed };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    }
  });

  ipcMain.handle('agent:history', async (_, limit: number = 50) => {
    return AgentManager.getRecentMessages(limit);
  });

  ipcMain.handle('agent:stats', async () => {
    return AgentManager.getStats();
  });

  ipcMain.handle('agent:clear', async () => {
    AgentManager.clearConversation();
    updateTrayMenu();
    return { success: true };
  });

  // Facts
  ipcMain.handle('facts:list', async () => {
    return AgentManager.getAllFacts();
  });

  ipcMain.handle('facts:search', async (_, query: string) => {
    return AgentManager.searchFacts(query);
  });

  ipcMain.handle('facts:categories', async () => {
    return memory?.getFactCategories() || [];
  });

  // Cron jobs
  ipcMain.handle('cron:list', async () => {
    return scheduler?.getAllJobs() || [];
  });

  ipcMain.handle('cron:create', async (_, name: string, schedule: string, prompt: string, channel: string) => {
    const success = await scheduler?.createJob(name, schedule, prompt, channel);
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:delete', async (_, name: string) => {
    const success = scheduler?.deleteJob(name);
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:toggle', async (_, name: string, enabled: boolean) => {
    const success = scheduler?.setJobEnabled(name, enabled);
    updateTrayMenu();
    return { success };
  });

  ipcMain.handle('cron:run', async (_, name: string) => {
    const result = await scheduler?.runJobNow(name);
    return result;
  });

  ipcMain.handle('cron:history', async (_, limit: number = 20) => {
    return scheduler?.getHistory(limit) || [];
  });

  // Settings
  ipcMain.handle('settings:getAll', async () => {
    return SettingsManager.getAll();
  });

  ipcMain.handle('settings:get', async (_, key: string) => {
    return SettingsManager.get(key);
  });

  ipcMain.handle('settings:set', async (_, key: string, value: string) => {
    try {
      SettingsManager.set(key, value);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('settings:delete', async (_, key: string) => {
    const success = SettingsManager.delete(key);
    return { success };
  });

  ipcMain.handle('settings:schema', async (_, category?: string) => {
    return SettingsManager.getSchema(category);
  });

  ipcMain.handle('settings:isFirstRun', async () => {
    return SettingsManager.isFirstRun();
  });

  ipcMain.handle('settings:validateAnthropic', async (_, key: string) => {
    return SettingsManager.validateAnthropicKey(key);
  });

  ipcMain.handle('settings:validateOpenAI', async (_, key: string) => {
    return SettingsManager.validateOpenAIKey(key);
  });

  ipcMain.handle('settings:validateTelegram', async (_, token: string) => {
    return SettingsManager.validateTelegramToken(token);
  });

  ipcMain.handle('agent:restart', async () => {
    try {
      await restartAgent();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('app:openSettings', async () => {
    openSettingsWindow();
  });

  // OAuth flow for Claude subscription
  ipcMain.handle('auth:startOAuth', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.startFlow();
  });

  ipcMain.handle('auth:completeOAuth', async (_, code: string) => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.completeWithCode(code);
  });

  ipcMain.handle('auth:cancelOAuth', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    ClaudeOAuth.cancelFlow();
    return { success: true };
  });

  ipcMain.handle('auth:isOAuthPending', async () => {
    const { ClaudeOAuth } = await import('../auth/oauth');
    return ClaudeOAuth.isPending();
  });
}

// ============ Agent Lifecycle ============

async function initializeAgent(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'pocket-agent.db');

  // Check if we have required API keys
  if (!SettingsManager.hasRequiredKeys()) {
    console.log('[Main] No API keys configured, skipping agent initialization');
    return;
  }

  // Project root (where CLAUDE.md lives)
  const projectRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '../..');

  // Initialize memory (if not already done)
  if (!memory) {
    memory = new MemoryManager(dbPath);
  }

  // Initialize embeddings if OpenAI key is available
  const openaiKey = SettingsManager.get('openai.apiKey');
  if (openaiKey) {
    memory.initializeEmbeddings(openaiKey);
    console.log('[Main] Embeddings enabled with OpenAI');
  } else {
    console.log('[Main] Embeddings disabled (no OpenAI API key)');
  }

  // Build tools config from settings
  const toolsConfig = {
    mcpServers: {},
    computerUse: {
      enabled: false,
      dockerized: true,
      displaySize: { width: 1920, height: 1080 },
    },
    browser: {
      enabled: SettingsManager.getBoolean('browser.enabled'),
      cdpUrl: SettingsManager.get('browser.cdpUrl') || 'http://localhost:9222',
    },
  };

  // Initialize agent with tools config
  AgentManager.initialize({
    memory,
    projectRoot,
    model: SettingsManager.get('agent.model'),
    tools: toolsConfig,
  });

  // Initialize scheduler
  if (SettingsManager.getBoolean('scheduler.enabled')) {
    scheduler = createScheduler();
    await scheduler.initialize(memory);

    // Set notification handler for scheduler
    scheduler.setNotificationHandler((title: string, body: string) => {
      showNotification(title, body);
    });
  }

  // Initialize Telegram
  const telegramEnabled = SettingsManager.getBoolean('telegram.enabled');
  const telegramToken = SettingsManager.get('telegram.botToken');

  if (telegramEnabled && telegramToken) {
    try {
      telegramBot = createTelegramBot();
      await telegramBot.start();

      if (scheduler) {
        scheduler.setTelegramBot(telegramBot);
      }

      console.log('[Main] Telegram started');
    } catch (error) {
      console.error('[Main] Telegram failed:', error);
    }
  }

  console.log('[Main] Pocket Agent initialized');
  updateTrayMenu();
}

async function stopAgent(): Promise<void> {
  if (telegramBot) {
    await telegramBot.stop();
    telegramBot = null;
  }
  if (scheduler) {
    scheduler.stopAll();
    scheduler = null;
  }
  // Cleanup browser resources
  AgentManager.cleanup();
  console.log('[Main] Agent stopped');
  updateTrayMenu();
}

async function restartAgent(): Promise<void> {
  await stopAgent();
  await initializeAgent();
}

// ============ App Lifecycle ============

app.whenReady().then(async () => {
  // Hide dock on macOS
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'pocket-agent.db');

  // Initialize settings first (uses same DB)
  SettingsManager.initialize(dbPath);

  // Migrate from old config.json if it exists
  const oldConfigPath = path.join(userDataPath, 'config.json');
  await SettingsManager.migrateFromConfig(oldConfigPath);

  // Initialize memory (shared with settings)
  memory = new MemoryManager(dbPath);

  setupIPC();
  await createTray();

  // Check for first run
  if (SettingsManager.isFirstRun()) {
    console.log('[Main] First run detected, showing setup wizard');
    openSetupWindow();
  } else {
    await initializeAgent();
  }

  // Periodic tray update
  setInterval(updateTrayMenu, 30000);
});

app.on('window-all-closed', () => {
  // Keep running (tray app)
});

app.on('before-quit', async () => {
  await stopAgent();
  if (memory) {
    memory.close();
  }
  SettingsManager.close();
});

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openChatWindow();
  });
}
