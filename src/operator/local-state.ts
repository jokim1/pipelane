import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { normalizePath, resolveGitCommonDir, runGit } from './state.ts';

export const MANAGED_LOCAL_STATE_START_MARKER = '# >>> pipelane local-state v1 >>>';
export const MANAGED_LOCAL_STATE_END_MARKER = '# <<< pipelane local-state v1 <<<';
export const MANAGED_LOCAL_STATE_ENTRY_PREFIX = '# pipelane-entry: ';
export const MANAGED_LOCAL_STATE_MAX_FILE_BYTES = 1024 * 1024;
export const MANAGED_LOCAL_STATE_MAX_BLOCK_BYTES = 64 * 1024;
export const MANAGED_LOCAL_STATE_MAX_ENTRIES = 128;
export const MANAGED_LOCAL_STATE_MAX_REASON_SCALARS = 256;
export const MANAGED_LOCAL_STATE_GIT_OUTPUT_BYTES = 1024 * 1024;

const MANAGED_LOCAL_STATE_DIGEST_DOMAIN = '\0pipelane-managed-local-state-v1\0';
const MANAGED_LOCAL_STATE_LEASE_DIRNAME = 'pipelane-local-state-v1.lock';
const MANAGED_LOCAL_STATE_LEASE_OWNER = 'owner.json';
const DEFAULT_LEASE_WAIT_MS = 2_000;
const DEFAULT_LEASE_POLL_MS = 25;

export interface LocalStateEntryV1 {
  schemaVersion: 1;
  path: string;
  kind: 'file' | 'directory';
  reason: string;
  createdAt: string;
}

export interface ParsedManagedLocalState {
  excludePath: string;
  entries: LocalStateEntryV1[];
  canonicalBlock: Buffer;
  blockStart: number;
  blockEnd: number;
  userOwnedBytes: Buffer;
}

export type ManagedLocalStateActualKind = LocalStateEntryV1['kind'] | 'missing' | 'symlink' | 'other';

export interface ManagedLocalStateEntryInspection extends LocalStateEntryV1 {
  pattern: string;
  present: boolean;
  actualKind: ManagedLocalStateActualKind;
  conflicts: string[];
}

export interface ManagedLocalStateInspection {
  repoRoot: string;
  commonDir: string;
  excludePath: string;
  initialized: boolean;
  valid: boolean;
  reliable: boolean;
  entries: ManagedLocalStateEntryInspection[];
  canonicalBlock: Buffer | null;
  canonicalBlockHash: string;
  digestSuffix: string;
  warnings: string[];
  validationGitCalls: number;
}

export interface ManagedLocalStateMutationHooks {
  beforeCompare?: (attempt: number, excludePath: string, candidate: Buffer) => void;
  beforeRename?: (attempt: number, excludePath: string, candidate: Buffer) => void;
  verify?: (repoRoot: string, candidate: Buffer) => void;
  now?: () => string;
  leaseWaitMs?: number;
  leasePollMs?: number;
}

export interface ManagedLocalStateWriterLease {
  leasePath: string;
  ownerPath: string;
  token: string;
  pid: number;
  acquiredAt: string;
}

interface ExcludeSnapshot {
  exists: boolean;
  bytes: Buffer;
  mode: number | null;
}

interface EntryValidationResult {
  inspections: ManagedLocalStateEntryInspection[];
  warnings: string[];
  gitCalls: number;
}

interface BatchQuery {
  expression: string;
  entryPath: string;
  checkedPath: string;
  role: 'root' | 'ancestor';
  stage?: number;
}

interface BatchResult {
  missing: boolean;
  type: string;
  objectId: string;
}

interface IgnoreProbe {
  entryPath: string;
  path: string;
  pattern: string;
}

interface LeaseOwnerFile {
  pid: number;
  acquiredAt: string;
  token: string;
}

export function resolveManagedLocalStateExcludePath(repoRoot: string): string {
  return path.join(resolveGitCommonDir(repoRoot), 'info', 'exclude');
}

export function resolveManagedLocalStateLeasePath(repoRoot: string): string {
  return path.join(resolveGitCommonDir(repoRoot), MANAGED_LOCAL_STATE_LEASE_DIRNAME);
}

export function emptyManagedLocalStateBlock(): Buffer {
  return Buffer.from(`${MANAGED_LOCAL_STATE_START_MARKER}\n${MANAGED_LOCAL_STATE_END_MARKER}\n`, 'utf8');
}

export function managedLocalStateBlockHash(block: Buffer): string {
  return createHash('sha256').update(block).digest('hex');
}

export function managedLocalStateDigestSuffix(block: Buffer): string {
  return `${MANAGED_LOCAL_STATE_DIGEST_DOMAIN}${managedLocalStateBlockHash(block)}`;
}

export function normalizeManagedLocalStatePath(rawPath: string): string {
  assertUnicodeScalars(rawPath, 'local-state path');
  assertNoControlCharacters(rawPath, 'local-state path');
  if (!rawPath.length) {
    throw new Error('local-state --path must name one repository-relative file or directory.');
  }
  if (path.posix.isAbsolute(rawPath) || path.isAbsolute(rawPath)) {
    throw new Error(`local-state path must be repository-relative, not absolute: ${rawPath}`);
  }
  const segments = rawPath.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`local-state path may not traverse a parent directory: ${rawPath}`);
  }
  const normalized = path.posix.normalize(rawPath);
  if (!normalized || normalized === '.' || normalized === '/') {
    throw new Error('local-state path may not declare the repository root.');
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`local-state path may not leave the repository: ${rawPath}`);
  }
  const normalizedSegments = normalized.split('/');
  if (normalizedSegments[0] === '.git') {
    throw new Error('local-state path may not declare .git or anything below it.');
  }
  return normalized.replace(/^\.\//u, '');
}

export function escapeManagedIgnorePattern(relativePath: string, kind: LocalStateEntryV1['kind']): string {
  const normalized = normalizeManagedLocalStatePath(relativePath);
  let escaped = '';
  for (const character of normalized) {
    if (character === '\\' || character === '!' || character === '#' || character === '*'
      || character === '?' || character === '[' || character === ']') {
      escaped += `\\${character}`;
    } else {
      escaped += character;
    }
  }
  escaped = escaped.replace(/ +$/u, (spaces) => '\\ '.repeat(spaces.length));
  return `/${escaped}${kind === 'directory' ? '/' : ''}`;
}

export function canonicalizeManagedLocalStateEntry(entry: LocalStateEntryV1): LocalStateEntryV1 {
  const normalizedPath = normalizeManagedLocalStatePath(entry.path);
  if (entry.path !== normalizedPath) {
    throw new Error(`local-state entry path is not canonical: ${entry.path}`);
  }
  if (entry.kind !== 'file' && entry.kind !== 'directory') {
    throw new Error(`local-state entry ${entry.path} has invalid kind ${String(entry.kind)}.`);
  }
  assertUnicodeScalars(entry.reason, `reason for ${entry.path}`);
  assertNoControlCharacters(entry.reason, `reason for ${entry.path}`);
  if (!entry.reason.trim()) {
    throw new Error(`local-state entry ${entry.path} requires a non-empty reason.`);
  }
  if (unicodeScalarLength(entry.reason) > MANAGED_LOCAL_STATE_MAX_REASON_SCALARS) {
    throw new Error(`local-state entry ${entry.path} reason exceeds ${MANAGED_LOCAL_STATE_MAX_REASON_SCALARS} Unicode scalar values.`);
  }
  if (!isCanonicalTimestamp(entry.createdAt)) {
    throw new Error(`local-state entry ${entry.path} createdAt must be UTC ISO 8601 with millisecond precision.`);
  }
  return {
    schemaVersion: 1,
    path: normalizedPath,
    kind: entry.kind,
    reason: entry.reason,
    createdAt: entry.createdAt,
  };
}

export function serializeManagedLocalStateBlock(entries: LocalStateEntryV1[]): Buffer {
  if (entries.length > MANAGED_LOCAL_STATE_MAX_ENTRIES) {
    throw new Error(`local-state declarations exceed the v1 limit of ${MANAGED_LOCAL_STATE_MAX_ENTRIES}.`);
  }
  const canonicalEntries = entries
    .map(canonicalizeManagedLocalStateEntry)
    .sort((left, right) => compareCanonicalPaths(left.path, right.path));
  assertNoDuplicateOrOverlappingEntries(canonicalEntries);
  const lines = [MANAGED_LOCAL_STATE_START_MARKER];
  for (const entry of canonicalEntries) {
    lines.push(`${MANAGED_LOCAL_STATE_ENTRY_PREFIX}${JSON.stringify(entry)}`);
    lines.push(escapeManagedIgnorePattern(entry.path, entry.kind));
  }
  lines.push(MANAGED_LOCAL_STATE_END_MARKER);
  const block = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  if (block.length > MANAGED_LOCAL_STATE_MAX_BLOCK_BYTES) {
    throw new Error(`Pipelane local-state managed block exceeds ${MANAGED_LOCAL_STATE_MAX_BLOCK_BYTES} bytes.`);
  }
  return block;
}

export function parseManagedLocalState(excludePath: string, bytes: Buffer): ParsedManagedLocalState {
  if (bytes.length > MANAGED_LOCAL_STATE_MAX_FILE_BYTES) {
    throw managedConfigError(excludePath, `exclude file exceeds ${MANAGED_LOCAL_STATE_MAX_FILE_BYTES} bytes`);
  }
  const starts = exactMarkerLinePositions(bytes, MANAGED_LOCAL_STATE_START_MARKER);
  const ends = exactMarkerLinePositions(bytes, MANAGED_LOCAL_STATE_END_MARKER);
  if (starts.length === 0 && ends.length === 0) {
    throw managedConfigError(excludePath, 'required v1 block is missing', true);
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw managedConfigError(excludePath, `expected exactly one managed block, found ${starts.length} start marker(s) and ${ends.length} end marker(s)`);
  }
  const blockStart = starts[0];
  const endMarkerStart = ends[0];
  if (endMarkerStart <= blockStart) {
    throw managedConfigError(excludePath, 'managed block markers are nested or out of order');
  }
  const startMarkerEnd = blockStart + Buffer.byteLength(MANAGED_LOCAL_STATE_START_MARKER);
  const endMarkerEnd = endMarkerStart + Buffer.byteLength(MANAGED_LOCAL_STATE_END_MARKER);
  if (bytes[startMarkerEnd] !== 0x0a || bytes[endMarkerEnd] !== 0x0a) {
    throw managedConfigError(excludePath, 'managed block lines must use canonical LF endings and include a final LF');
  }
  const blockEnd = endMarkerEnd + 1;
  const block = bytes.subarray(blockStart, blockEnd);
  if (block.length > MANAGED_LOCAL_STATE_MAX_BLOCK_BYTES) {
    throw managedConfigError(excludePath, `managed block exceeds ${MANAGED_LOCAL_STATE_MAX_BLOCK_BYTES} bytes`);
  }
  let blockText = '';
  try {
    blockText = new TextDecoder('utf-8', { fatal: true }).decode(block);
  } catch {
    throw managedConfigError(excludePath, 'managed block is not valid UTF-8');
  }
  const lines = blockText.split('\n');
  const body = lines.slice(1, -2);
  if (body.length % 2 !== 0) {
    throw managedConfigError(excludePath, 'managed entry metadata is truncated or missing its generated pattern');
  }
  const entries: LocalStateEntryV1[] = [];
  for (let index = 0; index < body.length; index += 2) {
    const metadataLine = body[index];
    const patternLine = body[index + 1];
    if (!metadataLine.startsWith(MANAGED_LOCAL_STATE_ENTRY_PREFIX)) {
      throw managedConfigError(excludePath, `managed line ${index + 2} must begin with ${MANAGED_LOCAL_STATE_ENTRY_PREFIX.trim()}`);
    }
    const jsonText = metadataLine.slice(MANAGED_LOCAL_STATE_ENTRY_PREFIX.length);
    let value: unknown;
    try {
      value = JSON.parse(jsonText);
    } catch {
      throw managedConfigError(excludePath, `managed entry JSON on line ${index + 2} is invalid`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw managedConfigError(excludePath, `managed entry JSON on line ${index + 2} must be an object`);
    }
    const raw = value as Record<string, unknown>;
    const keys = Object.keys(raw);
    const expectedKeys = ['schemaVersion', 'path', 'kind', 'reason', 'createdAt'];
    if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
      throw managedConfigError(excludePath, `managed entry JSON on line ${index + 2} has noncanonical keys or key order`);
    }
    if (raw.schemaVersion !== 1 || typeof raw.path !== 'string'
      || (raw.kind !== 'file' && raw.kind !== 'directory')
      || typeof raw.reason !== 'string' || typeof raw.createdAt !== 'string') {
      throw managedConfigError(excludePath, `managed entry JSON on line ${index + 2} does not match schemaVersion 1`);
    }
    let entry: LocalStateEntryV1;
    try {
      entry = canonicalizeManagedLocalStateEntry({
        schemaVersion: 1,
        path: raw.path,
        kind: raw.kind,
        reason: raw.reason,
        createdAt: raw.createdAt,
      });
    } catch (error) {
      throw managedConfigError(excludePath, error instanceof Error ? error.message : String(error));
    }
    if (JSON.stringify(entry) !== jsonText) {
      throw managedConfigError(excludePath, `managed entry JSON on line ${index + 2} is not canonical`);
    }
    const expectedPattern = escapeManagedIgnorePattern(entry.path, entry.kind);
    if (patternLine !== expectedPattern) {
      throw managedConfigError(excludePath, `managed entry ${entry.path} pattern mismatch: expected ${expectedPattern}`);
    }
    entries.push(entry);
  }
  let canonicalBlock: Buffer;
  try {
    canonicalBlock = serializeManagedLocalStateBlock(entries);
  } catch (error) {
    throw managedConfigError(excludePath, error instanceof Error ? error.message : String(error));
  }
  if (!canonicalBlock.equals(block)) {
    throw managedConfigError(excludePath, 'managed block is not in canonical path order or canonical serialization');
  }
  return {
    excludePath,
    entries,
    canonicalBlock,
    blockStart,
    blockEnd,
    userOwnedBytes: Buffer.concat([bytes.subarray(0, blockStart), bytes.subarray(blockEnd)]),
  };
}

export function inspectManagedLocalState(repoRoot: string): ManagedLocalStateInspection {
  const normalizedRoot = normalizePath(repoRoot);
  let commonDir = '';
  let excludePath = '';
  try {
    commonDir = resolveGitCommonDir(normalizedRoot);
    excludePath = path.join(commonDir, 'info', 'exclude');
    const snapshot = readExcludeSnapshot(excludePath, false);
    const parsed = parseManagedLocalState(excludePath, snapshot.bytes);
    const validation = inspectEntriesAgainstCurrentState(normalizedRoot, excludePath, parsed.entries);
    const warnings = uniqueStrings(validation.warnings);
    const blockHash = managedLocalStateBlockHash(parsed.canonicalBlock);
    return {
      repoRoot: normalizedRoot,
      commonDir,
      excludePath,
      initialized: true,
      valid: warnings.length === 0,
      reliable: warnings.length === 0,
      entries: validation.inspections,
      canonicalBlock: parsed.canonicalBlock,
      canonicalBlockHash: blockHash,
      digestSuffix: managedLocalStateDigestSuffix(parsed.canonicalBlock),
      warnings,
      validationGitCalls: validation.gitCalls,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      repoRoot: normalizedRoot,
      commonDir,
      excludePath: excludePath || path.join(normalizedRoot, '.git', 'info', 'exclude'),
      initialized: !/required v1 block is missing|does not exist/u.test(message),
      valid: false,
      reliable: false,
      entries: [],
      canonicalBlock: null,
      canonicalBlockHash: '',
      digestSuffix: '',
      warnings: [message],
      validationGitCalls: 0,
    };
  }
}

export function assertManagedLocalStateValid(repoRoot: string): ManagedLocalStateInspection {
  const inspection = inspectManagedLocalState(repoRoot);
  if (!inspection.valid) {
    throw new Error([
      `Pipelane managed local-state is invalid for ${inspection.repoRoot}.`,
      ...inspection.warnings.map((warning) => `- ${warning}`),
      `Inspect ${inspection.excludePath}.`,
      inspection.initialized
        ? 'Remove the conflicting declaration with `pipelane run local-state remove --path <path> --yes`, or repair the canonical managed block.'
        : 'Run `pipelane setup` once in this repository, then rerun review before a source-changing or destination command.',
    ].join('\n'));
  }
  return inspection;
}

export function assertManagedLocalStateValidForTree(repoRoot: string, targetRef: string): void {
  const normalizedRoot = normalizePath(repoRoot);
  const excludePath = resolveManagedLocalStateExcludePath(normalizedRoot);
  const parsed = parseManagedLocalState(excludePath, readExcludeSnapshot(excludePath, false).bytes);
  if (parsed.entries.length === 0) return;
  const commitOid = runGit(normalizedRoot, ['rev-parse', '--verify', `${targetRef}^{commit}`], true)?.trim() ?? '';
  if (!/^[a-f0-9]{40,64}$/iu.test(commitOid)) {
    throw new Error(`Managed local-state target validation could not resolve ${targetRef} to a commit in ${normalizedRoot}.`);
  }
  const queries: BatchQuery[] = [];
  for (const entry of parsed.entries) {
    queries.push({ expression: `${commitOid}:${entry.path}`, entryPath: entry.path, checkedPath: entry.path, role: 'root' });
    for (const ancestor of pathAncestors(entry.path)) {
      queries.push({ expression: `${commitOid}:${ancestor}`, entryPath: entry.path, checkedPath: ancestor, role: 'ancestor' });
    }
  }
  const results = runCatFileBatch(normalizedRoot, queries, 'target-tree');
  const conflicts: string[] = [];
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    const result = results[index];
    if (query.role === 'root' && !result.missing) {
      conflicts.push(`${targetRef} tracks ${query.checkedPath} (${result.type}), which conflicts with managed root ${query.entryPath}`);
    } else if (query.role === 'ancestor' && !result.missing && result.type !== 'tree') {
      conflicts.push(`${targetRef} tracks obstructing ${result.type} ancestor ${query.checkedPath} for managed root ${query.entryPath}`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error([
      `Managed local-state target validation blocked checkout of ${targetRef}.`,
      ...uniqueStrings(conflicts).map((conflict) => `- ${conflict}`),
      'Remove the declaration before switching or fast-forwarding to a tree that tracks the managed root.',
    ].join('\n'));
  }
}

export function planManagedLocalStateAdd(
  repoRoot: string,
  rawPath: string,
  reason: string,
  now = new Date().toISOString(),
): LocalStateEntryV1 {
  const inspection = assertManagedLocalStateValid(repoRoot);
  const normalizedPath = normalizeManagedLocalStatePath(rawPath);
  const entry = buildEntryFromExistingRoot(repoRoot, normalizedPath, reason, now);
  const entries = [...inspection.entries.map(stripInspection), entry];
  assertNoDuplicateOrOverlappingEntries(entries);
  const tracked = inspectTrackedEntries(repoRoot, entries);
  if (tracked.warnings.length > 0) {
    throw new Error(tracked.warnings.join('\n'));
  }
  return entry;
}

export function planManagedLocalStateRemove(repoRoot: string, rawPath: string): LocalStateEntryV1 {
  const inspection = inspectManagedLocalState(repoRoot);
  if (!inspection.canonicalBlock) {
    throw new Error(inspection.warnings.join('\n'));
  }
  const normalizedPath = normalizeManagedLocalStatePath(rawPath);
  const entry = inspection.entries.find((candidate) => candidate.path === normalizedPath);
  if (!entry) {
    throw new Error(`No Pipelane local-state declaration exists for ${normalizedPath}.`);
  }
  return stripInspection(entry);
}

export function initializeManagedLocalState(
  repoRoot: string,
  hooks: ManagedLocalStateMutationHooks = {},
): { created: boolean; excludePath: string; canonicalBlock: Buffer } {
  let created = false;
  const result = mutateManagedLocalState(repoRoot, { allowMissingBlock: true, hooks, verifyMode: 'full' }, (parsed) => {
    if (parsed) return parsed.entries;
    created = true;
    return [];
  });
  return { created, excludePath: result.excludePath, canonicalBlock: result.canonicalBlock };
}

export function addManagedLocalState(
  repoRoot: string,
  rawPath: string,
  reason: string,
  hooks: ManagedLocalStateMutationHooks = {},
): LocalStateEntryV1 {
  return addManagedLocalStateInternal(repoRoot, rawPath, reason, null, hooks);
}

export function addPlannedManagedLocalState(
  repoRoot: string,
  plannedEntry: LocalStateEntryV1,
  hooks: ManagedLocalStateMutationHooks = {},
): LocalStateEntryV1 {
  const approved = canonicalizeManagedLocalStateEntry(plannedEntry);
  return addManagedLocalStateInternal(repoRoot, approved.path, approved.reason, approved, hooks);
}

function addManagedLocalStateInternal(
  repoRoot: string,
  rawPath: string,
  reason: string,
  approvedEntry: LocalStateEntryV1 | null,
  hooks: ManagedLocalStateMutationHooks,
): LocalStateEntryV1 {
  let added: LocalStateEntryV1 | null = null;
  mutateManagedLocalState(repoRoot, { allowMissingBlock: false, hooks, verifyMode: 'full' }, (parsed) => {
    if (!parsed) throw new Error('Internal error: add requires an initialized local-state block.');
    const normalizedPath = normalizeManagedLocalStatePath(rawPath);
    const now = approvedEntry?.createdAt ?? hooks.now?.() ?? new Date().toISOString();
    const entry = buildEntryFromExistingRoot(repoRoot, normalizedPath, reason, now);
    if (approvedEntry && !sameManagedLocalStateEntry(entry, approvedEntry)) {
      throw new Error([
        `local-state add blocked because ${normalizedPath} changed after authorization.`,
        `Approved kind: ${approvedEntry.kind}; current kind: ${entry.kind}.`,
        'Rerun local-state add to inspect and authorize the current root shape.',
      ].join('\n'));
    }
    const next = [...parsed.entries, entry];
    assertNoDuplicateOrOverlappingEntries(next);
    const tracked = inspectTrackedEntries(repoRoot, next);
    if (tracked.warnings.length > 0) throw new Error(tracked.warnings.join('\n'));
    added = entry;
    return next;
  });
  if (!added) throw new Error('Internal error: local-state add did not produce an entry.');
  return added;
}

export function removeManagedLocalState(
  repoRoot: string,
  rawPath: string,
  hooks: ManagedLocalStateMutationHooks = {},
): LocalStateEntryV1 {
  return removeManagedLocalStateInternal(repoRoot, rawPath, null, hooks);
}

export function removePlannedManagedLocalState(
  repoRoot: string,
  plannedEntry: LocalStateEntryV1,
  hooks: ManagedLocalStateMutationHooks = {},
): LocalStateEntryV1 {
  const approved = canonicalizeManagedLocalStateEntry(plannedEntry);
  return removeManagedLocalStateInternal(repoRoot, approved.path, approved, hooks);
}

function removeManagedLocalStateInternal(
  repoRoot: string,
  rawPath: string,
  approvedEntry: LocalStateEntryV1 | null,
  hooks: ManagedLocalStateMutationHooks,
): LocalStateEntryV1 {
  let removed: LocalStateEntryV1 | null = null;
  mutateManagedLocalState(repoRoot, { allowMissingBlock: false, hooks, verifyMode: 'parse' }, (parsed) => {
    if (!parsed) throw new Error('Internal error: remove requires an initialized local-state block.');
    const normalizedPath = normalizeManagedLocalStatePath(rawPath);
    removed = parsed.entries.find((entry) => entry.path === normalizedPath) ?? null;
    if (!removed) throw new Error(`No Pipelane local-state declaration exists for ${normalizedPath}.`);
    if (approvedEntry && !sameManagedLocalStateEntry(removed, approvedEntry)) {
      throw new Error([
        `local-state remove blocked because the declaration for ${normalizedPath} changed after authorization.`,
        'Rerun local-state remove to inspect and authorize the current declaration.',
      ].join('\n'));
    }
    return parsed.entries.filter((entry) => entry.path !== normalizedPath);
  });
  if (!removed) throw new Error('Internal error: local-state remove did not find an entry.');
  return removed;
}

export function acquireManagedLocalStateWriterLease(
  commonDir: string,
  options: { waitMs?: number; pollMs?: number } = {},
): ManagedLocalStateWriterLease {
  const leasePath = path.join(commonDir, MANAGED_LOCAL_STATE_LEASE_DIRNAME);
  const ownerPath = path.join(leasePath, MANAGED_LOCAL_STATE_LEASE_OWNER);
  const waitMs = options.waitMs ?? DEFAULT_LEASE_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LEASE_POLL_MS;
  const started = Date.now();
  const token = randomBytes(32).toString('hex');
  const owner: LeaseOwnerFile = { pid: process.pid, acquiredAt: new Date().toISOString(), token };

  while (true) {
    try {
      mkdirSync(leasePath, { mode: 0o700 });
      try {
        writeLeaseOwner(ownerPath, owner);
      } catch (error) {
        rmSync(leasePath, { recursive: true, force: true });
        throw error;
      }
      return { leasePath, ownerPath, ...owner };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
    }

    const existing = readLeaseOwner(ownerPath);
    if (!existing) {
      throw leaseInspectionError(leasePath, 'owner record is missing or malformed');
    }
    const liveness = processLiveness(existing.pid);
    if (liveness === 'dead') {
      const latest = readLeaseOwner(ownerPath);
      if (latest?.token === existing.token) {
        rmSync(leasePath, { recursive: true, force: true });
      }
      continue;
    }
    if (liveness === 'unverifiable') {
      throw leaseInspectionError(leasePath, `owner PID ${existing.pid} cannot be inspected`);
    }
    if (Date.now() - started >= waitMs) {
      throw leaseInspectionError(
        leasePath,
        `owner PID ${existing.pid} is still live (or the PID has been reused); age alone cannot reclaim the lease`,
      );
    }
    synchronousWait(Math.max(1, Math.min(pollMs, waitMs - (Date.now() - started))));
  }
}

export function releaseManagedLocalStateWriterLease(lease: ManagedLocalStateWriterLease): boolean {
  const owner = readLeaseOwner(lease.ownerPath);
  if (!owner || owner.token !== lease.token) return false;
  rmSync(lease.leasePath, { recursive: true, force: true });
  return true;
}

function mutateManagedLocalState(
  repoRoot: string,
  options: { allowMissingBlock: boolean; hooks: ManagedLocalStateMutationHooks; verifyMode: 'full' | 'parse' },
  buildEntries: (parsed: ParsedManagedLocalState | null) => LocalStateEntryV1[],
): { excludePath: string; entries: LocalStateEntryV1[]; canonicalBlock: Buffer } {
  const normalizedRoot = normalizePath(repoRoot);
  const commonDir = resolveGitCommonDir(normalizedRoot);
  const excludePath = path.join(commonDir, 'info', 'exclude');
  const lease = acquireManagedLocalStateWriterLease(commonDir, {
    waitMs: options.hooks.leaseWaitMs,
    pollMs: options.hooks.leasePollMs,
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const baseline = readExcludeSnapshot(excludePath, options.allowMissingBlock);
      let parsed: ParsedManagedLocalState | null = null;
      if (baseline.exists) {
        try {
          parsed = parseManagedLocalState(excludePath, baseline.bytes);
        } catch (error) {
          if (!options.allowMissingBlock || hasAnyManagedMarkerLine(baseline.bytes)) throw error;
        }
      }
      if (!parsed && !options.allowMissingBlock) {
        throw managedConfigError(excludePath, 'required v1 block is missing', true);
      }
      const entries = buildEntries(parsed);
      const canonicalBlock = serializeManagedLocalStateBlock(entries);
      const candidate = parsed
        ? Buffer.concat([
            baseline.bytes.subarray(0, parsed.blockStart),
            canonicalBlock,
            baseline.bytes.subarray(parsed.blockEnd),
          ])
        : placeInitialCanonicalBlock(baseline.bytes, canonicalBlock);
      if (candidate.length > MANAGED_LOCAL_STATE_MAX_FILE_BYTES) {
        throw new Error(`Writing the Pipelane local-state block would make ${excludePath} exceed ${MANAGED_LOCAL_STATE_MAX_FILE_BYTES} bytes.`);
      }
      if (baseline.exists && candidate.equals(baseline.bytes)) {
        verifyManagedMutation(normalizedRoot, excludePath, candidate, options.hooks, options.verifyMode);
        return { excludePath, entries, canonicalBlock };
      }

      mkdirSync(path.dirname(excludePath), { recursive: true });
      const tempPath = writeCandidateTemp(excludePath, candidate, baseline.mode);
      let renamed = false;
      try {
        options.hooks.beforeCompare?.(attempt, excludePath, candidate);
        const current = readExcludeSnapshot(excludePath, true);
        if (!excludeSnapshotsEqual(current, baseline)) {
          unlinkSync(tempPath);
          if (attempt === 0) continue;
          throw new Error(`Concurrent edit detected twice while updating ${excludePath}; no Pipelane write was applied. Retry after the editor is idle.`);
        }
        options.hooks.beforeRename?.(attempt, excludePath, candidate);
        renameSync(tempPath, excludePath);
        renamed = true;
        fsyncDirectory(path.dirname(excludePath));
      } finally {
        if (!renamed && existsSync(tempPath)) unlinkSync(tempPath);
      }

      try {
        verifyManagedMutation(normalizedRoot, excludePath, candidate, options.hooks, options.verifyMode);
      } catch (error) {
        const restored = conditionallyRestoreBaseline(excludePath, candidate, baseline);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error([
          `Pipelane wrote a candidate local-state block, but verification failed: ${reason}`,
          restored
            ? 'The prior exclude bytes were restored because the file still matched Pipelane\'s candidate.'
            : `The prior bytes were not restored because ${excludePath} changed again; inspect it manually to avoid overwriting another editor.`,
        ].join('\n'));
      }
      return { excludePath, entries, canonicalBlock };
    }
    throw new Error(`Could not update ${excludePath}.`);
  } finally {
    releaseManagedLocalStateWriterLease(lease);
  }
}

function verifyManagedMutation(
  repoRoot: string,
  excludePath: string,
  candidate: Buffer,
  hooks: ManagedLocalStateMutationHooks,
  mode: 'full' | 'parse',
): void {
  if (hooks.verify) {
    hooks.verify(repoRoot, candidate);
    return;
  }
  if (mode === 'parse') {
    const current = readExcludeSnapshot(excludePath, false);
    if (!current.bytes.equals(candidate)) throw new Error(`${excludePath} changed before post-write parsing completed.`);
    parseManagedLocalState(excludePath, current.bytes);
    return;
  }
  assertManagedLocalStateValid(repoRoot);
}

// Preservation write: read -> build -> temp+fsync -> compare -> rename.
function writeCandidateTemp(excludePath: string, candidate: Buffer, existingMode: number | null): string {
  const tempPath = path.join(
    path.dirname(excludePath),
    `.pipelane-local-state-${process.pid}-${randomBytes(10).toString('hex')}.tmp`,
  );
  const fd = openSync(tempPath, 'wx', existingMode ?? 0o666);
  try {
    if (existingMode !== null) fchmodSync(fd, existingMode);
    let offset = 0;
    while (offset < candidate.length) {
      offset += writeSync(fd, candidate, offset, candidate.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existingMode !== null) chmodSync(tempPath, existingMode);
  return tempPath;
}

function conditionallyRestoreBaseline(excludePath: string, candidate: Buffer, baseline: ExcludeSnapshot): boolean {
  let current: ExcludeSnapshot;
  try {
    current = readExcludeSnapshot(excludePath, true);
  } catch {
    return false;
  }
  if (!current.exists || !current.bytes.equals(candidate)) return false;
  if (!baseline.exists) {
    unlinkSync(excludePath);
    fsyncDirectory(path.dirname(excludePath));
    return true;
  }
  const restoreTemp = writeCandidateTemp(excludePath, baseline.bytes, baseline.mode);
  renameSync(restoreTemp, excludePath);
  fsyncDirectory(path.dirname(excludePath));
  return true;
}

function inspectEntriesAgainstCurrentState(
  repoRoot: string,
  excludePath: string,
  entries: LocalStateEntryV1[],
): EntryValidationResult {
  const inspections = entries.map((entry): ManagedLocalStateEntryInspection => {
    const actualKind = actualRootKind(repoRoot, entry.path);
    const conflicts: string[] = [];
    if (actualKind === 'symlink') {
      conflicts.push(`managed root ${entry.path} is now a symlink`);
    } else if (actualKind !== 'missing' && actualKind !== entry.kind) {
      conflicts.push(`managed root ${entry.path} kind drifted: expected ${entry.kind}, found ${actualKind}`);
    }
    return {
      ...entry,
      pattern: escapeManagedIgnorePattern(entry.path, entry.kind),
      present: actualKind !== 'missing',
      actualKind,
      conflicts,
    };
  });
  if (entries.length === 0) return { inspections, warnings: [], gitCalls: 0 };

  const byPath = new Map(inspections.map((inspection) => [inspection.path, inspection]));
  const tracked = inspectTrackedEntries(repoRoot, entries);
  for (const [entryPath, conflicts] of tracked.conflictsByEntry) {
    byPath.get(entryPath)?.conflicts.push(...conflicts);
  }
  const ignore = inspectEffectiveIgnoreRules(repoRoot, excludePath, inspections);
  for (const [entryPath, conflicts] of ignore.conflictsByEntry) {
    byPath.get(entryPath)?.conflicts.push(...conflicts);
  }
  const warnings = [
    ...inspections.flatMap((inspection) => inspection.conflicts),
    ...tracked.globalWarnings,
    ...ignore.globalWarnings,
  ];
  return { inspections, warnings: uniqueStrings(warnings), gitCalls: tracked.gitCalls + ignore.gitCalls };
}

function inspectTrackedEntries(
  repoRoot: string,
  entries: LocalStateEntryV1[],
): { conflictsByEntry: Map<string, string[]>; warnings: string[]; globalWarnings: string[]; gitCalls: number } {
  const conflictsByEntry = new Map(entries.map((entry) => [entry.path, [] as string[]]));
  const globalWarnings: string[] = [];
  let gitCalls = 0;
  try {
    const roots = entries.map((entry) => entry.path);
    const lsFiles = runManagedGit(repoRoot, ['--literal-pathspecs', 'ls-files', '-z', '--', ...roots], Buffer.alloc(0), 'ls-files');
    gitCalls += 1;
    if (lsFiles.length > 0 && lsFiles[lsFiles.length - 1] !== 0x00) {
      throw new Error('git ls-files returned malformed non-NUL-terminated output');
    }
    const trackedPaths = splitNul(lsFiles).map((field) => field.toString('utf8')).filter(Boolean);
    for (const trackedPath of trackedPaths) {
      for (const entry of entries) {
        if (trackedPath === entry.path || trackedPath.startsWith(`${entry.path}/`)) {
          conflictsByEntry.get(entry.path)?.push(`tracked path ${trackedPath} is at or below managed root ${entry.path}`);
        }
      }
    }

    const ancestorQueries: BatchQuery[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      for (const ancestor of pathAncestors(entry.path)) {
        for (let stage = 0; stage <= 3; stage += 1) {
          const expression = `:${stage}:${ancestor}`;
          const key = `${entry.path}\0${expression}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ancestorQueries.push({ expression, entryPath: entry.path, checkedPath: ancestor, role: 'ancestor', stage });
        }
      }
    }
    const ancestorResults = runCatFileBatch(repoRoot, ancestorQueries, 'index-ancestors');
    gitCalls += 1;
    for (let index = 0; index < ancestorQueries.length; index += 1) {
      const query = ancestorQueries[index];
      const result = ancestorResults[index];
      if (!result.missing) {
        conflictsByEntry.get(query.entryPath)?.push(
          `tracked file ancestor ${query.checkedPath} at index stage ${query.stage} obstructs managed root ${query.entryPath}`,
        );
      }
    }
  } catch (error) {
    globalWarnings.push(error instanceof Error ? error.message : String(error));
    // Both bounded current-index calls are part of one validation pass. Preserve
    // the attempted count even when the first one failed before the second ran.
    gitCalls = Math.max(gitCalls, 1);
  }
  const warnings = [
    ...[...conflictsByEntry.values()].flat(),
    ...globalWarnings,
  ];
  return { conflictsByEntry, warnings, globalWarnings, gitCalls };
}

function inspectEffectiveIgnoreRules(
  repoRoot: string,
  excludePath: string,
  inspections: ManagedLocalStateEntryInspection[],
): { conflictsByEntry: Map<string, string[]>; globalWarnings: string[]; gitCalls: number } {
  const conflictsByEntry = new Map(inspections.map((entry) => [entry.path, [] as string[]]));
  const globalWarnings: string[] = [];
  const probes: IgnoreProbe[] = [];
  for (const inspection of inspections) {
    if (inspection.kind === 'file' || inspection.actualKind !== 'missing') {
      probes.push({ entryPath: inspection.path, path: inspection.path, pattern: inspection.pattern });
    }
    if (inspection.kind === 'directory') {
      probes.push({
        entryPath: inspection.path,
        path: `${inspection.path}/__pipelane_probe__`,
        pattern: inspection.pattern,
      });
    }
  }
  try {
    const input = Buffer.from(`${probes.map((probe) => probe.path).join('\0')}\0`, 'utf8');
    const output = runManagedGit(
      repoRoot,
      ['check-ignore', '--no-index', '--non-matching', '-z', '-v', '--stdin'],
      input,
      'check-ignore',
    );
    const fields = splitNul(output).map((field) => field.toString('utf8'));
    if (fields.length !== probes.length * 4) {
      throw new Error(`git check-ignore returned ${fields.length} NUL field(s) for ${probes.length} probe(s); expected ${probes.length * 4}`);
    }
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index];
      const [source, lineNumber, patternText, pathname] = fields.slice(index * 4, index * 4 + 4);
      if (pathname !== probe.path) {
        conflictsByEntry.get(probe.entryPath)?.push(`git check-ignore response path mismatch for ${probe.path}: received ${pathname || '(empty)'}`);
        continue;
      }
      const sourcePath = source ? normalizePath(path.isAbsolute(source) ? source : path.resolve(repoRoot, source)) : '';
      const expectedSource = normalizePath(excludePath);
      if (sourcePath !== expectedSource || patternText !== probe.pattern || !/^\d+$/u.test(lineNumber)) {
        conflictsByEntry.get(probe.entryPath)?.push(
          `managed ignore for ${probe.path} is ineffective: winning source=${source || '(none)'} pattern=${patternText || '(none)'}; expected source=${excludePath} pattern=${probe.pattern}`,
        );
      }
    }
  } catch (error) {
    globalWarnings.push(`managed ignore verification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { conflictsByEntry, globalWarnings, gitCalls: 1 };
}

function runCatFileBatch(repoRoot: string, queries: BatchQuery[], label: string): BatchResult[] {
  const input = Buffer.from(queries.map((query) => query.expression).join('\n') + (queries.length > 0 ? '\n' : ''), 'utf8');
  const output = runManagedGit(repoRoot, ['cat-file', '--batch-check'], input, label);
  const text = output.toString('utf8');
  const lines = text.length > 0 ? text.replace(/\n$/u, '').split('\n') : [];
  if (lines.length !== queries.length) {
    throw new Error(`git cat-file ${label} returned ${lines.length} response(s) for ${queries.length} request(s)`);
  }
  return lines.map((line, index) => parseCatFileBatchLine(line, queries[index].expression, label));
}

function parseCatFileBatchLine(line: string, expression: string, label: string): BatchResult {
  const present = /^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/iu.exec(line);
  if (present) return { missing: false, objectId: present[1], type: present[2] };
  if (line === `${expression} missing`) return { missing: true, objectId: '', type: '' };
  throw new Error(`git cat-file ${label} returned malformed response for ${expression}: ${line || '(empty)'}`);
}

function runManagedGit(repoRoot: string, args: string[], input: Buffer, label: string): Buffer {
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_LOCAL_STATE_GIT_FAIL === label) {
    throw new Error(`git ${label} failed: injected test failure`);
  }
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    input,
    encoding: 'buffer',
    maxBuffer: MANAGED_LOCAL_STATE_GIT_OUTPUT_BYTES,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
  if (result.error) throw new Error(`git ${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${label} failed: ${stderr.toString('utf8').trim() || `exit ${result.status ?? 'unknown'}`}`);
  }
  if (process.env.NODE_ENV === 'test' && process.env.PIPELANE_LOCAL_STATE_GIT_MALFORM === label) {
    return Buffer.from('malformed injected output\n', 'utf8');
  }
  if (stdout.length > MANAGED_LOCAL_STATE_GIT_OUTPUT_BYTES) {
    throw new Error(`git ${label} output exceeded ${MANAGED_LOCAL_STATE_GIT_OUTPUT_BYTES} bytes`);
  }
  return stdout;
}

function buildEntryFromExistingRoot(
  repoRoot: string,
  normalizedPath: string,
  reason: string,
  createdAt: string,
): LocalStateEntryV1 {
  assertUnicodeScalars(reason, `reason for ${normalizedPath}`);
  assertNoControlCharacters(reason, `reason for ${normalizedPath}`);
  if (!reason.trim()) throw new Error('local-state add requires a non-empty --reason.');
  if (unicodeScalarLength(reason) > MANAGED_LOCAL_STATE_MAX_REASON_SCALARS) {
    throw new Error(`local-state add --reason exceeds ${MANAGED_LOCAL_STATE_MAX_REASON_SCALARS} Unicode scalar values.`);
  }
  const targetPath = path.join(repoRoot, normalizedPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`local-state add requires an existing exact file or directory root: ${normalizedPath}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`local-state add refuses a symlink root: ${normalizedPath}`);
  const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
  if (!kind) throw new Error(`local-state add supports only a regular file or directory root: ${normalizedPath}`);
  return canonicalizeManagedLocalStateEntry({ schemaVersion: 1, path: normalizedPath, kind, reason, createdAt });
}

function actualRootKind(repoRoot: string, relativePath: string): ManagedLocalStateActualKind {
  try {
    const stat = lstatSync(path.join(repoRoot, relativePath));
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isFile()) return 'file';
    if (stat.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new Error(`Could not inspect managed root ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function placeInitialCanonicalBlock(userOwnedBytes: Buffer, canonicalBlock: Buffer): Buffer {
  if (userOwnedBytes.length === 0) return canonicalBlock;
  if (userOwnedBytes[userOwnedBytes.length - 1] === 0x0a) return Buffer.concat([userOwnedBytes, canonicalBlock]);
  return Buffer.concat([canonicalBlock, userOwnedBytes]);
}

function readExcludeSnapshot(excludePath: string, allowMissing: boolean): ExcludeSnapshot {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(excludePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) {
      return { exists: false, bytes: Buffer.alloc(0), mode: null };
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw managedConfigError(excludePath, 'exclude file does not exist and the required v1 block is missing', true);
    }
    throw new Error(`Could not inspect ${excludePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink()) throw managedConfigError(excludePath, 'exclude path is a symlink; refusing to follow it');
  if (!stat.isFile()) throw managedConfigError(excludePath, 'exclude path is not a regular file');
  if (stat.size > MANAGED_LOCAL_STATE_MAX_FILE_BYTES) {
    throw managedConfigError(excludePath, `exclude file exceeds ${MANAGED_LOCAL_STATE_MAX_FILE_BYTES} bytes`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(excludePath);
  } catch (error) {
    throw managedConfigError(excludePath, `exclude file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { exists: true, bytes, mode: stat.mode & 0o7777 };
}

function exactMarkerLinePositions(bytes: Buffer, marker: string): number[] {
  const needle = Buffer.from(marker, 'utf8');
  const positions: number[] = [];
  let offset = 0;
  while (offset <= bytes.length - needle.length) {
    const found = bytes.indexOf(needle, offset);
    if (found < 0) break;
    const atLineStart = found === 0 || bytes[found - 1] === 0x0a;
    const after = found + needle.length;
    const atLineEnd = after === bytes.length || bytes[after] === 0x0a || bytes[after] === 0x0d;
    if (atLineStart && atLineEnd) positions.push(found);
    offset = found + needle.length;
  }
  return positions;
}

function hasAnyManagedMarkerLine(bytes: Buffer): boolean {
  return exactMarkerLinePositions(bytes, MANAGED_LOCAL_STATE_START_MARKER).length > 0
    || exactMarkerLinePositions(bytes, MANAGED_LOCAL_STATE_END_MARKER).length > 0;
}

function managedConfigError(excludePath: string, detail: string, setup = false): Error {
  return new Error([
    `Invalid Pipelane local-state configuration at ${excludePath}: ${detail}.`,
    setup ? 'Run `pipelane setup` to initialize the persistent empty v1 block.' : 'Inspect and repair the canonical Pipelane-managed block before retrying.',
  ].join(' '));
}

function assertNoDuplicateOrOverlappingEntries(entries: LocalStateEntryV1[]): void {
  const sorted = [...entries].sort((left, right) => compareCanonicalPaths(left.path, right.path));
  for (let index = 0; index < sorted.length; index += 1) {
    for (let other = index + 1; other < sorted.length; other += 1) {
      const left = sorted[index].path;
      const right = sorted[other].path;
      if (left === right) throw new Error(`Duplicate Pipelane local-state declaration: ${left}.`);
      if (right.startsWith(`${left}/`) || left.startsWith(`${right}/`)) {
        throw new Error(`Overlapping Pipelane local-state declarations are not allowed: ${left} and ${right}.`);
      }
    }
  }
}

function compareCanonicalPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stripInspection(entry: ManagedLocalStateEntryInspection): LocalStateEntryV1 {
  return {
    schemaVersion: 1,
    path: entry.path,
    kind: entry.kind,
    reason: entry.reason,
    createdAt: entry.createdAt,
  };
}

function sameManagedLocalStateEntry(left: LocalStateEntryV1, right: LocalStateEntryV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.path === right.path
    && left.kind === right.kind
    && left.reason === right.reason
    && left.createdAt === right.createdAt;
}

function pathAncestors(relativePath: string): string[] {
  const segments = relativePath.split('/');
  const ancestors: string[] = [];
  for (let length = 1; length < segments.length; length += 1) {
    ancestors.push(segments.slice(0, length).join('/'));
  }
  return ancestors;
}

function assertUnicodeScalars(value: string, label: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      throw new Error(`${label} contains an unpaired UTF-16 surrogate.`);
    }
  }
}

function assertNoControlCharacters(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} contains a control character.`);
  }
}

function unicodeScalarLength(value: string): number {
  return [...value].length;
}

function splitNul(value: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    fields.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start < value.length) fields.push(value.subarray(start));
  return fields;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function excludeSnapshotsEqual(left: ExcludeSnapshot, right: ExcludeSnapshot): boolean {
  return left.exists === right.exists && left.mode === right.mode && left.bytes.equals(right.bytes);
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(directory, 'r');
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeLeaseOwner(ownerPath: string, owner: LeaseOwnerFile): void {
  const fd = openSync(ownerPath, 'wx', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readLeaseOwner(ownerPath: string): LeaseOwnerFile | null {
  try {
    const raw = JSON.parse(readFileSync(ownerPath, 'utf8')) as Partial<LeaseOwnerFile>;
    if (!Number.isSafeInteger(raw.pid) || (raw.pid ?? 0) <= 0) return null;
    if (typeof raw.acquiredAt !== 'string' || !isCanonicalTimestamp(raw.acquiredAt)) return null;
    if (typeof raw.token !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.token)) return null;
    return { pid: raw.pid, acquiredAt: raw.acquiredAt, token: raw.token } as LeaseOwnerFile;
  } catch {
    return null;
  }
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unverifiable' {
  const injected = process.env.NODE_ENV === 'test'
    ? process.env.PIPELANE_LOCAL_STATE_TEST_LIVENESS
    : undefined;
  if (injected === 'alive' || injected === 'dead' || injected === 'unverifiable') return injected;
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    return 'unverifiable';
  }
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function leaseInspectionError(leasePath: string, reason: string): Error {
  return new Error([
    `Pipelane local-state writer lease is unavailable at ${leasePath}: ${reason}.`,
    'Inspect that exact directory and owner.json manually. Do not delete it merely because it is old.',
  ].join(' '));
}

function synchronousWait(milliseconds: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}
