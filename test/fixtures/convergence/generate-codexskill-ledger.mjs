// D9: replay fixtures are generated, not copied. The generator consumes the
// checked-in shape spec (numbers pinned from the real codexskill ledgers) and
// invents all prose and identifiers, so no real repository's finding text or
// paths enter the pipelane history.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codexskill-route-shape.json');

export function loadCodexskillShapeSpec() {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
}

// Produces a legacy RouteSafetyRecord (pre-Convergence shape) representing the
// saga: 69 counted review passes and the 20-grant non-interactive resume
// burst. Placed in route-safety-state.json, it is the D6 migration input for
// the S1 replay acceptance test.
export function generateCodexskillLegacyRoute(spec, { taskSlug, branchName, headSha, targetCommand = '/pr' }) {
  const passes = spec.reviewPasses;
  const countedReviewRunIds = [];
  for (let index = 0; index < passes; index += 1) {
    countedReviewRunIds.push(`synthetic-review-${String(index + 1).padStart(3, '0')}`);
  }
  const resumes = [];
  const burstBase = Date.parse('2026-07-08T04:10:00.000Z');
  for (let index = 0; index < spec.resumeBurst.count; index += 1) {
    resumes.push({
      id: `synthetic-burst-${String(index + 1).padStart(2, '0')}`,
      kind: spec.resumeBurst.kind,
      recordedAt: new Date(burstBase + Math.floor((index * spec.resumeBurst.burstWindowSeconds * 1000) / spec.resumeBurst.count)).toISOString(),
      source: spec.resumeBurst.source,
      maxMoreLoops: spec.resumeBurst.maxMoreLoops,
      maxMoreMinutes: spec.resumeBurst.maxMoreMinutes,
    });
  }
  return {
    routeFingerprintDigest: 'd'.repeat(64),
    routeFingerprint: JSON.stringify({ synthetic: 'codexskill-saga' }),
    targetCommand,
    taskSlug,
    branchName,
    headSha,
    firstStartedAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    fixReviewLoops: passes,
    aiReviewRuns: passes,
    countedReviewRunIds,
    lastReviewRunId: countedReviewRunIds[countedReviewRunIds.length - 1],
    lastReviewStatus: 'failed',
    resumes,
  };
}
