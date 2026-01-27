/**
 * Scheduler tools for the agent
 *
 * Allows the agent to create, list, and manage scheduled tasks/reminders
 * Supports three schedule types:
 * - cron: Standard cron expressions (e.g., "0 9 * * *")
 * - at: One-time execution (e.g., "tomorrow 3pm", "in 10 minutes")
 * - every: Recurring intervals (e.g., "30m", "2h", "1d")
 */

import { getScheduler } from '../scheduler';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

function getDbPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const possiblePaths = [
    path.join(homeDir, 'Library/Application Support/pocket-agent/pocket-agent.db'),
    path.join(homeDir, '.config/pocket-agent/pocket-agent.db'),
    path.join(homeDir, 'AppData/Roaming/pocket-agent/pocket-agent.db'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

// Parse schedule string and determine type
function parseSchedule(input: string): {
  type: 'cron' | 'at' | 'every';
  schedule?: string;
  runAt?: string;
  intervalMs?: number;
} | null {
  const trimmed = input.trim();

  // Check for "every" pattern: 30m, 2h, 1d, etc.
  const everyMatch = trimmed.match(/^(?:every\s+)?(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (everyMatch) {
    const [, amount, unit] = everyMatch;
    const num = parseInt(amount, 10);
    let ms: number;
    if (unit.startsWith('m')) ms = num * 60 * 1000;
    else if (unit.startsWith('h')) ms = num * 60 * 60 * 1000;
    else ms = num * 24 * 60 * 60 * 1000;
    return { type: 'every', intervalMs: ms };
  }

  // Check for "at" pattern: specific datetime
  const atTime = parseDateTime(trimmed);
  if (atTime) {
    // If it's a relative/specific time, treat as "at"
    if (trimmed.match(/^(today|tomorrow|in\s+\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)) {
      return { type: 'at', runAt: atTime };
    }
  }

  // Check for cron expression (5 parts)
  const parts = trimmed.split(/\s+/);
  if (parts.length === 5 && validateCron(trimmed)) {
    return { type: 'cron', schedule: trimmed };
  }

  // Try parsing as datetime for "at" type
  if (atTime) {
    return { type: 'at', runAt: atTime };
  }

  return null;
}

// Parse datetime string to ISO format
function parseDateTime(input: string): string | null {
  const now = new Date();

  // "today 3pm", "tomorrow 9am", "monday 2pm"
  const relativeMatch = input.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (relativeMatch) {
    const [, dayStr, hourStr, minStr, ampm] = relativeMatch;
    const targetDate = new Date(now);

    if (dayStr.toLowerCase() === 'tomorrow') {
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (dayStr.toLowerCase() !== 'today') {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = days.indexOf(dayStr.toLowerCase());
      const currentDay = targetDate.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7;
      targetDate.setDate(targetDate.getDate() + daysToAdd);
    }

    let hour = parseInt(hourStr, 10);
    const min = minStr ? parseInt(minStr, 10) : 0;
    if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;

    targetDate.setHours(hour, min, 0, 0);
    return targetDate.toISOString();
  }

  // "in 2 hours", "in 30 minutes", "in 3 days"
  const inMatch = input.match(/^in\s+(\d+)\s*(hour|hr|minute|min|day|d)s?$/i);
  if (inMatch) {
    const [, amount, unit] = inMatch;
    const num = parseInt(amount, 10);
    let ms: number;
    if (unit.toLowerCase().startsWith('hour') || unit.toLowerCase() === 'hr') {
      ms = num * 3600000;
    } else if (unit.toLowerCase().startsWith('min')) {
      ms = num * 60000;
    } else {
      ms = num * 86400000;
    }
    return new Date(now.getTime() + ms).toISOString();
  }

  // Try direct parse (ISO format, etc.)
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime()) && parsed > now) {
    return parsed.toISOString();
  }

  return null;
}

// Validate cron expression
function validateCron(schedule: string): boolean {
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day
    [1, 12],  // month
    [0, 7],   // weekday
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    if (part === '*') continue;
    if (part.includes('/')) continue;
    if (part.includes('-')) continue;
    if (part.includes(',')) continue;

    const num = parseInt(part, 10);
    if (isNaN(num) || num < ranges[i][0] || num > ranges[i][1]) {
      return false;
    }
  }

  return true;
}

// Calculate next run time
function calculateNextRun(type: string, schedule: string | null, runAt: string | null, intervalMs: number | null): string | null {
  const now = new Date();

  if (type === 'at' && runAt) {
    const runDate = new Date(runAt);
    return runDate > now ? runAt : null;
  }

  if (type === 'every' && intervalMs) {
    return new Date(now.getTime() + intervalMs).toISOString();
  }

  if (type === 'cron' && schedule) {
    const parts = schedule.split(/\s+/);
    const [min, hour] = parts;
    const next = new Date(now);
    next.setSeconds(0, 0);

    if (min !== '*') next.setMinutes(parseInt(min, 10));
    if (hour !== '*') next.setHours(parseInt(hour, 10));

    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next.toISOString();
  }

  return null;
}

function formatDateTime(isoString: string | null): string | null {
  if (!isoString) return null;
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)}h`;
  return `${Math.round(ms / 86400000)}d`;
}

/**
 * Schedule task tool definition
 */
export function getScheduleTaskToolDefinition() {
  return {
    name: 'schedule_task',
    description: `Create a scheduled task or reminder.

Supports THREE schedule formats:
1. Natural language one-time: "in 10 minutes", "tomorrow 3pm", "monday 9am"
2. Recurring intervals: "30m", "2h", "1d" (every 30 min, 2 hours, 1 day)
3. Cron expressions: "0 9 * * *" (minute hour day month weekday)

Use this when the user asks to:
- Set a reminder ("remind me in 10 minutes")
- Schedule a one-time notification ("tomorrow at 3pm")
- Create a recurring task ("every 2 hours")

Examples:
- "in 10 minutes" = One-time, 10 minutes from now
- "tomorrow 3pm" = One-time, tomorrow at 3:00 PM
- "monday 9am" = One-time, next Monday at 9:00 AM
- "30m" = Every 30 minutes
- "2h" = Every 2 hours
- "0 9 * * *" = Every day at 9:00 AM (cron)
- "0 9 * * 1-5" = Every weekday at 9:00 AM (cron)

Channels: "desktop" (notification), "telegram" (if configured)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for this scheduled task (e.g., "standup_reminder")',
        },
        schedule: {
          type: 'string',
          description: 'When to run: "in 10 minutes", "tomorrow 3pm", "30m", "2h", or cron "0 9 * * *"',
        },
        prompt: {
          type: 'string',
          description: 'What the agent should do when triggered (e.g., "Remind me to take a break")',
        },
        channel: {
          type: 'string',
          description: 'Where to send: "desktop" or "telegram" (default: desktop)',
        },
      },
      required: ['name', 'schedule', 'prompt'],
    },
  };
}

/**
 * Schedule task tool handler
 * Now supports natural language scheduling in addition to cron
 */
export async function handleScheduleTaskTool(input: unknown): Promise<string> {
  const { name, schedule, prompt, channel } = input as {
    name: string;
    schedule: string;
    prompt: string;
    channel?: string;
  };

  if (!name || !schedule || !prompt) {
    return JSON.stringify({ error: 'Missing required fields: name, schedule, prompt' });
  }

  console.log(`[SchedulerTool] Creating task: ${name} (${schedule})`);

  // Parse the schedule string
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return JSON.stringify({
      error: `Could not parse schedule: "${schedule}"`,
      hint: 'Use: "in 10 minutes", "tomorrow 3pm", "30m", "2h", or cron "0 9 * * *"',
    });
  }

  try {
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) {
      return JSON.stringify({ error: 'Database not found. Start Pocket Agent first.' });
    }

    const db = new Database(dbPath);

    // Ensure table has the new columns
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN schedule_type TEXT DEFAULT 'cron'`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN run_at TEXT`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN interval_ms INTEGER`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER DEFAULT 0`);
    } catch { /* column exists */ }
    try {
      db.exec(`ALTER TABLE cron_jobs ADD COLUMN next_run_at TEXT`);
    } catch { /* column exists */ }

    // Auto-enable delete-after for one-time "at" jobs
    const deleteAfterRun = parsed.type === 'at' ? 1 : 0;

    // Determine default channel: use telegram if configured, otherwise desktop
    let targetChannel = channel;
    if (!targetChannel) {
      // Check if Telegram is configured by looking for activeChatIds in settings
      const telegramSetting = db.prepare(
        "SELECT value FROM settings WHERE key = 'telegram.activeChatIds'"
      ).get() as { value: string } | undefined;

      if (telegramSetting?.value) {
        try {
          const chatIds = JSON.parse(telegramSetting.value);
          if (Array.isArray(chatIds) && chatIds.length > 0) {
            targetChannel = 'telegram';
          }
        } catch {
          // Invalid JSON, fall through to desktop
        }
      }

      if (!targetChannel) {
        targetChannel = 'desktop';
      }
    }

    const nextRunAt = calculateNextRun(
      parsed.type,
      parsed.schedule || null,
      parsed.runAt || null,
      parsed.intervalMs || null
    );

    // Check if exists - update or insert
    const existing = db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(name);

    if (existing) {
      db.prepare(`
        UPDATE cron_jobs SET
          schedule_type = ?, schedule = ?, run_at = ?, interval_ms = ?,
          prompt = ?, channel = ?, enabled = 1,
          delete_after_run = ?, next_run_at = ?,
          updated_at = datetime('now')
        WHERE name = ?
      `).run(
        parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        prompt, targetChannel, deleteAfterRun, nextRunAt, name
      );
    } else {
      db.prepare(`
        INSERT INTO cron_jobs (
          name, schedule_type, schedule, run_at, interval_ms,
          prompt, channel, enabled, delete_after_run, next_run_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        name, parsed.type, parsed.schedule || null, parsed.runAt || null, parsed.intervalMs || null,
        prompt, targetChannel, deleteAfterRun, nextRunAt
      );
    }

    db.close();

    // Build user-friendly schedule description
    let scheduleDesc: string;
    if (parsed.type === 'at') {
      scheduleDesc = `one-time at ${formatDateTime(parsed.runAt!)}`;
    } else if (parsed.type === 'every') {
      scheduleDesc = `every ${formatDuration(parsed.intervalMs!)}`;
    } else {
      scheduleDesc = `cron: ${parsed.schedule}`;
    }

    console.log(`[SchedulerTool] Task created: ${name} (${parsed.type})`);
    return JSON.stringify({
      success: true,
      message: `Scheduled task "${name}" created`,
      name,
      type: parsed.type,
      schedule: scheduleDesc,
      next_run: formatDateTime(nextRunAt),
      one_time: deleteAfterRun === 1,
      channel: targetChannel,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SchedulerTool] Failed to create task: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
}

/**
 * List scheduled tasks tool definition
 */
export function getListScheduledTasksToolDefinition() {
  return {
    name: 'list_scheduled_tasks',
    description: 'List all scheduled tasks and reminders. Shows name, schedule, and status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  };
}

/**
 * List scheduled tasks handler
 */
export async function handleListScheduledTasksTool(): Promise<string> {
  const scheduler = getScheduler();

  if (!scheduler) {
    return JSON.stringify({ error: 'Scheduler not initialized' });
  }

  const jobs = scheduler.getAllJobs();

  if (jobs.length === 0) {
    return JSON.stringify({
      success: true,
      message: 'No scheduled tasks',
      tasks: [],
    });
  }

  return JSON.stringify({
    success: true,
    count: jobs.length,
    tasks: jobs.map(job => ({
      name: job.name,
      schedule: job.schedule,
      prompt: job.prompt,
      channel: job.channel,
      enabled: job.enabled,
    })),
  });
}

/**
 * Delete scheduled task tool definition
 */
export function getDeleteScheduledTaskToolDefinition() {
  return {
    name: 'delete_scheduled_task',
    description: 'Delete a scheduled task or reminder by name.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of the task to delete',
        },
      },
      required: ['name'],
    },
  };
}

/**
 * Delete scheduled task handler
 */
export async function handleDeleteScheduledTaskTool(input: unknown): Promise<string> {
  const scheduler = getScheduler();

  if (!scheduler) {
    return JSON.stringify({ error: 'Scheduler not initialized' });
  }

  const { name } = input as { name: string };

  if (!name) {
    return JSON.stringify({ error: 'Task name is required' });
  }

  const success = scheduler.deleteJob(name);

  if (success) {
    console.log(`[SchedulerTool] Deleted task: ${name}`);
    return JSON.stringify({
      success: true,
      message: `Task "${name}" deleted`,
    });
  } else {
    return JSON.stringify({
      success: false,
      error: `Task "${name}" not found`,
    });
  }
}

/**
 * Get all scheduler tools
 */
export function getSchedulerTools() {
  return [
    {
      ...getScheduleTaskToolDefinition(),
      handler: handleScheduleTaskTool,
    },
    {
      ...getListScheduledTasksToolDefinition(),
      handler: handleListScheduledTasksTool,
    },
    {
      ...getDeleteScheduledTaskToolDefinition(),
      handler: handleDeleteScheduledTaskTool,
    },
  ];
}
