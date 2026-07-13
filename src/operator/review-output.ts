import type { ReviewGateRunRecord } from './state.ts';
import { sanitizeForTerminal } from './text-output.ts';

const REVIEW_GATE_RESULT_LINE = /^PIPELANE_REVIEW_GATE_RESULT=(?:passed|failed|\{.*\})\s*$/gm;

function visibleStream(value: string | undefined): string {
  return sanitizeForTerminal((value ?? '').replace(REVIEW_GATE_RESULT_LINE, '').trim());
}

export function visibleReviewGateFailureOutput(gate: ReviewGateRunRecord): string {
  if (gate.status !== 'failed' && gate.status !== 'pending') return '';
  const report = visibleStream(gate.stdoutTail);
  const diagnostics = visibleStream(gate.stderrTail);
  if (report && diagnostics) {
    return ['Report:', report, '', 'Diagnostics:', diagnostics].join('\n');
  }
  if (report) return report;
  if (diagnostics) return ['Diagnostics:', diagnostics].join('\n');
  return '';
}
