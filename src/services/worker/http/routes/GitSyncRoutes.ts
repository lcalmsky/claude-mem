/**
 * Git Sync Routes
 *
 * Handles Git-based database backup and synchronization.
 * Endpoints for pull, push, status, and configuration.
 */

import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { GitSyncManager } from '../../GitSyncManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';

export class GitSyncRoutes extends BaseRouteHandler {
  constructor(
    private gitSyncManager: GitSyncManager
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    // Sync endpoints
    app.post('/api/git-sync/pull', this.handlePull.bind(this));
    app.post('/api/git-sync/push', this.handlePush.bind(this));
    app.get('/api/git-sync/status', this.handleStatus.bind(this));
    app.post('/api/git-sync/configure', this.handleConfigure.bind(this));

    // Conflict resolution endpoints
    app.post('/api/git-sync/resolve-pull', this.handleResolvePull.bind(this));
    app.post('/api/git-sync/resolve-push', this.handleResolvePush.bind(this));
  }

  /**
   * POST /api/git-sync/pull - Pull from remote
   */
  private handlePull = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    logger.info('GIT_SYNC', 'Pull request received');

    const result = await this.gitSyncManager.pull();
    res.json(result);
  });

  /**
   * POST /api/git-sync/push - Push to remote
   * Body: { message?: string }
   */
  private handlePush = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { message } = req.body || {};
    logger.info('GIT_SYNC', 'Push request received', { message });

    const result = await this.gitSyncManager.push(message);
    res.json(result);
  });

  /**
   * GET /api/git-sync/status - Get sync status
   */
  private handleStatus = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const status = await this.gitSyncManager.getStatus();
    res.json(status);
  });

  /**
   * POST /api/git-sync/configure - Configure remote URL
   * Body: { remoteUrl: string }
   */
  private handleConfigure = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { remoteUrl } = req.body;

    if (!remoteUrl) {
      res.status(400).json({ success: false, message: 'remoteUrl is required' });
      return;
    }

    logger.info('GIT_SYNC', 'Configure request received', { remoteUrl });

    const result = await this.gitSyncManager.configure(remoteUrl);
    res.json(result);
  });

  /**
   * POST /api/git-sync/resolve-pull - Resolve pull conflict
   * Body: { action: 'use_remote' | 'keep_local' }
   */
  private handleResolvePull = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { action } = req.body;

    if (!action || !['use_remote', 'keep_local'].includes(action)) {
      res.status(400).json({
        success: false,
        message: 'action must be "use_remote" or "keep_local"'
      });
      return;
    }

    logger.info('GIT_SYNC', 'Resolve pull conflict', { action });

    if (action === 'use_remote') {
      // Force pull (overwrite local)
      const result = await this.gitSyncManager.pull(true);
      res.json(result);
    } else {
      // Keep local, do nothing
      res.json({ success: true, message: 'Kept local version' });
    }
  });

  /**
   * POST /api/git-sync/resolve-push - Resolve push conflict
   * Body: { action: 'force_push' | 'pull_first' }
   */
  private handleResolvePush = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { action } = req.body;

    if (!action || !['force_push', 'pull_first'].includes(action)) {
      res.status(400).json({
        success: false,
        message: 'action must be "force_push" or "pull_first"'
      });
      return;
    }

    logger.info('GIT_SYNC', 'Resolve push conflict', { action });

    if (action === 'force_push') {
      // Force push (overwrite remote)
      const result = await this.gitSyncManager.push(undefined, true);
      res.json(result);
    } else {
      // Pull first, then push
      const pullResult = await this.gitSyncManager.pull(true);
      if (!pullResult.success) {
        res.json(pullResult);
        return;
      }
      const pushResult = await this.gitSyncManager.push();
      res.json(pushResult);
    }
  });
}
