import crypto from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { REVIEW_DATA_LIMITS, normalizeReviewDataField } from './review-data.ts';
import type { ReviewReportArtifactReference } from './state.ts';

export interface ReviewArtifactFileOps<Handle = unknown> {
  mkdir(targetPath: string): void;
  openExclusive(targetPath: string): Handle;
  write(handle: Handle, bytes: Buffer, offset: number): number;
  flushFile(handle: Handle): void;
  close(handle: Handle): void;
  rename(fromPath: string, toPath: string): void;
  flushDirectory(targetPath: string): void;
  read(targetPath: string): Buffer;
  inspect(targetPath: string): { regularFile: boolean; symbolicLink: boolean; size: number; mtimeMs: number };
  remove(targetPath: string): void;
}

export interface PersistReviewArtifactOptions<Handle = unknown> {
  root: string;
  runId: string;
  gateRecordId: string;
  report: string;
  diagnostics: string;
  fileOps?: ReviewArtifactFileOps<Handle>;
}

export interface ReviewArtifactGcResult {
  scanned: number;
  referenced: number;
  deleted: number;
  skipped: number;
  errors: string[];
}

export interface ReviewArtifactGcCandidate {
  relativePath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

const ARTIFACT_VERSION = 1;
const NORMAL_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_LEASE_NAME = '.active';
const ACTIVE_LEASE_MAX_AGE_MS = 60 * 60 * 1000;

export const nodeReviewArtifactFileOps: ReviewArtifactFileOps<number> = {
  mkdir(targetPath) {
    mkdirSync(targetPath, { recursive: true, mode: 0o700 });
  },
  openExclusive(targetPath) {
    return openSync(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  },
  write(handle, bytes, offset) {
    return writeSync(handle, bytes, offset, bytes.length - offset);
  },
  flushFile(handle) {
    fsyncSync(handle);
  },
  close(handle) {
    closeSync(handle);
  },
  rename(fromPath, toPath) {
    renameSync(fromPath, toPath);
  },
  flushDirectory(targetPath) {
    const fd = openSync(targetPath, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  read(targetPath) {
    const fd = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  inspect(targetPath) {
    const stat = lstatSync(targetPath);
    return { regularFile: stat.isFile(), symbolicLink: stat.isSymbolicLink(), size: stat.size, mtimeMs: stat.mtimeMs };
  },
  remove(targetPath) {
    unlinkSync(targetPath);
  },
};

/**
 * Artifact-first persistence and crash windows:
 * shape -> temp write* -> file fsync -> rename -> dir fsync -> reread/digest
 *               |             |          |                       |
 *          no ledger ref  no ledger ref  orphan only       safe to sign ledger
 */
export function persistReviewArtifact<Handle = number>(
  options: PersistReviewArtifactOptions<Handle>,
): ReviewReportArtifactReference {
  const fileOps = options.fileOps ?? nodeReviewArtifactFileOps as ReviewArtifactFileOps<Handle>;
  const shapedReport = shapeArtifactField(options.report, REVIEW_DATA_LIMITS.reportBytes, 'review report');
  const shapedDiagnostics = shapeArtifactField(options.diagnostics, REVIEW_DATA_LIMITS.diagnosticsBytes, 'review diagnostics');
  const payload = Buffer.from(JSON.stringify({
    version: ARTIFACT_VERSION,
    report: shapedReport.value,
    diagnostics: shapedDiagnostics.value,
  }), 'utf8');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const safeRunId = safeArtifactSegment(options.runId);
  const safeGateId = safeArtifactSegment(options.gateRecordId);
  const directory = path.join(options.root, safeRunId);
  const relativePath = path.posix.join(safeRunId, `${safeGateId}-${digest.slice(0, 16)}.json`);
  const finalPath = confinedArtifactPath(options.root, relativePath);
  const tempPath = path.join(directory, `.${safeGateId}-${crypto.randomUUID()}.tmp`);
  fileOps.mkdir(directory);
  assertNoSymlinkArtifactAncestors(options.root, finalPath);
  if (!options.fileOps) writeActiveReviewArtifactLease(directory, safeRunId);
  let handle: Handle | null = null;
  let renamed = false;
  try {
    handle = fileOps.openExclusive(tempPath);
    writeAll(fileOps, handle, payload);
    fileOps.flushFile(handle);
    fileOps.close(handle);
    handle = null;
    fileOps.rename(tempPath, finalPath);
    renamed = true;
    fileOps.flushDirectory(directory);
    const metadata = fileOps.inspect(finalPath);
    if (!metadata.regularFile || metadata.symbolicLink || metadata.size !== payload.length) {
      throw new Error('persisted review artifact is not the expected regular file.');
    }
    const verified = fileOps.read(finalPath);
    const verifiedDigest = crypto.createHash('sha256').update(verified).digest('hex');
    if (!verified.equals(payload) || verifiedDigest !== digest) {
      throw new Error('persisted review artifact failed byte-for-byte digest verification.');
    }
    return {
      path: relativePath,
      digest,
      bytes: payload.length,
      reportBytes: Buffer.byteLength(shapedReport.value, 'utf8'),
      diagnosticsBytes: Buffer.byteLength(shapedDiagnostics.value, 'utf8'),
      reportTruncated: shapedReport.truncated,
      diagnosticsTruncated: shapedDiagnostics.truncated,
    };
  } finally {
    if (handle !== null) {
      try { fileOps.close(handle); } catch {}
    }
    if (!renamed) {
      try { fileOps.remove(tempPath); } catch {}
    }
  }
}

export function releaseReviewArtifactLease(root: string, runId: string): void {
  const directory = path.join(path.resolve(root), safeArtifactSegment(runId));
  const leasePath = confinedArtifactPath(root, path.posix.join(safeArtifactSegment(runId), ACTIVE_LEASE_NAME));
  try {
    unlinkSync(leasePath);
    nodeReviewArtifactFileOps.flushDirectory(directory);
  } catch {}
}

export function appendArtifactBackedReviewRun<T>(options: {
  root: string;
  runId: string;
  appendRecord: () => T;
  releaseLease?: (root: string, runId: string) => void;
}): T {
  const persisted = options.appendRecord();
  (options.releaseLease ?? releaseReviewArtifactLease)(options.root, options.runId);
  return persisted;
}

function writeActiveReviewArtifactLease(directory: string, runId: string): void {
  const leasePath = path.join(directory, ACTIVE_LEASE_NAME);
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, runId, pid: process.pid, updatedAt: new Date().toISOString() })}\n`, 'utf8');
  const fd = openSync(leasePath, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  nodeReviewArtifactFileOps.flushDirectory(directory);
}

export function readVerifiedReviewArtifact(
  root: string,
  reference: ReviewReportArtifactReference,
  fileOps: ReviewArtifactFileOps = nodeReviewArtifactFileOps,
): { report: string; diagnostics: string } {
  const targetPath = confinedArtifactPath(root, reference.path);
  assertNoSymlinkArtifactAncestors(root, targetPath);
  let metadata: ReturnType<ReviewArtifactFileOps['inspect']>;
  try {
    metadata = fileOps.inspect(targetPath);
  } catch {
    throw new Error('review artifact is missing or unreadable; rerun review before relying on this evidence.');
  }
  if (!metadata.regularFile || metadata.symbolicLink || metadata.size !== reference.bytes) {
    throw new Error('review artifact is missing, changed, or not a regular file; rerun review before relying on this evidence.');
  }
  let bytes: Buffer;
  try {
    bytes = fileOps.read(targetPath);
  } catch {
    throw new Error('review artifact is missing or unreadable; rerun review before relying on this evidence.');
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== reference.digest) {
    throw new Error('review artifact digest does not match signed evidence; rerun review before relying on this evidence.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('review artifact is malformed or not valid UTF-8; rerun review.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('review artifact payload is malformed; rerun review.');
  const object = raw as Record<string, unknown>;
  if (object.version !== ARTIFACT_VERSION || typeof object.report !== 'string' || typeof object.diagnostics !== 'string') {
    throw new Error('review artifact payload version or fields are invalid; rerun review.');
  }
  return { report: object.report, diagnostics: object.diagnostics };
}

export function collectReferencedReviewArtifactPaths(records: Array<{ gates: Array<{ reportArtifact?: ReviewReportArtifactReference }> }>): Set<string> {
  return new Set(records.flatMap((record) => record.gates.map((gate) => gate.reportArtifact?.path).filter((value): value is string => Boolean(value))));
}

export function garbageCollectReviewArtifacts(options: {
  root: string;
  referencedPaths: Set<string>;
  candidates?: ReviewArtifactGcCandidate[];
  exhaustive?: boolean;
  nowMs?: number;
  maxDeletes?: number;
  maxDurationMs?: number;
}): ReviewArtifactGcResult {
  const result: ReviewArtifactGcResult = { scanned: 0, referenced: 0, deleted: 0, skipped: 0, errors: [] };
  if (!existsSync(options.root)) return result;
  if (!isSafeArtifactRoot(options.root)) {
    result.errors.push('review artifact root is not a regular directory or is a symbolic link; refusing to scan or delete.');
    return result;
  }
  const started = Date.now();
  const nowMs = options.nowMs ?? Date.now();
  const maxDeletes = options.maxDeletes ?? (options.exhaustive ? Number.POSITIVE_INFINITY : 50);
  const maxDurationMs = options.maxDurationMs ?? (options.exhaustive ? Number.POSITIVE_INFINITY : 100);
  const candidates = options.candidates ?? discoverReviewArtifactCandidates(options.root);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (result.deleted >= maxDeletes || Date.now() - started >= maxDurationMs) {
      result.skipped += candidates.length - index;
      break;
    }
    result.scanned += 1;
    if (options.referencedPaths.has(candidate.relativePath)) {
      result.referenced += 1;
      continue;
    }
    try {
      if (runHasActiveArtifactLease(options.root, candidate.relativePath, nowMs)) {
        result.skipped += 1;
        continue;
      }
      const confined = confinedArtifactPath(options.root, candidate.relativePath);
      const before = lstatSync(confined);
      if (!before.isFile() || before.isSymbolicLink()) {
        result.skipped += 1;
        continue;
      }
      if (!options.exhaustive && nowMs - before.mtimeMs < NORMAL_PRUNE_GRACE_MS) {
        result.skipped += 1;
        continue;
      }
      if (before.dev !== candidate.dev || before.ino !== candidate.ino || before.size !== candidate.size || before.mtimeMs !== candidate.mtimeMs) {
        result.skipped += 1;
        continue;
      }
      const revalidated = lstatSync(confined);
      if (
        !revalidated.isFile()
        || revalidated.isSymbolicLink()
        || revalidated.dev !== candidate.dev
        || revalidated.ino !== candidate.ino
        || revalidated.size !== candidate.size
        || revalidated.mtimeMs !== candidate.mtimeMs
        || options.referencedPaths.has(candidate.relativePath)
        || runHasActiveArtifactLease(options.root, candidate.relativePath, nowMs)
      ) {
        result.skipped += 1;
        continue;
      }
      unlinkSync(confined);
      result.deleted += 1;
    } catch (error) {
      result.errors.push(`${candidate.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export function discoverReviewArtifactCandidates(root: string): ReviewArtifactGcCandidate[] {
  if (!existsSync(root)) return [];
  if (!isSafeArtifactRoot(root)) return [];
  const candidates: ReviewArtifactGcCandidate[] = [];
  for (const entry of listArtifactFiles(root)) {
    try {
      const metadata = lstatSync(confinedArtifactPath(root, entry.relativePath));
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      candidates.push({
        relativePath: entry.relativePath,
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      });
    } catch {}
  }
  return candidates;
}

function isSafeArtifactRoot(root: string): boolean {
  try {
    const stat = lstatSync(path.resolve(root));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function writeAll<Handle>(ops: ReviewArtifactFileOps<Handle>, handle: Handle, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = ops.write(handle, bytes, offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
      throw new Error(`review artifact write made invalid progress at byte ${offset}.`);
    }
    offset += written;
  }
}

function shapeArtifactField(value: string, maxBytes: number, field: string): { value: string; truncated: boolean } {
  const normalized = normalizeReviewDataField(value, { field, maxBytes: Number.MAX_SAFE_INTEGER, allowEmpty: true, redact: true });
  const bytes = Buffer.from(normalized, 'utf8');
  if (bytes.length <= maxBytes) return { value: normalized, truncated: false };
  let omitted = bytes.length;
  let shaped = Buffer.alloc(0);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const marker = Buffer.from(`\n...[${omitted} bytes omitted]...\n`, 'utf8');
    const available = Math.max(0, maxBytes - marker.length);
    const head = utf8SafePrefix(bytes, Math.ceil(available / 2));
    const tail = utf8SafeSuffix(bytes, Math.floor(available / 2));
    const nextOmitted = bytes.length - head.length - tail.length;
    shaped = Buffer.concat([head, Buffer.from(`\n...[${nextOmitted} bytes omitted]...\n`, 'utf8'), tail]);
    if (nextOmitted === omitted && shaped.length <= maxBytes) break;
    omitted = nextOmitted;
  }
  if (shaped.length > maxBytes) throw new Error(`${field} could not be safely truncated to ${maxBytes} bytes.`);
  return { value: shaped.toString('utf8'), truncated: true };
}

function utf8SafePrefix(bytes: Buffer, limit: number): Buffer {
  let end = Math.min(limit, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

function utf8SafeSuffix(bytes: Buffer, limit: number): Buffer {
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

function confinedArtifactPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) throw new Error('review artifact path must be relative.');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('review artifact path escapes its machine-local root.');
  return resolved;
}

function assertNoSymlinkArtifactAncestors(root: string, targetPath: string): void {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(targetPath));
  let current = resolvedRoot;
  for (const segment of ['', ...relative.split(path.sep).slice(0, -1)]) {
    if (segment) current = path.join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('review artifact path contains a non-directory or symlink ancestor.');
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code === 'ENOENT') continue;
      throw error;
    }
  }
}

function safeArtifactSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  if (!normalized) throw new Error('review artifact id has no safe path representation.');
  return normalized;
}

function listArtifactFiles(root: string): Array<{ relativePath: string }> {
  const output: Array<{ relativePath: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(absolute);
      } else if (entry.isFile() && !entry.isSymbolicLink() && entry.name !== ACTIVE_LEASE_NAME) {
        output.push({ relativePath: path.relative(root, absolute).split(path.sep).join('/') });
      }
    }
  };
  visit(root);
  return output;
}

function runHasActiveArtifactLease(root: string, relativePath: string, nowMs: number): boolean {
  const [runDirectory] = relativePath.split('/');
  if (!runDirectory) return false;
  try {
    const lease = lstatSync(confinedArtifactPath(root, path.posix.join(runDirectory, ACTIVE_LEASE_NAME)));
    return lease.isFile() && !lease.isSymbolicLink() && nowMs - lease.mtimeMs < ACTIVE_LEASE_MAX_AGE_MS;
  } catch {
    return false;
  }
}
