import type { DeployConfig } from '../release-gate.ts';
import type { WorkflowConfig } from '../state.ts';

export interface CheckContext {
  repoRoot: string;
  config: WorkflowConfig;
  deployConfig: DeployConfig;
}

export interface CheckFinding {
  // Human-readable description of what is missing or wrong.
  reason: string;
  // Plugin name for attribution ("secret-manifest", "gh-required-secrets").
  plugin: string;
}

export interface CheckOutcome {
  plugin: string;
  // True when the plugin ran cleanly and all requirements are satisfied.
  ok: boolean;
  findings: CheckFinding[];
  // Populated when the plugin couldn't execute (tool missing, gh auth gone).
  // Treated like a finding — fail-closed.
  error?: string;
}

export interface Check {
  name: string;
  // Return null if the check is not configured and should not run.
  // Return a CheckOutcome when it did run (ok:true/false carries the result).
  run(context: CheckContext): Promise<CheckOutcome | null>;
}
