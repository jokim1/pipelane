export interface BootstrapOptions {
  projectName?: string;
  yes?: boolean;
}

export interface BootstrapResult {
  repoRoot: string;
  displayName: string;
  installedPackage: boolean;
  initializedRepo: boolean;
  createdClaude: boolean;
  skippedClaudeScaffold: boolean;
  codexSkillsDir: string;
  installedCodexSkills: string[];
  warnings: string[];
}

const UNSUPPORTED_BOOTSTRAP_MESSAGE =
  'pipelane bootstrap is no longer supported. Use `pipelane install-codex` or `pipelane install-claude` once per machine, then run `pipelane setup` in the repo.';

export function parseBootstrapArgs(argv: string[]): BootstrapOptions {
  void argv;
  throw new Error(UNSUPPORTED_BOOTSTRAP_MESSAGE);
}

export function runBootstrap(cwd: string, options: BootstrapOptions): BootstrapResult {
  void cwd;
  void options;
  throw new Error(UNSUPPORTED_BOOTSTRAP_MESSAGE);
}
