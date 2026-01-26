/**
 * Skills dependency manager
 *
 * Handles checking and installing dependencies for Claude skills
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsManager } from '../settings';
import { PermissionType, getMissingPermissions, isMacOS } from '../permissions/macos';

// Re-export PermissionType for external use
export type { PermissionType } from '../permissions/macos';

// Types
export interface InstallOption {
  id: string;
  kind: 'brew' | 'brew-cask' | 'node' | 'go' | 'uv' | 'apt' | 'download';
  formula?: string;
  cask?: string;
  package?: string;
  module?: string;
  url?: string;
  bins?: string[];
  label: string;
  os?: string[];
}

export interface SkillDependency {
  bins: string[];
  os: string[];
  install: InstallOption[];
  requires_config?: string[];
  requires_env?: string[];
  requires_permissions?: PermissionType[];
}

export interface SkillsManifest {
  version: string;
  generated: string;
  source: string;
  skills: Record<string, SkillDependency>;
}

export interface SkillStatus {
  name: string;
  available: boolean;
  missingBins: string[];
  missingEnvVars: string[];
  requiredEnvVars: string[];
  missingPermissions: PermissionType[];
  requiredPermissions: PermissionType[];
  osCompatible: boolean;
  installOptions: InstallOption[];
}

// Platform detection
const PLATFORM = os.platform(); // 'darwin', 'linux', 'win32'

/**
 * Load skills manifest
 */
export function loadSkillsManifest(skillsDir: string): SkillsManifest | null {
  const manifestPath = path.join(skillsDir, 'skills-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn('[Skills] No skills-manifest.json found');
    return null;
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as SkillsManifest;
  } catch (err) {
    console.error('[Skills] Failed to load manifest:', err);
    return null;
  }
}

// Cache for dynamic paths (computed once)
let cachedPaths: string[] | null = null;

/**
 * Get all possible binary installation paths
 * Based on: npm, homebrew, go, uv, cargo, and system paths
 */
function getAllBinPaths(): string[] {
  if (cachedPaths) return cachedPaths;

  const home = os.homedir();
  const paths: string[] = [];

  // === System paths ===
  paths.push('/usr/local/bin');
  paths.push('/usr/bin');
  paths.push('/bin');
  paths.push('/usr/sbin');
  paths.push('/sbin');

  // === Homebrew ===
  // Apple Silicon Mac
  paths.push('/opt/homebrew/bin');
  paths.push('/opt/homebrew/sbin');
  // Intel Mac
  paths.push('/usr/local/bin');
  paths.push('/usr/local/sbin');
  // Linux Homebrew
  paths.push('/home/linuxbrew/.linuxbrew/bin');
  paths.push(`${home}/.linuxbrew/bin`);

  // === npm global ===
  // Default locations
  paths.push('/usr/local/bin');
  paths.push(`${home}/.npm-global/bin`);
  paths.push(`${home}/.npm/bin`);
  // nvm locations (check common node versions)
  const nvmBase = `${home}/.nvm/versions/node`;
  if (fs.existsSync(nvmBase)) {
    try {
      const versions = fs.readdirSync(nvmBase);
      for (const v of versions) {
        paths.push(`${nvmBase}/${v}/bin`);
      }
    } catch { /* ignore */ }
  }
  // Try to get actual npm prefix
  try {
    const npmPrefix = execSync('npm prefix -g', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    if (npmPrefix) paths.push(`${npmPrefix}/bin`);
  } catch { /* ignore */ }

  // === Go ===
  // Default GOPATH/bin
  paths.push(`${home}/go/bin`);
  // Check GOPATH env
  const gopath = process.env.GOPATH;
  if (gopath) paths.push(`${gopath}/bin`);
  // Check GOBIN env
  const gobin = process.env.GOBIN;
  if (gobin) paths.push(gobin);

  // === Python / uv / pipx ===
  paths.push(`${home}/.local/bin`);
  paths.push(`${home}/.local/share/uv/tools`);
  // pipx
  paths.push(`${home}/.local/pipx/venvs`);

  // === Cargo (Rust) ===
  paths.push(`${home}/.cargo/bin`);

  // === Volta (Node version manager) ===
  paths.push(`${home}/.volta/bin`);

  // === asdf version manager ===
  paths.push(`${home}/.asdf/shims`);

  // === mise (formerly rtx) version manager ===
  paths.push(`${home}/.local/share/mise/shims`);

  // Deduplicate and cache
  cachedPaths = [...new Set(paths)];
  return cachedPaths;
}

/**
 * Check if a binary is available
 * Checks all known installation paths for package managers
 */
export function isBinAvailable(bin: string): boolean {
  if (PLATFORM === 'win32') {
    try {
      execSync(`where ${bin}`, { stdio: 'pipe' });
      return true;
    } catch {
      // Also check common Windows paths
      const appData = process.env.APPDATA || '';
      const localAppData = process.env.LOCALAPPDATA || '';
      const winPaths = [
        `${appData}\\npm\\${bin}.cmd`,
        `${appData}\\npm\\${bin}`,
        `${localAppData}\\Programs\\Python\\Python*\\Scripts\\${bin}.exe`,
      ];
      for (const p of winPaths) {
        if (fs.existsSync(p)) return true;
      }
      return false;
    }
  }

  // Check all known paths
  const allPaths = getAllBinPaths();
  for (const dir of allPaths) {
    const fullPath = path.join(dir, bin);
    if (fs.existsSync(fullPath)) {
      return true;
    }
  }

  // Last resort: try which (may work if PATH is set correctly in shell)
  try {
    execSync(`which ${bin}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if skill is compatible with current OS
 */
export function isOsCompatible(skill: SkillDependency): boolean {
  if (skill.os.length === 0) return true; // No OS restriction
  return skill.os.includes(PLATFORM);
}

/**
 * Get status of a single skill
 */
export function getSkillStatus(name: string, skill: SkillDependency): SkillStatus {
  const osCompatible = isOsCompatible(skill);
  const missingBins = skill.bins.filter((bin) => !isBinAvailable(bin));

  // Check for required environment variables / API keys
  const requiredEnvVars = skill.requires_env || [];
  const missingEnvVars = requiredEnvVars.filter((envVar) => !SettingsManager.hasApiKey(envVar));

  // Check for required permissions (macOS only)
  const requiredPermissions = skill.requires_permissions || [];
  const missingPermissions = isMacOS() ? getMissingPermissions(requiredPermissions) : [];

  // Filter install options for current OS
  const installOptions = skill.install.filter((opt) => {
    if (!opt.os || opt.os.length === 0) return true;
    return opt.os.includes(PLATFORM);
  });

  return {
    name,
    available:
      osCompatible &&
      missingBins.length === 0 &&
      missingEnvVars.length === 0 &&
      missingPermissions.length === 0,
    missingBins,
    missingEnvVars,
    requiredEnvVars,
    missingPermissions,
    requiredPermissions,
    osCompatible,
    installOptions,
  };
}

/**
 * Get status of all skills
 */
export function getAllSkillStatuses(manifest: SkillsManifest): SkillStatus[] {
  return Object.entries(manifest.skills).map(([name, skill]) => getSkillStatus(name, skill));
}

/**
 * Get summary of skill availability
 */
export function getSkillsSummary(manifest: SkillsManifest): {
  total: number;
  available: number;
  unavailable: number;
  incompatible: number;
  missingDeps: SkillStatus[];
} {
  const statuses = getAllSkillStatuses(manifest);
  const available = statuses.filter((s) => s.available);
  const incompatible = statuses.filter((s) => !s.osCompatible);
  const missingDeps = statuses.filter((s) => s.osCompatible && !s.available);

  return {
    total: statuses.length,
    available: available.length,
    unavailable: missingDeps.length,
    incompatible: incompatible.length,
    missingDeps,
  };
}

/**
 * Check if Homebrew is installed
 */
export function hasHomebrew(): boolean {
  return isBinAvailable('brew');
}

/**
 * Check if Go is installed
 */
export function hasGo(): boolean {
  return isBinAvailable('go');
}

/**
 * Check if Node/npm is installed
 */
export function hasNode(): boolean {
  return isBinAvailable('npm');
}

/**
 * Check if uv is installed
 */
export function hasUv(): boolean {
  return isBinAvailable('uv');
}

/**
 * Install a dependency using the specified method (async, non-blocking)
 */
export async function installDependency(
  option: InstallOption,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string }> {
  const log = onProgress || console.log;

  try {
    switch (option.kind) {
      case 'brew': {
        if (!hasHomebrew()) {
          return { success: false, error: 'Homebrew not installed' };
        }
        log(`Installing ${option.formula} via Homebrew...`);
        await execAsync(`brew install ${option.formula}`);
        return { success: true };
      }

      case 'brew-cask': {
        if (!hasHomebrew()) {
          return { success: false, error: 'Homebrew not installed' };
        }
        log(`Installing ${option.cask} via Homebrew Cask...`);
        await execAsync(`brew install --cask ${option.cask}`);
        return { success: true };
      }

      case 'node': {
        if (!hasNode()) {
          return { success: false, error: 'Node.js/npm not installed' };
        }
        log(`Installing ${option.package} via npm...`);
        await execAsync(`npm install -g ${option.package}`);
        return { success: true };
      }

      case 'go': {
        if (!hasGo()) {
          return { success: false, error: 'Go not installed' };
        }
        log(`Installing ${option.module} via go install...`);
        await execAsync(`go install ${option.module}`);
        return { success: true };
      }

      case 'uv': {
        if (!hasUv()) {
          // Try to install uv first
          if (hasHomebrew()) {
            log('Installing uv via Homebrew...');
            await execAsync('brew install uv');
          } else {
            return { success: false, error: 'uv not installed and no way to install it' };
          }
        }
        log(`Installing ${option.package} via uv...`);
        await execAsync(`uv tool install ${option.package}`);
        return { success: true };
      }

      case 'apt': {
        if (PLATFORM !== 'linux') {
          return { success: false, error: 'apt only available on Linux' };
        }
        log(`Installing ${option.package} via apt...`);
        await execAsync(`sudo apt-get install -y ${option.package}`);
        return { success: true };
      }

      case 'download': {
        log(`Download required: ${option.url}`);
        // For downloads, we'd need more complex handling
        return { success: false, error: 'Manual download required' };
      }

      default:
        return { success: false, error: `Unknown install kind: ${option.kind}` };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: errorMsg };
  }
}

/**
 * Install all missing dependencies for a skill
 */
export async function installSkillDependencies(
  status: SkillStatus,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];

  if (status.available) {
    return { success: true, installed, failed };
  }

  if (!status.osCompatible) {
    return { success: false, installed, failed: ['OS not compatible'] };
  }

  // Group install options by the bins they provide
  const binToOptions = new Map<string, InstallOption[]>();
  for (const opt of status.installOptions) {
    for (const bin of opt.bins || []) {
      if (!binToOptions.has(bin)) {
        binToOptions.set(bin, []);
      }
      binToOptions.get(bin)!.push(opt);
    }
  }

  // Try to install each missing bin
  for (const bin of status.missingBins) {
    const options = binToOptions.get(bin) || [];
    if (options.length === 0) {
      failed.push(bin);
      continue;
    }

    // Try each option until one succeeds
    let success = false;
    for (const opt of options) {
      const result = await installDependency(opt, onProgress);
      if (result.success) {
        installed.push(bin);
        success = true;
        break;
      }
    }

    if (!success) {
      failed.push(bin);
    }
  }

  return {
    success: failed.length === 0,
    installed,
    failed,
  };
}

/**
 * Batch install dependencies for multiple skills
 */
export async function batchInstallDependencies(
  statuses: SkillStatus[],
  onProgress?: (skill: string, message: string) => void
): Promise<Map<string, { success: boolean; installed: string[]; failed: string[] }>> {
  const results = new Map<string, { success: boolean; installed: string[]; failed: string[] }>();

  // Collect all unique bins needed
  const allMissingBins = new Set<string>();
  for (const status of statuses) {
    for (const bin of status.missingBins) {
      allMissingBins.add(bin);
    }
  }

  // Install each skill's deps
  for (const status of statuses) {
    if (status.available) {
      results.set(status.name, { success: true, installed: [], failed: [] });
      continue;
    }

    const result = await installSkillDependencies(status, (msg) =>
      onProgress?.(status.name, msg)
    );
    results.set(status.name, result);
  }

  return results;
}

/**
 * Get recommended install order based on shared dependencies
 */
export function getRecommendedInstallOrder(statuses: SkillStatus[]): InstallOption[] {
  // Count how many skills need each install option
  const optionCounts = new Map<string, { option: InstallOption; count: number }>();

  for (const status of statuses) {
    for (const opt of status.installOptions) {
      const key = `${opt.kind}:${opt.formula || opt.package || opt.module || opt.cask}`;
      if (!optionCounts.has(key)) {
        optionCounts.set(key, { option: opt, count: 0 });
      }
      optionCounts.get(key)!.count++;
    }
  }

  // Sort by count (most needed first)
  return Array.from(optionCounts.values())
    .sort((a, b) => b.count - a.count)
    .map((v) => v.option);
}

/**
 * Check prerequisites (brew, go, node, etc.)
 */
export function checkPrerequisites(): {
  brew: boolean;
  go: boolean;
  node: boolean;
  uv: boolean;
  git: boolean;
} {
  return {
    brew: hasHomebrew(),
    go: hasGo(),
    node: hasNode(),
    uv: hasUv(),
    git: isBinAvailable('git'),
  };
}
