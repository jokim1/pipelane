import crypto from 'node:crypto';

import {
  isCrossModelReviewGate,
  isIndependentAiReviewGate,
} from './review-gate-policy.ts';
import type { ReviewActorIdentity, ReviewRunRecord } from './state.ts';

export type ReviewIndependenceLabel =
  | 'cross-provider'
  | 'same-provider-independent'
  | 'same-session'
  | 'legacy'
  | 'unknown';

const SESSION_ID_ENV_KEYS = [
  'PIPELANE_ORCHESTRATE_WORKER_SESSION_ID',
  'PIPELANE_REVIEW_GATE_SESSION_ID',
  'PIPELANE_AGENT_SESSION_ID',
  'CODEX_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'OPENAI_SESSION_ID',
  'ANTHROPIC_SESSION_ID',
  'OPENCLAW_SESSION',
] as const;

const SESSION_ID_ENV_SOURCES: Array<{ key: typeof SESSION_ID_ENV_KEYS[number]; provider: string | null }> = [
  { key: 'PIPELANE_ORCHESTRATE_WORKER_SESSION_ID', provider: null },
  { key: 'PIPELANE_REVIEW_GATE_SESSION_ID', provider: null },
  { key: 'PIPELANE_AGENT_SESSION_ID', provider: null },
  { key: 'CODEX_SESSION_ID', provider: 'codex' },
  { key: 'CLAUDE_SESSION_ID', provider: 'claude' },
  { key: 'OPENAI_SESSION_ID', provider: 'codex' },
  { key: 'ANTHROPIC_SESSION_ID', provider: 'claude' },
  { key: 'OPENCLAW_SESSION', provider: 'openclaw' },
];

const PROVIDER_ENV_KEYS = [
  'PIPELANE_AGENT_PROVIDER',
  'PIPELANE_REVIEW_PROVIDER',
  'PIPELANE_ORCHESTRATE_PROVIDER',
] as const;

const AUTHOR_SESSION_ENV_KEYS = [
  'PIPELANE_AUTHOR_SESSION_ID',
  'PIPELANE_WORKER_SESSION_ID',
  'PIPELANE_ORCHESTRATE_WORKER_SESSION_ID',
] as const;

const AUTHOR_PROVIDER_ENV_KEYS = [
  'PIPELANE_AUTHOR_PROVIDER',
  'PIPELANE_WORKER_PROVIDER',
  'PIPELANE_ORCHESTRATE_PROVIDER',
  'PIPELANE_AGENT_PROVIDER',
] as const;

const KNOWN_REVIEW_PROVIDERS = new Set(['codex', 'claude', 'openclaw']);
const TRUSTED_REVIEWER_PROVIDER_SOURCES = new Map<string, string>([
  ['CODEX_SESSION_ID', 'codex'],
  ['OPENAI_SESSION_ID', 'codex'],
  ['CLAUDE_SESSION_ID', 'claude'],
  ['ANTHROPIC_SESSION_ID', 'claude'],
  ['OPENCLAW_SESSION', 'openclaw'],
]);

export function createReviewActorIdentity(options: {
  provider: string;
  sessionId: string;
  source: string;
}): ReviewActorIdentity {
  return {
    provider: normalizeIdentityText(options.provider, 'unknown'),
    sessionId: hashSessionId(options.sessionId),
    source: normalizeIdentityText(options.source, 'provided'),
  };
}

export function resolveReviewActorIdentity(options: {
  provider?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ReviewActorIdentity {
  const env = options.env ?? process.env;
  const explicitProvider = normalizeOptionalIdentityText(options.provider);
  const envProvider = normalizeOptionalIdentityText(firstEnvValue(env, PROVIDER_ENV_KEYS)?.value);
  const session = selectSessionEnvValue(env, explicitProvider || envProvider || '');
  const inferredProvider = session?.provider ?? '';
  const provider = explicitProvider || envProvider || inferredProvider || 'unknown';
  return {
    provider: normalizeIdentityText(provider, 'unknown'),
    sessionId: session ? hashSessionId(session.value) : null,
    source: session?.key ?? 'unavailable',
  };
}

export function resolveReviewAuthorIdentity(options: {
  provider?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ReviewActorIdentity | null {
  const env = options.env ?? process.env;
  const session = firstEnvValue(env, AUTHOR_SESSION_ENV_KEYS);
  if (session) {
    const provider = normalizeOptionalIdentityText(options.provider)
      || normalizeOptionalIdentityText(firstEnvValue(env, AUTHOR_PROVIDER_ENV_KEYS)?.value)
      || 'unknown';
    return createReviewActorIdentity({
      provider,
      sessionId: session.value,
      source: session.key,
    });
  }
  const fallback = resolveReviewActorIdentity(options);
  return fallback.sessionId ? fallback : null;
}

export function classifyReviewIndependence(options: {
  worker?: ReviewActorIdentity | null;
  reviewer?: ReviewActorIdentity | null;
}): { label: ReviewIndependenceLabel; reason: string } {
  const worker = options.worker ?? null;
  const reviewer = options.reviewer ?? null;
  if (!worker && !reviewer) {
    return { label: 'legacy', reason: 'review evidence predates actor identity tracking' };
  }
  if (!worker || !reviewer || !worker.sessionId || !reviewer.sessionId) {
    return { label: 'unknown', reason: 'recorded worker or reviewer session identity is unavailable' };
  }
  if (worker.sessionId === reviewer.sessionId) {
    return { label: 'same-session', reason: 'reviewer session matches the recorded worker session' };
  }
  const workerProviderTrusted = hasTrustedWorkerProviderIdentity(worker);
  const reviewerProviderTrusted = hasTrustedReviewerProviderIdentity(reviewer);
  if (workerProviderTrusted && reviewerProviderTrusted && worker.provider !== reviewer.provider) {
    return { label: 'cross-provider', reason: `reviewer provider ${reviewer.provider} differs from recorded worker provider ${worker.provider}` };
  }
  if (workerProviderTrusted && reviewerProviderTrusted && worker.provider === reviewer.provider) {
    return { label: 'same-provider-independent', reason: `reviewer session differs from recorded worker session for provider ${reviewer.provider}` };
  }
  return { label: 'unknown', reason: 'recorded worker or reviewer provider identity is unavailable' };
}

export function classifyReviewEvidenceIndependence(options: {
  reviewRun: Pick<ReviewRunRecord, 'gates' | 'reviewer'>;
  worker?: ReviewActorIdentity | null;
}): { label: ReviewIndependenceLabel; reason: string } {
  const worker = options.worker ?? null;
  if (!worker && !options.reviewRun.reviewer) {
    return classifyReviewIndependence({ worker, reviewer: null });
  }
  let trustedAiEvidence: { label: ReviewIndependenceLabel; reason: string } | null = null;
  let hasPassedBlockingAiGate = false;
  for (const gate of options.reviewRun.gates) {
    if (
      gate.blocking === false
      || gate.status !== 'passed'
      || !isIndependentAiReviewGate(gate)
    ) {
      continue;
    }
    hasPassedBlockingAiGate = true;
    const evidence = gate.attester
      ? classifyReviewIndependence({ worker, reviewer: gate.attester })
      : {
          label: 'unknown' as const,
          reason: `gate ${gate.gateId}: passed blocking AI review gate is missing attester identity`,
        };
    if (evidence.label === 'same-session' || evidence.label === 'unknown') return evidence;
    if (evidence.label === 'same-provider-independent') {
      trustedAiEvidence = evidence;
      continue;
    }
    if (!trustedAiEvidence) {
      trustedAiEvidence = evidence;
    }
  }
  if (hasPassedBlockingAiGate && trustedAiEvidence) return trustedAiEvidence;
  return classifyReviewIndependence({
    worker,
    reviewer: options.reviewRun.reviewer ?? null,
  });
}

export function reviewRunHasBlockingPassedAiGate(reviewRun: Pick<ReviewRunRecord, 'gates'>): boolean {
  return reviewRun.gates.some((gate) =>
    gate.blocking !== false
    && gate.status === 'passed'
    && isIndependentAiReviewGate(gate)
  );
}

export function aiReviewIndependenceBlocker(options: {
  reviewRun: Pick<ReviewRunRecord, 'gates'>;
  independence: ReviewIndependenceLabel | null | undefined;
  reason?: string | null;
}): string | null {
  if (!reviewRunHasBlockingPassedAiGate(options.reviewRun)) return null;
  if (options.independence === 'cross-provider') return null;
  if (options.independence === 'legacy' || !options.independence) return null;
  if (options.independence === 'same-session') {
    return `${options.reason ?? 'reviewer session matches the recorded worker session'}; blocking AI review evidence must come from a separate reviewer session`;
  }
  if (options.independence === 'same-provider-independent') return null;
  return `${options.reason ?? 'reviewer independence is unknown'}; blocking AI review evidence requires recorded worker and reviewer session identities`;
}

export function blockingAiReviewEvidenceBlocker(options: {
  reviewRun: Pick<ReviewRunRecord, 'gates' | 'reviewer'>;
  worker?: ReviewActorIdentity | null;
  allowTrustedAttesterWithoutWorker?: boolean;
  allowSessionOnlyIndependence?: boolean;
}): string | null {
  const worker = options.worker ?? null;
  const availableComparisonWorker = worker?.sessionId ? worker : null;
  const comparisonWorker = availableComparisonWorker
    && (!options.allowTrustedAttesterWithoutWorker || hasTrustedWorkerProviderIdentity(availableComparisonWorker))
    ? availableComparisonWorker
    : null;
  for (const gate of options.reviewRun.gates) {
    if (
      gate.blocking === false
      || gate.status !== 'passed'
      || !isIndependentAiReviewGate(gate)
    ) {
      continue;
    }
    if (!gate.attester) {
      return `gate ${gate.gateId}: passed blocking AI review gate is missing attester identity`;
    }
    if (
      availableComparisonWorker?.sessionId
      && gate.attester.sessionId
      && availableComparisonWorker.sessionId === gate.attester.sessionId
    ) {
      const sameSessionBlocker = aiReviewIndependenceBlocker({
        reviewRun: { gates: [gate] },
        independence: 'same-session',
        reason: 'reviewer session matches the recorded worker session',
      });
      return sameSessionBlocker ? `gate ${gate.gateId}: ${sameSessionBlocker}` : null;
    }
    if (!comparisonWorker) {
      if (options.allowTrustedAttesterWithoutWorker && hasTrustedReviewerProviderIdentity(gate.attester)) {
        continue;
      }
      return `gate ${gate.gateId}: recorded worker session identity is unavailable; blocking AI review evidence requires recorded worker and reviewer session identities`;
    }
    const independence = classifyReviewIndependence({ worker: comparisonWorker, reviewer: gate.attester });
    if (isCrossModelReviewGate(gate) && independence.label !== 'cross-provider') {
      return `gate ${gate.gateId}: cross-model review requires a different trusted provider family; ${independence.reason}`;
    }
    if (
      options.allowSessionOnlyIndependence
      && independence.label === 'unknown'
      && availableComparisonWorker?.sessionId
      && gate.attester.sessionId
      && availableComparisonWorker.sessionId !== gate.attester.sessionId
    ) {
      continue;
    }
    const blocker = aiReviewIndependenceBlocker({
      reviewRun: { gates: [gate] },
      independence: independence.label,
      reason: independence.reason,
    });
    if (blocker) return `gate ${gate.gateId}: ${blocker}`;
  }
  return null;
}

function knownProvider(provider: string): boolean {
  return KNOWN_REVIEW_PROVIDERS.has(provider);
}

function hasTrustedWorkerProviderIdentity(identity: ReviewActorIdentity): boolean {
  if (!identity.sessionId) return false;
  if (identity.source === 'PIPELANE_ORCHESTRATE_WORKER_SESSION_ID') return true;
  return knownProvider(identity.provider)
    && TRUSTED_REVIEWER_PROVIDER_SOURCES.get(identity.source) === identity.provider;
}

function hasTrustedReviewerProviderIdentity(identity: ReviewActorIdentity): boolean {
  if (!identity.sessionId || !knownProvider(identity.provider)) return false;
  if (identity.source === 'PIPELANE_REVIEW_GATE_SESSION_ID') return true;
  return TRUSTED_REVIEWER_PROVIDER_SOURCES.get(identity.source) === identity.provider;
}

function hashSessionId(sessionId: string): string {
  return `sha256:${crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;
}

function firstEnvValue(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

function selectSessionEnvValue(
  env: NodeJS.ProcessEnv,
  targetProvider: string,
): { key: string; value: string; provider: string | null } | null {
  const workerSession = env.PIPELANE_ORCHESTRATE_WORKER_SESSION_ID?.trim();
  if (workerSession) {
    return { key: 'PIPELANE_ORCHESTRATE_WORKER_SESSION_ID', value: workerSession, provider: null };
  }
  const reviewGateSession = env.PIPELANE_REVIEW_GATE_SESSION_ID?.trim();
  if (reviewGateSession) {
    return { key: 'PIPELANE_REVIEW_GATE_SESSION_ID', value: reviewGateSession, provider: null };
  }
  const available = SESSION_ID_ENV_SOURCES.flatMap((source) => {
    const value = env[source.key]?.trim();
    return value ? [{ ...source, value }] : [];
  });
  if (available.length === 0) return null;
  if (targetProvider) {
    return available.find((source) => source.provider === targetProvider)
      ?? available.find((source) => source.provider === null)
      ?? available[0];
  }
  return available.find((source) => source.provider !== null)
    ?? available.find((source) => source.provider === null)
    ?? available[0];
}

function normalizeOptionalIdentityText(value: string | undefined | null): string {
  return value ? normalizeIdentityText(value, '') : '';
}

function normalizeIdentityText(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/[^A-Za-z0-9_.:/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return normalized || fallback;
}
