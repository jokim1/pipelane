import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  resolveConvergenceStateKey,
  signSignedPayload,
  stateKeyFingerprint,
  verifySignedPayload,
} from './integrity.ts';
import {
  acquireDirectoryStateLock,
  nowIso,
  resolveStateDir,
  type WorkflowConfig,
} from './state.ts';

// Convergence v1 S1 (D15): the completion-journal substrate. Review completion
// (budget debit + evidence continuity, later cache/ledger/spin-off writes)
// executes inside one task-scoped lock section: append an idempotent
// completion record keyed by reviewRunId, apply the store writes, then append
// an applied marker. Crash recovery replays unapplied records exactly-once —
// the same transaction-marker pattern as the orchestration ledger. Every line
// is HMAC-signed with the convergence-state key and fail-closed (D16): a line
// that fails verification refuses the journal instead of degrading to trust.

export const COMPLETION_JOURNAL_DIRNAME = 'completion-journal';
const COMPLETION_JOURNAL_LOCK_SUFFIX = '.lock';

export interface ReviewCompletionDebits {
  aiRunLaunches: number;
  activeMillis: number;
  // 1 when the run was a finding-failure (reviewer completed with blocking
  // findings); 0 for passes and for infra-only failures (D14: infra failures
  // never consume the operator's convergence allowance).
  fixReviewLoops: number;
  infraOnly: boolean;
}

export interface ReviewCompletionRecord {
  schemaVersion: 1;
  kind: 'review-completion';
  lineageKey: string;
  taskSlug: string;
  branchName: string;
  reviewRunId: string;
  reviewStatus: 'passed' | 'failed' | 'pending';
  debits: ReviewCompletionDebits;
  recordedAt: string;
  keyId: string;
  signature?: string;
}

interface AppliedMarkerRecord {
  schemaVersion: 1;
  kind: 'applied';
  lineageKey: string;
  reviewRunId: string;
  appliedAt: string;
  keyId: string;
  signature?: string;
}

type JournalLine = ReviewCompletionRecord | AppliedMarkerRecord;

export function completionJournalDir(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), COMPLETION_JOURNAL_DIRNAME);
}

export function completionJournalPath(commonDir: string, config: WorkflowConfig, lineageKey: string): string {
  return path.join(completionJournalDir(commonDir, config), `${lineageKey}.jsonl`);
}

function completionJournalLockPath(commonDir: string, config: WorkflowConfig, lineageKey: string): string {
  return path.join(completionJournalDir(commonDir, config), `${lineageKey}${COMPLETION_JOURNAL_LOCK_SUFFIX}`);
}

// D15's task-scoped lock: one lock per task lineage serializes the whole
// completion transaction (journal append + budget/evidence writes + marker).
export function withTaskCompletionLock<T>(commonDir: string, config: WorkflowConfig, lineageKey: string, fn: () => T): T {
  mkdirSync(completionJournalDir(commonDir, config), { recursive: true });
  const lock = acquireDirectoryStateLock(
    completionJournalLockPath(commonDir, config, lineageKey),
    `completion journal for task lineage ${lineageKey.slice(0, 12)} is locked: another process is applying a completion transaction. Wait and retry.`,
  );
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function signLine<T extends { signature?: string; keyId: string }>(line: T): T {
  const key = resolveConvergenceStateKey();
  line.keyId = stateKeyFingerprint(key);
  line.signature = signSignedPayload(line, key);
  return line;
}

function verifyLine(line: { signature?: string; keyId?: string }): boolean {
  const key = resolveConvergenceStateKey();
  if (line.keyId !== stateKeyFingerprint(key)) return false;
  return verifySignedPayload(line, key);
}

function readJournalLines(journalPath: string): JournalLine[] {
  if (!existsSync(journalPath)) return [];
  const rawText = readFileSync(journalPath, 'utf8');
  const lines: JournalLine[] = [];
  for (const [index, rawLine] of rawText.split('\n').entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Completion journal ${journalPath} line ${index + 1} is not valid JSON. The journal is refused (fail-closed); repair or remove the corrupted journal before continuing.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Completion journal ${journalPath} line ${index + 1} is not a journal record. The journal is refused (fail-closed).`);
    }
    const record = parsed as JournalLine;
    if (record.kind !== 'review-completion' && record.kind !== 'applied') {
      throw new Error(`Completion journal ${journalPath} line ${index + 1} has unknown kind. The journal is refused (fail-closed).`);
    }
    if (!verifyLine(record)) {
      throw new Error(`Completion journal ${journalPath} line ${index + 1} failed convergence-key signature verification. The journal is refused (fail-closed); no unverified completion record is ever applied.`);
    }
    lines.push(record);
  }
  return lines;
}

function writeJournalLines(journalPath: string, lines: JournalLine[]): void {
  const dir = path.dirname(journalPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(journalPath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmpPath, lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
    renameSync(tmpPath, journalPath);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

// Idempotent append: a record for an already-journaled reviewRunId returns the
// existing record untouched, so retries and crash replays never double-debit.
export function appendReviewCompletionRecord(
  commonDir: string,
  config: WorkflowConfig,
  record: Omit<ReviewCompletionRecord, 'schemaVersion' | 'kind' | 'recordedAt' | 'keyId' | 'signature'>,
): ReviewCompletionRecord {
  const journalPath = completionJournalPath(commonDir, config, record.lineageKey);
  const lines = readJournalLines(journalPath);
  const existing = lines.find((line): line is ReviewCompletionRecord =>
    line.kind === 'review-completion' && line.reviewRunId === record.reviewRunId);
  if (existing) return existing;
  const full: ReviewCompletionRecord = signLine({
    schemaVersion: 1,
    kind: 'review-completion',
    ...record,
    recordedAt: nowIso(),
    keyId: '',
  });
  writeJournalLines(journalPath, [...lines, full]);
  return full;
}

export function markReviewCompletionApplied(
  commonDir: string,
  config: WorkflowConfig,
  lineageKey: string,
  reviewRunId: string,
): void {
  const journalPath = completionJournalPath(commonDir, config, lineageKey);
  const lines = readJournalLines(journalPath);
  if (lines.some((line) => line.kind === 'applied' && line.reviewRunId === reviewRunId)) return;
  const marker: AppliedMarkerRecord = signLine({
    schemaVersion: 1,
    kind: 'applied',
    lineageKey,
    reviewRunId,
    appliedAt: nowIso(),
    keyId: '',
  });
  writeJournalLines(journalPath, [...lines, marker]);
}

// Records journaled but never marked applied — the crash-replay input.
export function readUnappliedCompletionRecords(
  commonDir: string,
  config: WorkflowConfig,
  lineageKey: string,
): ReviewCompletionRecord[] {
  const lines = readJournalLines(completionJournalPath(commonDir, config, lineageKey));
  const applied = new Set(lines.filter((line) => line.kind === 'applied').map((line) => line.reviewRunId));
  return lines.filter((line): line is ReviewCompletionRecord =>
    line.kind === 'review-completion' && !applied.has(line.reviewRunId));
}

// A lineage re-key (branch-alone entry upgraded to its slug lineage) carries
// the journal with it, so unapplied crash records survive the identity
// transfer. Records already present under the new key win; missing ones
// append. The old file is removed only after the merge is durably written.
export function migrateCompletionJournalLineage(
  commonDir: string,
  config: WorkflowConfig,
  fromLineageKey: string,
  toLineageKey: string,
): void {
  if (fromLineageKey === toLineageKey) return;
  const fromPath = completionJournalPath(commonDir, config, fromLineageKey);
  if (!existsSync(fromPath)) return;
  const toPath = completionJournalPath(commonDir, config, toLineageKey);
  const fromLines = readJournalLines(fromPath);
  const toLines = readJournalLines(toPath);
  const seen = new Set(toLines.map((line) => `${line.kind}:${line.reviewRunId}`));
  const merged = [...toLines];
  for (const line of fromLines) {
    if (seen.has(`${line.kind}:${line.reviewRunId}`)) continue;
    // Re-sign under the new lineage key value so replay verification of the
    // migrated line matches its stored lineage.
    merged.push(signLine({ ...line, lineageKey: toLineageKey, signature: undefined, keyId: '' } as JournalLine & { keyId: string }));
    seen.add(`${line.kind}:${line.reviewRunId}`);
  }
  writeJournalLines(toPath, merged);
  rmSync(fromPath, { force: true });
}

// D10 retention: the journal truncates after successful apply + /clean. Only
// a fully-applied journal is removed; an unapplied record keeps the file so
// the next load can replay it.
export function pruneAppliedCompletionJournal(
  commonDir: string,
  config: WorkflowConfig,
  lineageKey: string,
): boolean {
  const journalPath = completionJournalPath(commonDir, config, lineageKey);
  if (!existsSync(journalPath)) return false;
  if (readUnappliedCompletionRecords(commonDir, config, lineageKey).length > 0) return false;
  rmSync(journalPath, { force: true });
  return true;
}
