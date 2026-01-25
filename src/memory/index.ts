import Database from 'better-sqlite3';
import {
  initEmbeddings,
  hasEmbeddings,
  embed,
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
  EMBEDDING_DIMENSIONS,
} from './embeddings';

// Types
export interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  token_count?: number;
}

export interface Fact {
  id: number;
  category: string;
  subject: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface CronJob {
  id: number;
  name: string;
  schedule: string;
  prompt: string;
  channel: string;
  enabled: boolean;
}

export interface ConversationContext {
  messages: Array<{ role: string; content: string }>;
  totalTokens: number;
  summarizedCount: number;
  summary?: string;
}

export interface SearchResult {
  fact: Fact;
  score: number;
  vectorScore: number;
  keywordScore: number;
}

// Summarizer function type - injected to avoid circular dependency with agent
export type SummarizerFn = (messages: Message[]) => Promise<string>;

// Token estimation: ~4 characters per token
const CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_LIMIT = 150000;

// Search weights
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const MIN_SCORE_THRESHOLD = 0.35;
const MAX_SEARCH_RESULTS = 6;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class MemoryManager {
  private db: Database.Database;
  private summarizer?: SummarizerFn;
  private embeddingsReady: boolean = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      -- Main conversation messages (ONE persistent conversation)
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp TEXT DEFAULT (datetime('now')),
        token_count INTEGER
      );

      -- Facts extracted from conversations (long-term memory)
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Embedding chunks linked to facts
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (fact_id) REFERENCES facts(id) ON DELETE CASCADE
      );

      -- Scheduled cron jobs
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        schedule TEXT NOT NULL,
        prompt TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'default',
        enabled INTEGER DEFAULT 1
      );

      -- Summaries of older conversation chunks
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_message_id INTEGER NOT NULL,
        end_message_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
      CREATE INDEX IF NOT EXISTS idx_chunks_fact_id ON chunks(fact_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_range ON summaries(start_message_id, end_message_id);
    `);

    // Create FTS5 virtual table for keyword search
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
          category,
          subject,
          content,
          content='facts',
          content_rowid='id'
        );
      `);

      // Create triggers to keep FTS index in sync
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
          INSERT INTO facts_fts(rowid, category, subject, content)
          VALUES (new.id, new.category, new.subject, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, category, subject, content)
          VALUES ('delete', old.id, old.category, old.subject, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
          INSERT INTO facts_fts(facts_fts, rowid, category, subject, content)
          VALUES ('delete', old.id, old.category, old.subject, old.content);
          INSERT INTO facts_fts(rowid, category, subject, content)
          VALUES (new.id, new.category, new.subject, new.content);
        END;
      `);
    } catch (e) {
      // FTS5 triggers may already exist
    }

    // Rebuild FTS index from existing facts
    this.rebuildFtsIndex();

    // Migration: add subject column if missing
    const columns = this.db.pragma('table_info(facts)') as Array<{ name: string }>;
    const hasSubject = columns.some(c => c.name === 'subject');
    if (!hasSubject) {
      this.db.exec(`ALTER TABLE facts ADD COLUMN subject TEXT NOT NULL DEFAULT ''`);
      console.log('[Memory] Migrated facts table: added subject column');
    }
  }

  /**
   * Rebuild FTS index from existing facts
   */
  private rebuildFtsIndex(): void {
    try {
      // Check if FTS table is empty but facts exist
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM facts_fts').get() as { c: number }).c;
      const factsCount = (this.db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number }).c;

      if (ftsCount === 0 && factsCount > 0) {
        console.log('[Memory] Rebuilding FTS index...');
        const facts = this.db.prepare('SELECT id, category, subject, content FROM facts').all() as Fact[];
        const insert = this.db.prepare('INSERT INTO facts_fts(rowid, category, subject, content) VALUES (?, ?, ?, ?)');

        for (const fact of facts) {
          insert.run(fact.id, fact.category, fact.subject, fact.content);
        }
        console.log(`[Memory] Rebuilt FTS index with ${facts.length} facts`);
      }
    } catch (e) {
      console.warn('[Memory] FTS rebuild failed:', e);
    }
  }

  /**
   * Initialize embeddings with OpenAI API key
   */
  initializeEmbeddings(openaiApiKey: string): void {
    initEmbeddings(openaiApiKey);
    this.embeddingsReady = true;
    console.log('[Memory] Embeddings initialized');

    // Embed any facts that don't have embeddings
    this.embedMissingFacts().catch(err => {
      console.error('[Memory] Failed to embed missing facts:', err);
    });
  }

  /**
   * Embed facts that don't have embeddings yet
   */
  private async embedMissingFacts(): Promise<void> {
    if (!hasEmbeddings()) return;

    const factsWithoutEmbeddings = this.db.prepare(`
      SELECT f.id, f.category, f.subject, f.content
      FROM facts f
      LEFT JOIN chunks c ON f.id = c.fact_id
      WHERE c.id IS NULL
    `).all() as Fact[];

    if (factsWithoutEmbeddings.length === 0) return;

    console.log(`[Memory] Embedding ${factsWithoutEmbeddings.length} facts...`);

    for (const fact of factsWithoutEmbeddings) {
      await this.embedFact(fact);
    }

    console.log('[Memory] Finished embedding facts');
  }

  /**
   * Generate and store embedding for a fact
   */
  private async embedFact(fact: Fact): Promise<void> {
    if (!hasEmbeddings()) return;

    try {
      // Combine fact fields for embedding
      const textToEmbed = `${fact.category}: ${fact.subject} - ${fact.content}`;
      const embedding = await embed(textToEmbed);
      const embeddingBuffer = serializeEmbedding(embedding);

      // Delete existing chunk for this fact
      this.db.prepare('DELETE FROM chunks WHERE fact_id = ?').run(fact.id);

      // Insert new chunk with embedding
      this.db.prepare(`
        INSERT INTO chunks (fact_id, content, embedding)
        VALUES (?, ?, ?)
      `).run(fact.id, textToEmbed, embeddingBuffer);
    } catch (err) {
      console.error(`[Memory] Failed to embed fact ${fact.id}:`, err);
    }
  }

  /**
   * Set the summarizer function
   */
  setSummarizer(fn: SummarizerFn): void {
    this.summarizer = fn;
  }

  // ============ MESSAGE METHODS ============

  saveMessage(role: 'user' | 'assistant' | 'system', content: string): number {
    const tokenCount = estimateTokens(content);
    const stmt = this.db.prepare(`
      INSERT INTO messages (role, content, token_count)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(role, content, tokenCount);
    return result.lastInsertRowid as number;
  }

  getRecentMessages(limit: number = 50): Message[] {
    const stmt = this.db.prepare(`
      SELECT id, role, content, timestamp, token_count
      FROM messages
      ORDER BY id DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Message[];
    return rows.reverse();
  }

  getMessageCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  async getConversationContext(
    tokenLimit: number = DEFAULT_TOKEN_LIMIT
  ): Promise<ConversationContext> {
    const reservedTokens = 10000;
    const availableTokens = tokenLimit - reservedTokens;

    const allMessages = this.db.prepare(`
      SELECT id, role, content, timestamp, token_count
      FROM messages
      ORDER BY id DESC
    `).all() as Message[];

    if (allMessages.length === 0) {
      return { messages: [], totalTokens: 0, summarizedCount: 0 };
    }

    const recentMessages: Message[] = [];
    let tokenCount = 0;
    let cutoffIndex = 0;

    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      const msgTokens = msg.token_count || estimateTokens(msg.content);

      if (tokenCount + msgTokens > availableTokens) {
        cutoffIndex = i;
        break;
      }

      recentMessages.unshift(msg);
      tokenCount += msgTokens;
      cutoffIndex = i + 1;
    }

    if (cutoffIndex >= allMessages.length) {
      return {
        messages: recentMessages.map(m => ({ role: m.role, content: m.content })),
        totalTokens: tokenCount,
        summarizedCount: 0,
      };
    }

    const oldestRecentId = recentMessages[0]?.id || 0;
    const summary = await this.getOrCreateSummary(oldestRecentId);

    const contextMessages: Array<{ role: string; content: string }> = [];

    if (summary) {
      contextMessages.push({
        role: 'system',
        content: `[Previous conversation summary]\n${summary}`,
      });
      tokenCount += estimateTokens(summary);
    }

    contextMessages.push(
      ...recentMessages.map(m => ({ role: m.role, content: m.content }))
    );

    return {
      messages: contextMessages,
      totalTokens: tokenCount,
      summarizedCount: allMessages.length - recentMessages.length,
      summary,
    };
  }

  private async getOrCreateSummary(beforeMessageId: number): Promise<string | undefined> {
    if (beforeMessageId <= 1) {
      return undefined;
    }

    const existingSummary = this.db.prepare(`
      SELECT content FROM summaries
      WHERE end_message_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(beforeMessageId - 1) as { content: string } | undefined;

    if (existingSummary) {
      return existingSummary.content;
    }

    const messagesToSummarize = this.db.prepare(`
      SELECT id, role, content, timestamp
      FROM messages
      WHERE id < ?
      ORDER BY id ASC
    `).all(beforeMessageId) as Message[];

    if (messagesToSummarize.length === 0) {
      return undefined;
    }

    const partialSummary = this.db.prepare(`
      SELECT id, end_message_id, content FROM summaries
      WHERE end_message_id < ?
      ORDER BY end_message_id DESC
      LIMIT 1
    `).get(beforeMessageId) as { id: number; end_message_id: number; content: string } | undefined;

    let summary: string;
    let startId: number;

    if (partialSummary && this.summarizer) {
      const newMessages = messagesToSummarize.filter(m => m.id > partialSummary.end_message_id);
      if (newMessages.length === 0) {
        return partialSummary.content;
      }

      const combinedContent = [
        { role: 'system' as const, content: `Previous summary: ${partialSummary.content}` },
        ...newMessages,
      ];
      summary = await this.summarizer(combinedContent as Message[]);
      startId = 1;
    } else if (this.summarizer) {
      summary = await this.summarizer(messagesToSummarize);
      startId = messagesToSummarize[0].id;
    } else {
      summary = this.createBasicSummary(messagesToSummarize);
      startId = messagesToSummarize[0].id;
    }

    const endId = messagesToSummarize[messagesToSummarize.length - 1].id;
    this.db.prepare(`
      INSERT INTO summaries (start_message_id, end_message_id, content, token_count)
      VALUES (?, ?, ?, ?)
    `).run(startId, endId, summary, estimateTokens(summary));

    return summary;
  }

  private createBasicSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user');
    const topics = new Set<string>();

    for (const msg of userMessages.slice(-20)) {
      const topic = msg.content.slice(0, 100).replace(/\n/g, ' ');
      topics.add(topic);
    }

    const topicList = Array.from(topics).slice(0, 10);
    return `Previous conversation (${messages.length} messages) covered:\n${topicList.map(t => `- ${t}...`).join('\n')}`;
  }

  // ============ FACT METHODS ============

  /**
   * Save a fact to long-term memory (with embedding)
   */
  saveFact(category: string, subject: string, content: string): number {
    const existing = this.db.prepare(`
      SELECT id FROM facts WHERE category = ? AND subject = ?
    `).get(category, subject) as { id: number } | undefined;

    let factId: number;

    if (existing) {
      this.db.prepare(`
        UPDATE facts SET content = ?, updated_at = datetime('now') WHERE id = ?
      `).run(content, existing.id);
      factId = existing.id;
    } else {
      const stmt = this.db.prepare(`
        INSERT INTO facts (category, subject, content)
        VALUES (?, ?, ?)
      `);
      const result = stmt.run(category, subject, content);
      factId = result.lastInsertRowid as number;
    }

    // Embed the fact asynchronously
    if (hasEmbeddings()) {
      const fact: Fact = { id: factId, category, subject, content, created_at: '', updated_at: '' };
      this.embedFact(fact).catch(err => {
        console.error(`[Memory] Failed to embed fact ${factId}:`, err);
      });
    }

    return factId;
  }

  getAllFacts(): Fact[] {
    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      ORDER BY category, subject
    `);
    return stmt.all() as Fact[];
  }

  getFactsForContext(): string {
    const facts = this.getAllFacts();
    if (facts.length === 0) return '';

    const byCategory = new Map<string, Fact[]>();
    for (const fact of facts) {
      const list = byCategory.get(fact.category) || [];
      list.push(fact);
      byCategory.set(fact.category, list);
    }

    const lines: string[] = ['## Known Facts'];
    for (const [category, categoryFacts] of byCategory) {
      lines.push(`\n### ${category}`);
      for (const fact of categoryFacts) {
        if (fact.subject) {
          lines.push(`- **${fact.subject}**: ${fact.content}`);
        } else {
          lines.push(`- ${fact.content}`);
        }
      }
    }

    return lines.join('\n');
  }

  deleteFact(id: number): boolean {
    // Chunks will be deleted by CASCADE
    const stmt = this.db.prepare('DELETE FROM facts WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteFactBySubject(category: string, subject: string): boolean {
    const stmt = this.db.prepare('DELETE FROM facts WHERE category = ? AND subject = ?');
    const result = stmt.run(category, subject);
    return result.changes > 0;
  }

  /**
   * Hybrid semantic + keyword search for facts
   */
  async searchFactsHybrid(query: string): Promise<SearchResult[]> {
    const results: Map<number, SearchResult> = new Map();

    // 1. Vector search (if embeddings available)
    if (hasEmbeddings()) {
      try {
        const queryEmbedding = await embed(query);

        const chunks = this.db.prepare(`
          SELECT c.fact_id, c.embedding, f.id, f.category, f.subject, f.content, f.created_at, f.updated_at
          FROM chunks c
          JOIN facts f ON c.fact_id = f.id
          WHERE c.embedding IS NOT NULL
        `).all() as Array<{
          fact_id: number;
          embedding: Buffer;
          id: number;
          category: string;
          subject: string;
          content: string;
          created_at: string;
          updated_at: string;
        }>;

        for (const chunk of chunks) {
          const chunkEmbedding = deserializeEmbedding(chunk.embedding);
          const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);

          const fact: Fact = {
            id: chunk.id,
            category: chunk.category,
            subject: chunk.subject,
            content: chunk.content,
            created_at: chunk.created_at,
            updated_at: chunk.updated_at,
          };

          results.set(chunk.id, {
            fact,
            score: similarity * VECTOR_WEIGHT,
            vectorScore: similarity,
            keywordScore: 0,
          });
        }
      } catch (err) {
        console.error('[Memory] Vector search failed:', err);
      }
    }

    // 2. Keyword search using FTS5
    try {
      // Escape special FTS5 characters and create search query
      const escapedQuery = query.replace(/['"]/g, '').trim();
      if (escapedQuery) {
        const ftsResults = this.db.prepare(`
          SELECT f.id, f.category, f.subject, f.content, f.created_at, f.updated_at,
                 bm25(facts_fts) as rank
          FROM facts_fts
          JOIN facts f ON facts_fts.rowid = f.id
          WHERE facts_fts MATCH ?
          ORDER BY rank
          LIMIT 20
        `).all(`"${escapedQuery}" OR ${escapedQuery.split(/\s+/).join(' OR ')}`) as Array<Fact & { rank: number }>;

        // Normalize keyword scores (BM25 returns negative values, lower is better)
        const maxRank = Math.max(...ftsResults.map(r => Math.abs(r.rank)), 1);

        for (const ftsResult of ftsResults) {
          const normalizedScore = 1 - (Math.abs(ftsResult.rank) / maxRank);
          const existing = results.get(ftsResult.id);

          if (existing) {
            existing.keywordScore = normalizedScore;
            existing.score += normalizedScore * KEYWORD_WEIGHT;
          } else {
            const fact: Fact = {
              id: ftsResult.id,
              category: ftsResult.category,
              subject: ftsResult.subject,
              content: ftsResult.content,
              created_at: ftsResult.created_at,
              updated_at: ftsResult.updated_at,
            };

            results.set(ftsResult.id, {
              fact,
              score: normalizedScore * KEYWORD_WEIGHT,
              vectorScore: 0,
              keywordScore: normalizedScore,
            });
          }
        }
      }
    } catch (err) {
      console.error('[Memory] Keyword search failed:', err);
    }

    // 3. Sort by score and filter
    const sortedResults = Array.from(results.values())
      .filter(r => r.score >= MIN_SCORE_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SEARCH_RESULTS);

    return sortedResults;
  }

  /**
   * Simple search (fallback, no embeddings)
   */
  searchFacts(query: string, category?: string): Fact[] {
    const searchPattern = `%${query}%`;

    if (category) {
      const stmt = this.db.prepare(`
        SELECT id, category, subject, content, created_at, updated_at
        FROM facts
        WHERE category = ? AND (content LIKE ? OR subject LIKE ?)
        ORDER BY updated_at DESC
      `);
      return stmt.all(category, searchPattern, searchPattern) as Fact[];
    }

    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      WHERE content LIKE ? OR subject LIKE ? OR category LIKE ?
      ORDER BY updated_at DESC
    `);
    return stmt.all(searchPattern, searchPattern, searchPattern) as Fact[];
  }

  getFactsByCategory(category: string): Fact[] {
    const stmt = this.db.prepare(`
      SELECT id, category, subject, content, created_at, updated_at
      FROM facts
      WHERE category = ?
      ORDER BY subject, updated_at DESC
    `);
    return stmt.all(category) as Fact[];
  }

  getFactCategories(): string[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT category FROM facts ORDER BY category
    `);
    const rows = stmt.all() as { category: string }[];
    return rows.map(r => r.category);
  }

  // ============ CRON JOB METHODS ============

  saveCronJob(
    name: string,
    schedule: string,
    prompt: string,
    channel: string = 'default'
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO cron_jobs (name, schedule, prompt, channel)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        schedule = excluded.schedule,
        prompt = excluded.prompt,
        channel = excluded.channel
    `);
    const result = stmt.run(name, schedule, prompt, channel);
    return result.lastInsertRowid as number;
  }

  getCronJobs(enabledOnly: boolean = true): CronJob[] {
    const query = enabledOnly
      ? 'SELECT * FROM cron_jobs WHERE enabled = 1'
      : 'SELECT * FROM cron_jobs';
    const stmt = this.db.prepare(query);
    const rows = stmt.all() as Array<{
      id: number;
      name: string;
      schedule: string;
      prompt: string;
      channel: string;
      enabled: number;
    }>;
    return rows.map(r => ({ ...r, enabled: r.enabled === 1 }));
  }

  setCronJobEnabled(name: string, enabled: boolean): boolean {
    const stmt = this.db.prepare(`
      UPDATE cron_jobs SET enabled = ? WHERE name = ?
    `);
    const result = stmt.run(enabled ? 1 : 0, name);
    return result.changes > 0;
  }

  deleteCronJob(name: string): boolean {
    const stmt = this.db.prepare('DELETE FROM cron_jobs WHERE name = ?');
    const result = stmt.run(name);
    return result.changes > 0;
  }

  // ============ UTILITY METHODS ============

  getStats(): {
    messageCount: number;
    factCount: number;
    cronJobCount: number;
    summaryCount: number;
    estimatedTokens: number;
    embeddedFactCount: number;
  } {
    const messages = this.db.prepare('SELECT COUNT(*) as c, SUM(token_count) as t FROM messages').get() as { c: number; t: number };
    const facts = this.db.prepare('SELECT COUNT(*) as c FROM facts').get() as { c: number };
    const cronJobs = this.db.prepare('SELECT COUNT(*) as c FROM cron_jobs').get() as { c: number };
    const summaries = this.db.prepare('SELECT COUNT(*) as c FROM summaries').get() as { c: number };
    const embeddedFacts = this.db.prepare('SELECT COUNT(DISTINCT fact_id) as c FROM chunks WHERE embedding IS NOT NULL').get() as { c: number };

    return {
      messageCount: messages.c,
      factCount: facts.c,
      cronJobCount: cronJobs.c,
      summaryCount: summaries.c,
      estimatedTokens: messages.t || 0,
      embeddedFactCount: embeddedFacts.c,
    };
  }

  clearConversation(): void {
    this.db.exec('DELETE FROM messages');
    this.db.exec('DELETE FROM summaries');
  }

  close(): void {
    this.db.close();
  }
}

export { MemoryManager as MemoryStore };
