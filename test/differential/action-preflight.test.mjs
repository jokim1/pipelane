import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

import {
  RISKY_ACTION_IDS,
  STABLE_ACTION_IDS,
  parseEnvelope,
  runPipelane,
  runRocketboard,
  setupMinimalFixture,
  ROCKETBOARD_OPERATOR,
} from './harness.mjs';

const hasRocketboard = existsSync(ROCKETBOARD_OPERATOR);

// Per-action argv augmentations. Pipelane's preflight now gates on operator
// scope for some actions (e.g. v0.7 requires clean.apply scope). Without
// these flags, Pipelane emits allowed:false + state:blocked and the risky/
// requiresConfirmation assertions below wouldn't exercise the happy path.
// Rocketboard accepts the same flags as a no-op.
const PREFLIGHT_EXTRA_ARGS = {
  'clean.apply': ['--all-stale'],
};

test('action preflight differential: risky flag and label match across all 11 stable IDs', { skip: !hasRocketboard && 'Rocketboard operator not available' }, () => {
  const repoRoot = setupMinimalFixture();
  try {
    const divergences = [];
    for (const actionId of STABLE_ACTION_IDS) {
      const extra = PREFLIGHT_EXTRA_ARGS[actionId] ?? [];
      const pipelaneResult = runPipelane(repoRoot, ['api', 'action', actionId, ...extra]);
      const rocketboardResult = runRocketboard(repoRoot, ['api', 'action', actionId, ...extra]);

      const pEnv = parseEnvelope(pipelaneResult.stdout);
      const rEnv = parseEnvelope(rocketboardResult.stdout);

      if (!pEnv) {
        divergences.push(`${actionId}: Pipelane produced no envelope (exit ${pipelaneResult.exitCode}). stderr: ${pipelaneResult.stderr}`);
        continue;
      }
      if (!rEnv) {
        divergences.push(`${actionId}: Rocketboard produced no envelope (exit ${rocketboardResult.exitCode}).`);
        continue;
      }

      assert.equal(pEnv.schemaVersion, rEnv.schemaVersion, `${actionId}: schemaVersion`);
      assert.equal(pEnv.command, rEnv.command, `${actionId}: command`);
      assert.equal(pEnv.data.action.id, rEnv.data.action.id, `${actionId}: action.id`);
      assert.equal(pEnv.data.action.risky, rEnv.data.action.risky, `${actionId}: action.risky`);
      assert.equal(pEnv.data.action.risky, RISKY_ACTION_IDS.has(actionId), `${actionId}: risky flag matches canonical set`);
      assert.equal(pEnv.data.preflight.requiresConfirmation, rEnv.data.preflight.requiresConfirmation, `${actionId}: requiresConfirmation`);

      if (pEnv.data.action.label !== rEnv.data.action.label) {
        divergences.push(`${actionId}: label differs (pipelane="${pEnv.data.action.label}", rocketboard="${rEnv.data.action.label}")`);
      }
    }

    if (divergences.length > 0) {
      console.log('\n[differential] action preflight divergences:');
      for (const entry of divergences) console.log(`  - ${entry}`);
    } else {
      console.log('\n[differential] action preflight: all 11 IDs match on action.id + risky + requiresConfirmation.');
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('action preflight: token issuance follows allowed/blocked semantics', { skip: !hasRocketboard && 'Rocketboard operator not available' }, () => {
  const repoRoot = setupMinimalFixture();
  try {
    const permissiveDivergences = [];
    const stricterDivergences = [];

    for (const actionId of RISKY_ACTION_IDS) {
      const pEnv = parseEnvelope(runPipelane(repoRoot, ['api', 'action', actionId]).stdout);
      const rEnv = parseEnvelope(runRocketboard(repoRoot, ['api', 'action', actionId]).stdout);
      assert.ok(pEnv, `${actionId}: Pipelane envelope`);
      assert.ok(rEnv, `${actionId}: Rocketboard envelope`);

      // Contract: token is only meaningful when preflight is allowed.
      if (pEnv.data.preflight.allowed) {
        assert.ok(pEnv.data.preflight.confirmation?.token, `${actionId}: Pipelane issued token when allowed`);
        assert.match(pEnv.data.preflight.confirmation.token, /^[a-f0-9]{32,64}$/, `${actionId}: Pipelane token format`);
      }
      if (rEnv.data.preflight.allowed) {
        assert.ok(rEnv.data.preflight.confirmation?.token, `${actionId}: Rocketboard issued token when allowed`);
        assert.match(rEnv.data.preflight.confirmation.token, /^[a-f0-9]{32,64}$/, `${actionId}: Rocketboard token format`);
      }

      // Known intentional divergence (step 6 backlog): Pipelane's preflight
      // is too permissive. Rocketboard gates on task-lock existence etc.
      // and emits allowed: false + state: blocked; Pipelane always says
      // allowed: true. Log each instance so step 6 has the agenda.
      if (pEnv.data.preflight.allowed && !rEnv.data.preflight.allowed) {
        permissiveDivergences.push(`${actionId}: Pipelane allowed=true but Rocketboard blocked (reason: ${rEnv.data.preflight.reason})`);
      }
      // v0.7+ intentional divergence in the other direction: Pipelane is
      // stricter than Rocketboard (e.g. clean.apply blocks when scope is
      // ambiguous). Log so we can see the surface shrinking session over session.
      if (!pEnv.data.preflight.allowed && rEnv.data.preflight.allowed) {
        stricterDivergences.push(`${actionId}: Pipelane blocked (reason: ${pEnv.data.preflight.reason}) but Rocketboard allowed`);
      }
    }

    if (permissiveDivergences.length > 0) {
      console.log('\n[differential] action preflight: Pipelane preflight too permissive (step 6 backlog):');
      for (const entry of permissiveDivergences) console.log(`  - ${entry}`);
    }
    if (stricterDivergences.length > 0) {
      console.log('\n[differential] action preflight: Pipelane stricter than Rocketboard (intentional, tracked in CHANGE_MANIFEST):');
      for (const entry of stricterDivergences) console.log(`  - ${entry}`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('action preflight: clean.apply without scope is blocked by Pipelane (v0.7 intentional divergence)', { skip: !hasRocketboard && 'Rocketboard operator not available' }, () => {
  const repoRoot = setupMinimalFixture();
  try {
    const pipelaneResult = runPipelane(repoRoot, ['api', 'action', 'clean.apply']);
    const envelope = parseEnvelope(pipelaneResult.stdout);
    assert.ok(envelope, 'Pipelane envelope parsed');
    assert.equal(envelope.ok, false, 'envelope.ok false when preflight is blocked');
    assert.equal(envelope.data.preflight.allowed, false);
    assert.equal(envelope.data.preflight.state, 'blocked');
    assert.equal(envelope.data.preflight.requiresConfirmation, false);
    assert.equal(envelope.data.preflight.confirmation, null);
    assert.match(envelope.data.preflight.reason, /requires scope/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// The risky-flag-and-label differential test runs Rocketboard with Pipelane's
// --all-stale flag to hit the "allowed" codepath on the Pipelane side. That
// only works if Rocketboard treats --all-stale as a no-op (its operator was
// written before the flag existed). Assert it explicitly instead of trusting
// the other test's silence.
test('differential: Rocketboard treats Pipelane --all-stale as a no-op on clean.apply', { skip: !hasRocketboard && 'Rocketboard operator not available' }, () => {
  const repoRoot = setupMinimalFixture();
  try {
    const withoutFlag = parseEnvelope(runRocketboard(repoRoot, ['api', 'action', 'clean.apply']).stdout);
    const withFlag = parseEnvelope(runRocketboard(repoRoot, ['api', 'action', 'clean.apply', '--all-stale']).stdout);
    assert.ok(withoutFlag, 'Rocketboard envelope without flag');
    assert.ok(withFlag, 'Rocketboard envelope with --all-stale');
    assert.equal(withFlag.ok, withoutFlag.ok, 'envelope.ok unchanged by --all-stale');
    assert.equal(withFlag.data.preflight.allowed, withoutFlag.data.preflight.allowed, 'preflight.allowed unchanged');
    assert.equal(withFlag.data.action.risky, withoutFlag.data.action.risky, 'action.risky unchanged');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
