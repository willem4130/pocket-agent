/**
 * CDP (Chrome DevTools Protocol) browser tier
 *
 * Connects to user's Chrome via CDP for tasks requiring logged-in sessions.
 * User runs Chrome with: --remote-debugging-port=9222
 */

import puppeteer, { Browser, Page } from 'puppeteer-core';
import { BrowserAction, BrowserResult } from './types';

const DEFAULT_CDP_URL = 'http://localhost:9222';

export class CdpTier {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private currentUrl: string = '';
  private cdpUrl: string;

  constructor(cdpUrl: string = DEFAULT_CDP_URL) {
    this.cdpUrl = cdpUrl;
  }

  /**
   * Connect to Chrome via CDP
   */
  async connect(): Promise<BrowserResult> {
    try {
      // Check if Chrome is running with CDP
      const response = await fetch(`${this.cdpUrl}/json/version`);
      if (!response.ok) {
        throw new Error('Chrome not running with remote debugging');
      }

      this.browser = await puppeteer.connect({
        browserURL: this.cdpUrl,
        defaultViewport: null,
      });

      // Get existing pages
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
      this.currentUrl = this.page.url();

      console.log('[CDP] Connected to Chrome');

      return {
        success: true,
        tier: 'cdp',
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: this.getConnectionHelp(error),
      };
    }
  }

  /**
   * Get helpful connection error message
   */
  private getConnectionHelp(error: unknown): string {
    const msg = error instanceof Error ? error.message : 'Unknown error';

    return `CDP connection failed: ${msg}\n\n` +
      'To use CDP tier, start Chrome with remote debugging:\n\n' +
      'macOS:\n' +
      '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n\n' +
      'Windows:\n' +
      '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222\n\n' +
      'Linux:\n' +
      '  google-chrome --remote-debugging-port=9222';
  }

  /**
   * Ensure connected
   */
  private async ensurePage(): Promise<Page> {
    if (!this.page || !this.browser?.connected) {
      const result = await this.connect();
      if (!result.success) {
        throw new Error(result.error || 'Failed to connect');
      }
    }
    return this.page!;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, waitFor?: string | number): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      this.currentUrl = page.url();

      // Wait for condition if specified
      if (waitFor) {
        if (typeof waitFor === 'number') {
          await new Promise(resolve => setTimeout(resolve, waitFor));
        } else {
          await page.waitForSelector(waitFor, { timeout: 10000 });
        }
      }

      const title = await page.title();
      const text = await this.getVisibleText();

      return {
        success: true,
        tier: 'cdp',
        url: this.currentUrl,
        title,
        text,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Take screenshot
   */
  async screenshot(): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      const buffer = await page.screenshot({
        encoding: 'base64',
        type: 'png',
      });

      return {
        success: true,
        tier: 'cdp',
        screenshot: buffer as string,
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Click an element
   */
  async click(selector: string): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      await page.waitForSelector(selector, { timeout: 5000 });
      await page.click(selector);

      // Wait for any navigation
      await new Promise(resolve => setTimeout(resolve, 500));

      return {
        success: true,
        tier: 'cdp',
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Type into an element
   */
  async type(selector: string, text: string): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      await page.waitForSelector(selector, { timeout: 5000 });

      // Clear existing value
      await page.click(selector, { clickCount: 3 });
      await page.keyboard.press('Backspace');

      // Type new value
      await page.type(selector, text);

      return {
        success: true,
        tier: 'cdp',
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Evaluate JavaScript
   */
  async evaluate(script: string): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();

      const result = await page.evaluate(script);

      return {
        success: true,
        tier: 'cdp',
        data: result,
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Extract data from page
   */
  async extract(action: BrowserAction): Promise<BrowserResult> {
    try {
      const page = await this.ensurePage();
      const selector = action.extractSelector || 'body';
      const extractType = action.extractType || 'structured';

      const result = await page.evaluate((sel: string, type: string) => {
        const el = document.querySelector(sel) || document.body;

        switch (type) {
          case 'text':
            return { text: (el as HTMLElement).innerText };

          case 'html':
            return { html: el.innerHTML };

          case 'links':
            const links: Array<{ href: string; text: string }> = [];
            el.querySelectorAll('a[href]').forEach((a: Element) => {
              links.push({
                href: (a as HTMLAnchorElement).href,
                text: a.textContent?.trim() || '',
              });
            });
            return { links };

          case 'tables':
            const tables: string[][][] = [];
            el.querySelectorAll('table').forEach((table: Element) => {
              const tableData: string[][] = [];
              table.querySelectorAll('tr').forEach((row: Element) => {
                const rowData: string[] = [];
                row.querySelectorAll('td, th').forEach((cell: Element) => {
                  rowData.push(cell.textContent?.trim() || '');
                });
                if (rowData.length) tableData.push(rowData);
              });
              if (tableData.length) tables.push(tableData);
            });
            return { tables };

          case 'structured':
          default:
            const mainEl = document.querySelector('main, article, [role="main"], .content') || document.body;
            return {
              title: document.title,
              url: window.location.href,
              description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
              headings: Array.from(document.querySelectorAll('h1, h2, h3'))
                .slice(0, 20)
                .map(h => h.textContent?.trim()),
              mainContent: (mainEl as HTMLElement).innerText?.slice(0, 3000) || '',
            };
        }
      }, selector, extractType);

      return {
        success: true,
        tier: 'cdp',
        data: result,
        url: page.url(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'cdp',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get visible text from page
   */
  private async getVisibleText(): Promise<string> {
    if (!this.page) return '';

    return this.page.evaluate(() => {
      return document.body.innerText.slice(0, 5000);
    });
  }

  /**
   * Execute action
   */
  async execute(action: BrowserAction): Promise<BrowserResult> {
    switch (action.action) {
      case 'navigate':
        if (!action.url) {
          return { success: false, tier: 'cdp', error: 'URL required' };
        }
        return this.navigate(action.url, action.waitFor);

      case 'screenshot':
        return this.screenshot();

      case 'click':
        if (!action.selector) {
          return { success: false, tier: 'cdp', error: 'Selector required' };
        }
        return this.click(action.selector);

      case 'type':
        if (!action.selector || action.text === undefined) {
          return { success: false, tier: 'cdp', error: 'Selector and text required' };
        }
        return this.type(action.selector, action.text);

      case 'evaluate':
        if (!action.script) {
          return { success: false, tier: 'cdp', error: 'Script required' };
        }
        return this.evaluate(action.script);

      case 'extract':
        return this.extract(action);

      default:
        return {
          success: false,
          tier: 'cdp',
          error: `Unknown action: ${action.action}`,
        };
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.browser?.connected || false;
  }

  /**
   * Get current state
   */
  getState(): { url: string; connected: boolean } {
    return {
      url: this.currentUrl,
      connected: this.isConnected(),
    };
  }

  /**
   * Disconnect from Chrome
   */
  disconnect(): void {
    if (this.browser) {
      this.browser.disconnect();
    }
    this.browser = null;
    this.page = null;
    this.currentUrl = '';
    console.log('[CDP] Disconnected');
  }
}
