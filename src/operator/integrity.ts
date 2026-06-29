import crypto from 'node:crypto';

export const DEPLOY_STATE_KEY_ENV = 'PIPELANE_DEPLOY_STATE_KEY';
export const PROBE_STATE_KEY_ENV = 'PIPELANE_PROBE_STATE_KEY';
export const REVIEW_STATE_KEY_ENV = 'PIPELANE_REVIEW_STATE_KEY';
export const ORCHESTRATION_STATE_KEY_ENV = 'PIPELANE_ORCHESTRATION_STATE_KEY';
export const MIN_STATE_KEY_LENGTH = 32;

export function canonicalize(value: unknown): string {
  if (value === undefined) {
    // JSON.stringify drops undefined properties when writing to disk; the
    // canonical form must match so sign-time and verify-time produce the
    // same string after an on-disk round-trip.
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Arrays: JSON.stringify turns undefined entries into null, keeping the
    // slot. Mirror that so the canonical form survives JSON round-trip.
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalize(entry))).join(',')}]`;
  }

  const entries: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${canonicalize(entry)}`);
  }
  return `{${entries.join(',')}}`;
}

export function signSignedPayload<T extends { signature?: string }>(record: T, key: string): string {
  const { signature: _signature, ...rest } = record;
  return crypto.createHmac('sha256', key).update(canonicalize(rest)).digest('hex');
}

export function verifySignedPayload<T extends { signature?: string }>(record: T, key: string): boolean {
  if (typeof record.signature !== 'string' || record.signature.length !== 64 || !/^[a-f0-9]{64}$/i.test(record.signature)) return false;
  const expected = signSignedPayload(record, key);
  const a = Buffer.from(record.signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function computeUrlFingerprint(url: string): string {
  return crypto.createHash('sha256').update(url.trim()).digest('hex');
}

function resolveStateKey(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return undefined;
  return raw.trim();
}

export function resolveDeployStateKey(): string | undefined {
  return resolveStateKey(DEPLOY_STATE_KEY_ENV);
}

export function resolveProbeStateKey(): string | undefined {
  return resolveStateKey(PROBE_STATE_KEY_ENV);
}

export function resolveReviewStateKey(): string | undefined {
  return resolveStateKey(REVIEW_STATE_KEY_ENV);
}

export function resolveRequiredStateKey(name: string): string {
  const raw = process.env[name];
  if (raw === undefined) {
    throw new Error(`${name} is missing; set a signing key of at least ${MIN_STATE_KEY_LENGTH} characters before mutating or reading signed orchestration ledgers.`);
  }
  if (raw.trim().length === 0) {
    throw new Error(`${name} is blank; set a signing key of at least ${MIN_STATE_KEY_LENGTH} characters.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_STATE_KEY_LENGTH) {
    throw new Error(`${name} is too short; minimum accepted length is ${MIN_STATE_KEY_LENGTH} characters.`);
  }
  return trimmed;
}

export function resolveOrchestrationStateKey(): string {
  return resolveRequiredStateKey(ORCHESTRATION_STATE_KEY_ENV);
}

export function stateKeyFingerprint(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}
