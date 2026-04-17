import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { WorkflowConfig } from '../state.ts';
import { nowIso, resolveStateDir } from '../state.ts';

export const API_CONFIRMATIONS_DIRNAME = 'api-confirmations';
export const API_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const API_CONFIRMATION_TOKEN_PATTERN = /^[a-f0-9]{32,64}$/;

export interface ConfirmationRecord {
  token: string;
  actionId: string;
  fingerprint: string;
  normalizedInputs: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export function apiConfirmationDir(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), API_CONFIRMATIONS_DIRNAME);
}

function ensureApiConfirmationDir(commonDir: string, config: WorkflowConfig): void {
  mkdirSync(apiConfirmationDir(commonDir, config), { recursive: true });
}

export function apiConfirmationPath(commonDir: string, config: WorkflowConfig, token: string): string {
  return path.join(apiConfirmationDir(commonDir, config), `${token}.json`);
}

export function isValidConfirmationToken(token: unknown): token is string {
  return typeof token === 'string' && API_CONFIRMATION_TOKEN_PATTERN.test(token);
}

export function buildActionFingerprint(actionId: string, normalizedInputs: Record<string, unknown>): string {
  const canonical = JSON.stringify({ actionId, inputs: canonicalize(normalizedInputs) });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonicalize(v)]));
  }
  return value;
}

export function sweepExpiredApiConfirmations(commonDir: string, config: WorkflowConfig): void {
  const dir = apiConfirmationDir(commonDir, config);
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  const consumingStaleCutoff = now - API_CONFIRMATION_TTL_MS * 2;

  for (const entry of entries) {
    const filePath = path.join(dir, entry);

    if (entry.endsWith('.json')) {
      try {
        const record = JSON.parse(readFileSync(filePath, 'utf8')) as ConfirmationRecord;
        if (!record.expiresAt || Date.parse(record.expiresAt) < now) {
          unlinkSync(filePath);
        }
      } catch {
        // best-effort cleanup
      }
      continue;
    }

    // Orphaned `.consuming.<pid>.<ts>` files from a consume that failed
    // between rename and unlink. Reap once they're clearly stale so the
    // directory doesn't grow unbounded.
    const consumingMatch = entry.match(/\.consuming\.\d+\.(\d+)$/);
    if (consumingMatch) {
      const createdAt = Number(consumingMatch[1]);
      if (Number.isFinite(createdAt) && createdAt < consumingStaleCutoff) {
        try {
          unlinkSync(filePath);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }
}

export function createActionConfirmation(
  commonDir: string,
  config: WorkflowConfig,
  payload: { actionId: string; fingerprint: string; normalizedInputs: Record<string, unknown> },
): ConfirmationRecord {
  ensureApiConfirmationDir(commonDir, config);
  sweepExpiredApiConfirmations(commonDir, config);
  const token = crypto.randomBytes(16).toString('hex');
  const createdAt = nowIso();
  const record: ConfirmationRecord = {
    ...payload,
    token,
    createdAt,
    expiresAt: new Date(Date.now() + API_CONFIRMATION_TTL_MS).toISOString(),
  };
  writeFileSync(apiConfirmationPath(commonDir, config, token), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function consumeActionConfirmation(
  commonDir: string,
  config: WorkflowConfig,
  token: string,
  expectedFingerprint: string,
): ConfirmationRecord {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!isValidConfirmationToken(trimmed)) {
    throw new Error('No confirmation token found for this action.');
  }

  const sourcePath = apiConfirmationPath(commonDir, config, trimmed);
  const consumingPath = `${sourcePath}.consuming.${process.pid}.${Date.now()}`;

  try {
    renameSync(sourcePath, consumingPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error('No confirmation token found for this action.');
    }
    throw error;
  }

  let record: ConfirmationRecord | null = null;
  try {
    record = JSON.parse(readFileSync(consumingPath, 'utf8')) as ConfirmationRecord;
  } catch {
    record = null;
  }
  try {
    unlinkSync(consumingPath);
  } catch {
    // best effort
  }

  if (!record) {
    throw new Error('No confirmation token found for this action.');
  }
  if (!record.expiresAt || Date.parse(record.expiresAt) < Date.now()) {
    throw new Error('Confirmation token expired. Run the preflight again.');
  }
  if (record.fingerprint !== expectedFingerprint) {
    throw new Error('Confirmation token no longer matches the current action target. Run the preflight again.');
  }

  return record;
}
