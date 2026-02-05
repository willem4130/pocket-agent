/**
 * Telegram text message handler
 */

import { Context } from 'grammy';
import { AgentManager } from '../../../agent';
import { MessageCallback } from '../types';
import { withTyping } from '../utils/typing';

export interface MessageHandlerDeps {
  onMessageCallback: MessageCallback | null;
  sendResponse: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Handle incoming text messages
 */
export async function handleTextMessage(
  ctx: Context,
  deps: MessageHandlerDeps
): Promise<void> {
  const message = ctx.message?.text;
  const chatId = ctx.chat?.id;
  if (!message || !chatId) return;

  const { onMessageCallback, sendResponse } = deps;

  try {
    const result = await withTyping(ctx, async () => {
      // Look up which session this chat is linked to
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      return AgentManager.processMessage(message, 'telegram', sessionId);
    });

    // Send response, splitting if necessary
    await sendResponse(ctx, result.response);

    // Notify callback for cross-channel sync (to desktop)
    if (onMessageCallback) {
      const memory = AgentManager.getMemory();
      const sessionId = memory?.getSessionForChat(chatId) || 'default';

      onMessageCallback({
        userMessage: message,
        response: result.response,
        channel: 'telegram',
        chatId,
        sessionId,
      });
    }

    // If compaction happened, notify
    if (result.wasCompacted) {
      await ctx.reply('(your chat has been compacted)');
    }
  } catch (error) {
    console.error('[Telegram] Error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    await ctx.reply(`Error: ${errorMsg}`);
  }
}
