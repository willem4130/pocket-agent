import { Bot, Context } from 'grammy';
import { BaseChannel } from './index';
import { AgentManager } from '../agent';
import { SettingsManager } from '../settings';

export class TelegramBot extends BaseChannel {
  name = 'telegram';
  private bot: Bot;
  private allowedUserIds: Set<number>;
  private activeChatIds: Set<number> = new Set();

  constructor() {
    super();
    const botToken = SettingsManager.get('telegram.botToken');
    const allowedUsers = SettingsManager.getArray('telegram.allowedUserIds');
    this.bot = new Bot(botToken);
    this.allowedUserIds = new Set(allowedUsers.map(id => parseInt(id, 10)).filter(id => !isNaN(id)));
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Middleware to check allowed users (if configured)
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;

      // Track active chat IDs for proactive messaging
      if (chatId) {
        this.activeChatIds.add(chatId);
      }

      // If allowlist is configured, enforce it
      if (this.allowedUserIds.size > 0) {
        if (!userId || !this.allowedUserIds.has(userId)) {
          console.log(`[Telegram] Unauthorized user: ${userId}`);
          await ctx.reply('Sorry, you are not authorized to use this bot.');
          return;
        }
      }

      await next();
    });

    // Handle /start command
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from?.id;
      await ctx.reply(
        `Welcome to Pocket Agent!\n\n` +
        `I'm your personal AI assistant with persistent memory. ` +
        `I remember our conversations across sessions.\n\n` +
        `Your user ID: ${userId}\n\n` +
        `Commands:\n` +
        `/status - Show agent status\n` +
        `/facts [query] - Search stored facts\n` +
        `/clear - Clear conversation (keeps facts)\n` +
        `/mychatid - Show your chat ID for cron jobs`
      );
    });

    // Handle /mychatid command (for setting up cron notifications)
    this.bot.command('mychatid', async (ctx) => {
      const chatId = ctx.chat?.id;
      const userId = ctx.from?.id;
      await ctx.reply(
        `Your IDs for cron job configuration:\n\n` +
        `Chat ID: ${chatId}\n` +
        `User ID: ${userId}\n\n` +
        `Use the Chat ID when scheduling tasks that should message you.`
      );
    });

    // Handle /status command
    this.bot.command('status', async (ctx) => {
      const stats = AgentManager.getStats();
      if (!stats) {
        await ctx.reply('Agent not initialized');
        return;
      }

      const memoryMB = process.memoryUsage().heapUsed / 1024 / 1024;

      await ctx.reply(
        `📊 Pocket Agent Status\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💬 Messages: ${stats.messageCount}\n` +
        `🧠 Facts: ${stats.factCount}\n` +
        `⏰ Cron Jobs: ${stats.cronJobCount}\n` +
        `📝 Summaries: ${stats.summaryCount}\n` +
        `🎯 Est. Tokens: ${stats.estimatedTokens.toLocaleString()}\n` +
        `💾 Memory: ${memoryMB.toFixed(1)} MB`
      );
    });

    // Handle /facts command
    this.bot.command('facts', async (ctx) => {
      const query = ctx.message?.text?.replace('/facts', '').trim();

      if (!query) {
        // List all facts grouped by category
        const facts = AgentManager.getAllFacts();
        if (facts.length === 0) {
          await ctx.reply('No facts stored yet.\n\nI learn facts when you tell me things about yourself, or when I use the remember tool.');
          return;
        }

        // Group by category
        const byCategory = new Map<string, typeof facts>();
        for (const fact of facts) {
          const list = byCategory.get(fact.category) || [];
          list.push(fact);
          byCategory.set(fact.category, list);
        }

        const lines: string[] = [`📚 Known Facts (${facts.length} total)`];
        for (const [category, categoryFacts] of byCategory) {
          lines.push(`\n📁 ${category}`);
          for (const fact of categoryFacts) {
            lines.push(`  • ${fact.subject}: ${fact.content}`);
          }
        }

        await this.sendResponse(ctx, lines.join('\n'));
        return;
      }

      const facts = AgentManager.searchFacts(query);
      if (facts.length === 0) {
        await ctx.reply(`No facts found for "${query}"`);
        return;
      }

      const response = facts
        .slice(0, 15)
        .map(f => `[${f.category}] ${f.subject}: ${f.content}`)
        .join('\n');

      await ctx.reply(`Found ${facts.length} fact(s):\n\n${response}`);
    });

    // Handle /clear command
    this.bot.command('clear', async (ctx) => {
      AgentManager.clearConversation();
      await ctx.reply('✅ Conversation history cleared.\nFacts and scheduled tasks are preserved.');
    });

    // Handle all text messages
    this.bot.on('message:text', async (ctx: Context) => {
      const message = ctx.message?.text;
      if (!message) return;

      // Show typing indicator
      await ctx.replyWithChatAction('typing');

      // Keep typing indicator active for long operations
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const result = await AgentManager.processMessage(message, 'telegram');

        clearInterval(typingInterval);

        // Send response, splitting if necessary
        await this.sendResponse(ctx, result.response);

        // If compaction happened, notify
        if (result.wasCompacted) {
          await ctx.reply('📦 (Conversation history was compacted to save space)');
        }
      } catch (error) {
        clearInterval(typingInterval);
        console.error('[Telegram] Error:', error);
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await ctx.reply(`❌ Error: ${errorMsg}`);
      }
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('[Telegram] Bot error:', err);
    });
  }

  /**
   * Send a response, splitting into multiple messages if needed
   */
  private async sendResponse(ctx: Context, text: string): Promise<void> {
    const MAX_LENGTH = 4000; // Telegram limit is 4096, leave buffer

    if (text.length <= MAX_LENGTH) {
      await ctx.reply(text);
      return;
    }

    const chunks = this.splitMessage(text, MAX_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
      await ctx.reply(prefix + chunks[i]);
      // Small delay between messages to maintain order
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  /**
   * Split long text into chunks at natural boundaries
   */
  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to find a good split point
      let splitPoint = -1;

      // Priority 1: Double newline (paragraph break)
      const doubleNewline = remaining.lastIndexOf('\n\n', maxLength);
      if (doubleNewline > maxLength / 2) {
        splitPoint = doubleNewline;
      }

      // Priority 2: Single newline
      if (splitPoint === -1) {
        const singleNewline = remaining.lastIndexOf('\n', maxLength);
        if (singleNewline > maxLength / 2) {
          splitPoint = singleNewline;
        }
      }

      // Priority 3: Sentence end
      if (splitPoint === -1) {
        const sentenceEnd = Math.max(
          remaining.lastIndexOf('. ', maxLength),
          remaining.lastIndexOf('! ', maxLength),
          remaining.lastIndexOf('? ', maxLength)
        );
        if (sentenceEnd > maxLength / 2) {
          splitPoint = sentenceEnd + 1;
        }
      }

      // Priority 4: Space
      if (splitPoint === -1) {
        const space = remaining.lastIndexOf(' ', maxLength);
        if (space > maxLength / 2) {
          splitPoint = space;
        }
      }

      // Fallback: Hard cut
      if (splitPoint === -1) {
        splitPoint = maxLength;
      }

      chunks.push(remaining.substring(0, splitPoint).trim());
      remaining = remaining.substring(splitPoint).trim();
    }

    return chunks;
  }

  /**
   * Proactively send a message to a specific chat
   * Used by scheduler for cron jobs
   */
  async sendMessage(chatId: number, text: string): Promise<boolean> {
    if (!this.isRunning) {
      console.error('[Telegram] Bot not running, cannot send message');
      return false;
    }

    try {
      const MAX_LENGTH = 4000;

      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(chatId, text);
      } else {
        const chunks = this.splitMessage(text, MAX_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
          await this.bot.api.sendMessage(chatId, prefix + chunks[i]);
          if (i < chunks.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
      }

      console.log(`[Telegram] Sent proactive message to chat ${chatId}`);
      return true;
    } catch (error) {
      console.error(`[Telegram] Failed to send message to chat ${chatId}:`, error);
      return false;
    }
  }

  /**
   * Send a message to all active chats (broadcast)
   */
  async broadcast(text: string): Promise<number> {
    let sent = 0;
    for (const chatId of this.activeChatIds) {
      const success = await this.sendMessage(chatId, text);
      if (success) sent++;
    }
    return sent;
  }

  /**
   * Get list of active chat IDs
   */
  getActiveChatIds(): number[] {
    return Array.from(this.activeChatIds);
  }

  /**
   * Add a user to the allowlist
   */
  addAllowedUser(userId: number): void {
    this.allowedUserIds.add(userId);
  }

  /**
   * Remove a user from the allowlist
   */
  removeAllowedUser(userId: number): void {
    this.allowedUserIds.delete(userId);
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    const botToken = SettingsManager.get('telegram.botToken');
    if (!botToken) {
      console.error('[Telegram] No bot token configured');
      return;
    }

    this.isRunning = true;

    this.bot.start({
      onStart: (botInfo) => {
        console.log(`[Telegram] Bot @${botInfo.username} started`);
        console.log(`[Telegram] Allowlist: ${this.allowedUserIds.size > 0
          ? Array.from(this.allowedUserIds).join(', ')
          : 'disabled (all users allowed)'}`);
      },
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    await this.bot.stop();
    this.isRunning = false;
    console.log('[Telegram] Bot stopped');
  }
}

// Singleton instance
let telegramBotInstance: TelegramBot | null = null;

export function getTelegramBot(): TelegramBot | null {
  return telegramBotInstance;
}

export function createTelegramBot(): TelegramBot {
  if (!telegramBotInstance) {
    telegramBotInstance = new TelegramBot();
  }
  return telegramBotInstance;
}
