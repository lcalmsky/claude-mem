---
name: mem-sync
description: Git으로 claude-mem 데이터베이스 백업/동기화. 수동으로 pull, push, status 확인 가능.
---

# Memory Sync

Git repository를 사용하여 claude-mem 데이터베이스를 백업하고 동기화합니다.

## When to Use

- 다른 머신으로 메모리를 옮기고 싶을 때
- 메모리를 백업하고 싶을 때
- 동기화 상태를 확인하고 싶을 때
- Remote URL을 설정하고 싶을 때

## Commands

### Pull (Remote에서 가져오기)

```
POST http://127.0.0.1:37777/api/git-sync/pull
```

Remote repository에서 최신 데이터베이스를 가져옵니다.

**충돌 시:**
- `needsUserAction: 'conflict_pull'` 반환
- `/api/git-sync/resolve-pull` 호출 필요
  - `action: 'use_remote'` - Remote 버전으로 덮어쓰기 (local 데이터 손실)
  - `action: 'keep_local'` - Local 버전 유지

### Push (Remote로 보내기)

```
POST http://127.0.0.1:37777/api/git-sync/push
Body: { "message": "optional commit message" }
```

현재 데이터베이스를 remote repository로 푸시합니다.

**충돌 시:**
- `needsUserAction: 'conflict_push'` 반환
- `/api/git-sync/resolve-push` 호출 필요
  - `action: 'force_push'` - 강제 푸시 (remote 데이터 손실)
  - `action: 'pull_first'` - 먼저 pull 후 push

### Status (상태 확인)

```
GET http://127.0.0.1:37777/api/git-sync/status
```

동기화 상태를 확인합니다.

**응답:**
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

### Configure (설정)

```
POST http://127.0.0.1:37777/api/git-sync/configure
Body: { "remoteUrl": "git@github.com:user/claude-mem-backup.git" }
```

Remote URL을 설정합니다. SSH URL 권장 (예: `git@github.com:user/repo.git`).

## Auto Sync 설정

`~/.claude-mem/settings.json`에서 설정:

```json
{
  "CLAUDE_MEM_GIT_REMOTE_URL": "git@github.com:user/repo.git",
  "CLAUDE_MEM_GIT_AUTO_SYNC": "true",
  "CLAUDE_MEM_GIT_IDLE_TIMEOUT_MIN": "10"
}
```

- `CLAUDE_MEM_GIT_AUTO_SYNC`: `"true"`로 설정하면 세션 시작 시 자동 pull, 종료 시 자동 push
- `CLAUDE_MEM_GIT_IDLE_TIMEOUT_MIN`: 지정된 분 동안 입력이 없으면 자동 push (기본값: 10분)

## Examples

### 1. 초기 설정

```
POST /api/git-sync/configure
Body: { "remoteUrl": "git@github.com:myuser/claude-mem-backup.git" }
```

### 2. 수동 백업

```
POST /api/git-sync/push
Body: { "message": "Manual backup before migration" }
```

### 3. 다른 머신에서 복원

```
POST /api/git-sync/pull
```

### 4. 충돌 해결 (remote 우선)

```
POST /api/git-sync/resolve-pull
Body: { "action": "use_remote" }
```

## Important Notes

- SSH key가 설정되어 있어야 합니다 (`~/.ssh/`)
- 바이너리 파일(SQLite)이므로 충돌 시 한쪽만 선택 가능합니다
- 동시에 여러 머신에서 작업하면 데이터 손실 위험이 있습니다
- 작업 전 항상 pull, 작업 후 바로 push 권장
