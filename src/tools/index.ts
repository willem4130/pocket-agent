/**
 * Tool configurations for the agent
 *
 * Available capabilities:
 * - File/Terminal: Built-in with claude_code preset
 * - Browser: Three-tier system (HTTP, Electron, CDP)
 * - Desktop: Anthropic computer use tool (Docker recommended)
 */

import { getBrowserToolDefinition, handleBrowserTool } from '../browser';
import { getMemoryTools, setMemoryManager } from './memory-tools';
import { MemoryManager } from '../memory';

export { setMemoryManager } from './memory-tools';

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ToolsConfig {
  mcpServers: Record<string, MCPServerConfig>;
  computerUse: {
    enabled: boolean;
    dockerized: boolean;
    displaySize?: { width: number; height: number };
  };
  browser: {
    enabled: boolean;
    cdpUrl?: string; // Default: http://localhost:9222
  };
}

/**
 * Default tools configuration
 */
export function getDefaultToolsConfig(): ToolsConfig {
  return {
    mcpServers: {},
    computerUse: {
      enabled: false,
      dockerized: true,
      displaySize: { width: 1920, height: 1080 },
    },
    browser: {
      enabled: true,
      cdpUrl: 'http://localhost:9222',
    },
  };
}

/**
 * Build MCP server configurations
 */
export function buildMCPServers(config: ToolsConfig): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};

  // Computer use server (for desktop automation)
  if (config.computerUse.enabled) {
    if (config.computerUse.dockerized) {
      servers['computer'] = {
        command: 'docker',
        args: [
          'run', '-i', '--rm',
          '-e', `DISPLAY_WIDTH=${config.computerUse.displaySize?.width || 1920}`,
          '-e', `DISPLAY_HEIGHT=${config.computerUse.displaySize?.height || 1080}`,
          'ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest',
        ],
      };
    } else {
      servers['computer'] = {
        command: 'npx',
        args: ['-y', '@anthropic-ai/computer-use-server'],
      };
    }
  }

  // Merge with any custom servers
  return { ...servers, ...config.mcpServers };
}

/**
 * Get computer use tool definition for direct API use
 */
export function getComputerUseTool(displaySize: { width: number; height: number }) {
  return {
    type: 'computer_20241022' as const,
    name: 'computer',
    display_width_px: displaySize.width,
    display_height_px: displaySize.height,
  };
}

/**
 * Get custom tools for the agent
 */
export function getCustomTools(config: ToolsConfig): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  handler: (input: unknown) => Promise<string>;
}> {
  const tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    handler: (input: unknown) => Promise<string>;
  }> = [];

  // Memory tools (always enabled)
  const memoryTools = getMemoryTools();
  for (const tool of memoryTools) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Record<string, unknown>,
      handler: tool.handler,
    });
  }

  // Browser tool
  if (config.browser.enabled) {
    const browserDef = getBrowserToolDefinition();
    tools.push({
      name: browserDef.name,
      description: browserDef.description,
      input_schema: browserDef.input_schema as Record<string, unknown>,
      handler: handleBrowserTool,
    });
  }

  return tools;
}

/**
 * Validate that required environment variables are set
 */
export function validateToolsConfig(config: ToolsConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.computerUse.enabled && config.computerUse.dockerized) {
    // Check if Docker is available
    try {
      require('child_process').execSync('docker --version', { stdio: 'ignore' });
    } catch {
      errors.push('Docker not available (required for safe computer use)');
    }
  }

  return { valid: errors.length === 0, errors };
}
