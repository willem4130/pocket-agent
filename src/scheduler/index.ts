import cron, { ScheduledTask } from 'node-cron';
import { AgentManager } from '../agent';
import { MemoryManager, CronJob } from '../memory';
import type { TelegramBot } from '../channels/telegram';

export interface ScheduledJob {
  id: number;
  name: string;
  schedule: string;
  prompt: string;
  channel: string;
  recipient?: string; // Chat ID for telegram, etc.
  enabled: boolean;
}

export interface JobResult {
  jobName: string;
  response: string;
  channel: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

/**
 * CronScheduler - Manages scheduled jobs from SQLite
 *
 * Loads jobs from cron_jobs table, runs them on schedule,
 * calls AgentManager.processMessage() and routes responses.
 */
export class CronScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private jobs: Map<string, ScheduledJob> = new Map();
  private memory: MemoryManager | null = null;
  private telegramBot: TelegramBot | null = null;
  private jobHistory: JobResult[] = [];
  private maxHistorySize: number = 100;

  constructor() {}

  /**
   * Initialize scheduler with memory manager and load jobs
   */
  async initialize(memory: MemoryManager): Promise<void> {
    this.memory = memory;
    await this.loadJobsFromDatabase();
    console.log(`[Scheduler] Initialized with ${this.jobs.size} jobs`);
  }

  /**
   * Set Telegram bot for routing messages
   */
  setTelegramBot(bot: TelegramBot): void {
    this.telegramBot = bot;
    console.log('[Scheduler] Telegram bot connected');
  }

  /**
   * Load all enabled jobs from database and schedule them
   */
  async loadJobsFromDatabase(): Promise<void> {
    if (!this.memory) {
      console.error('[Scheduler] Memory not initialized');
      return;
    }

    // Stop all existing tasks
    this.stopAll();

    // Load jobs from SQLite
    const dbJobs = this.memory.getCronJobs(true); // enabled only

    for (const dbJob of dbJobs) {
      const job: ScheduledJob = {
        id: dbJob.id,
        name: dbJob.name,
        schedule: dbJob.schedule,
        prompt: dbJob.prompt,
        channel: dbJob.channel,
        recipient: this.extractRecipient(dbJob.prompt),
        enabled: dbJob.enabled,
      };

      this.scheduleJob(job);
    }

    console.log(`[Scheduler] Loaded ${dbJobs.length} jobs from database`);
  }

  /**
   * Extract recipient from prompt if specified (format: @recipient: prompt)
   */
  private extractRecipient(prompt: string): string | undefined {
    const match = prompt.match(/^@(\S+):\s*/);
    return match ? match[1] : undefined;
  }

  /**
   * Schedule a single job
   */
  scheduleJob(job: ScheduledJob): boolean {
    if (!cron.validate(job.schedule)) {
      console.error(`[Scheduler] Invalid cron expression for ${job.name}: ${job.schedule}`);
      return false;
    }

    // Stop existing task with same name
    this.stopJob(job.name);

    const task = cron.schedule(job.schedule, async () => {
      await this.executeJob(job);
    });

    this.tasks.set(job.name, task);
    this.jobs.set(job.name, job);

    console.log(`[Scheduler] Scheduled: ${job.name} (${job.schedule}) → ${job.channel}`);
    return true;
  }

  /**
   * Execute a job
   */
  private async executeJob(job: ScheduledJob): Promise<void> {
    console.log(`[Scheduler] Executing: ${job.name}`);

    const result: JobResult = {
      jobName: job.name,
      response: '',
      channel: job.channel,
      success: false,
      timestamp: new Date(),
    };

    if (!AgentManager.isInitialized()) {
      result.error = 'AgentManager not initialized';
      this.addToHistory(result);
      console.error(`[Scheduler] ${result.error}`);
      return;
    }

    try {
      // Clean prompt (remove recipient prefix if present)
      const cleanPrompt = job.prompt.replace(/^@\S+:\s*/, '');

      // Process through agent
      const agentResult = await AgentManager.processMessage(
        `[Scheduled Task: ${job.name}] ${cleanPrompt}`,
        `cron:${job.name}`
      );

      result.response = agentResult.response;
      result.success = true;

      // Route response to channel
      await this.routeResponse(job, result.response);

    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Scheduler] Job ${job.name} failed:`, result.error);
    }

    this.addToHistory(result);
  }

  /**
   * Route response to appropriate channel
   */
  private async routeResponse(job: ScheduledJob, response: string): Promise<void> {
    switch (job.channel) {
      case 'telegram':
        if (this.telegramBot) {
          if (job.recipient) {
            // Send to specific chat
            const chatId = parseInt(job.recipient, 10);
            if (!isNaN(chatId)) {
              await this.telegramBot.sendMessage(chatId, `📅 ${job.name}\n\n${response}`);
            }
          } else {
            // Broadcast to all active chats
            await this.telegramBot.broadcast(`📅 ${job.name}\n\n${response}`);
          }
        } else {
          console.warn(`[Scheduler] Telegram not available for job: ${job.name}`);
        }
        break;

      case 'desktop':
      case 'default':
        // Emit event for desktop notification
        this.emitDesktopNotification(job.name, response);
        break;

      default:
        console.log(`[Scheduler] Response for ${job.name} (${job.channel}): ${response.slice(0, 100)}...`);
    }
  }

  /**
   * Emit desktop notification (handled by main process)
   */
  private emitDesktopNotification(title: string, body: string): void {
    // Use global event emitter pattern
    if (this.onNotification) {
      this.onNotification(title, body);
    }
  }

  /**
   * Set notification handler
   */
  setNotificationHandler(handler: (title: string, body: string) => void): void {
    this.onNotification = handler;
  }

  private onNotification?: (title: string, body: string) => void;

  /**
   * Add result to history
   */
  private addToHistory(result: JobResult): void {
    this.jobHistory.unshift(result);
    if (this.jobHistory.length > this.maxHistorySize) {
      this.jobHistory.pop();
    }
  }

  /**
   * Create a new job and save to database
   */
  async createJob(
    name: string,
    schedule: string,
    prompt: string,
    channel: string = 'default'
  ): Promise<boolean> {
    if (!this.memory) return false;

    if (!cron.validate(schedule)) {
      console.error(`[Scheduler] Invalid cron: ${schedule}`);
      return false;
    }

    // Save to database
    const id = this.memory.saveCronJob(name, schedule, prompt, channel);

    // Schedule it
    const job: ScheduledJob = {
      id,
      name,
      schedule,
      prompt,
      channel,
      recipient: this.extractRecipient(prompt),
      enabled: true,
    };

    return this.scheduleJob(job);
  }

  /**
   * Delete a job
   */
  deleteJob(name: string): boolean {
    this.stopJob(name);

    if (this.memory) {
      return this.memory.deleteCronJob(name);
    }

    return false;
  }

  /**
   * Stop a specific job
   */
  stopJob(name: string): boolean {
    const task = this.tasks.get(name);
    if (task) {
      task.stop();
      this.tasks.delete(name);
      this.jobs.delete(name);
      console.log(`[Scheduler] Stopped: ${name}`);
      return true;
    }
    return false;
  }

  /**
   * Stop all jobs
   */
  stopAll(): void {
    for (const [name, task] of this.tasks) {
      task.stop();
      console.log(`[Scheduler] Stopped: ${name}`);
    }
    this.tasks.clear();
    this.jobs.clear();
  }

  /**
   * Enable/disable a job
   */
  setJobEnabled(name: string, enabled: boolean): boolean {
    if (!this.memory) return false;

    const success = this.memory.setCronJobEnabled(name, enabled);

    if (success) {
      if (enabled) {
        // Reload from database to reschedule
        const dbJobs = this.memory.getCronJobs(false);
        const dbJob = dbJobs.find(j => j.name === name);
        if (dbJob) {
          this.scheduleJob({
            id: dbJob.id,
            name: dbJob.name,
            schedule: dbJob.schedule,
            prompt: dbJob.prompt,
            channel: dbJob.channel,
            recipient: this.extractRecipient(dbJob.prompt),
            enabled: true,
          });
        }
      } else {
        this.stopJob(name);
      }
    }

    return success;
  }

  /**
   * Run a job immediately (for testing)
   */
  async runJobNow(name: string): Promise<JobResult | null> {
    const job = this.jobs.get(name);
    if (!job) {
      console.error(`[Scheduler] Job not found: ${name}`);
      return null;
    }

    await this.executeJob(job);
    return this.jobHistory[0] || null;
  }

  /**
   * Get all jobs
   */
  getJobs(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Get all jobs including disabled ones
   */
  getAllJobs(): CronJob[] {
    return this.memory?.getCronJobs(false) || [];
  }

  /**
   * Get job history
   */
  getHistory(limit: number = 20): JobResult[] {
    return this.jobHistory.slice(0, limit);
  }

  /**
   * Check if a job is running
   */
  isRunning(name: string): boolean {
    return this.tasks.has(name);
  }

  /**
   * Get scheduler stats
   */
  getStats(): { activeJobs: number; totalExecutions: number; lastExecution?: Date } {
    return {
      activeJobs: this.tasks.size,
      totalExecutions: this.jobHistory.length,
      lastExecution: this.jobHistory[0]?.timestamp,
    };
  }
}

// Singleton instance
let schedulerInstance: CronScheduler | null = null;

export function getScheduler(): CronScheduler | null {
  return schedulerInstance;
}

export function createScheduler(): CronScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new CronScheduler();
  }
  return schedulerInstance;
}
