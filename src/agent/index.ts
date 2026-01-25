import { MemoryManager, Message } from '../memory';
import { buildMCPServers, setMemoryManager, ToolsConfig, validateToolsConfig } from '../tools';
import { closeBrowserManager } from '../browser';
import { loadIdentity } from '../config/identity';

// Token limits
const MAX_CONTEXT_TOKENS = 150000;
const COMPACTION_THRESHOLD = 120000; // Start compacting at 80% capacity

// SDK types (loaded dynamically)
type SDKQuery = AsyncGenerator<any, void>;
type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  abortController?: AbortController;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  persistSession?: boolean;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, any>;
};

// Dynamic SDK loader
let sdkQuery: ((params: { prompt: string; options?: SDKOptions }) => SDKQuery) | null = null;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}

export interface AgentConfig {
  memory: MemoryManager;
  projectRoot?: string;
  model?: string;
  tools?: ToolsConfig;
}

export interface ProcessResult {
  response: string;
  tokensUsed: number;
  wasCompacted: boolean;
}

/**
 * AgentManager - Singleton wrapper around Claude Agent SDK
 */
class AgentManagerClass {
  private static instance: AgentManagerClass | null = null;
  private memory: MemoryManager | null = null;
  private projectRoot: string = process.cwd();
  private model: string = 'claude-sonnet-4-20250514';
  private toolsConfig: ToolsConfig | null = null;
  private initialized: boolean = false;
  private identity: string = '';

  private constructor() {}

  static getInstance(): AgentManagerClass {
    if (!AgentManagerClass.instance) {
      AgentManagerClass.instance = new AgentManagerClass();
    }
    return AgentManagerClass.instance;
  }

  initialize(config: AgentConfig): void {
    this.memory = config.memory;
    this.projectRoot = config.projectRoot || process.cwd();
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.toolsConfig = config.tools || null;
    this.initialized = true;

    this.identity = loadIdentity();
    this.memory.setSummarizer(this.createSummary.bind(this));
    setMemoryManager(this.memory);

    console.log('[AgentManager] Initialized');
    console.log('[AgentManager] Project root:', this.projectRoot);
    console.log('[AgentManager] Model:', this.model);
    console.log('[AgentManager] Identity loaded:', this.identity.length, 'chars');

    if (this.toolsConfig) {
      const validation = validateToolsConfig(this.toolsConfig);
      if (!validation.valid) {
        console.warn('[AgentManager] Tool config issues:', validation.errors);
      }

      if (this.toolsConfig.browser.enabled) {
        console.log('[AgentManager] Browser: 2-tier (Electron, CDP)');
      }
    }
  }

  isInitialized(): boolean {
    return this.initialized && this.memory !== null;
  }

  async processMessage(
    userMessage: string,
    _channel: string = 'default'
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    let wasCompacted = false;

    const statsBefore = this.memory.getStats();
    if (statsBefore.estimatedTokens > COMPACTION_THRESHOLD) {
      console.log('[AgentManager] Token limit approaching, running compaction...');
      await this.runCompaction();
      wasCompacted = true;
    }

    const context = await this.memory.getConversationContext(MAX_CONTEXT_TOKENS);
    const factsContext = this.memory.getFactsForContext();

    console.log(`[AgentManager] Loaded ${context.messages.length} messages (${context.totalTokens} tokens)`);

    const contextParts: string[] = [];

    if (context.messages.length > 0) {
      const historyText = context.messages
        .map((m: Message) => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');
      contextParts.push(`Previous conversation:\n${historyText}`);
    }

    const fullPrompt = contextParts.length > 0
      ? `${contextParts.join('\n\n---\n\n')}\n\n---\n\nUser: ${userMessage}`
      : userMessage;

    try {
      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      const options = this.buildOptions(factsContext);

      console.log('[AgentManager] Calling query()...');

      const queryResult = query({ prompt: fullPrompt, options });
      let response = '';

      for await (const message of queryResult) {
        response = this.extractFromMessage(message, response);
      }

      if (!response) {
        response = 'I processed your request but have no text response.';
      }

      this.memory.saveMessage('user', userMessage);
      this.memory.saveMessage('assistant', response);

      console.log('[AgentManager] Saved messages to SQLite');

      this.extractAndStoreFacts(userMessage);

      const statsAfter = this.memory.getStats();

      return {
        response,
        tokensUsed: statsAfter.estimatedTokens,
        wasCompacted,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AgentManager] Query failed:', errorMsg);

      this.memory.saveMessage('user', userMessage);

      throw error;
    }
  }

  private buildOptions(factsContext: string): SDKOptions {
    const appendParts: string[] = [];

    if (this.identity) {
      appendParts.push(this.identity);
    }

    if (factsContext) {
      appendParts.push(factsContext);
    }

    const options: SDKOptions = {
      model: this.model,
      cwd: this.projectRoot,
      maxTurns: 20,
      abortController: new AbortController(),
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      persistSession: false,
    };

    if (appendParts.length > 0) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: appendParts.join('\n\n'),
      };
    }

    if (this.toolsConfig) {
      const mcpServers = buildMCPServers(this.toolsConfig);

      if (Object.keys(mcpServers).length > 0) {
        options.mcpServers = mcpServers;
        console.log('[AgentManager] MCP servers:', Object.keys(mcpServers).join(', '));
      }
    }

    return options;
  }

  private extractFromMessage(message: any, current: string): string {
    if (message.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        const textBlocks = content
          .filter((block: any) => block?.type === 'text')
          .map((block: any) => block.text);
        return textBlocks.join('\n');
      }
    }

    if (message.type === 'result') {
      if (message.output) return message.output;
      if (message.result) return message.result;
    }

    return current;
  }

  private async runCompaction(): Promise<void> {
    if (!this.memory) return;

    console.log('[AgentManager] Running compaction...');

    // Before compaction, extract and save important facts from recent messages
    await this.extractFactsBeforeCompaction();

    await this.memory.getConversationContext(MAX_CONTEXT_TOKENS);
    const stats = this.memory.getStats();
    console.log(`[AgentManager] Compaction complete. Now at ${stats.estimatedTokens} tokens`);
  }

  /**
   * Extract important facts from recent conversation before compaction
   */
  private async extractFactsBeforeCompaction(): Promise<void> {
    if (!this.memory) return;

    try {
      const query = await loadSDK();
      if (!query) return;

      // Get recent messages that haven't been processed for facts
      const recentMessages = this.memory.getRecentMessages(30);
      if (recentMessages.length < 5) return;

      const conversationText = recentMessages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');

      const extractionPrompt = `Analyze this conversation and extract important facts about the user that should be saved to long-term memory. Only extract concrete, specific information - not general conversation topics.

Focus on:
- Personal info (name, location, job, etc.)
- Preferences and opinions
- Projects and goals
- Important dates or deadlines
- Relationships and people mentioned
- Decisions made

For each fact, output in this exact format (one per line):
FACT|category|subject|content

Categories: user_info, preferences, projects, people, work, notes, decisions

Example:
FACT|user_info|name|John Smith
FACT|work|employer|Works at Acme Corp as a software engineer
FACT|preferences|coffee|Prefers oat milk lattes

If no important facts are found, output: NO_FACTS

Conversation:
${conversationText}`;

      const options: SDKOptions = {
        model: 'claude-3-haiku-20240307',
        maxTurns: 1,
        abortController: new AbortController(),
        tools: [],
        persistSession: false,
      };

      const queryResult = query({ prompt: extractionPrompt, options });
      let response = '';

      for await (const message of queryResult) {
        response = this.extractFromMessage(message, response);
      }

      if (!response || response.includes('NO_FACTS')) {
        console.log('[AgentManager] No new facts extracted before compaction');
        return;
      }

      // Parse and save facts
      const lines = response.split('\n').filter(line => line.startsWith('FACT|'));
      let savedCount = 0;

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length >= 4) {
          const [_, category, subject, ...contentParts] = parts;
          const content = contentParts.join('|').trim();

          if (category && subject && content) {
            this.memory.saveFact(category.trim(), subject.trim(), content);
            savedCount++;
          }
        }
      }

      if (savedCount > 0) {
        console.log(`[AgentManager] Extracted ${savedCount} facts before compaction`);
      }
    } catch (error) {
      console.error('[AgentManager] Fact extraction before compaction failed:', error);
      // Don't block compaction on fact extraction failure
    }
  }

  private async createSummary(messages: Message[]): Promise<string> {
    if (messages.length === 0) {
      return '';
    }

    const conversationText = messages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n---\n\n');

    try {
      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      const summaryPrompt = `Summarize this conversation concisely, preserving key facts about the user (name, preferences, work), important decisions, ongoing tasks, and context needed to continue the conversation:\n\n${conversationText}`;

      const options: SDKOptions = {
        model: 'claude-3-haiku-20240307',
        maxTurns: 1,
        abortController: new AbortController(),
        tools: [],
        persistSession: false,
      };

      const queryResult = query({ prompt: summaryPrompt, options });
      let summary = '';

      for await (const message of queryResult) {
        summary = this.extractFromMessage(message, summary);
      }

      console.log(`[AgentManager] Created summary of ${messages.length} messages`);
      return summary || `Previous conversation (${messages.length} messages) summarized.`;
    } catch (error) {
      console.error('[AgentManager] Summarization failed:', error);

      const userMessages = messages.filter(m => m.role === 'user');
      const snippets = userMessages
        .slice(-10)
        .map(m => m.content.slice(0, 100))
        .join('; ');

      return `Previous conversation (${messages.length} messages). Topics discussed: ${snippets}`;
    }
  }

  private extractAndStoreFacts(userMessage: string): void {
    if (!this.memory) return;

    const patterns: Array<{ pattern: RegExp; category: string; subject: string }> = [
      { pattern: /my name is (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /call me (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /i live in ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i'm from ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i work (?:at|for) ([^.,]+)/i, category: 'work', subject: 'employer' },
      { pattern: /i work as (?:a |an )?([^.,]+)/i, category: 'work', subject: 'role' },
      { pattern: /my job is ([^.,]+)/i, category: 'work', subject: 'role' },
    ];

    for (const { pattern, category, subject } of patterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        this.memory.saveFact(category, subject, match[1].trim());
        console.log(`[AgentManager] Extracted fact: [${category}] ${subject}: ${match[1]}`);
      }
    }
  }

  // ============ Public API ============

  getStats(): ReturnType<MemoryManager['getStats']> | null {
    return this.memory?.getStats() || null;
  }

  clearConversation(): void {
    this.memory?.clearConversation();
    console.log('[AgentManager] Conversation cleared');
  }

  getMemory(): MemoryManager | null {
    return this.memory;
  }

  searchFacts(queryStr: string): Array<{ category: string; subject: string; content: string }> {
    return this.memory?.searchFacts(queryStr) || [];
  }

  saveFact(category: string, subject: string, content: string): void {
    this.memory?.saveFact(category, subject, content);
  }

  getAllFacts(): Array<{ id: number; category: string; subject: string; content: string }> {
    return this.memory?.getAllFacts() || [];
  }

  getRecentMessages(limit: number = 10): Message[] {
    return this.memory?.getRecentMessages(limit) || [];
  }

  getToolsConfig(): ToolsConfig | null {
    return this.toolsConfig;
  }

  cleanup(): void {
    closeBrowserManager();
    console.log('[AgentManager] Cleanup complete');
  }
}

export const AgentManager = AgentManagerClass.getInstance();
export { AgentManagerClass };
