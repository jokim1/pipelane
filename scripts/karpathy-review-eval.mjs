import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = await import(pathToFileURL(path.join(root, 'dist/operator/review-contract.js')).href);
const providers = (process.env.PIPELANE_REVIEW_EVAL_PROVIDERS ?? 'codex,claude').split(',').map((value) => value.trim()).filter(Boolean);
const deadline = Date.now() + 30 * 60 * 1000;
const fixtures = [
  {
    id: 'clean',
    scenario: 'Every changed hunk directly serves the objective and a focused regression verifies the failure path.',
    expected: 'passed', critical: [0, 0], warning: [0, 0], nit: [0, 0],
  },
  {
    id: 'unrelated-logic',
    scenario: 'The requested one-line fix is present, but the diff also changes unrelated product logic in a collateral file.',
    expected: 'failed', critical: [1, 100], warning: [0, 100], nit: [0, 100],
  },
  {
    id: 'drive-by-refactor',
    scenario: 'The requested behavior is implemented, but the diff also performs a broad drive-by refactor and reformat.',
    expected: 'failed', critical: [0, 100], warning: [1, 100], nit: [0, 100],
  },
  {
    id: 'missing-verification',
    scenario: 'A bug fix changes behavior but adds no reproducing regression or focused verification for the failure path.',
    expected: 'failed', critical: [0, 100], warning: [1, 100], nit: [0, 100],
  },
  {
    id: 'nit-only',
    scenario: 'The implementation is correct and verified; the sole issue is a trivial import-order naming preference.',
    expected: 'passed', critical: [0, 0], warning: [0, 0], nit: [1, 100],
  },
  {
    id: 'over-engineered',
    scenario: 'A fixed one-off behavior is implemented through speculative plugin configurability outside the task.',
    expected: 'failed', critical: [0, 100], warning: [1, 100], nit: [0, 100],
  },
];
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-karpathy-eval-'));
const providerRuns = new Map();
const unavailable = new Set();

try {
  for (const provider of providers) {
    if (spawnSync(provider, ['--version'], { stdio: 'ignore', timeout: 5000 }).status !== 0) {
      unavailable.add(provider);
      continue;
    }
    const runs = new Map();
    providerRuns.set(provider, runs);
    for (const fixture of fixtures) {
      if (Date.now() >= deadline) {
        runs.set(fixture.id, { fixture: fixture.id, attempt: 1, kind: 'cancelled', error: 'global 30-minute deadline reached before scheduling' });
        continue;
      }
      runs.set(fixture.id, invoke(provider, fixture, tempRoot, deadline, 1));
    }
  }

  const rerunKeys = new Set();
  for (const [provider, runs] of providerRuns) {
    for (const fixture of fixtures) {
      const result = runs.get(fixture.id);
      if (result?.kind === 'result' && !matchesBaseline(result, fixture)) rerunKeys.add(`${provider}\0${fixture.id}`);
    }
  }
  for (const fixture of fixtures) {
    const comparable = [...providerRuns.entries()].flatMap(([provider, runs]) => {
      const result = runs.get(fixture.id);
      return result?.kind === 'result' ? [{ provider, result }] : [];
    });
    if (new Set(comparable.map(({ result }) => resultKey(result))).size > 1) {
      for (const { provider } of comparable) rerunKeys.add(`${provider}\0${fixture.id}`);
    }
  }

  for (const key of rerunKeys) {
    const [provider, fixtureId] = key.split('\0');
    const fixture = fixtures.find((entry) => entry.id === fixtureId);
    const first = providerRuns.get(provider)?.get(fixtureId);
    if (!fixture || first?.kind !== 'result') continue;
    const rerun = Date.now() >= deadline
      ? { fixture: fixture.id, attempt: 2, kind: 'cancelled', error: 'global 30-minute deadline reached before rerun' }
      : invoke(provider, fixture, tempRoot, deadline, 2);
    providerRuns.get(provider).set(fixtureId, { ...first, rerun });
  }

  const summaries = providers.map((provider) => {
    if (unavailable.has(provider)) {
      return {
        provider,
        available: false,
        protocol: 'not-run',
        counts: { scheduled: 0, completed: 0, rerun: 0, timedOut: 0, skipped: fixtures.length, cancelled: 0 },
        fixtures: [],
        failures: [],
        skipReason: 'provider unavailable',
      };
    }
    const runs = providerRuns.get(provider);
    const details = fixtures.map((fixture) => {
      const first = runs.get(fixture.id);
      const final = first.rerun ?? first;
      const failures = [];
      if (final.kind !== 'result') failures.push(final.error ?? final.kind);
      else if (!matchesBaseline(final, fixture)) failures.push(baselineFailure(final, fixture));
      return { baseline: fixture, first, final, failures };
    });
    writeFileSync(path.join(tempRoot, `${provider}-details.json`), `${JSON.stringify(details, null, 2)}\n`, 'utf8');
    return {
      provider,
      available: true,
      protocol: details.every((entry) => entry.final.kind === 'result') ? 'passed' : 'failed',
      counts: countProviderRuns(details),
      fixtures: details.map((entry) => ({
        id: entry.baseline.id,
        expected: entry.baseline.expected,
        final: entry.final.kind === 'result'
          ? {
              status: entry.final.status,
              critical: entry.final.criticalCount,
              warning: entry.final.warningCount,
              nit: entry.final.nitCount,
              attempt: entry.final.attempt,
            }
          : { kind: entry.final.kind, attempt: entry.final.attempt },
        rerun: Boolean(entry.first.rerun),
        passedBaseline: entry.failures.length === 0,
      })),
      failures: details.flatMap((entry) => entry.failures.map((failure) => `${entry.baseline.id}: ${failure}`)),
    };
  });

  for (const fixture of fixtures) {
    const finalResults = summaries.flatMap((summary) => {
      const entry = summary.fixtures.find((candidate) => candidate.id === fixture.id);
      return entry?.final.status ? [{ summary, result: entry.final }] : [];
    });
    if (new Set(finalResults.map(({ result }) => summaryResultKey(result))).size > 1) {
      for (const { summary } of finalResults) summary.failures.push(`${fixture.id}: provider disagreement remained after the single permitted rerun`);
    }
  }

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    providerCallConcurrency: 1,
    providerCallConcurrencyLimit: 2,
    deadlineMinutes: 30,
    details: 'transient test temp root (removed after summary emission)',
    providers: summaries,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  const available = summaries.filter((summary) => summary.available);
  if (available.length === 0 || available.some((summary) => summary.failures.length > 0)) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function invoke(provider, fixture, tempRoot, globalDeadline, attempt) {
  const remaining = globalDeadline - Date.now();
  if (remaining <= 0) return { fixture: fixture.id, attempt, kind: 'cancelled', error: 'global 30-minute deadline reached' };
  const invocationRoot = mkdtempSync(path.join(tempRoot, `${provider}-${fixture.id}-`));
  const schema = path.join(invocationRoot, 'schema.json');
  const output = path.join(invocationRoot, 'result.json');
  writeFileSync(schema, JSON.stringify(contract.providerNativeJsonSchema()), 'utf8');
  const prompt = `Apply Karpathy traceability review semantics to this synthetic case. Critical or warning findings fail; nit-only passes. Return native structured JSON. Use null when a finding has no precise location.\nScenario: ${fixture.scenario}`;
  const args = provider === 'codex'
    ? ['exec', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '--skip-git-repo-check', '--output-schema', schema, '--output-last-message', output, '-']
    : ['--print', '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(contract.providerNativeJsonSchema())];
  const child = spawnSync(provider, args, {
    cwd: invocationRoot,
    input: prompt,
    encoding: 'utf8',
    timeout: Math.max(1, Math.min(10 * 60 * 1000, remaining)),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (child.error?.code === 'ETIMEDOUT') return { fixture: fixture.id, attempt, kind: 'timeout', error: child.error.message };
  if (child.error || child.signal || child.status === null || child.status !== 0) {
    return { fixture: fixture.id, attempt, kind: 'execution-error', error: child.error?.message ?? (child.signal ? `terminated by ${child.signal}` : `exit ${child.status}`) };
  }
  try {
    const stdout = provider === 'codex' && existsSync(output) ? readFileSync(output) : Buffer.from(child.stdout, 'utf8');
    const result = contract.adaptProviderCompletion({ provider, providerExitCode: child.status, providerSignal: child.signal, stdout }).result;
    return {
      fixture: fixture.id,
      attempt,
      kind: 'result',
      status: result.status,
      criticalCount: result.findings.filter((finding) => finding.severity === 'critical').length,
      warningCount: result.findings.filter((finding) => finding.severity === 'warning').length,
      nitCount: result.findings.filter((finding) => finding.severity === 'nit').length,
      findings: result.findings,
    };
  } catch (error) {
    return { fixture: fixture.id, attempt, kind: 'protocol-error', error: error instanceof Error ? error.message : String(error) };
  }
}

function matchesBaseline(result, fixture) {
  return result.status === fixture.expected
    && inRange(result.criticalCount, fixture.critical)
    && inRange(result.warningCount, fixture.warning)
    && inRange(result.nitCount, fixture.nit);
}

function baselineFailure(result, fixture) {
  return `expected ${fixture.expected}, critical ${fixture.critical.join('..')}, warning ${fixture.warning.join('..')}, nit ${fixture.nit.join('..')}; received ${result.status}, critical ${result.criticalCount}, warning ${result.warningCount}, nit ${result.nitCount}`;
}

function resultKey(result) {
  return `${result.status}:critical=${result.criticalCount > 0}:warning=${result.warningCount > 0}:nit=${result.nitCount > 0}`;
}

function summaryResultKey(result) {
  return `${result.status}:critical=${result.critical > 0}:warning=${result.warning > 0}:nit=${result.nit > 0}`;
}

function countProviderRuns(details) {
  const attempts = details.flatMap((entry) => [entry.first, ...(entry.first.rerun ? [entry.first.rerun] : [])]);
  return {
    scheduled: details.filter((entry) => entry.first.kind !== 'cancelled').length,
    completed: attempts.filter((entry) => entry.kind === 'result').length,
    rerun: details.filter((entry) => Boolean(entry.first.rerun)).length,
    timedOut: attempts.filter((entry) => entry.kind === 'timeout').length,
    skipped: 0,
    cancelled: attempts.filter((entry) => entry.kind === 'cancelled').length,
  };
}

function inRange(value, range) {
  return value >= range[0] && value <= range[1];
}
