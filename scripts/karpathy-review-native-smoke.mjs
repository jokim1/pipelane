import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = await import(pathToFileURL(path.join(root, 'dist/operator/review-contract.js')).href);
const requested = (process.env.PIPELANE_REVIEW_SMOKE_PROVIDERS ?? 'codex,claude').split(',').map((value) => value.trim()).filter(Boolean);
const required = new Set((process.env.PIPELANE_REVIEW_SMOKE_REQUIRED ?? requested[0] ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const timeout = Number.parseInt(process.env.PIPELANE_REVIEW_SMOKE_TIMEOUT_MS ?? '600000', 10);
const results = [];

for (const provider of requested) {
  if (!executable(provider)) {
    results.push({ provider, status: required.has(provider) ? 'failed' : 'skipped', reason: 'executable unavailable' });
    continue;
  }
  for (const expected of ['passed', 'failed']) {
    const temp = mkdtempSync(path.join(os.tmpdir(), `pipelane-${provider}-smoke-`));
    try {
      const schema = path.join(temp, 'schema.json');
      const output = path.join(temp, 'result.json');
      writeFileSync(schema, JSON.stringify(contract.providerNativeJsonSchema()), 'utf8');
      const prompt = expected === 'passed'
        ? 'Return a passed structured result with zero findings and a one-sentence report. Do not use tools.'
        : 'Return a failed structured result with exactly one warning finding titled "Synthetic smoke finding" and a one-sentence report. Do not use tools.';
      const invocation = provider === 'codex'
        ? ['codex', ['exec', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '--skip-git-repo-check', '--output-schema', schema, '--output-last-message', output, '-']]
        : ['claude', ['--print', '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(contract.providerNativeJsonSchema())]];
      const child = spawnSync(invocation[0], invocation[1], { cwd: temp, input: prompt, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
      const stdout = provider === 'codex' && existsSync(output) ? readFileSync(output, 'utf8') : child.stdout;
      if (child.error || child.signal || child.status === null || child.status !== 0) {
        throw new Error(child.error?.message ?? (child.signal
          ? `provider terminated by ${child.signal}`
          : `provider exited ${child.status}: ${boundedDiagnostic(child.stderr)}`));
      }
      const adapted = contract.adaptProviderCompletion({ provider, providerExitCode: child.status, providerSignal: child.signal, stdout });
      if (adapted.result.status !== expected) throw new Error(`expected ${expected}, received ${adapted.result.status}`);
      results.push({ provider, fixture: expected, status: 'passed' });
    } catch (error) {
      results.push({ provider, fixture: expected, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

const passedProviders = new Set(results.filter((entry) => entry.status === 'passed').map((entry) => entry.provider));
const failedRequired = [...required].filter((provider) => !passedProviders.has(provider));
process.stdout.write(`${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
if (failedRequired.length > 0 || passedProviders.size === 0 || results.some((entry) => entry.status === 'failed' && required.has(entry.provider))) process.exitCode = 1;

function executable(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

function boundedDiagnostic(value) {
  return String(value ?? '')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[REDACTED_AUTH_HEADER]')
    .replace(/\b((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .slice(-2000)
    .trim() || 'no stderr';
}
