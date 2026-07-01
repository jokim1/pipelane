import crypto from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEPLOY_STATE_KEY_ENV = 'PIPELANE_DEPLOY_STATE_KEY';
export const PROBE_STATE_KEY_ENV = 'PIPELANE_PROBE_STATE_KEY';
export const REVIEW_STATE_KEY_ENV = 'PIPELANE_REVIEW_STATE_KEY';
export const ORCHESTRATION_STATE_KEY_ENV = 'PIPELANE_ORCHESTRATION_STATE_KEY';
export const ORCHESTRATION_STATE_KEY_FILE_ENV = 'PIPELANE_ORCHESTRATION_STATE_KEY_FILE';
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

function validateRequiredStateKey(name: string, raw: string | undefined, sourceLabel = name): string {
  if (raw === undefined) {
    throw new Error(`${name} is missing; set a signing key of at least ${MIN_STATE_KEY_LENGTH} characters before mutating or reading signed orchestration ledgers.`);
  }
  if (raw.trim().length === 0) {
    throw new Error(`${sourceLabel} is blank; set a signing key of at least ${MIN_STATE_KEY_LENGTH} characters.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_STATE_KEY_LENGTH) {
    throw new Error(`${sourceLabel} is too short; minimum accepted length is ${MIN_STATE_KEY_LENGTH} characters.`);
  }
  return trimmed;
}

export function resolveRequiredStateKey(name: string): string {
  return validateRequiredStateKey(name, process.env[name]);
}

function pipelaneHomeDir(): string {
  const override = process.env.PIPELANE_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.pipelane');
}

export function orchestrationStateKeyPath(): string {
  const override = process.env[ORCHESTRATION_STATE_KEY_FILE_ENV]?.trim();
  return override ? path.resolve(override) : path.join(pipelaneHomeDir(), 'keys', 'orchestration-state.key');
}

function readOrCreatePersistedOrchestrationStateKey(): string {
  const keyPath = orchestrationStateKeyPath();
  try {
    return validateRequiredStateKey(
      ORCHESTRATION_STATE_KEY_ENV,
      readFileSync(keyPath, 'utf8'),
      `${ORCHESTRATION_STATE_KEY_FILE_ENV} ${keyPath}`,
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw error;
  }

  const key = crypto.randomBytes(32).toString('base64url');
  mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    chmodSync(path.dirname(keyPath), 0o700);
  } catch {
    // Best effort: Windows and some network filesystems may not honor POSIX modes.
  }
  try {
    writeFileSync(keyPath, `${key}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      chmodSync(keyPath, 0o600);
    } catch {}
    return key;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') throw error;
    return validateRequiredStateKey(
      ORCHESTRATION_STATE_KEY_ENV,
      readFileSync(keyPath, 'utf8'),
      `${ORCHESTRATION_STATE_KEY_FILE_ENV} ${keyPath}`,
    );
  }
}

export function resolveOrchestrationStateKey(): string {
  if (process.env[ORCHESTRATION_STATE_KEY_ENV] !== undefined) {
    return resolveRequiredStateKey(ORCHESTRATION_STATE_KEY_ENV);
  }
  return readOrCreatePersistedOrchestrationStateKey();
}

export function stateKeyFingerprint(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}
