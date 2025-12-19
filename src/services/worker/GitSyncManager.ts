/**
 * GitSyncManager: Git-based database backup and sync
 *
 * Responsibility:
 * - Sync SQLite database to/from Git remote repository
 * - Track activity for idle timeout push
 * - Handle Git operations (pull, push, status)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

const execAsync = promisify(exec);

export interface GitSyncResult {
  success: boolean;
  message: string;
  needsUserAction?: 'conflict_pull' | 'conflict_push';
  details?: string;
}

export interface GitSyncStatus {
  configured: boolean;
  remoteUrl: string;
  lastSyncTime: number | null;
  hasLocalChanges: boolean;
  isAheadOfRemote: boolean;
  isBehindRemote: boolean;
  isDiverged: boolean;
}

export class GitSyncManager {
  private lastActivityTime: number = Date.now();
  private idlePushDone: boolean = false;
  private idleCheckInterval: NodeJS.Timeout | null = null;
  private settingsPath: string;
  private dataDir: string;
  private gitBackupDir: string;
  private dbPath: string;
  private dbBackupPath: string;

  // Callback for when DB needs to be closed/reopened during sync
  private onDbClose?: () => Promise<void>;
  private onDbReopen?: () => Promise<void>;
  // Callback for safe DB backup (uses VACUUM INTO)
  private onDbBackup?: (destPath: string) => Promise<void>;

  constructor() {
    this.dataDir = join(homedir(), '.claude-mem');
    this.settingsPath = join(this.dataDir, 'settings.json');
    this.gitBackupDir = join(this.dataDir, 'git-backup');
    this.dbPath = join(this.dataDir, 'claude-mem.db');
    this.dbBackupPath = join(this.gitBackupDir, 'claude-mem.db');
  }

  /**
   * Set callbacks for DB operations during sync
   * @param onClose - Called before replacing DB file (pull)
   * @param onReopen - Called after replacing DB file (pull)
   * @param onBackup - Called to safely backup DB (uses VACUUM INTO)
   */
  setDbCallbacks(
    onClose: () => Promise<void>,
    onReopen: () => Promise<void>,
    onBackup: (destPath: string) => Promise<void>
  ): void {
    this.onDbClose = onClose;
    this.onDbReopen = onReopen;
    this.onDbBackup = onBackup;
  }

  /**
   * Record activity (resets idle push flag)
   */
  recordActivity(): void {
    this.lastActivityTime = Date.now();
    this.idlePushDone = false;
  }

  /**
   * Get settings from file
   */
  private getSettings() {
    return SettingsDefaultsManager.loadFromFile(this.settingsPath);
  }

  /**
   * Check if Git sync is configured
   */
  isConfigured(): boolean {
    const settings = this.getSettings();
    return !!settings.CLAUDE_MEM_GIT_REMOTE_URL;
  }

  /**
   * Check if auto sync is enabled
   */
  isAutoSyncEnabled(): boolean {
    const settings = this.getSettings();
    return settings.CLAUDE_MEM_GIT_AUTO_SYNC === 'true' && this.isConfigured();
  }

  /**
   * Initialize git backup directory
   */
  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      logger.info('GIT_SYNC', 'Git sync not configured, skipping initialization');
      return;
    }

    // Create git-backup directory if not exists
    if (!existsSync(this.gitBackupDir)) {
      mkdirSync(this.gitBackupDir, { recursive: true });
    }

    // Initialize git repo if not exists
    const gitDir = join(this.gitBackupDir, '.git');
    if (!existsSync(gitDir)) {
      await this.execGit('init');
      logger.info('GIT_SYNC', 'Initialized git repository');
    }

    // Set remote URL
    const settings = this.getSettings();
    const remoteUrl = settings.CLAUDE_MEM_GIT_REMOTE_URL;

    try {
      // Check if remote exists
      await this.execGit('remote get-url origin');
      // Update URL if needed
      await this.execGit(`remote set-url origin "${remoteUrl}"`);
    } catch {
      // Remote doesn't exist, add it
      await this.execGit(`remote add origin "${remoteUrl}"`);
    }

    logger.info('GIT_SYNC', 'Git sync initialized', { remoteUrl });
  }

  /**
   * Start idle check interval
   */
  startIdleCheck(): void {
    if (this.idleCheckInterval) {
      return; // Already running
    }

    const settings = this.getSettings();
    const idleTimeoutMin = parseInt(settings.CLAUDE_MEM_GIT_IDLE_TIMEOUT_MIN, 10) || 10;
    const idleTimeoutMs = idleTimeoutMin * 60 * 1000;

    // Check every minute
    this.idleCheckInterval = setInterval(async () => {
      if (!this.isAutoSyncEnabled()) {
        return;
      }

      const idleTime = Date.now() - this.lastActivityTime;

      if (idleTime >= idleTimeoutMs && !this.idlePushDone) {
        logger.info('GIT_SYNC', 'Idle timeout reached, pushing to remote', {
          idleMinutes: Math.floor(idleTime / 60000)
        });

        const result = await this.push('Auto-sync: idle timeout');
        if (result.success) {
          this.idlePushDone = true;
        }
      }
    }, 60000); // Check every minute

    logger.info('GIT_SYNC', 'Idle check started', { idleTimeoutMin });
  }

  /**
   * Stop idle check interval
   */
  stopIdleCheck(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
      logger.info('GIT_SYNC', 'Idle check stopped');
    }
  }

  /**
   * Execute git command in backup directory
   */
  private async execGit(command: string): Promise<string> {
    const { stdout } = await execAsync(`git -C "${this.gitBackupDir}" ${command}`, {
      timeout: 60000 // 1 minute timeout
    });
    return stdout.trim();
  }

  /**
   * Get sync status
   */
  async getStatus(): Promise<GitSyncStatus> {
    const settings = this.getSettings();
    const remoteUrl = settings.CLAUDE_MEM_GIT_REMOTE_URL;

    if (!remoteUrl) {
      return {
        configured: false,
        remoteUrl: '',
        lastSyncTime: null,
        hasLocalChanges: false,
        isAheadOfRemote: false,
        isBehindRemote: false,
        isDiverged: false
      };
    }

    // Safely backup current DB to backup dir for status check
    if (existsSync(this.dbPath) && this.onDbBackup) {
      try {
        await this.onDbBackup(this.dbBackupPath);
      } catch (error) {
        logger.warn('GIT_SYNC', 'Failed to backup DB for status check', {}, error as Error);
      }
    }

    let hasLocalChanges = false;
    let isAheadOfRemote = false;
    let isBehindRemote = false;
    let isDiverged = false;

    try {
      // Check local changes
      const status = await this.execGit('status --porcelain');
      hasLocalChanges = status.length > 0;

      // Fetch to update remote refs
      try {
        await this.execGit('fetch origin main 2>/dev/null || true');
      } catch {
        // Remote might not exist yet
      }

      // Check ahead/behind
      try {
        const revList = await this.execGit('rev-list --left-right --count HEAD...origin/main 2>/dev/null || echo "0 0"');
        const [ahead, behind] = revList.split(/\s+/).map(n => parseInt(n, 10));
        isAheadOfRemote = ahead > 0;
        isBehindRemote = behind > 0;
        isDiverged = isAheadOfRemote && isBehindRemote;
      } catch {
        // origin/main might not exist
      }
    } catch (error) {
      logger.warn('GIT_SYNC', 'Failed to get git status', {}, error as Error);
    }

    return {
      configured: true,
      remoteUrl,
      lastSyncTime: null, // Could track this in a file if needed
      hasLocalChanges,
      isAheadOfRemote,
      isBehindRemote,
      isDiverged
    };
  }

  /**
   * Pull from remote
   * Returns needsUserAction if there's a conflict
   */
  async pull(force: boolean = false): Promise<GitSyncResult> {
    if (!this.isConfigured()) {
      return { success: false, message: 'Git sync not configured' };
    }

    try {
      // Fetch first to check status
      try {
        await this.execGit('fetch origin main');
      } catch (error) {
        // Remote might be empty
        return { success: true, message: 'Remote is empty, nothing to pull' };
      }

      // Check if we have local commits
      let localCommits = false;
      try {
        const localHead = await this.execGit('rev-parse HEAD 2>/dev/null');
        localCommits = !!localHead;
      } catch {
        // No local commits
      }

      // Check for divergence
      if (localCommits) {
        try {
          const mergeBase = await this.execGit('merge-base HEAD origin/main 2>/dev/null');
          const localHead = await this.execGit('rev-parse HEAD');
          const remoteHead = await this.execGit('rev-parse origin/main');

          if (mergeBase !== localHead && mergeBase !== remoteHead) {
            // Diverged
            if (!force) {
              return {
                success: false,
                message: 'Local and remote have diverged. Choose: use remote (lose local) or keep local.',
                needsUserAction: 'conflict_pull'
              };
            }
          }
        } catch {
          // Could not determine merge base
        }
      }

      // Close DB before replacing
      if (this.onDbClose) {
        await this.onDbClose();
      }

      try {
        // Reset to remote
        await this.execGit('reset --hard origin/main');

        // Copy DB from backup to main location
        if (existsSync(this.dbBackupPath)) {
          copyFileSync(this.dbBackupPath, this.dbPath);
        }

        logger.info('GIT_SYNC', 'Pull completed successfully');
        return { success: true, message: 'Pull completed successfully' };
      } finally {
        // Reopen DB
        if (this.onDbReopen) {
          await this.onDbReopen();
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('GIT_SYNC', 'Pull failed', {}, error as Error);
      return { success: false, message: `Pull failed: ${errorMsg}` };
    }
  }

  /**
   * Push to remote
   * Returns needsUserAction if there's a conflict
   */
  async push(commitMessage?: string, force: boolean = false): Promise<GitSyncResult> {
    if (!this.isConfigured()) {
      return { success: false, message: 'Git sync not configured' };
    }

    try {
      // Safely backup current DB to backup directory
      if (!existsSync(this.dbPath)) {
        return { success: false, message: 'Database file not found' };
      }

      if (!this.onDbBackup) {
        return { success: false, message: 'Database backup callback not configured' };
      }

      await this.onDbBackup(this.dbBackupPath);

      // Stage changes
      await this.execGit('add claude-mem.db');

      // Check if there are changes to commit
      const status = await this.execGit('status --porcelain');
      if (!status) {
        return { success: true, message: 'No changes to push' };
      }

      // Commit
      const message = commitMessage || `Auto-sync: ${new Date().toISOString()}`;
      await this.execGit(`commit -m "${message}"`);

      // Try to push
      try {
        if (force) {
          await this.execGit('push -f origin main');
        } else {
          await this.execGit('push origin main');
        }
      } catch (pushError) {
        // Push failed, likely due to conflict
        const errorMsg = pushError instanceof Error ? pushError.message : '';

        if (errorMsg.includes('rejected') || errorMsg.includes('non-fast-forward')) {
          return {
            success: false,
            message: 'Remote has new changes. Choose: force push (overwrite remote) or pull first.',
            needsUserAction: 'conflict_push'
          };
        }

        throw pushError;
      }

      logger.info('GIT_SYNC', 'Push completed successfully');
      return { success: true, message: 'Push completed successfully' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('GIT_SYNC', 'Push failed', {}, error as Error);
      return { success: false, message: `Push failed: ${errorMsg}` };
    }
  }

  /**
   * Configure remote URL
   */
  async configure(remoteUrl: string): Promise<GitSyncResult> {
    // Validate URL format (SSH or HTTPS)
    const isSSH = remoteUrl.startsWith('git@');
    const isHTTPS = remoteUrl.startsWith('https://');

    if (!isSSH && !isHTTPS) {
      return {
        success: false,
        message: 'Invalid URL format. Use SSH (git@github.com:...) or HTTPS (https://github.com/...)'
      };
    }

    if (isHTTPS) {
      logger.warn('GIT_SYNC', 'HTTPS URL detected. Make sure credential helper is configured.');
    }

    // Update settings file
    const settings = this.getSettings();
    const updatedSettings = {
      ...settings,
      CLAUDE_MEM_GIT_REMOTE_URL: remoteUrl
    };

    const { writeFileSync } = await import('fs');
    writeFileSync(this.settingsPath, JSON.stringify(updatedSettings, null, 2));

    // Initialize with new URL
    await this.initialize();

    return { success: true, message: `Configured remote URL: ${remoteUrl}` };
  }

  /**
   * Cleanup on shutdown
   */
  async close(): Promise<void> {
    this.stopIdleCheck();
    logger.info('GIT_SYNC', 'GitSyncManager closed');
  }
}
