import { readFileSync, statSync } from 'node:fs';

import { canonicalize } from './integrity.ts';
import { sanitizeForTerminal } from './text-output.ts';
import type { TaskBrief } from './state.ts';
import crypto from 'node:crypto';

export const REVIEW_DATA_LIMITS = {
  objectiveBytes: 8 * 1024,
  constraintBytes: 2 * 1024,
  acceptanceCriterionBytes: 2 * 1024,
  briefFileBytes: 64 * 1024,
  intentBytes: 16 * 1024,
  findingTitleBytes: 300,
  findingLocationBytes: 300,
  findingCount: 100,
  protocolLineBytes: 64 * 1024,
  reportBytes: 64 * 1024,
  diagnosticsBytes: 16 * 1024,
  reasonBytes: 8 * 1024,
  manualFindingsFileBytes: 64 * 1024,
  manualProvenanceFileBytes: 32 * 1024,
  provenanceFieldBytes: 2 * 1024,
  verificationFileBytes: 64 * 1024,
  verificationCommandBytes: 2 * 1024,
  verificationOutputBytes: 16 * 1024,
  verificationCommandCount: 20,
  changedPathCount: 512,
} as const;

export interface TaskBriefInput {
  objective: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
}

export function normalizeReviewDataField(
  value: string,
  options: { field: string; maxBytes: number; allowEmpty?: boolean; redact?: boolean },
): string {
  const normalized = stripUnsafeControls(value.normalize('NFC')).trim();
  const result = options.redact ? redactReviewSecrets(normalized) : normalized;
  if (!options.allowEmpty && !result) throw new Error(`${options.field} must not be blank.`);
  const bytes = Buffer.byteLength(result, 'utf8');
  if (bytes > options.maxBytes) {
    throw new Error(`${options.field} exceeds the ${options.maxBytes}-byte limit (${bytes} bytes).`);
  }
  return result;
}

export function decodeBoundedUtf8File(filePath: string, field: string, maxBytes: number): string {
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`${field} must name a regular file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`${field} exceeds the ${maxBytes}-byte limit (${stat.size} bytes).`);
  const bytes = readFileSync(filePath);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${field} is not valid UTF-8: ${filePath}`);
  }
  return decoded;
}

export function normalizeTaskBrief(input: TaskBriefInput, source: TaskBrief['source']): TaskBrief {
  const objective = normalizeReviewDataField(input.objective, {
    field: 'task brief objective',
    maxBytes: REVIEW_DATA_LIMITS.objectiveBytes,
  });
  const constraints = normalizeStringList(input.constraints ?? [], {
    field: 'task brief constraint',
    maxItems: 50,
    maxBytes: REVIEW_DATA_LIMITS.constraintBytes,
  });
  const acceptanceCriteria = normalizeStringList(input.acceptanceCriteria ?? [], {
    field: 'task brief acceptance criterion',
    maxItems: 50,
    maxBytes: REVIEW_DATA_LIMITS.acceptanceCriterionBytes,
  });
  const digest = crypto.createHash('sha256').update(canonicalize({
    version: 1,
    objective,
    constraints,
    acceptanceCriteria,
  })).digest('hex');
  return { objective, constraints, acceptanceCriteria, source, digest };
}

export function readTaskBriefFile(filePath: string, source: TaskBrief['source']): TaskBrief {
  const text = decodeBoundedUtf8File(filePath, '--brief-file', REVIEW_DATA_LIMITS.briefFileBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--brief-file must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--brief-file must contain an object with objective, constraints, and acceptanceCriteria.');
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.objective !== 'string') throw new Error('--brief-file objective must be a string.');
  if (raw.constraints !== undefined && (!Array.isArray(raw.constraints) || !raw.constraints.every((entry) => typeof entry === 'string'))) {
    throw new Error('--brief-file constraints must be an array of strings.');
  }
  if (raw.acceptanceCriteria !== undefined && (!Array.isArray(raw.acceptanceCriteria) || !raw.acceptanceCriteria.every((entry) => typeof entry === 'string'))) {
    throw new Error('--brief-file acceptanceCriteria must be an array of strings.');
  }
  const allowed = new Set(['objective', 'constraints', 'acceptanceCriteria']);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`--brief-file contains unknown field(s): ${unknown.join(', ')}.`);
  return normalizeTaskBrief({
    objective: raw.objective,
    constraints: raw.constraints as string[] | undefined,
    acceptanceCriteria: raw.acceptanceCriteria as string[] | undefined,
  }, source);
}

export function taskBriefFromFlags(
  brief: string,
  briefFile: string,
  source: TaskBrief['source'],
): TaskBrief | undefined {
  if (brief.trim() && briefFile.trim()) throw new Error('--brief and --brief-file are mutually exclusive.');
  if (briefFile.trim()) return readTaskBriefFile(briefFile.trim(), source);
  if (brief.trim()) return normalizeTaskBrief({ objective: brief }, source);
  return undefined;
}

export function delimitUntrustedReviewData(label: string, value: string): string {
  const normalizedLabel = label.toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  const digest = crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
  return [
    `<<<PIPELANE_DATA_${normalizedLabel}_${digest}`,
    value,
    `PIPELANE_DATA_${normalizedLabel}_${digest}>>>`,
  ].join('\n');
}

export function redactReviewSecrets(value: string): string {
  return value
    .replace(/([?&](?:token|key|secret|password|pass|auth|session|cookie)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED_AUTH_HEADER]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)=("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2=[REDACTED]')
    .replace(/(^|\s)(--(?:token|key|secret|password|pass|auth|session|cookie|api-key|access-key)(?:[-_][a-z0-9]+)?)\s+("[^"]*"|'[^']*'|[^\s]+)/gi, '$1$2 [REDACTED]')
    .replace(/\b((?:token|key|secret|password|pass|session|cookie|api[_-]?key|access[_-]?key)\s*:\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|SESSION|API_KEY|ACCESS_KEY)[A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s]+)/gi, (match) => {
      const key = match.split('=')[0];
      return `${key}=[REDACTED]`;
    });
}

export function terminalReviewData(value: string): string {
  return sanitizeForTerminal(stripUnsafeControls(value));
}

function normalizeStringList(
  values: string[],
  options: { field: string; maxItems: number; maxBytes: number },
): string[] {
  if (values.length > options.maxItems) throw new Error(`${options.field} count exceeds ${options.maxItems}.`);
  return values.map((value, index) => normalizeReviewDataField(value, {
    field: `${options.field} ${index + 1}`,
    maxBytes: options.maxBytes,
  }));
}

function stripUnsafeControls(value: string): string {
  return sanitizeForTerminal(value).replace(/\r\n?/g, '\n');
}
