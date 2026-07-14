// Captured from src/operator/state.ts at PR 1 merge
// 168ff47351ee01cb46460d7307fd0d229ef80e33. Keep this fixture independent
// from the current reader so additive compatibility regressions are observable.
export function readPr1RouteSafetyState(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { routes: {} };
  const routes = {};
  const rawRoutes = raw.routes;
  if (rawRoutes && typeof rawRoutes === 'object' && !Array.isArray(rawRoutes)) {
    for (const [digest, value] of Object.entries(rawRoutes)) {
      const normalized = normalizeRouteSafetyRecord(value);
      if (normalized && (normalized.lineageDigest === digest || normalized.routeFingerprintDigest === digest)) {
        routes[digest] = normalized;
      }
    }
  }
  const latestPausedRouteFingerprintDigest = typeof raw.latestPausedRouteFingerprintDigest === 'string'
    && routes[raw.latestPausedRouteFingerprintDigest]
    ? raw.latestPausedRouteFingerprintDigest
    : undefined;
  return {
    routes,
    ...(latestPausedRouteFingerprintDigest ? { latestPausedRouteFingerprintDigest } : {}),
  };
}

function normalizeRouteSafetyRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value;
  if (
    typeof raw.routeFingerprintDigest !== 'string'
    || typeof raw.routeFingerprint !== 'string'
    || typeof raw.targetCommand !== 'string'
    || typeof raw.taskSlug !== 'string'
    || typeof raw.branchName !== 'string'
    || typeof raw.headSha !== 'string'
    || typeof raw.firstStartedAt !== 'string'
    || typeof raw.updatedAt !== 'string'
  ) return null;
  const record = {
    routeFingerprintDigest: raw.routeFingerprintDigest,
    routeFingerprint: raw.routeFingerprint,
    targetCommand: raw.targetCommand,
    taskSlug: raw.taskSlug,
    branchName: raw.branchName,
    headSha: raw.headSha,
    firstStartedAt: raw.firstStartedAt,
    updatedAt: raw.updatedAt,
    fixReviewLoops: nonNegativeInteger(raw.fixReviewLoops),
    aiReviewRuns: nonNegativeInteger(raw.aiReviewRuns),
    countedReviewRunIds: Array.isArray(raw.countedReviewRunIds)
      ? raw.countedReviewRunIds.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      : [],
  };
  if (raw.lineageVersion === 1) record.lineageVersion = 1;
  for (const key of [
    'lineageDigest', 'lineageFingerprint', 'taskBindingId', 'acceptedFindingsAt',
    'acceptedFindingsSource', 'acceptedReviewRunId', 'acceptedAttemptDigest',
    'lastReviewRunId', 'pausedAt', 'pauseReason', 'currentAttemptDigest',
  ]) {
    if (typeof raw[key] === 'string') record[key] = raw[key];
  }
  if (raw.lastReviewStatus === 'passed' || raw.lastReviewStatus === 'failed' || raw.lastReviewStatus === 'pending') {
    record.lastReviewStatus = raw.lastReviewStatus;
  }
  if (Array.isArray(raw.attempts)) {
    const attempts = raw.attempts.filter(isRouteSafetyAttemptRecord).slice(0, 50);
    if (attempts.length > 0) record.attempts = attempts;
  }
  const legacyMigration = normalizeRouteSafetyLegacyMigration(raw.legacyMigration);
  if (legacyMigration) record.legacyMigration = legacyMigration;
  if (Array.isArray(raw.resumes)) {
    const resumes = raw.resumes.map(normalizeRouteSafetyResumeRecord).filter((entry) => entry !== null);
    if (resumes.length > 0) record.resumes = resumes;
  }
  return record;
}

function normalizeRouteSafetyResumeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value;
  if (
    typeof raw.id !== 'string'
    || typeof raw.recordedAt !== 'string'
    || (raw.source !== 'resume' && raw.source !== 'tty')
    || !['one-more-loop', 'more-loops-and-minutes', 'until-review-passes', 'accept-findings', 'legacy-import', 'legacy-fresh-start'].includes(raw.kind)
  ) return null;
  const record = { id: raw.id, kind: raw.kind, recordedAt: raw.recordedAt, source: raw.source };
  if (raw.oneMoreLoop === true) record.oneMoreLoop = true;
  for (const key of ['moreLoops', 'moreMinutes', 'maxMoreLoops', 'maxMoreMinutes']) {
    const parsed = positiveConfigInteger(raw[key]);
    if (parsed !== undefined) record[key] = parsed;
  }
  if (raw.acceptedFindings === true) record.acceptedFindings = true;
  if (typeof raw.confirmation === 'string') record.confirmation = raw.confirmation;
  if (typeof raw.reason === 'string') record.reason = raw.reason;
  if (raw.legacyMigrationAction === 'import' || raw.legacyMigrationAction === 'fresh-start') {
    record.legacyMigrationAction = raw.legacyMigrationAction;
  }
  if (typeof raw.legacyMigrationSourceDigest === 'string') record.legacyMigrationSourceDigest = raw.legacyMigrationSourceDigest;
  return record;
}

function isRouteSafetyAttemptRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.digest === 'string'
    && typeof value.fingerprint === 'string'
    && typeof value.headSha === 'string'
    && typeof value.worktreeStatusDigest === 'string'
    && typeof value.observedAt === 'string'
    && (value.reviewRunId === undefined || typeof value.reviewRunId === 'string');
}

function normalizeRouteSafetyLegacyMigration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['pending', 'imported', 'fresh-start'].includes(value.status)) return null;
  if (!Array.isArray(value.candidateDigests) || !value.candidateDigests.every((entry) => typeof entry === 'string')) return null;
  return {
    status: value.status,
    candidateDigests: value.candidateDigests,
    ...(nonNegativeInteger(value.extraLoops) > 0 ? { extraLoops: nonNegativeInteger(value.extraLoops) } : {}),
    ...(nonNegativeInteger(value.extraMinutes) > 0 ? { extraMinutes: nonNegativeInteger(value.extraMinutes) } : {}),
    ...(typeof value.decidedAt === 'string' ? { decidedAt: value.decidedAt } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.sourceDigest === 'string' ? { sourceDigest: value.sourceDigest } : {}),
  };
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveConfigInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
