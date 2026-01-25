/**
 * Electron hidden window browser tier
 *
 * Uses a hidden BrowserWindow for JS-heavy pages.
 * Runs invisibly, doesn't interrupt user.
 */

import { BrowserWindow, WebContents } from 'electron';
import { BrowserAction, BrowserResult } from './types';

export class ElectronTier {
  private window: BrowserWindow | null = null;
  private currentUrl: string = '';

  /**
   * Initialize hidden browser window
   */
  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }

    this.window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false, // Hidden
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });

    // Prevent window from showing
    this.window.on('show', () => {
      this.window?.hide();
    });

    return this.window;
  }

  /**
   * Get webContents
   */
  private async getWebContents(): Promise<WebContents> {
    const window = await this.ensureWindow();
    return window.webContents;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, waitFor?: string | number): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      await webContents.loadURL(url);
      this.currentUrl = url;

      // Wait for condition if specified
      if (waitFor) {
        await this.waitFor(waitFor);
      } else {
        // Default: wait for DOM content loaded
        await new Promise<void>(resolve => {
          webContents.once('dom-ready', () => resolve());
          // Timeout fallback
          setTimeout(resolve, 5000);
        });
      }

      const title = await webContents.executeJavaScript('document.title');
      const text = await this.getVisibleText();

      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
        title,
        text,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Take screenshot
   */
  async screenshot(): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      if (!this.currentUrl) {
        return {
          success: false,
          tier: 'electron',
          error: 'No page loaded. Call navigate first.',
        };
      }

      const image = await webContents.capturePage();
      const base64 = image.toPNG().toString('base64');

      return {
        success: true,
        tier: 'electron',
        screenshot: base64,
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Click an element
   */
  async click(selector: string): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { success: false, error: 'Element not found' };
          el.click();
          return { success: true };
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error || 'Click failed',
        };
      }

      // Wait a bit for any navigation/updates
      await new Promise(resolve => setTimeout(resolve, 500));

      return {
        success: true,
        tier: 'electron',
        url: webContents.getURL(),
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Type into an element
   */
  async type(selector: string, text: string): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { success: false, error: 'Element not found' };
          if (!('value' in el)) return { success: false, error: 'Element is not an input' };

          el.focus();
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));

          return { success: true };
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error || 'Type failed',
        };
      }

      return {
        success: true,
        tier: 'electron',
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Evaluate JavaScript
   */
  async evaluate(script: string): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();

      const result = await webContents.executeJavaScript(`
        (function() {
          try {
            const result = ${script};
            return { success: true, data: result };
          } catch (e) {
            return { success: false, error: e.message };
          }
        })()
      `);

      if (!result.success) {
        return {
          success: false,
          tier: 'electron',
          error: result.error,
        };
      }

      return {
        success: true,
        tier: 'electron',
        data: result.data,
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Extract data from page
   */
  async extract(action: BrowserAction): Promise<BrowserResult> {
    try {
      const webContents = await this.getWebContents();
      const selector = action.extractSelector || 'body';
      const extractType = action.extractType || 'structured';

      const result = await webContents.executeJavaScript(`
        (function() {
          const selector = ${JSON.stringify(selector)};
          const el = document.querySelector(selector) || document.body;
          const extractType = ${JSON.stringify(extractType)};

          switch (extractType) {
            case 'text':
              return { text: el.innerText };

            case 'html':
              return { html: el.innerHTML };

            case 'links':
              const links = [];
              el.querySelectorAll('a[href]').forEach(a => {
                links.push({ href: a.href, text: a.innerText.trim() });
              });
              return { links };

            case 'tables':
              const tables = [];
              el.querySelectorAll('table').forEach(table => {
                const tableData = [];
                table.querySelectorAll('tr').forEach(row => {
                  const rowData = [];
                  row.querySelectorAll('td, th').forEach(cell => {
                    rowData.push(cell.innerText.trim());
                  });
                  if (rowData.length) tableData.push(rowData);
                });
                if (tableData.length) tables.push(tableData);
              });
              return { tables };

            case 'structured':
            default:
              return {
                title: document.title,
                description: document.querySelector('meta[name="description"]')?.content || '',
                headings: Array.from(document.querySelectorAll('h1, h2, h3'))
                  .slice(0, 20)
                  .map(h => h.innerText.trim()),
                mainContent: (document.querySelector('main, article, [role="main"], .content') || document.body)
                  .innerText.slice(0, 3000)
              };
          }
        })()
      `);

      return {
        success: true,
        tier: 'electron',
        data: result,
        url: this.currentUrl,
      };
    } catch (error) {
      return {
        success: false,
        tier: 'electron',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Wait for condition
   */
  private async waitFor(condition: string | number): Promise<void> {
    const webContents = await this.getWebContents();

    if (typeof condition === 'number') {
      await new Promise(resolve => setTimeout(resolve, condition));
      return;
    }

    // Wait for selector
    const timeout = 10000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const found = await webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(condition)})`
      );
      if (found) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for selector: ${condition}`);
  }

  /**
   * Get visible text from page
   */
  private async getVisibleText(): Promise<string> {
    const webContents = await this.getWebContents();

    return webContents.executeJavaScript(`
      document.body.innerText.slice(0, 5000)
    `);
  }

  /**
   * Execute action
   */
  async execute(action: BrowserAction): Promise<BrowserResult> {
    switch (action.action) {
      case 'navigate':
        if (!action.url) {
          return { success: false, tier: 'electron', error: 'URL required' };
        }
        return this.navigate(action.url, action.waitFor);

      case 'screenshot':
        return this.screenshot();

      case 'click':
        if (!action.selector) {
          return { success: false, tier: 'electron', error: 'Selector required' };
        }
        return this.click(action.selector);

      case 'type':
        if (!action.selector || action.text === undefined) {
          return { success: false, tier: 'electron', error: 'Selector and text required' };
        }
        return this.type(action.selector, action.text);

      case 'evaluate':
        if (!action.script) {
          return { success: false, tier: 'electron', error: 'Script required' };
        }
        return this.evaluate(action.script);

      case 'extract':
        return this.extract(action);

      default:
        return {
          success: false,
          tier: 'electron',
          error: `Unknown action: ${action.action}`,
        };
    }
  }

  /**
   * Get current state
   */
  getState(): { url: string; active: boolean } {
    return {
      url: this.currentUrl,
      active: this.window !== null && !this.window.isDestroyed(),
    };
  }

  /**
   * Close the hidden window
   */
  close(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
    this.currentUrl = '';
  }
}
