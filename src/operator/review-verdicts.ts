import crypto from 'node:crypto';
import { existsSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';

import {
  canonicalize,
  resolveConvergenceStateKey,
  signSignedPayload,
  stateKeyFingerprint,
  verifySignedPayload,
} from './integrity.ts';
import {
  loadReviewState,
  normalizeVersionedJsonValue,
  readJsonFile,
  reviewVerdictsRoot,
  STATE_SCHEMA_VERSIONS,
  withReviewStateLock,
  writeJsonFile,
  writeVersionedJsonFile,
  type ReviewActorIdentity,
  type WorkflowConfig,
} from './state.ts';

// Convergence v1 verdict cache (plan §4.4, slice S2): content-addressed,
// signed, scope-qualified reuse of AI gate results.
//
// - The key (D13) is the full ReviewVerdictScope; delta and full entries can
//   never collide because reviewMode/deltaBaseTree are key fields, and every
//   consumer performs an exact-scope lookup (there is deliberately no partial
//   lookup surface — a consumer that cannot reconstruct the complete scope
//   treats the cache as a miss).
// - Entries are self-contained (D7): validity never depends on review-state
//   retention. `reviewRunId` is provenance only. (Strict-v3 replay fidelity —
//   result envelope + report artifact — still resolves through the original
//   run record and degrades to a miss once pruned; see review.ts.)
// - Signing is mandatory and fail-closed (D3/D16): a missing key, missing
//   signature, or bad signature makes the entry a MISS (re-review, never
//   trust), and `keyId` rotation invalidates entries under retired keys.
// - Eviction (D10/D13): LRU capped at 200 unpinned entries; entries referenced
//   by live review-state evidence or by a lineage's last verdict tree are
//   pinned (evicted only when superseded). Pins can therefore hold the store
//   above the cap — that condition is surfaced on stderr, never silent.
// - Writes (entry + pin index + eviction) serialize under the review-state
//   lock; lookups stay lock-free (entries are immutable once written and
//   verified by signature).

export type ReviewVerdictMode = 'full' | 'delta';
export type ReviewVerdictStatus = 'passed' | 'failed';

export interface ReviewVerdictScope {
  gateId: string;
  gateDefinitionHash: string;
  contractDigest: string;
  materialTreeHash: string;
  baseTipOid: string;
  reviewMode: ReviewVerdictMode;
  deltaBaseTree: string;
  reviewedScopeDigest: string;
  intentDigest: string;
}

export interface ReviewVerdictEntry {
  scope: ReviewVerdictScope;
  status: ReviewVerdictStatus;
  findingIds: string[];
  attester: ReviewActorIdentity | null;
  reviewRunId: string;
  recordedAt: string;
  tokensUsed: number;
  keyId: string;
  sig: string;
}

export const REVIEW_VERDICT_CACHE_MAX_ENTRIES = 200;
const LAST_VERDICT_TREES_FILENAME = 'last-verdict-trees.json';
const LAST_VERDICT_TREES_MAX_LINEAGES = 200;

// A lineage's current verdict is one exact entry PER gate (its latest). Pins
// are the exact entry key digests (filenames), not the material tree: pinning
// by tree hash would keep every historical base-tip/contract variant of the
// same tree alive forever, defeating the cap (D10/D13). Recording a new verdict
// for the same (lineage, gate) supersedes the prior pin, so old-tree and
// old-base entries become evictable. Pinned entries are therefore bounded by
// (lineages ≤ 200) × (gates per review), and superseded ones are released.
interface LastVerdictLineagePin {
  gates: Record<string, string>; // gateId -> exact entry key digest
  updatedAt: string;
}

interface LastVerdictTreePinsFile {
  pins: Record<string, LastVerdictLineagePin>;
}

// D16 fail-closed boundary: every read and write path resolves the mandatory
// convergence key through here. Resolution failure (unprovisionable home,
// invalid explicit key) yields null, which callers must treat as a cache miss
// on read and a skipped write — never as permission to trust or emit an
// unsigned entry.
function currentVerdictSigningKey(): { key: string; keyId: string } | null {
  try {
    const key = resolveConvergenceStateKey();
    return { key, keyId: stateKeyFingerprint(key) };
  } catch {
    return null;
  }
}

export function reviewVerdictKeyDigest(scope: ReviewVerdictScope): string {
  return crypto.createHash('sha256').update(canonicalize({ version: 1, ...scope })).digest('hex');
}

function reviewVerdictEntryPath(root: string, scope: ReviewVerdictScope): string {
  return path.join(root, `${reviewVerdictKeyDigest(scope)}.json`);
}

function lastVerdictTreesPath(root: string): string {
  return path.join(root, LAST_VERDICT_TREES_FILENAME);
}

function signReviewVerdictEntry(entry: Omit<ReviewVerdictEntry, 'sig'>, key: string): string {
  // The entry carries `sig`, not `signature`; map onto the shared HMAC helpers
  // so the canonical payload covers every field except the signature itself.
  const payload: Omit<ReviewVerdictEntry, 'sig'> & { signature?: string } = { ...entry };
  return signSignedPayload(payload, key);
}

function verifyReviewVerdictEntry(entry: ReviewVerdictEntry, key: string): boolean {
  const { sig, ...rest } = entry;
  return verifySignedPayload({ ...rest, signature: sig }, key);
}

const REVIEW_VERDICT_MODES: readonly ReviewVerdictMode[] = ['full', 'delta'];
const REVIEW_VERDICT_STATUSES: readonly ReviewVerdictStatus[] = ['passed', 'failed'];

function isReviewVerdictScope(raw: unknown): raw is ReviewVerdictScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const scope = raw as Record<string, unknown>;
  return typeof scope.gateId === 'string' && scope.gateId.length > 0
    && typeof scope.gateDefinitionHash === 'string' && scope.gateDefinitionHash.length > 0
    && typeof scope.contractDigest === 'string' && scope.contractDigest.length > 0
    && typeof scope.materialTreeHash === 'string' && scope.materialTreeHash.length > 0
    && typeof scope.baseTipOid === 'string' && scope.baseTipOid.length > 0
    && REVIEW_VERDICT_MODES.includes(scope.reviewMode as ReviewVerdictMode)
    && typeof scope.deltaBaseTree === 'string'
    && (scope.reviewMode === 'delta' ? scope.deltaBaseTree.length > 0 : scope.deltaBaseTree === '')
    && typeof scope.reviewedScopeDigest === 'string' && scope.reviewedScopeDigest.length > 0
    && typeof scope.intentDigest === 'string';
}

function isReviewActorIdentity(raw: unknown): raw is ReviewActorIdentity {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const actor = raw as Record<string, unknown>;
  return typeof actor.provider === 'string'
    && (actor.sessionId === null || typeof actor.sessionId === 'string')
    && typeof actor.source === 'string';
}

export function isReviewVerdictEntry(raw: unknown): raw is ReviewVerdictEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const entry = raw as Record<string, unknown>;
  return isReviewVerdictScope(entry.scope)
    && REVIEW_VERDICT_STATUSES.includes(entry.status as ReviewVerdictStatus)
    && Array.isArray(entry.findingIds)
    && entry.findingIds.every((id) => typeof id === 'string')
    && (entry.attester === null || isReviewActorIdentity(entry.attester))
    && typeof entry.reviewRunId === 'string'
    && typeof entry.recordedAt === 'string'
    && typeof entry.tokensUsed === 'number' && Number.isFinite(entry.tokensUsed)
    && typeof entry.keyId === 'string'
    && typeof entry.sig === 'string';
}

export interface RecordReviewVerdictOptions {
  scope: ReviewVerdictScope;
  status: ReviewVerdictStatus;
  findingIds: string[];
  attester: ReviewActorIdentity | null;
  reviewRunId: string;
  recordedAt: string;
  // Real token accounting lands with S11 (D18); until then writers record 0.
  tokensUsed?: number;
  // Lineage (task binding id or branch) whose lastVerdictTree pin should track
  // this entry's tree (D13 pinning).
  pinLineage?: string;
}

export function recordReviewVerdict(
  commonDir: string,
  config: WorkflowConfig,
  options: RecordReviewVerdictOptions,
): ReviewVerdictEntry | null {
  const signing = currentVerdictSigningKey();
  if (!signing) return null;
  if (!isReviewVerdictScope(options.scope)) return null;
  const unsigned: Omit<ReviewVerdictEntry, 'sig'> = {
    scope: options.scope,
    status: options.status,
    findingIds: [...options.findingIds],
    attester: options.attester,
    reviewRunId: options.reviewRunId,
    recordedAt: options.recordedAt,
    tokensUsed: options.tokensUsed ?? 0,
    keyId: signing.keyId,
  };
  const entry: ReviewVerdictEntry = { ...unsigned, sig: signReviewVerdictEntry(unsigned, signing.key) };
  // The cache is a pure optimization: writing it must never be able to fail
  // the review that just paid for the verdict. Entry write, pin update, and
  // eviction are one read-modify-write section serialized with concurrent
  // reviews under the shared review-state lock (so a parallel run can neither
  // drop a pin update nor evict an entry this write is about to pin), but the
  // lock is non-blocking and throws under contention — any failure degrades to
  // "not cached" rather than propagating. Worst case: the next review re-runs
  // the gate and re-derives the entry.
  try {
    return withReviewStateLock(commonDir, config, () => {
      const root = reviewVerdictsRoot(commonDir, config);
      // Entries carry the schemaVersion envelope directly (registry-compliant,
      // migrated forward on read via normalizeVersionedJsonValue) instead of
      // going through writeVersionedJsonFile: content-addressed filenames would
      // otherwise accumulate unboundedly in the install marker's stateFiles
      // list. The singleton pin index below uses the full versioned writer.
      writeJsonFile(reviewVerdictEntryPath(root, options.scope), {
        ...entry,
        schemaVersion: STATE_SCHEMA_VERSIONS.reviewVerdictEntry,
      });
      const pinLineage = options.pinLineage?.trim();
      if (pinLineage) updateLastVerdictTreePin(root, pinLineage, options.scope);
      evictReviewVerdictsOverCapLocked(commonDir, config, root);
      return entry;
    });
  } catch {
    return null;
  }
}

// The pin index is advisory eviction state, not evidence: tampering with it can
// only change which entries are evicted first, never what a lookup trusts (the
// D16 signature on each entry gates trust), so it stays unsigned. Mutated only
// under the review-state lock (recordReviewVerdict). Pins the exact entry key
// per (lineage, gate); a new verdict for the same (lineage, gate) supersedes
// the prior pin so old-tree/old-base entries are released for eviction.
function updateLastVerdictTreePin(root: string, lineage: string, scope: ReviewVerdictScope): void {
  const pins = loadLastVerdictTreePins(root);
  const existing = pins[lineage]?.gates ?? {};
  pins[lineage] = {
    gates: { ...existing, [scope.gateId]: reviewVerdictKeyDigest(scope) },
    updatedAt: new Date().toISOString(),
  };
  const capped = Object.fromEntries(
    Object.entries(pins)
      .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, LAST_VERDICT_TREES_MAX_LINEAGES),
  );
  writeVersionedJsonFile('reviewVerdictPins', lastVerdictTreesPath(root), { pins: capped } satisfies LastVerdictTreePinsFile);
}

function loadLastVerdictTreePins(root: string): Record<string, LastVerdictLineagePin> {
  const raw = readJsonFile<unknown>(lastVerdictTreesPath(root), null);
  if (!raw) return {};
  const file = normalizeVersionedJsonValue<Partial<LastVerdictTreePinsFile>>('reviewVerdictPins', raw);
  if (!file || typeof file !== 'object' || !file.pins || typeof file.pins !== 'object' || Array.isArray(file.pins)) return {};
  const pins: Record<string, LastVerdictLineagePin> = {};
  for (const [lineage, value] of Object.entries(file.pins as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const pin = value as Record<string, unknown>;
    if (typeof pin.updatedAt !== 'string' || !pin.gates || typeof pin.gates !== 'object' || Array.isArray(pin.gates)) continue;
    const gates: Record<string, string> = {};
    for (const [gateId, digest] of Object.entries(pin.gates as Record<string, unknown>)) {
      if (typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) gates[gateId] = digest;
    }
    if (Object.keys(gates).length > 0) pins[lineage] = { gates, updatedAt: pin.updatedAt };
  }
  return pins;
}

// The set of exact entry key digests currently pinned by any lineage.
function pinnedKeyDigests(root: string): Set<string> {
  const pinned = new Set<string>();
  for (const pin of Object.values(loadLastVerdictTreePins(root))) {
    for (const digest of Object.values(pin.gates)) pinned.add(digest);
  }
  return pinned;
}

export function lookupReviewVerdict(
  commonDir: string,
  config: WorkflowConfig,
  scope: ReviewVerdictScope,
): ReviewVerdictEntry | null {
  const signing = currentVerdictSigningKey();
  if (!signing) return null;
  if (!isReviewVerdictScope(scope)) return null;
  const entryPath = reviewVerdictEntryPath(reviewVerdictsRoot(commonDir, config), scope);
  const entry = readVerifiedEntry(entryPath, signing);
  if (!entry) return null;
  // Self-containment defense: the signed scope inside the file must attest the
  // requested scope, so a renamed or copied entry can never satisfy another
  // key. Combined with the digest-derived path this makes every consumer an
  // exact-scope consumer — all nine D13 qualifiers must match.
  if (canonicalize(entry.scope) !== canonicalize(scope)) return null;
  touchForLru(entryPath);
  return entry;
}

function readVerifiedEntry(entryPath: string, signing: { key: string; keyId: string }): ReviewVerdictEntry | null {
  // A concurrent eviction can remove the file between existsSync and the read,
  // and readJsonFile only swallows JSON syntax errors — an ENOENT would
  // otherwise throw. A lock-free lookup racing eviction is expected, so treat
  // any read failure as an ordinary cache miss.
  let raw: unknown;
  try {
    if (!existsSync(entryPath)) return null;
    raw = readJsonFile<unknown>(entryPath, null);
  } catch {
    return null;
  }
  if (!raw) return null;
  const stripped = normalizeVersionedJsonValue<unknown>('reviewVerdictEntry', raw);
  if (!isReviewVerdictEntry(stripped)) return null;
  // keyId rotation: entries under a retired key invalidate to re-derivable
  // state (they simply miss until a fresh review rewrites them).
  if (stripped.keyId !== signing.keyId) return null;
  if (!verifyReviewVerdictEntry(stripped, signing.key)) return null;
  return stripped;
}

function touchForLru(entryPath: string): void {
  try {
    const now = new Date();
    utimesSync(entryPath, now, now);
  } catch {
    // Recency tracking is best-effort; a failed touch only skews eviction order.
  }
}

function listVerdictEntryPaths(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json') && dirent.name !== LAST_VERDICT_TREES_FILENAME && !dirent.name.startsWith('.'))
      .map((dirent) => path.join(root, dirent.name));
  } catch {
    return [];
  }
}

export function evictReviewVerdictsOverCap(commonDir: string, config: WorkflowConfig): void {
  // Best-effort like the write path: eviction under lock contention simply
  // does not run this pass rather than throwing to the caller.
  try {
    withReviewStateLock(commonDir, config, () => {
      evictReviewVerdictsOverCapLocked(commonDir, config, reviewVerdictsRoot(commonDir, config));
    });
  } catch {
    // Cap enforcement retries on the next recorded verdict.
  }
}

function evictReviewVerdictsOverCapLocked(commonDir: string, config: WorkflowConfig, root: string): void {
  const entryPaths = listVerdictEntryPaths(root);
  if (entryPaths.length <= REVIEW_VERDICT_CACHE_MAX_ENTRIES) return;

  const pinnedKeys = pinnedKeyDigests(root);
  const liveEvidenceRunIds = new Set(
    loadReviewState(commonDir, config).records.map((record) => record.id),
  );

  const candidates = entryPaths.map((entryPath) => {
    // Pinned (D10/D13): the entry's EXACT key (its filename stem) is a lineage's
    // current verdict for its gate, or its run is live /pr//merge evidence.
    // Keying by exact digest (not material tree) bounds pinned entries to
    // (lineages × gates) — historical variants of a pinned tree are NOT pinned.
    const keyDigest = path.basename(entryPath, '.json');
    let pinned = pinnedKeys.has(keyDigest);
    if (!pinned) {
      const raw = readJsonFile<unknown>(entryPath, null);
      const stripped = raw ? normalizeVersionedJsonValue<unknown>('reviewVerdictEntry', raw) : null;
      const entry = isReviewVerdictEntry(stripped) ? stripped : null;
      // Malformed entries are never pinned — they are the first eviction targets.
      pinned = Boolean(entry) && liveEvidenceRunIds.has(entry!.reviewRunId);
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(entryPath).mtimeMs;
    } catch {}
    return { entryPath, pinned, mtimeMs };
  });

  const removable = candidates
    .filter((candidate) => !candidate.pinned)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  let excess = entryPaths.length - REVIEW_VERDICT_CACHE_MAX_ENTRIES;
  let removed = 0;
  for (const candidate of removable) {
    if (excess <= 0) break;
    try {
      rmSync(candidate.entryPath, { force: true });
      removed += 1;
      excess -= 1;
    } catch {}
  }
  if (excess > 0) {
    // No silent caps: pinned entries legitimately survive eviction (D10/D13),
    // but the operator must be able to see the store holding above its cap.
    const pinnedCount = candidates.filter((candidate) => candidate.pinned).length;
    process.stderr.write(
      `[pipelane] review-verdicts: ${entryPaths.length - removed} entries remain above the ${REVIEW_VERDICT_CACHE_MAX_ENTRIES}-entry cap; ${pinnedCount} are pinned by live evidence or lastVerdictTree and were not evicted.\n`,
    );
  }
}
