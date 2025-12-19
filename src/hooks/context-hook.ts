/**
 * Context Hook - SessionStart
 *
 * Pure HTTP client - calls worker to generate context.
 * This allows the hook to run under any runtime (Node.js or Bun) since it has no
 * native module dependencies.
 */

import { stdin } from "process";
import { join } from "path";
import { homedir } from "os";
import { ensureWorkerRunning, getWorkerPort } from "../shared/worker-utils.js";
import { HOOK_TIMEOUTS } from "../shared/hook-constants.js";
import { handleWorkerError } from "../shared/hook-error-handler.js";
import { handleFetchError } from "./shared/error-handler.js";
import { getProjectName } from "../utils/project-name.js";
import { SettingsDefaultsManager } from "../shared/SettingsDefaultsManager.js";

export interface SessionStartInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name?: string;
}

async function contextHook(input?: SessionStartInput): Promise<string> {
  // Ensure worker is running before any other logic
  await ensureWorkerRunning();

  const cwd = input?.cwd ?? process.cwd();
  const project = getProjectName(cwd);
  const port = getWorkerPort();

  // Check if git auto sync is enabled and trigger pull
  try {
    const settingsPath = join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    if (settings.CLAUDE_MEM_GIT_AUTO_SYNC === 'true' && settings.CLAUDE_MEM_GIT_REMOTE_URL) {
      // Fire-and-forget pull (don't wait for result, don't block context generation)
      fetch(`http://127.0.0.1:${port}/api/git-sync/pull`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000)
      }).catch(() => {
        // Silently ignore errors - git sync is optional
      });
    }
  } catch {
    // Silently ignore settings read errors
  }

  const url = `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(project)}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HOOK_TIMEOUTS.DEFAULT) });

    if (!response.ok) {
      const errorText = await response.text();
      handleFetchError(response, errorText, {
        hookName: 'context',
        operation: 'Context generation',
        project,
        port
      });
    }

    const result = await response.text();
    return result.trim();
  } catch (error: any) {
    handleWorkerError(error);
  }
}

// Entry Point - handle stdin/stdout
const forceColors = process.argv.includes("--colors");

if (stdin.isTTY || forceColors) {
  contextHook(undefined).then((text) => {
    console.log(text);
    process.exit(0);
  });
} else {
  let input = "";
  stdin.on("data", (chunk) => (input += chunk));
  stdin.on("end", async () => {
    const parsed = input.trim() ? JSON.parse(input) : undefined;
    const text = await contextHook(parsed);

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text,
        },
      })
    );
    process.exit(0);
  });
}
