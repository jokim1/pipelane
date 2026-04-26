import { nowIso } from '../state.ts';

// Bumped 2026-04-25: action inputs can expose structured choice options.
// Readers that ignore the new fields still parse correctly because the
// extension is additive-only.
export const WORKFLOW_API_SCHEMA_VERSION = '2026-04-25';

export const CANONICAL_LANE_STATES = [
  'healthy',
  'running',
  'blocked',
  'degraded',
  'stale',
  'unknown',
  'bypassed',
  'awaiting_preflight',
] as const;

export type LaneState = (typeof CANONICAL_LANE_STATES)[number];
export const SHELL_LAYER_HEALTH_STATES = [
  'healthy',
  'unknown',
  'degraded',
  'unavailable',
] as const;
export type ShellLayerHealth = (typeof SHELL_LAYER_HEALTH_STATES)[number];

export const SHELL_RELATIONSHIP_STATES = [
  'match',
  'drift',
  'not-comparable',
] as const;
export type ShellRelationshipState = (typeof SHELL_RELATIONSHIP_STATES)[number];

export type IssueSeverity = 'info' | 'warning' | 'error';

export interface Freshness {
  checkedAt: string;
  observedAt: string;
  state: 'fresh' | 'stale';
}

export interface ApiIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  source: string;
  blocking: boolean;
  branch: string;
  lane: string;
  action: string;
}

export interface SourceHealthEntry {
  name: string;
  state: LaneState;
  blocking: boolean;
  reason: string;
  freshness: Freshness;
}

export interface ApiStatusCell {
  state: LaneState;
  reason: string;
  detail: string;
  freshness: Freshness;
}

export interface ApiActionState {
  id: string;
  label: string;
  state: LaneState;
  reason: string;
  risky: boolean;
  requiresConfirmation: boolean;
  inputs: ApiActionInput[];
  defaultParams: Record<string, unknown>;
  freshness: Freshness;
}

export interface ApiActionInput {
  name: string;
  label: string;
  type: 'text' | 'boolean' | 'choice';
  required: boolean;
  placeholder: string;
  options?: ApiActionInputOption[];
}

export interface ApiActionInputOption {
  value: string;
  label: string;
  description: string;
  params?: Record<string, unknown>;
}

export interface ApiEnvelope<TData = unknown> {
  schemaVersion: string;
  command: string;
  ok: boolean;
  message: string;
  warnings: string[];
  issues: ApiIssue[];
  data: TData;
}

export function buildApiEnvelope<TData>(options: {
  command: string;
  ok?: boolean;
  message?: string;
  warnings?: string[];
  issues?: ApiIssue[];
  data: TData;
}): ApiEnvelope<TData> {
  return {
    schemaVersion: WORKFLOW_API_SCHEMA_VERSION,
    command: options.command,
    ok: options.ok ?? true,
    message: options.message ?? '',
    warnings: options.warnings ?? [],
    issues: options.issues ?? [],
    data: options.data,
  };
}

export function buildApiIssue(options: {
  code: string;
  severity?: IssueSeverity;
  message: string;
  source?: string;
  blocking?: boolean;
  branch?: string;
  lane?: string;
  action?: string;
}): ApiIssue {
  return {
    code: options.code,
    severity: options.severity ?? 'warning',
    message: options.message,
    source: options.source ?? '',
    blocking: options.blocking ?? false,
    branch: options.branch ?? '',
    lane: options.lane ?? '',
    action: options.action ?? '',
  };
}

export function buildFreshness(options: {
  checkedAt?: string;
  observedAt?: string;
  stale?: boolean;
} = {}): Freshness {
  const checkedAt = options.checkedAt ?? nowIso();
  return {
    checkedAt,
    observedAt: options.observedAt ?? checkedAt,
    state: options.stale ? 'stale' : 'fresh',
  };
}

export function buildSourceHealthEntry(options: {
  name: string;
  state?: LaneState;
  blocking?: boolean;
  reason?: string;
  checkedAt?: string;
  observedAt?: string;
  stale?: boolean;
}): SourceHealthEntry {
  return {
    name: options.name,
    state: options.state ?? 'healthy',
    blocking: options.blocking ?? false,
    reason: options.reason ?? '',
    freshness: buildFreshness({
      checkedAt: options.checkedAt,
      observedAt: options.observedAt,
      stale: options.stale,
    }),
  };
}

export function buildApiStatusCell(options: {
  state?: LaneState;
  reason?: string;
  detail?: string;
  checkedAt?: string;
  observedAt?: string;
  stale?: boolean;
} = {}): ApiStatusCell {
  return {
    state: options.state ?? 'unknown',
    reason: options.reason ?? '',
    detail: options.detail ?? '',
    freshness: buildFreshness({
      checkedAt: options.checkedAt,
      observedAt: options.observedAt,
      stale: options.stale,
    }),
  };
}

export function buildApiActionState(options: {
  id: string;
  label?: string;
  state?: LaneState;
  reason?: string;
  risky?: boolean;
  requiresConfirmation?: boolean;
  inputs?: ApiActionInput[];
  defaultParams?: Record<string, unknown>;
  checkedAt?: string;
}): ApiActionState {
  return {
    id: options.id,
    label: options.label ?? options.id,
    state: options.state ?? 'unknown',
    reason: options.reason ?? '',
    risky: options.risky ?? false,
    requiresConfirmation: options.requiresConfirmation ?? false,
    inputs: options.inputs ?? [],
    defaultParams: options.defaultParams ?? {},
    freshness: buildFreshness({ checkedAt: options.checkedAt }),
  };
}
