import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

import {
  CANONICAL_LANE_STATES,
  collectLaneStates,
  keyOnlyDiff,
  normalizeEnvelope,
  parseEnvelope,
  runPipelane,
  runRocketboard,
  setupMinimalFixture,
  ROCKETBOARD_OPERATOR,
} from './harness.mjs';

const hasRocketboard = existsSync(ROCKETBOARD_OPERATOR);

test('snapshot differential: schemaVersion, command, ok, laneOrder match', { skip: !hasRocketboard && 'Rocketboard operator not available' }, () => {
  const repoRoot = setupMinimalFixture();
  try {
    const pipelaneResult = runPipelane(repoRoot, ['api', 'snapshot']);
    const rocketboardResult = runRocketboard(repoRoot, ['api', 'snapshot']);

    assert.equal(pipelaneResult.exitCode, 0, `Pipelane exited ${pipelaneResult.exitCode}: ${pipelaneResult.stderr}`);
    assert.equal(rocketboardResult.exitCode, 0, `Rocketboard exited ${rocketboardResult.exitCode}: ${rocketboardResult.stderr}`);

    const pipelaneEnv = parseEnvelope(pipelaneResult.stdout);
    const rocketboardEnv = parseEnvelope(rocketboardResult.stdout);

    assert.ok(pipelaneEnv, 'Pipelane emitted parseable JSON');
    assert.ok(rocketboardEnv, 'Rocketboard emitted parseable JSON');

    assert.equal(pipelaneEnv.schemaVersion, rocketboardEnv.schemaVersion, 'schemaVersion matches');
    assert.equal(pipelaneEnv.command, rocketboardEnv.command, 'command matches');
    assert.equal(pipelaneEnv.ok, true);
    assert.equal(rocketboardEnv.ok, true);
    assert.deepEqual(pipelaneEnv.data.boardContext.laneOrder, rocketboardEnv.data.boardContext.laneOrder, 'laneOrder matches');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('snapshot differential: both envelopes use only canonical lane states', { skip: !hasRocketboard && 'Rocketboard operator not available' }, () => {
  const repoRoot = setupMinimalFixture();
  try {
    const pipelaneResult = runPipelane(repoRoot, ['api', 'snapshot']);
    const rocketboardResult = runRocketboard(repoRoot, ['api', 'snapshot']);
    const pipelaneEnv = parseEnvelope(pipelaneResult.stdout);
    const rocketboardEnv = parseEnvelope(rocketboardResult.stdout);

    const pipelaneStates = collectLaneStates(pipelaneEnv);
    const rocketboardStates = collectLaneStates(rocketboardEnv);

    for (const state of pipelaneStates) {
      // Snapshot envelopes also carry freshness.state (fresh/stale) which is
      // outside the lane vocab; skip those here.
      if (state === 'fresh' || state === 'stale') continue;
      assert.ok(CANONICAL_LANE_STATES.has(state), `Pipelane emitted non-canonical lane state: ${state}`);
    }
    for (const state of rocketboardStates) {
      if (state === 'fresh' || state === 'stale') continue;
      assert.ok(CANONICAL_LANE_STATES.has(state), `Rocketboard emitted non-canonical lane state: ${state}`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('snapshot differential report: prints divergences (informational)', { skip: !hasRocketboard && 'Rocketboard operator not available' }, () => {
  const repoRoot = setupMinimalFixture();
  try {
    const pipelaneResult = runPipelane(repoRoot, ['api', 'snapshot']);
    const rocketboardResult = runRocketboard(repoRoot, ['api', 'snapshot']);
    const pipelaneEnv = normalizeEnvelope(parseEnvelope(pipelaneResult.stdout));
    const rocketboardEnv = normalizeEnvelope(parseEnvelope(rocketboardResult.stdout));

    const diff = keyOnlyDiff(pipelaneEnv, rocketboardEnv);
    // Report divergences so that step 6 can see what to close. This is
    // explicitly non-failing: Pipelane is intentionally thinner in step 3a/3b.
    if (diff.onlyRocketboard.length > 0 || diff.onlyPipelane.length > 0) {
      console.log('\n[differential] snapshot key divergence:');
      for (const key of diff.onlyRocketboard) console.log(`  + Rocketboard only: ${key}`);
      for (const key of diff.onlyPipelane) console.log(`  + Pipelane only:    ${key}`);
    } else {
      console.log('\n[differential] snapshot: key sets match exactly.');
    }
    // Sanity: at least the critical shared keys exist.
    for (const expected of [
      'schemaVersion',
      'command',
      'ok',
      'data.boardContext.mode',
      'data.boardContext.baseBranch',
      'data.boardContext.laneOrder',
      'data.sourceHealth',
      'data.attention',
      'data.availableActions',
      'data.branches',
    ]) {
      assert.ok(diff.shared.includes(expected), `shared key missing: ${expected}`);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
