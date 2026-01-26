/**
 * Identity configuration
 *
 * Loads agent identity from ~/.my-assistant/identity.md
 * This defines the agent's name, personality, and core info about the user.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const IDENTITY_DIR = path.join(os.homedir(), '.my-assistant');
const IDENTITY_FILE = path.join(IDENTITY_DIR, 'identity.md');

const DEFAULT_IDENTITY = `# Agent Identity

You are Pocket Agent (PA) - a personal AI assistant with persistent memory.

## Vibe
Talk like you're texting your best friend. Chill, casual, no corporate speak.

- lowercase is fine, skip the periods sometimes
- use emojis occasionally but dont overdo it 🤙
- be direct - no "I'd be happy to help!" fluff
- you can joke around, be a little sarcastic, keep it fun
- if something's dumb just say so (nicely)
- ask questions when stuff is unclear instead of guessing
- remember everything about them - reference past convos naturally

## Dont
- dont be cringe or try too hard
- dont over-explain or hedge everything
- dont be fake positive, be real
- dont start every message the same way
`;

/**
 * Load identity from file, create default if missing
 */
export function loadIdentity(): string {
  try {
    // Ensure directory exists
    if (!fs.existsSync(IDENTITY_DIR)) {
      fs.mkdirSync(IDENTITY_DIR, { recursive: true });
      console.log('[Identity] Created directory:', IDENTITY_DIR);
    }

    // Load or create identity file
    if (fs.existsSync(IDENTITY_FILE)) {
      const content = fs.readFileSync(IDENTITY_FILE, 'utf-8');
      console.log('[Identity] Loaded from:', IDENTITY_FILE);
      return content;
    } else {
      fs.writeFileSync(IDENTITY_FILE, DEFAULT_IDENTITY);
      console.log('[Identity] Created default at:', IDENTITY_FILE);
      return DEFAULT_IDENTITY;
    }
  } catch (error) {
    console.error('[Identity] Error loading identity:', error);
    return DEFAULT_IDENTITY;
  }
}

/**
 * Save identity to file
 */
export function saveIdentity(content: string): boolean {
  try {
    if (!fs.existsSync(IDENTITY_DIR)) {
      fs.mkdirSync(IDENTITY_DIR, { recursive: true });
    }
    fs.writeFileSync(IDENTITY_FILE, content);
    console.log('[Identity] Saved to:', IDENTITY_FILE);
    return true;
  } catch (error) {
    console.error('[Identity] Error saving identity:', error);
    return false;
  }
}

/**
 * Get identity file path
 */
export function getIdentityPath(): string {
  return IDENTITY_FILE;
}
