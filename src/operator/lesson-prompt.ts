import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// Single source of truth for the /lesson prompt body, read by BOTH the
// machine-local host-install /lesson skill (desiredHostInstall) and the
// repo-local Codex /lesson skill (buildLessonCodexSkill). Mirrors
// readFixPromptBody, but lesson.md carries no command / consumer-extension
// markers: `lesson` is deliberately NOT in MANAGED_COMMANDS, so syncConsumerDocs
// never writes a repo-local .claude/commands/lesson.md. This file is a
// prompt-body source only — not a managed Claude command surface.
export function readLessonPromptBody(): string {
  return readFileSync(path.join(packageRoot(), 'templates', '.claude', 'commands', 'lesson.md'), 'utf8').trimEnd();
}
