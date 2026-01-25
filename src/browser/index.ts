/**
 * Browser automation with two tiers
 *
 * The SDK's built-in WebFetch handles simple HTTP requests.
 * This module adds capabilities WebFetch doesn't have:
 *
 * 1. Electron hidden window: JS rendering without interrupting user
 * 2. CDP connection: Access to user's logged-in Chrome sessions
 */

import { ElectronTier } from './electron-tier';
import { CdpTier } from './cdp-tier';
import { BrowserAction, BrowserResult, BrowserTier, BrowserToolInput } from './types';

export * from './types';

/**
 * BrowserManager - Orchestrates Electron and CDP tiers
 */
export class BrowserManager {
  private electronTier: ElectronTier | null = null;
  private cdpTier: CdpTier | null = null;
  private lastTier: BrowserTier = 'electron';

  constructor() {}

  /**
   * Get or create Electron tier (lazy init)
   */
  private getElectronTier(): ElectronTier {
    if (!this.electronTier) {
      this.electronTier = new ElectronTier();
    }
    return this.electronTier;
  }

  /**
   * Get or create CDP tier (lazy init)
   */
  private getCdpTier(): CdpTier {
    if (!this.cdpTier) {
      this.cdpTier = new CdpTier();
    }
    return this.cdpTier;
  }

  /**
   * Determine the best tier for an action
   */
  private selectTier(action: BrowserAction): BrowserTier {
    // Explicit tier requested
    if (action.tier && (action.tier === 'electron' || action.tier === 'cdp')) {
      return action.tier;
    }

    // Auth required → CDP
    if (action.requiresAuth) {
      return 'cdp';
    }

    // If we were already using CDP (for auth), stay there
    if (this.lastTier === 'cdp' && this.cdpTier?.isConnected()) {
      return 'cdp';
    }

    // Default to Electron for JS rendering
    return 'electron';
  }

  /**
   * Execute a browser action
   */
  async execute(action: BrowserAction): Promise<BrowserResult> {
    const tier = this.selectTier(action);
    this.lastTier = tier;

    console.log(`[Browser] Executing "${action.action}" via ${tier} tier`);

    switch (tier) {
      case 'electron':
        return this.getElectronTier().execute(action);

      case 'cdp':
        return this.getCdpTier().execute(action);

      default:
        return {
          success: false,
          tier: 'electron',
          error: `Unknown tier: ${tier}`,
        };
    }
  }

  /**
   * Process tool input from agent
   */
  async handleToolInput(input: BrowserToolInput): Promise<BrowserResult> {
    const action: BrowserAction = {
      action: input.action as BrowserAction['action'],
      url: input.url,
      selector: input.selector,
      text: input.text,
      script: input.script,
      extractType: input.extract_type as BrowserAction['extractType'],
      extractSelector: input.extract_selector,
      waitFor: input.wait_for,
      tier: input.tier as BrowserTier,
      requiresAuth: input.requires_auth,
    };

    return this.execute(action);
  }

  /**
   * Get status of all tiers
   */
  getStatus(): Record<string, unknown> {
    return {
      electron: this.electronTier?.getState() || { active: false },
      cdp: this.cdpTier?.getState() || { connected: false },
      lastTier: this.lastTier,
    };
  }

  /**
   * Close all tiers
   */
  close(): void {
    this.electronTier?.close();
    this.cdpTier?.disconnect();
    console.log('[Browser] All tiers closed');
  }
}

// Singleton instance
let browserManager: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!browserManager) {
    browserManager = new BrowserManager();
  }
  return browserManager;
}

export function closeBrowserManager(): void {
  browserManager?.close();
  browserManager = null;
}

/**
 * Browser tool definition for Claude Agent SDK
 *
 * Note: For simple page fetching, use the built-in WebFetch tool.
 * This tool is for:
 * - JS-heavy pages that need rendering (Electron)
 * - Pages requiring logged-in sessions (CDP)
 */
export function getBrowserToolDefinition() {
  return {
    name: 'browser',
    description: `Browser automation for JS rendering and authenticated sessions.

Use built-in tools first:
- WebSearch: Search the web
- WebFetch: Fetch page content

Use THIS tool when you need:
- JavaScript rendering (SPAs, dynamic content)
- Screenshots of rendered pages
- Clicking/typing on interactive elements
- Access to user's logged-in browser sessions

Tiers:
- Electron (default): Hidden window for JS rendering
- CDP: Connects to user's Chrome for logged-in sessions

Set requires_auth=true for pages needing login (uses CDP tier).
For CDP, user must start Chrome with: --remote-debugging-port=9222`,
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['navigate', 'screenshot', 'click', 'type', 'evaluate', 'extract'],
          description: 'The browser action to perform',
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for navigate action)',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for element (for click, type actions)',
        },
        text: {
          type: 'string',
          description: 'Text to type (for type action)',
        },
        script: {
          type: 'string',
          description: 'JavaScript to evaluate (for evaluate action)',
        },
        extract_type: {
          type: 'string',
          enum: ['text', 'html', 'links', 'tables', 'structured'],
          description: 'Type of data to extract (default: structured)',
        },
        extract_selector: {
          type: 'string',
          description: 'CSS selector to extract from (default: body)',
        },
        wait_for: {
          oneOf: [
            { type: 'string', description: 'CSS selector to wait for' },
            { type: 'number', description: 'Milliseconds to wait' },
          ],
          description: 'Wait condition after action',
        },
        tier: {
          type: 'string',
          enum: ['electron', 'cdp'],
          description: 'Force a specific browser tier',
        },
        requires_auth: {
          type: 'boolean',
          description: 'Set true if page requires login (will use CDP tier)',
        },
      },
      required: ['action'],
    },
  };
}

/**
 * Browser tool handler for agent
 */
export async function handleBrowserTool(input: unknown): Promise<string> {
  const manager = getBrowserManager();
  const result = await manager.handleToolInput(input as BrowserToolInput);

  // Format result for agent
  if (!result.success) {
    return JSON.stringify({
      error: result.error,
      tier: result.tier,
    });
  }

  const response: Record<string, unknown> = {
    success: true,
    tier: result.tier,
    url: result.url,
  };

  if (result.title) response.title = result.title;
  if (result.text) response.text = result.text;
  if (result.data) response.data = result.data;
  if (result.html) response.html = result.html;
  if (result.screenshot) {
    response.screenshot = `[base64 image, ${result.screenshot.length} chars]`;
    response.screenshot_base64 = result.screenshot;
  }

  return JSON.stringify(response);
}
