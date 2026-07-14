import crypto from 'node:crypto';

import {
  REVIEW_DATA_LIMITS,
  decodeBoundedUtf8File,
  normalizeReviewDataField,
} from './review-data.ts';
import type {
  ReviewFinding,
  ReviewManualExecutionProvenance,
} from './state.ts';

export interface ManualReviewInput {
  report: string;
  findings: ReviewFinding[];
  provenance: ReviewManualExecutionProvenance;
}

export function readManualReviewInput(options: {
  status: 'passed' | 'failed';
  reportFile: string;
  findingsFile: string;
  provenanceFile: string;
}): ManualReviewInput {
  const report = normalizeReviewDataField(
    decodeBoundedUtf8File(options.reportFile, '--report-file', REVIEW_DATA_LIMITS.reportBytes),
    { field: 'manual review report', maxBytes: REVIEW_DATA_LIMITS.reportBytes, redact: true },
  );
  const findings = readManualFindings(options.findingsFile);
  if (options.status === 'passed' && findings.some((finding) => finding.severity === 'critical' || finding.severity === 'warning')) {
    throw new Error('review attest --status passed cannot include critical or warning findings; record failed evidence instead.');
  }
  const provenance = readManualProvenance(options.provenanceFile);
  if (options.status === 'passed' && provenance.exitCode !== 0) {
    throw new Error('review attest --status passed requires manual execution provenance with exitCode 0; record failed evidence instead.');
  }
  return {
    report,
    findings,
    provenance,
  };
}

function readManualFindings(filePath: string): ReviewFinding[] {
  const parsed = parseJsonFile(filePath, '--findings-file', REVIEW_DATA_LIMITS.manualFindingsFileBytes);
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : null;
  if (!values) throw new Error('--findings-file must contain a JSON array or an object with a findings array.');
  if (values.length > REVIEW_DATA_LIMITS.findingCount) {
    throw new Error(`--findings-file exceeds the ${REVIEW_DATA_LIMITS.findingCount}-finding limit.`);
  }
  return values.map((value, index): ReviewFinding => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`manual finding ${index + 1} must be an object.`);
    }
    const raw = value as Record<string, unknown>;
    const unknown = Object.keys(raw).filter((key) => !['id', 'severity', 'title', 'location'].includes(key));
    if (unknown.length > 0) throw new Error(`manual finding ${index + 1} contains unknown field(s): ${unknown.join(', ')}.`);
    if (raw.severity !== 'critical' && raw.severity !== 'warning' && raw.severity !== 'nit') {
      throw new Error(`manual finding ${index + 1} severity must be critical, warning, or nit.`);
    }
    if (typeof raw.title !== 'string') throw new Error(`manual finding ${index + 1} title must be a string.`);
    if (raw.location !== undefined && typeof raw.location !== 'string') throw new Error(`manual finding ${index + 1} location must be a string.`);
    return {
      id: `F${String(index + 1).padStart(3, '0')}`,
      severity: raw.severity,
      title: normalizeReviewDataField(raw.title, {
        field: `manual finding ${index + 1} title`,
        maxBytes: REVIEW_DATA_LIMITS.findingTitleBytes,
        redact: true,
      }),
      ...(typeof raw.location === 'string' && raw.location.trim()
        ? {
            location: normalizeReviewDataField(raw.location, {
              field: `manual finding ${index + 1} location`,
              maxBytes: REVIEW_DATA_LIMITS.findingLocationBytes,
              redact: true,
            }),
          }
        : {}),
    };
  });
}

function readManualProvenance(filePath: string): ReviewManualExecutionProvenance {
  const parsed = parseJsonFile(filePath, '--provenance-file', REVIEW_DATA_LIMITS.manualProvenanceFileBytes);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--provenance-file must contain a JSON object.');
  }
  const raw = parsed as Record<string, unknown>;
  const allowed = new Set(['source', 'command', 'exitCode', 'startedAt', 'finishedAt', 'provider', 'sessionId', 'output']);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`--provenance-file contains unknown field(s): ${unknown.join(', ')}.`);
  if (typeof raw.source !== 'string') throw new Error('--provenance-file source must be a string.');
  if (typeof raw.command !== 'string') throw new Error('--provenance-file command must be a string.');
  if (typeof raw.exitCode !== 'number' || !Number.isSafeInteger(raw.exitCode)) throw new Error('--provenance-file exitCode must be a safe integer.');
  for (const key of ['startedAt', 'finishedAt', 'provider', 'sessionId', 'output'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`--provenance-file ${key} must be a string.`);
  }
  const optionalField = (key: 'startedAt' | 'finishedAt' | 'provider' | 'sessionId'): string | undefined =>
    typeof raw[key] === 'string' && raw[key].trim()
      ? normalizeReviewDataField(raw[key], { field: `manual provenance ${key}`, maxBytes: REVIEW_DATA_LIMITS.provenanceFieldBytes, redact: true })
      : undefined;
  const output = normalizeReviewDataField(typeof raw.output === 'string' ? raw.output : '', {
    field: 'manual provenance output',
    maxBytes: REVIEW_DATA_LIMITS.diagnosticsBytes,
    allowEmpty: true,
    redact: true,
  });
  const startedAt = optionalField('startedAt');
  const finishedAt = optionalField('finishedAt');
  const provider = optionalField('provider');
  const sessionId = optionalField('sessionId');
  return {
    source: normalizeReviewDataField(raw.source, { field: 'manual provenance source', maxBytes: REVIEW_DATA_LIMITS.provenanceFieldBytes, redact: true }),
    command: normalizeReviewDataField(raw.command, { field: 'manual provenance command', maxBytes: REVIEW_DATA_LIMITS.provenanceFieldBytes, redact: true }),
    exitCode: raw.exitCode,
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(provider ? { provider } : {}),
    ...(sessionId ? { sessionId } : {}),
    outputDigest: crypto.createHash('sha256').update(output).digest('hex'),
  };
}

function parseJsonFile(filePath: string, field: string, maxBytes: number): unknown {
  const text = decodeBoundedUtf8File(filePath, field, maxBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${field} must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}
