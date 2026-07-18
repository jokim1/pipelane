import crypto from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  resolveConvergenceStateKey,
  signSignedPayload,
  stateKeyFingerprint,
  verifySignedPayload,
  canonicalize,
} from './integrity.ts';
import {
  acquireDirectoryStateLock,
  nowIso,
  resolveStateDir,
  writeJsonFile,
  type ReviewActorIdentity,
  type TaskBudgetGrantAllowance,
  type WorkflowConfig,
} from './state.ts';

// Convergence v1 S1 (D11): budget-extension consent issuance is human-surface
// only. Grants are minted by a Board approval of a pending consent card or by
// a TTY typed confirmation phrase — never by a non-interactive code path. The
// record class is HMAC-signed with the convergence-state key and fail-closed
// (D16): a missing key, missing signature, or bad signature refuses the
// artifact; it never degrades to trust.

export const CONSENT_GRANTS_DIRNAME = 'consent-grants';
export const CONSENT_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const BUDGET_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BudgetExtensionScope extends TaskBudgetGrantAllowance {
  lineageKey: string;
  taskSlug: string;
  branchName: string;
  reason: string;
}

export type ConsentCardStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface BudgetConsentCard extends TaskBudgetGrantAllowance {
  schemaVersion: 1;
  id: string;
  kind: 'budget-extension';
  status: ConsentCardStatus;
  lineageKey: string;
  taskSlug: string;
  branchName: string;
  reason: string;
  reasonDigest: string;
  scopeHash: string;
  // Bumps whenever the card content changes; a Board approval mints a grant
  // whose choice fingerprint binds to the exact mutation index the human saw.
  mutationIndex: number;
  requestedAt: string;
  requestedBy: ReviewActorIdentity;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  grantId?: string;
  keyId: string;
  signature?: string;
}

export interface BudgetExtensionGrant extends TaskBudgetGrantAllowance {
  schemaVersion: 1;
  id: string;
  kind: 'budget-extension';
  source: 'board' | 'tty';
  cardId?: string;
  choiceFingerprint: string;
  scopeHash: string;
  lineageKey: string;
  taskSlug: string;
  branchName: string;
  reason: string;
  reasonDigest: string;
  mintedAt: string;
  mintedBy: string;
  expiresAt: string;
  consumedAt?: string;
  keyId: string;
  signature?: string;
}

export interface GrantRefusal {
  code: 'missing' | 'expired' | 'reused' | 'wrong-scope' | 'invalid-signature';
  message: string;
}

export function consentGrantsDir(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), CONSENT_GRANTS_DIRNAME);
}

function consentGrantsLockPath(commonDir: string, config: WorkflowConfig): string {
  return path.join(resolveStateDir(commonDir, config), 'consent-grants.lock');
}

function cardPath(commonDir: string, config: WorkflowConfig, id: string): string {
  return path.join(consentGrantsDir(commonDir, config), `${id}.json`);
}

function grantPath(commonDir: string, config: WorkflowConfig, id: string): string {
  return path.join(consentGrantsDir(commonDir, config), `${id}.json`);
}

export function budgetExtensionScopeHash(scope: BudgetExtensionScope): string {
  return crypto.createHash('sha256').update(canonicalize({
    serializationVersion: 1,
    kind: 'budget-extension',
    lineageKey: scope.lineageKey,
    taskSlug: scope.taskSlug,
    branchName: scope.branchName,
    aiRunsDelta: scope.aiRunsDelta,
    activeMinutesDelta: scope.activeMinutesDelta,
    fixReviewLoopsDelta: scope.fixReviewLoopsDelta,
    reasonDigest: crypto.createHash('sha256').update(scope.reason).digest('hex'),
  })).digest('hex');
}

function choiceFingerprintForCard(cardId: string, mutationIndex: number): string {
  return crypto.createHash('sha256').update(canonicalize({ cardId, mutationIndex })).digest('hex');
}

function withConsentGrantsLock<T>(commonDir: string, config: WorkflowConfig, fn: () => T): T {
  const lock = acquireDirectoryStateLock(
    consentGrantsLockPath(commonDir, config),
    'consent-grants store is locked: another process is updating consent records. Wait and retry.',
  );
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function signRecord<T extends { signature?: string; keyId: string }>(record: T): T {
  const key = resolveConvergenceStateKey();
  record.keyId = stateKeyFingerprint(key);
  record.signature = signSignedPayload(record, key);
  return record;
}

function verifyRecord(record: { signature?: string; keyId?: string }): boolean {
  try {
    const key = resolveConvergenceStateKey();
    if (record.keyId !== stateKeyFingerprint(key)) return false;
    return verifySignedPayload(record, key);
  } catch {
    // Fail-closed (D16): an unavailable key refuses the record class.
    return false;
  }
}

function readConsentRecord(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isBudgetConsentCard(raw: Record<string, unknown>): raw is Record<string, unknown> & BudgetConsentCard {
  return raw.schemaVersion === 1
    && raw.kind === 'budget-extension'
    && typeof raw.id === 'string'
    && raw.id.startsWith('consent-card-')
    && typeof raw.lineageKey === 'string'
    && typeof raw.scopeHash === 'string'
    && typeof raw.expiresAt === 'string'
    && typeof raw.mutationIndex === 'number';
}

function isBudgetExtensionGrant(raw: Record<string, unknown>): raw is Record<string, unknown> & BudgetExtensionGrant {
  return raw.schemaVersion === 1
    && raw.kind === 'budget-extension'
    && typeof raw.id === 'string'
    && raw.id.startsWith('budget-grant-')
    && typeof raw.lineageKey === 'string'
    && typeof raw.scopeHash === 'string'
    && typeof raw.choiceFingerprint === 'string'
    && (raw.source === 'board' || raw.source === 'tty');
}

function listRecords(commonDir: string, config: WorkflowConfig): { cards: BudgetConsentCard[]; grants: BudgetExtensionGrant[] } {
  const dir = consentGrantsDir(commonDir, config);
  const cards: BudgetConsentCard[] = [];
  const grants: BudgetExtensionGrant[] = [];
  if (!existsSync(dir)) return { cards, grants };
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return { cards, grants };
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const raw = readConsentRecord(path.join(dir, entry));
    if (!raw) continue;
    if (isBudgetConsentCard(raw)) cards.push(raw);
    else if (isBudgetExtensionGrant(raw)) grants.push(raw);
  }
  cards.sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
  grants.sort((left, right) => right.mintedAt.localeCompare(left.mintedAt));
  return { cards, grants };
}

function persistCard(commonDir: string, config: WorkflowConfig, card: BudgetConsentCard): BudgetConsentCard {
  mkdirSync(consentGrantsDir(commonDir, config), { recursive: true });
  writeJsonFile(cardPath(commonDir, config, card.id), signRecord(card));
  return card;
}

function persistGrant(commonDir: string, config: WorkflowConfig, grant: BudgetExtensionGrant): BudgetExtensionGrant {
  mkdirSync(consentGrantsDir(commonDir, config), { recursive: true });
  writeJsonFile(grantPath(commonDir, config, grant.id), signRecord(grant));
  return grant;
}

function expireStalePendingCard(commonDir: string, config: WorkflowConfig, card: BudgetConsentCard): BudgetConsentCard {
  if (card.status !== 'pending' || Date.parse(card.expiresAt) >= Date.now()) return card;
  const expired: BudgetConsentCard = { ...card, status: 'expired', decidedAt: nowIso(), decidedBy: 'expiry-sweep' };
  return persistCard(commonDir, config, expired);
}

export function listBudgetConsentCards(
  commonDir: string,
  config: WorkflowConfig,
  filter: { lineageKey?: string; status?: ConsentCardStatus } = {},
): BudgetConsentCard[] {
  return listRecords(commonDir, config).cards
    .map((card) => expireStalePendingCard(commonDir, config, card))
    .filter((card) => verifyRecord(card))
    .filter((card) => (!filter.lineageKey || card.lineageKey === filter.lineageKey)
      && (!filter.status || card.status === filter.status));
}

export function listBudgetExtensionGrants(
  commonDir: string,
  config: WorkflowConfig,
  filter: { lineageKey?: string; unconsumedOnly?: boolean } = {},
): BudgetExtensionGrant[] {
  return listRecords(commonDir, config).grants
    .filter((grant) => (!filter.lineageKey || grant.lineageKey === filter.lineageKey)
      && (!filter.unconsumedOnly || !grant.consumedAt));
}

// The agent-reachable request path: files (or reuses) exactly one pending
// consent card per task lineage. Never returns a token or grant.
export function requestBudgetExtensionCard(
  commonDir: string,
  config: WorkflowConfig,
  scope: BudgetExtensionScope,
  requestedBy: ReviewActorIdentity,
): { card: BudgetConsentCard; created: boolean; updated: boolean } {
  return withConsentGrantsLock(commonDir, config, () => {
    const scopeHash = budgetExtensionScopeHash(scope);
    const pending = listRecords(commonDir, config).cards
      .map((card) => expireStalePendingCard(commonDir, config, card))
      .filter((card) => card.status === 'pending' && card.lineageKey === scope.lineageKey && verifyRecord(card));
    const existing = pending[0];
    if (existing) {
      if (existing.scopeHash === scopeHash) {
        return { card: existing, created: false, updated: false };
      }
      // Re-request with a different scope supersedes the pending card in
      // place: same card id, bumped mutation index, so a Board approval that
      // raced the edit can never mint a broader grant than the human saw.
      const updated: BudgetConsentCard = {
        ...existing,
        aiRunsDelta: scope.aiRunsDelta,
        activeMinutesDelta: scope.activeMinutesDelta,
        fixReviewLoopsDelta: scope.fixReviewLoopsDelta,
        reason: scope.reason,
        reasonDigest: crypto.createHash('sha256').update(scope.reason).digest('hex'),
        scopeHash,
        mutationIndex: existing.mutationIndex + 1,
        requestedAt: nowIso(),
        requestedBy,
        expiresAt: new Date(Date.now() + CONSENT_CARD_TTL_MS).toISOString(),
      };
      return { card: persistCard(commonDir, config, updated), created: false, updated: true };
    }
    const requestedAt = nowIso();
    const card: BudgetConsentCard = {
      schemaVersion: 1,
      id: `consent-card-${new Date(requestedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
      kind: 'budget-extension',
      status: 'pending',
      lineageKey: scope.lineageKey,
      taskSlug: scope.taskSlug,
      branchName: scope.branchName,
      aiRunsDelta: scope.aiRunsDelta,
      activeMinutesDelta: scope.activeMinutesDelta,
      fixReviewLoopsDelta: scope.fixReviewLoopsDelta,
      reason: scope.reason,
      reasonDigest: crypto.createHash('sha256').update(scope.reason).digest('hex'),
      scopeHash,
      mutationIndex: 0,
      requestedAt,
      requestedBy,
      expiresAt: new Date(Date.now() + CONSENT_CARD_TTL_MS).toISOString(),
      keyId: '',
    };
    return { card: persistCard(commonDir, config, card), created: true, updated: false };
  });
}

// Board approval path. The caller (dashboard server) is responsible for the
// human-surface gauntlet (loopback origin + browser session token); this
// function enforces record integrity, expiry, and one-grant-per-card.
export function approveBudgetConsentCard(
  commonDir: string,
  config: WorkflowConfig,
  cardId: string,
  options: { decidedBy: string; decisionReason?: string },
): { card: BudgetConsentCard; grant: BudgetExtensionGrant } {
  return withConsentGrantsLock(commonDir, config, () => {
    const raw = readConsentRecord(cardPath(commonDir, config, cardId));
    if (!raw || !isBudgetConsentCard(raw)) throw new Error(`Consent card ${cardId} was not found.`);
    const card = raw as BudgetConsentCard;
    if (!verifyRecord(card)) throw new Error(`Consent card ${cardId} failed signature verification and was refused (fail-closed).`);
    if (card.status !== 'pending') throw new Error(`Consent card ${cardId} is ${card.status}; only a pending card can be approved.`);
    if (Date.parse(card.expiresAt) < Date.now()) {
      persistCard(commonDir, config, { ...card, status: 'expired', decidedAt: nowIso(), decidedBy: 'expiry-sweep' });
      throw new Error(`Consent card ${cardId} expired at ${card.expiresAt}; ask the requester to file a fresh request.`);
    }
    const mintedAt = nowIso();
    const grant: BudgetExtensionGrant = {
      schemaVersion: 1,
      id: `budget-grant-${new Date(mintedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
      kind: 'budget-extension',
      source: 'board',
      cardId: card.id,
      choiceFingerprint: choiceFingerprintForCard(card.id, card.mutationIndex),
      scopeHash: card.scopeHash,
      lineageKey: card.lineageKey,
      taskSlug: card.taskSlug,
      branchName: card.branchName,
      aiRunsDelta: card.aiRunsDelta,
      activeMinutesDelta: card.activeMinutesDelta,
      fixReviewLoopsDelta: card.fixReviewLoopsDelta,
      reason: card.reason,
      reasonDigest: card.reasonDigest,
      mintedAt,
      mintedBy: options.decidedBy,
      expiresAt: new Date(Date.now() + BUDGET_GRANT_TTL_MS).toISOString(),
      keyId: '',
    };
    persistGrant(commonDir, config, grant);
    const decided: BudgetConsentCard = {
      ...card,
      status: 'approved',
      decidedAt: mintedAt,
      decidedBy: options.decidedBy,
      ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
      grantId: grant.id,
    };
    return { card: persistCard(commonDir, config, decided), grant };
  });
}

export function denyBudgetConsentCard(
  commonDir: string,
  config: WorkflowConfig,
  cardId: string,
  options: { decidedBy: string; decisionReason: string },
): BudgetConsentCard {
  return withConsentGrantsLock(commonDir, config, () => {
    const raw = readConsentRecord(cardPath(commonDir, config, cardId));
    if (!raw || !isBudgetConsentCard(raw)) throw new Error(`Consent card ${cardId} was not found.`);
    const card = raw as BudgetConsentCard;
    if (!verifyRecord(card)) throw new Error(`Consent card ${cardId} failed signature verification and was refused (fail-closed).`);
    if (card.status !== 'pending') throw new Error(`Consent card ${cardId} is ${card.status}; only a pending card can be denied.`);
    return persistCard(commonDir, config, {
      ...card,
      status: 'denied',
      decidedAt: nowIso(),
      decidedBy: options.decidedBy,
      decisionReason: options.decisionReason,
    });
  });
}

// TTY typed-phrase path (option-4 pattern): the interactive operator mints a
// grant directly; issuance and the identity of the typing human are the same
// surface, so the grant records source 'tty' and is immediately consumable.
export function mintTtyBudgetExtensionGrant(
  commonDir: string,
  config: WorkflowConfig,
  scope: BudgetExtensionScope,
  options: { mintedBy: string; confirmationPhrase: string },
): BudgetExtensionGrant {
  return withConsentGrantsLock(commonDir, config, () => {
    const mintedAt = nowIso();
    const grant: BudgetExtensionGrant = {
      schemaVersion: 1,
      id: `budget-grant-${new Date(mintedAt).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`,
      kind: 'budget-extension',
      source: 'tty',
      choiceFingerprint: crypto.createHash('sha256').update(canonicalize({
        confirmationPhrase: options.confirmationPhrase,
        mintedAt,
        lineageKey: scope.lineageKey,
      })).digest('hex'),
      scopeHash: budgetExtensionScopeHash(scope),
      lineageKey: scope.lineageKey,
      taskSlug: scope.taskSlug,
      branchName: scope.branchName,
      aiRunsDelta: scope.aiRunsDelta,
      activeMinutesDelta: scope.activeMinutesDelta,
      fixReviewLoopsDelta: scope.fixReviewLoopsDelta,
      reason: scope.reason,
      reasonDigest: crypto.createHash('sha256').update(scope.reason).digest('hex'),
      mintedAt,
      mintedBy: options.mintedBy,
      expiresAt: new Date(Date.now() + BUDGET_GRANT_TTL_MS).toISOString(),
      keyId: '',
    };
    return persistGrant(commonDir, config, grant);
  });
}

// One-use consumption. Every refusal names its reason (§8-S1 acceptance:
// expired / reused / wrong-scope fixtures refuse with reason).
export function consumeBudgetExtensionGrant(
  commonDir: string,
  config: WorkflowConfig,
  options: { lineageKey: string; grantId?: string },
): { grant: BudgetExtensionGrant } | { refusal: GrantRefusal } {
  return withConsentGrantsLock(commonDir, config, () => {
    const { grants } = listRecords(commonDir, config);
    const candidates = grants.filter((grant) => (options.grantId ? grant.id === options.grantId : grant.lineageKey === options.lineageKey));
    if (candidates.length === 0) {
      return { refusal: { code: 'missing' as const, message: 'No budget-extension grant exists for this task lineage. Extension requires a Board approval or an interactive operator terminal.' } };
    }
    const refusals: GrantRefusal[] = [];
    for (const grant of candidates) {
      if (!verifyRecord(grant)) {
        refusals.push({ code: 'invalid-signature', message: `Grant ${grant.id} failed convergence-key signature verification and was refused (fail-closed).` });
        continue;
      }
      if (grant.lineageKey !== options.lineageKey) {
        refusals.push({ code: 'wrong-scope', message: `Grant ${grant.id} is scoped to a different task lineage and cannot extend this task.` });
        continue;
      }
      if (grant.scopeHash !== budgetExtensionScopeHash({
        lineageKey: grant.lineageKey,
        taskSlug: grant.taskSlug,
        branchName: grant.branchName,
        aiRunsDelta: grant.aiRunsDelta,
        activeMinutesDelta: grant.activeMinutesDelta,
        fixReviewLoopsDelta: grant.fixReviewLoopsDelta,
        reason: grant.reason,
      })) {
        refusals.push({ code: 'wrong-scope', message: `Grant ${grant.id} scope hash does not match its recorded scope; the grant was refused.` });
        continue;
      }
      if (grant.consumedAt) {
        refusals.push({ code: 'reused', message: `Grant ${grant.id} was already consumed at ${grant.consumedAt}; grants are one-use.` });
        continue;
      }
      if (Date.parse(grant.expiresAt) < Date.now()) {
        refusals.push({ code: 'expired', message: `Grant ${grant.id} expired at ${grant.expiresAt}; request a fresh extension.` });
        continue;
      }
      const consumed: BudgetExtensionGrant = { ...grant, consumedAt: nowIso() };
      persistGrant(commonDir, config, consumed);
      return { grant: consumed };
    }
    return { refusal: refusals[0] ?? { code: 'missing' as const, message: 'No consumable budget-extension grant exists for this task lineage.' } };
  });
}
