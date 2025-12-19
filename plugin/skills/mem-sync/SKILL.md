---
name: mem-sync
description: Backup and sync claude-mem database via Git. Manually pull, push, or check status.
---

# Memory Sync

Backup and synchronize your claude-mem database using a Git repository.

## When to Use

- When you want to sync memory across multiple machines
- When you want to backup your memory
- When you want to check sync status
- When you want to configure remote URL

## Commands

### Pull (Fetch from remote)

```
POST http://127.0.0.1:37777/api/git-sync/pull
```

Fetches the latest database from the remote repository.

**On conflict:**
- Returns `needsUserAction: 'conflict_pull'`
- Call `/api/git-sync/resolve-pull` with:
  - `action: 'use_remote'` - Overwrite with remote version (local data loss)
  - `action: 'keep_local'` - Keep local version

### Push (Send to remote)

```
POST http://127.0.0.1:37777/api/git-sync/push
Body: { "message": "optional commit message" }
```

Pushes the current database to the remote repository.

**On conflict:**
- Returns `needsUserAction: 'conflict_push'`
- Call `/api/git-sync/resolve-push` with:
  - `action: 'force_push'` - Force push (remote data loss)
  - `action: 'pull_first'` - Pull first, then push

### Status (Check status)

```
GET http://127.0.0.1:37777/api/git-sync/status
```

Check synchronization status.

**Response:**
```json
{
  "configured": true,
  "remoteUrl": "git@github.com:user/repo.git",
  "lastSyncTime": null,
  "hasLocalChanges": true,
  "isAheadOfRemote": true,
  "isBehindRemote": false,
  "isDiverged": false
}
```

### Configure (Setup)

```
POST http://127.0.0.1:37777/api/git-sync/configure
Body: { "remoteUrl": "git@github.com:user/claude-mem-backup.git" }
```

Configure the remote URL. SSH URL recommended (e.g., `git@github.com:user/repo.git`).

## Auto Sync Settings

Configure in `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_GIT_REMOTE_URL": "git@github.com:user/repo.git",
  "CLAUDE_MEM_GIT_AUTO_SYNC": "true",
  "CLAUDE_MEM_GIT_IDLE_TIMEOUT_MIN": "10"
}
```

- `CLAUDE_MEM_GIT_AUTO_SYNC`: Set to `"true"` for auto pull on session start, auto push on session end
- `CLAUDE_MEM_GIT_IDLE_TIMEOUT_MIN`: Auto push after specified minutes of inactivity (default: 10)

## Examples

### 1. Initial Setup

```
POST /api/git-sync/configure
Body: { "remoteUrl": "git@github.com:myuser/claude-mem-backup.git" }
```

### 2. Manual Backup

```
POST /api/git-sync/push
Body: { "message": "Manual backup before migration" }
```

### 3. Restore on Another Machine

```
POST /api/git-sync/pull
```

### 4. Resolve Conflict (use remote)

```
POST /api/git-sync/resolve-pull
Body: { "action": "use_remote" }
```

## Important Notes

- SSH key must be configured (`~/.ssh/`)
- Binary file (SQLite) - only one side can be chosen on conflict
- Risk of data loss when working on multiple machines simultaneously
- Recommended: Always pull before starting work, push immediately after
