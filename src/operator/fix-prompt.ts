import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function readFixPromptBody(): string {
  const raw = readFileSync(path.join(packageRoot(), 'templates', '.claude', 'commands', 'fix.md'), 'utf8');
  return raw
    .replace(/^<!-- pipelane:command:fix -->\n/, '')
    .replace(/\n<!-- pipelane:consumer-extension:start -->\n<!-- pipelane:consumer-extension:end -->\n?$/, '\n');
}
