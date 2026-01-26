/**
 * Task/Todo tools for the agent
 *
 * MCP tools for managing tasks with priorities and due dates
 *
 * Uses a shared database connection to prevent SQLite locks
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Shared database connection (singleton pattern to prevent locks)
let sharedDb: Database.Database | null = null;
let dbInitialized = false;

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

/**
 * Get or create shared database connection
 * Uses WAL mode for better concurrent access
 */
function getDb(): Database.Database {
  if (sharedDb && !dbInitialized) {
    // Connection exists but table not initialized
    ensureTable(sharedDb);
    dbInitialized = true;
    return sharedDb;
  }

  if (sharedDb) {
    return sharedDb;
  }

  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error('Database not found. Start Pocket Agent first.');
  }

  console.log('[TaskTools] Opening shared database connection');
  sharedDb = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  sharedDb.pragma('journal_mode = WAL');
  sharedDb.pragma('busy_timeout = 5000'); // Wait up to 5s if locked

  ensureTable(sharedDb);
  dbInitialized = true;

  return sharedDb;
}

/**
 * Close shared database connection (call on app shutdown)
 */
export function closeTaskDb(): void {
  if (sharedDb) {
    console.log('[TaskTools] Closing shared database connection');
    sharedDb.close();
    sharedDb = null;
    dbInitialized = false;
  }
}

function parseDateTime(input: string): string | null {
  const now = new Date();

  // "today", "tomorrow", "monday", etc. with optional time
  const dayMatch = input.match(
    /^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i
  );
  if (dayMatch) {
    const [, dayStr, hourStr, minStr, ampm] = dayMatch;
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

    if (hourStr) {
      let hour = parseInt(hourStr, 10);
      const min = minStr ? parseInt(minStr, 10) : 0;
      if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;
      targetDate.setHours(hour, min, 0, 0);
    } else {
      targetDate.setHours(23, 59, 0, 0); // End of day
    }

    return targetDate.toISOString();
  }

  // "in X days/hours/weeks"
  const inMatch = input.match(/^in\s+(\d+)\s+(day|hour|week)s?$/i);
  if (inMatch) {
    const [, amount, unit] = inMatch;
    const ms =
      parseInt(amount, 10) *
      (unit.toLowerCase() === 'hour' ? 3600000 : unit.toLowerCase() === 'week' ? 604800000 : 86400000);
    return new Date(now.getTime() + ms).toISOString();
  }

  // Try direct parse
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return null;
}

function formatDateTime(isoString: string | null): string | null {
  if (!isoString) return null;
  const date = new Date(isoString);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  if (isToday) {
    return `Today ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  }
  if (isTomorrow) {
    return `Tomorrow ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  }

  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function ensureTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed')),
      reminder_minutes INTEGER,
      reminded INTEGER DEFAULT 0,
      channel TEXT DEFAULT 'desktop',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);
}

// ============================================================================
// Task Add Tool
// ============================================================================

export function getTaskAddToolDefinition() {
  return {
    name: 'task_add',
    description: `Add a new task/todo item with optional due date, priority, and reminder.

Use when user wants to:
- Create a todo item
- Add something to their task list
- Set a task with a deadline

Priority levels: low, medium (default), high

Examples:
- task_add("Buy groceries")
- task_add("Call mom", due="tomorrow 5pm", priority="high")
- task_add("Submit report", due="friday", reminder_minutes=60)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Optional task description' },
        due: { type: 'string', description: 'Due date (e.g., "tomorrow", "friday 5pm")' },
        priority: { type: 'string', description: 'Priority: low, medium, high (default: medium)' },
        reminder_minutes: { type: 'number', description: 'Minutes before due to remind' },
        channel: { type: 'string', description: 'Where to send reminder: desktop or telegram' },
      },
      required: ['title'],
    },
  };
}

export async function handleTaskAddTool(input: unknown): Promise<string> {
  const params = input as {
    title: string;
    description?: string;
    due?: string;
    priority?: string;
    reminder_minutes?: number;
    channel?: string;
  };

  if (!params.title) {
    return JSON.stringify({ error: 'title is required' });
  }

  const dueDate = params.due ? parseDateTime(params.due) : null;
  if (params.due && !dueDate) {
    return JSON.stringify({ error: `Could not parse due date: "${params.due}"` });
  }

  const priority = params.priority?.toLowerCase() || 'medium';
  if (!['low', 'medium', 'high'].includes(priority)) {
    return JSON.stringify({ error: 'Priority must be: low, medium, or high' });
  }

  const channel = params.channel || 'desktop';

  try {
    const db = getDb();

    const result = db.prepare(`
      INSERT INTO tasks (title, description, due_date, priority, reminder_minutes, channel)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(params.title, params.description || null, dueDate, priority, params.reminder_minutes || null, channel);

    return JSON.stringify({
      success: true,
      id: result.lastInsertRowid,
      title: params.title,
      due: dueDate ? formatDateTime(dueDate) : null,
      priority,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_add failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task List Tool
// ============================================================================

export function getTaskListToolDefinition() {
  return {
    name: 'task_list',
    description: `List tasks/todos. Optionally filter by status.

Status options: pending (default), completed, in_progress, all

Examples:
- task_list() - pending tasks
- task_list(status="all")
- task_list(status="completed")`,
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter by status: pending, completed, in_progress, all' },
      },
      required: [],
    },
  };
}

export async function handleTaskListTool(input: unknown): Promise<string> {
  const params = input as { status?: string };
  const statusFilter = params.status || 'pending';

  try {
    const db = getDb();

    let query = 'SELECT * FROM tasks';
    const queryParams: string[] = [];

    if (statusFilter !== 'all') {
      query += ' WHERE status = ?';
      queryParams.push(statusFilter);
    }

    query +=
      " ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC NULLS LAST";

    const tasks = db.prepare(query).all(...queryParams) as Array<{
      id: number;
      title: string;
      due_date: string | null;
      priority: string;
      status: string;
      reminder_minutes: number | null;
    }>;

    return JSON.stringify({
      success: true,
      filter: statusFilter,
      count: tasks.length,
      tasks: tasks.map(t => ({
        id: t.id,
        title: t.title,
        due: formatDateTime(t.due_date),
        priority: t.priority,
        status: t.status,
      })),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_list failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task Complete Tool
// ============================================================================

export function getTaskCompleteToolDefinition() {
  return {
    name: 'task_complete',
    description: 'Mark a task as completed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID to complete' },
      },
      required: ['id'],
    },
  };
}

export async function handleTaskCompleteTool(input: unknown): Promise<string> {
  const params = input as { id: number };

  if (!params.id) {
    return JSON.stringify({ error: 'id is required' });
  }

  try {
    const db = getDb();

    const result = db
      .prepare(`UPDATE tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?`)
      .run(params.id);

    if (result.changes > 0) {
      return JSON.stringify({ success: true, message: `Task ${params.id} completed` });
    } else {
      return JSON.stringify({ success: false, error: `Task ${params.id} not found` });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_complete failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task Delete Tool
// ============================================================================

export function getTaskDeleteToolDefinition() {
  return {
    name: 'task_delete',
    description: 'Delete a task by ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Task ID to delete' },
      },
      required: ['id'],
    },
  };
}

export async function handleTaskDeleteTool(input: unknown): Promise<string> {
  const params = input as { id: number };

  if (!params.id) {
    return JSON.stringify({ error: 'id is required' });
  }

  try {
    const db = getDb();

    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(params.id);
    if (result.changes > 0) {
      return JSON.stringify({ success: true, message: `Task ${params.id} deleted` });
    } else {
      return JSON.stringify({ success: false, error: `Task ${params.id} not found` });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_delete failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Task Due Tool
// ============================================================================

export function getTaskDueToolDefinition() {
  return {
    name: 'task_due',
    description: `Get tasks due within the next N hours, including overdue tasks.

Examples:
- task_due() - due in next 24 hours (default)
- task_due(hours=48)`,
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: { type: 'number', description: 'Hours to look ahead (default: 24)' },
      },
      required: [],
    },
  };
}

export async function handleTaskDueTool(input: unknown): Promise<string> {
  const params = input as { hours?: number };
  const hours = params.hours ?? 24;

  try {
    const db = getDb();

    const now = new Date();
    const later = new Date(now.getTime() + hours * 3600000);

    const tasks = db.prepare(`
      SELECT * FROM tasks
      WHERE status != 'completed' AND due_date IS NOT NULL AND due_date <= ?
      ORDER BY due_date ASC
    `).all(later.toISOString()) as Array<{
      id: number;
      title: string;
      due_date: string;
      priority: string;
      status: string;
    }>;

    const overdue = tasks.filter(t => new Date(t.due_date) < now);
    const upcoming = tasks.filter(t => new Date(t.due_date) >= now);

    return JSON.stringify({
      success: true,
      hours,
      overdue: overdue.map(t => ({
        id: t.id,
        title: t.title,
        due: formatDateTime(t.due_date),
        priority: t.priority,
      })),
      upcoming: upcoming.map(t => ({
        id: t.id,
        title: t.title,
        due: formatDateTime(t.due_date),
        priority: t.priority,
      })),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TaskTools] task_due failed:', errorMsg);
    return JSON.stringify({ error: errorMsg });
  }
}

// ============================================================================
// Export all task tools
// ============================================================================

export function getTaskTools() {
  return [
    { ...getTaskAddToolDefinition(), handler: handleTaskAddTool },
    { ...getTaskListToolDefinition(), handler: handleTaskListTool },
    { ...getTaskCompleteToolDefinition(), handler: handleTaskCompleteTool },
    { ...getTaskDeleteToolDefinition(), handler: handleTaskDeleteTool },
    { ...getTaskDueToolDefinition(), handler: handleTaskDueTool },
  ];
}
