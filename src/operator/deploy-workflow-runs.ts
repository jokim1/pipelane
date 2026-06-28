import { runCommandCapture, type DeployRecord } from './state.ts';

export interface CompletedDeployWorkflowRun {
  ok: boolean;
  status: string;
  conclusion: string;
  url?: string;
}

export function observeCompletedDeployWorkflowRun(
  repoRoot: string,
  record: DeployRecord,
): CompletedDeployWorkflowRun | null {
  const runId = record.workflowRunId?.trim();
  if (!runId) return null;

  const output = runCommandCapture('gh', [
    'run',
    'view',
    runId,
    '--json',
    'status,conclusion,url',
  ], { cwd: repoRoot });
  if (!output.ok || !output.stdout) return null;

  try {
    const parsed = JSON.parse(output.stdout) as {
      status?: unknown;
      conclusion?: unknown;
      url?: unknown;
    };
    const status = typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
    if (status !== 'completed') return null;
    const conclusion = typeof parsed.conclusion === 'string' ? parsed.conclusion.toLowerCase() : '';
    const url = typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url.trim() : undefined;
    return {
      ok: conclusion === 'success',
      status,
      conclusion: conclusion || 'unknown',
      url,
    };
  } catch {
    return null;
  }
}

export function describeCompletedDeployWorkflowRun(run: CompletedDeployWorkflowRun): string {
  return run.ok
    ? 'workflow run completed successfully'
    : `workflow run completed with conclusion "${run.conclusion}"`;
}
