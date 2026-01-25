/**
 * Browser automation types
 */

export type BrowserTier = 'electron' | 'cdp';

export interface BrowserAction {
  action: 'navigate' | 'screenshot' | 'click' | 'type' | 'evaluate' | 'extract';
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  extractType?: 'text' | 'html' | 'links' | 'tables' | 'structured';
  extractSelector?: string;
  waitFor?: string | number; // selector or ms
  tier?: BrowserTier; // Force a specific tier
  requiresAuth?: boolean; // Hint that auth is needed (triggers CDP)
}

export interface BrowserResult {
  success: boolean;
  tier: BrowserTier;
  data?: unknown;
  screenshot?: string; // base64
  html?: string;
  text?: string;
  error?: string;
  url?: string;
  title?: string;
}

export interface ExtractedData {
  text?: string;
  html?: string;
  links?: Array<{ href: string; text: string }>;
  tables?: Array<Array<Array<string>>>;
  structured?: Record<string, unknown>;
}

export interface BrowserState {
  currentUrl?: string;
  currentTier?: BrowserTier;
  electronWindowId?: number;
  cdpConnected?: boolean;
}

export interface BrowserToolInput {
  action: string;
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  extract_type?: string;
  extract_selector?: string;
  wait_for?: string | number;
  tier?: string;
  requires_auth?: boolean;
}
