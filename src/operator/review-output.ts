import type { ReviewGateRunRecord } from './state.ts';
import { sanitizeForTerminal } from './text-output.ts';
import { readVerifiedReviewArtifact } from './review-artifacts.ts';

const REVIEW_GATE_RESULT_LINE = /^PIPELANE_REVIEW_GATE_RESULT=(?:passed|failed|\{.*\})\s*$/gm;

function visibleStream(value: string | undefined): string {
  return sanitizeForTerminal((value ?? '').replace(REVIEW_GATE_RESULT_LINE, '').trim());
}

export function visibleReviewGateFailureOutput(gate: ReviewGateRunRecord, artifactRoot?: string): string {
  if (gate.status !== 'failed' && gate.status !== 'pending') return '';
  const findings = (gate.findings ?? []).map((finding) =>
    `- ${sanitizeForTerminal(finding.id)} [${sanitizeForTerminal(finding.severity)}] ${sanitizeForTerminal(finding.title)}${finding.location ? ` (${sanitizeForTerminal(finding.location)})` : ''}`
  );
  let report = visibleStream(gate.stdoutTail);
  let diagnostics = visibleStream(gate.stderrTail);
  if (artifactRoot && gate.reportArtifact) {
    try {
      const artifact = readVerifiedReviewArtifact(artifactRoot, gate.reportArtifact);
      report = visibleStream(artifact.report);
      diagnostics = visibleStream(artifact.diagnostics);
    } catch (error) {
      diagnostics = [diagnostics, `Artifact integrity: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('\n');
    }
  }
  const sections: string[] = [];
  if (findings.length > 0) sections.push('Findings:', ...findings);
  if (report) sections.push(...(sections.length > 0 ? [''] : []), 'Report:', report);
  if (diagnostics) sections.push(...(sections.length > 0 ? [''] : []), 'Diagnostics:', diagnostics);
  return sections.join('\n');
}
