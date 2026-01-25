/**
 * Computer Use Tool Implementation
 *
 * Provides screenshot capture and mouse/keyboard control.
 * Should be run in Docker container for safety.
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import path from 'path';

export interface ComputerAction {
  action: 'screenshot' | 'mouse_move' | 'left_click' | 'right_click' |
          'double_click' | 'type' | 'key' | 'scroll';
  coordinate?: [number, number];
  text?: string;
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
}

export interface ComputerUseConfig {
  displayWidth: number;
  displayHeight: number;
  dockerized: boolean;
  containerName?: string;
}

/**
 * Docker-based computer use executor
 * Runs actions in an isolated container with virtual display
 */
export class DockerComputerUse {
  private config: ComputerUseConfig;
  private container: ChildProcess | null = null;
  private containerName: string;

  constructor(config: ComputerUseConfig) {
    this.config = config;
    this.containerName = config.containerName || `pocket-agent-computer-${Date.now()}`;
  }

  /**
   * Start the Docker container with virtual display
   */
  async start(): Promise<void> {
    if (this.container) {
      console.log('[ComputerUse] Container already running');
      return;
    }

    console.log('[ComputerUse] Starting Docker container...');

    const args = [
      'run', '-d', '--rm',
      '--name', this.containerName,
      '-e', `DISPLAY_WIDTH=${this.config.displayWidth}`,
      '-e', `DISPLAY_HEIGHT=${this.config.displayHeight}`,
      '-p', '5900:5900', // VNC port for debugging
      '-p', '6080:6080', // noVNC web interface
      '-p', '8080:8080', // API port
      'ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest',
    ];

    try {
      execSync(`docker ${args.join(' ')}`, { stdio: 'inherit' });
      console.log(`[ComputerUse] Container ${this.containerName} started`);

      // Wait for container to be ready
      await this.waitForReady();
    } catch (error) {
      console.error('[ComputerUse] Failed to start container:', error);
      throw error;
    }
  }

  /**
   * Wait for container to be ready
   */
  private async waitForReady(timeout: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        execSync(`docker exec ${this.containerName} curl -s http://localhost:8080/health`, {
          stdio: 'ignore',
        });
        console.log('[ComputerUse] Container ready');
        return;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    throw new Error('Container failed to become ready');
  }

  /**
   * Execute a computer action
   */
  async execute(action: ComputerAction): Promise<{ success: boolean; screenshot?: string; error?: string }> {
    try {
      const result = execSync(
        `docker exec ${this.containerName} curl -s -X POST http://localhost:8080/action -H "Content-Type: application/json" -d '${JSON.stringify(action)}'`,
        { encoding: 'utf-8' }
      );

      const response = JSON.parse(result);
      return response;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Take a screenshot
   */
  async screenshot(): Promise<string | null> {
    const result = await this.execute({ action: 'screenshot' });
    return result.screenshot || null;
  }

  /**
   * Stop the container
   */
  async stop(): Promise<void> {
    if (!this.container && !this.containerName) return;

    try {
      execSync(`docker stop ${this.containerName}`, { stdio: 'ignore' });
      console.log(`[ComputerUse] Container ${this.containerName} stopped`);
    } catch (error) {
      console.error('[ComputerUse] Failed to stop container:', error);
    }

    this.container = null;
  }

  /**
   * Check if container is running
   */
  isRunning(): boolean {
    try {
      const result = execSync(`docker inspect -f '{{.State.Running}}' ${this.containerName}`, {
        encoding: 'utf-8',
      });
      return result.trim() === 'true';
    } catch {
      return false;
    }
  }
}

/**
 * Create computer use tool handler for the agent
 */
export function createComputerUseHandler(config: ComputerUseConfig) {
  const dockerComputer = new DockerComputerUse(config);
  let started = false;

  return {
    name: 'computer',
    description: 'Control the computer - take screenshots, move mouse, click, type, scroll',

    async execute(params: ComputerAction): Promise<string> {
      // Lazy start container
      if (!started && config.dockerized) {
        await dockerComputer.start();
        started = true;
      }

      const result = await dockerComputer.execute(params);

      if (!result.success) {
        return `Error: ${result.error}`;
      }

      if (result.screenshot) {
        return `Screenshot captured (base64): ${result.screenshot.slice(0, 100)}...`;
      }

      return `Action ${params.action} completed successfully`;
    },

    async cleanup(): Promise<void> {
      if (started && config.dockerized) {
        await dockerComputer.stop();
      }
    },
  };
}
