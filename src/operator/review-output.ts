import type {
  ReviewConsentRecord,
  ReviewFindingSeverity,
  ReviewGateRunRecord,
  ReviewRunRecord,
} from './state.ts';
import { sanitizeForTerminal } from './text-output.ts';
import { readVerifiedReviewArtifact } from './review-artifacts.ts';

const REVIEW_GATE_RESULT_LINE = /^PIPELANE_REVIEW_GATE_RESULT=(?:passed|failed|\{.*\})\s*$/gm;

export const REVIEW_FINDINGS_HEADING = 'Review findings:';

export type ReviewPresentationRelation = 'current' | 'recent' | 'embedded';
export type ReviewPresentationTextSource = 'artifact' | 'legacy-stdout' | 'legacy-stderr';

export interface ReviewFindingPresentation {
  id: string;
  severity: ReviewFindingSeverity;
  title: string;
  location: string | null;
}

export interface ReviewPresentationText {
  text: string;
  source: ReviewPresentationTextSource;
  bytes: number | null;
  truncated: boolean;
  diagnosticOnly: boolean;
}

export interface ReviewGatePresentation {
  gateId: string;
  phase: ReviewGateRunRecord['phase'];
  type: ReviewGateRunRecord['type'];
  blocking: boolean;
  status: ReviewGateRunRecord['status'];
  summary: string;
  counts: {
    critical: number;
    warning: number;
    nit: number;
    blocking: number;
    advisory: number;
    total: number;
  };
  findings: ReviewFindingPresentation[];
  report: ReviewPresentationText | null;
  diagnostics: ReviewPresentationText | null;
  protocolErrors: string[];
  evidenceKind: 'automatic' | 'manual-attestation' | 'manual-approval';
  manualAttestation: null | {
    status: 'passed' | 'failed';
    message: string;
    source: string;
    command: string;
    exitCode: number;
    substitutionRequested: boolean;
  };
  result: null | {
    protocolVersion: number;
    declaredStatus: 'passed' | 'failed';
    effectiveStatus: 'passed' | 'failed';
    blockingCount: number;
    advisoryCount: number;
    findingsKnown: boolean;
    providerExitCode: number | null;
    adapterExitCode: number;
  };
}

export interface ReviewRunPresentation {
  schemaVersion: 1;
  relation: ReviewPresentationRelation;
  runId: string;
  status: ReviewRunRecord['status'];
  branchName: string;
  sha: string;
  targetDigest: string | null;
  enforcementMode: ReviewRunRecord['enforcementMode'] | null;
  policyVersion: number | null;
  counts: {
    gates: {
      total: number;
      passed: number;
      failed: number;
      pending: number;
      skipped: number;
    };
    findings: {
      critical: number;
      warning: number;
      nit: number;
      blocking: number;
      advisory: number;
      total: number;
    };
    protocolErrors: number;
  };
  gates: ReviewGatePresentation[];
  authorizations: Array<{
    id: string;
    kind: ReviewConsentRecord['kind'];
    gateId: string;
    label: 'bypassed by user' | 'findings accepted' | 'manual review substituted';
    reason: string;
    routeAction: string;
    recordedAt: string;
  }>;
  nextAction: null | {
    kind: 'repair-rerun' | 'complete-rerun' | 'continue';
    summary: string;
    command: string;
  };
}

export interface ProjectReviewRunOptions {
  artifactRoot?: string;
  relation?: ReviewPresentationRelation;
  includeReportText?: boolean;
  consents?: ReviewConsentRecord[];
}

export interface RenderReviewPresentationOptions {
  gateIds?: Iterable<string>;
  includePassed?: boolean;
  includeGateHeader?: boolean;
  indent?: string;
}

function visibleStream(value: string | undefined): string {
  return sanitizeForTerminal((value ?? '').replace(REVIEW_GATE_RESULT_LINE, '').trim());
}

function visible(value: string | undefined | null): string {
  return sanitizeForTerminal(value ?? '');
}

function findingCounts(findings: ReviewFindingPresentation[]): ReviewGatePresentation['counts'] {
  const critical = findings.filter((finding) => finding.severity === 'critical').length;
  const warning = findings.filter((finding) => finding.severity === 'warning').length;
  const nit = findings.filter((finding) => finding.severity === 'nit').length;
  return {
    critical,
    warning,
    nit,
    blocking: critical + warning,
    advisory: nit,
    total: findings.length,
  };
}

function legacyPresentationText(
  text: string,
  source: Extract<ReviewPresentationTextSource, 'legacy-stdout' | 'legacy-stderr'>,
): ReviewPresentationText | null {
  if (!text) return null;
  return {
    text,
    source,
    bytes: null,
    truncated: false,
    diagnosticOnly: false,
  };
}

export function projectReviewGate(
  gate: ReviewGateRunRecord,
  artifactRoot?: string,
  includeReportText = true,
): ReviewGatePresentation {
  const findings = (gate.findings ?? []).map((finding) => ({
    id: visible(finding.id),
    severity: finding.severity,
    title: visible(finding.title),
    location: finding.location ? visible(finding.location) : null,
  }));
  let report = includeReportText ? legacyPresentationText(visibleStream(gate.stdoutTail), 'legacy-stdout') : null;
  let diagnostics = includeReportText ? legacyPresentationText(visibleStream(gate.stderrTail), 'legacy-stderr') : null;
  const protocolErrors = [
    gate.errorCode || gate.errorMessage
      ? [visible(gate.errorCode), visible(gate.errorMessage)].filter(Boolean).join(': ')
      : '',
  ].filter(Boolean);

  if (includeReportText && artifactRoot && gate.reportArtifact) {
    try {
      const artifact = readVerifiedReviewArtifact(artifactRoot, gate.reportArtifact);
      const artifactReport = visibleStream(artifact.report);
      const artifactDiagnostics = visibleStream(artifact.diagnostics);
      report = artifactReport
        ? {
            text: artifactReport,
            source: 'artifact',
            bytes: gate.reportArtifact.reportBytes,
            truncated: gate.reportArtifact.reportTruncated,
            diagnosticOnly: gate.reportArtifact.diagnosticOnly === true,
          }
        : null;
      diagnostics = artifactDiagnostics
        ? {
            text: artifactDiagnostics,
            source: 'artifact',
            bytes: gate.reportArtifact.diagnosticsBytes,
            truncated: gate.reportArtifact.diagnosticsTruncated,
            diagnosticOnly: gate.reportArtifact.diagnosticOnly === true,
          }
        : null;
    } catch (error) {
      protocolErrors.push(`Artifact integrity: ${visible(error instanceof Error ? error.message : String(error))}`);
    }
  }

  return {
    gateId: visible(gate.gateId),
    phase: gate.phase,
    type: gate.type,
    blocking: gate.blocking,
    status: gate.status,
    summary: visible(gate.summary),
    counts: findingCounts(findings),
    findings,
    report,
    diagnostics,
    protocolErrors,
    evidenceKind: gate.manualAttestation
      ? 'manual-attestation'
      : gate.type === 'approval'
        ? 'manual-approval'
        : 'automatic',
    manualAttestation: gate.manualAttestation
      ? {
          status: gate.manualAttestation.status,
          message: visible(gate.manualAttestation.message),
          source: visible(gate.manualAttestation.provenance.source),
          command: visible(gate.manualAttestation.provenance.command),
          exitCode: gate.manualAttestation.provenance.exitCode,
          substitutionRequested: gate.manualAttestation.substitutionRequested,
        }
      : null,
    result: gate.result
      ? {
          protocolVersion: gate.result.protocolVersion,
          declaredStatus: gate.result.declaredStatus,
          effectiveStatus: gate.result.effectiveStatus,
          blockingCount: gate.result.blockingCount,
          advisoryCount: gate.result.advisoryCount,
          findingsKnown: gate.result.findingsKnown,
          providerExitCode: gate.result.providerExitCode ?? null,
          adapterExitCode: gate.result.adapterExitCode,
        }
      : null,
  };
}

export function projectReviewRun(
  record: ReviewRunRecord,
  options: ProjectReviewRunOptions = {},
): ReviewRunPresentation {
  const includeReportText = options.includeReportText ?? (options.relation !== 'recent');
  const gates = record.gates.map((gate) => projectReviewGate(gate, options.artifactRoot, includeReportText));
  const gateCounts = {
    total: gates.length,
    passed: gates.filter((gate) => gate.status === 'passed').length,
    failed: gates.filter((gate) => gate.status === 'failed').length,
    pending: gates.filter((gate) => gate.status === 'pending').length,
    skipped: gates.filter((gate) => gate.status === 'skipped').length,
  };
  const findingTotals = findingCounts(gates.flatMap((gate) => gate.findings));
  const relation = options.relation ?? 'embedded';
  const authorizations = (options.consents ?? []).map((consent) => ({
    id: visible(consent.id),
    kind: consent.kind,
    gateId: visible(consent.gateId),
    label: consent.kind === 'manual-substitution'
      ? 'manual review substituted' as const
      : consent.kind === 'accept-findings'
        ? 'findings accepted' as const
        : 'bypassed by user' as const,
    reason: visible(consent.reason),
    routeAction: visible(consent.routeAction),
    recordedAt: visible(consent.recordedAt),
  }));
  const nextAction = relation === 'recent'
    ? null
    : record.status === 'failed'
    ? {
        kind: 'repair-rerun' as const,
        summary: 'Repair every blocking finding or evidence error, then rerun review.',
        command: '/pipelane review',
      }
    : record.status === 'pending'
      ? {
          kind: 'complete-rerun' as const,
          summary: 'Complete pending evidence, then rerun review.',
          command: '/pipelane review',
        }
      : {
          kind: 'continue' as const,
          summary: 'Review evidence passed; continue to PR when ready.',
          command: '/pr',
        };
  return {
    schemaVersion: 1,
    relation,
    runId: visible(record.id),
    status: record.status,
    branchName: visible(record.branchName),
    sha: visible(record.sha),
    targetDigest: record.target?.targetDigest ? visible(record.target.targetDigest) : null,
    enforcementMode: record.enforcementMode ?? null,
    policyVersion: record.policyVersion ?? null,
    counts: {
      gates: gateCounts,
      findings: findingTotals,
      protocolErrors: gates.reduce((count, gate) => count + gate.protocolErrors.length, 0),
    },
    gates,
    authorizations,
    nextAction,
  };
}

function renderFinding(finding: ReviewFindingPresentation): string {
  return `- ${finding.id} [${finding.severity}] ${finding.title}${finding.location ? ` (${finding.location})` : ''}`;
}

export function renderReviewGatePresentation(
  gate: ReviewGatePresentation,
  options: Pick<RenderReviewPresentationOptions, 'includeGateHeader' | 'indent'> = {},
): string[] {
  const indent = options.indent ?? '';
  const lines: string[] = [];
  if (options.includeGateHeader !== false) {
    lines.push(`${indent}- ${gate.gateId} [${gate.phase}] ${gate.status.toUpperCase()} (${gate.blocking ? 'blocking' : 'non-blocking'}) - ${gate.summary}`);
  }
  const contentIndent = options.includeGateHeader === false ? indent : `${indent}  `;
  if (gate.manualAttestation) {
    lines.push(`${contentIndent}Evidence: MANUAL ATTESTATION (${gate.manualAttestation.status}); automatic capability was not claimed.`);
    lines.push(`${contentIndent}Provenance: ${gate.manualAttestation.source}; command=${gate.manualAttestation.command}; exit=${gate.manualAttestation.exitCode}`);
  }
  if (gate.findings.length > 0) {
    lines.push(`${contentIndent}Findings (${gate.counts.blocking} blocking, ${gate.counts.advisory} advisory):`);
    lines.push(...gate.findings.map((finding) => `${contentIndent}  ${renderFinding(finding)}`));
  }
  if (gate.report) {
    const suffix = gate.report.truncated ? ' (truncated at the persisted evidence limit)' : '';
    lines.push(`${contentIndent}Report${suffix}:`);
    lines.push(...gate.report.text.split('\n').map((line) => `${contentIndent}  ${line}`));
  }
  if (gate.diagnostics) {
    const suffix = gate.diagnostics.truncated ? ' (truncated at the persisted evidence limit)' : '';
    lines.push(`${contentIndent}Diagnostics${suffix}:`);
    lines.push(...gate.diagnostics.text.split('\n').map((line) => `${contentIndent}  ${line}`));
  }
  if (gate.protocolErrors.length > 0) {
    lines.push(`${contentIndent}Protocol errors:`);
    lines.push(...gate.protocolErrors.map((error) => `${contentIndent}  - ${error}`));
  }
  return lines;
}

export function renderReviewPresentation(
  presentation: ReviewRunPresentation,
  options: RenderReviewPresentationOptions = {},
): string[] {
  const gateIds = options.gateIds ? new Set(options.gateIds) : null;
  const gates = presentation.gates.filter((gate) =>
    (!gateIds || gateIds.has(gate.gateId))
    && (
      options.includePassed === true
      || gate.status === 'failed'
      || gate.status === 'pending'
      || gate.manualAttestation !== null
      || gate.findings.length > 0
      || gate.protocolErrors.length > 0
    )
  );
  const authorizations = presentation.authorizations.flatMap((authorization) => [
    `- ${authorization.label.toUpperCase()} for ${authorization.gateId} and ${authorization.routeAction}: ${authorization.reason}`,
    ...(authorization.kind === 'manual-substitution'
      ? ['  Underlying capability remains manual-attestation, not automatic strict review.']
      : []),
  ]);
  return [
    ...(authorizations.length > 0 ? ['Review authorizations:', ...authorizations] : []),
    ...gates.flatMap((gate) => renderReviewGatePresentation(gate, options)),
  ];
}

export function visibleReviewGateFailureOutput(gate: ReviewGateRunRecord, artifactRoot?: string): string {
  if (gate.status !== 'failed' && gate.status !== 'pending') return '';
  return renderReviewGatePresentation(projectReviewGate(gate, artifactRoot), {
    includeGateHeader: false,
  }).join('\n');
}
