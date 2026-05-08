import { aliasCommandName, resolveWorkflowAliases, type WorkflowCommand, WORKFLOW_COMMANDS, type WorkflowConfig } from './state.ts';

export type HostInstall = 'codex' | 'claude';
export type HostInstallScope = 'repo-local' | 'machine-local';

export const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';
export const PIPELANE_DISPATCH_SKILL_NAME = 'pipelane';
export const PIPELANE_FIX_SKILL_NAME = 'pipelane-fix';
export const FIX_SKILL_NAME = 'fix';

export const MACHINE_CODEX_SKILL_MARKER_PREFIX = '<!-- pipelane:codex-global-skill:';
export const MACHINE_CLAUDE_SKILL_MARKER_PREFIX = '<!-- pipelane:claude-global-skill:';
export const REPO_CODEX_SKILL_MARKER_PREFIX = '<!-- pipelane:codex-skill:';

export type DesiredInstallEntryKind = 'workflow' | 'dispatcher' | 'bootstrap' | 'prompt';

export interface DesiredInstallEntry {
  kind: DesiredInstallEntryKind;
  name: string;
  slashAlias: string;
  body: string;
  command?: WorkflowCommand | 'pipelane';
  required: boolean;
}

export interface DesiredInstall {
  host: HostInstall;
  scope: HostInstallScope;
  entries: DesiredInstallEntry[];
  runnerScript: string;
  bootstrapScript: string;
}

export interface WorkflowSkillBodyOptions {
  host: HostInstall;
  scope: HostInstallScope;
  command: WorkflowCommand | 'pipelane';
  slashAlias: string;
  runnerPath: string;
  markerPrefix: string;
}

export interface PromptSkillBodyOptions {
  host: HostInstall;
  name: string;
  description: string;
  body: string;
  markerPrefix: string;
}

export interface BootstrapSkillBodyOptions {
  host: HostInstall;
  bootstrapScriptPath: string;
  markerPrefix: string;
}

export interface ManagedRunnerScriptOptions {
  managedRuntimeRoot: string;
  managedPipelaneBin: string;
  globalBinFallback?: string;
  hostLabel: string;
}

function hostDescription(host: HostInstall): string {
  return host === 'claude' ? 'Claude' : 'Codex';
}

function sideEffectFrontmatter(host: HostInstall): string {
  return host === 'claude' ? 'disable-model-invocation: true\n' : '';
}

export function buildSkillMarker(prefix: string, name: string): string {
  return `${prefix}${name} -->`;
}

function renderWorkflowSkillGuidance(command: WorkflowCommand | 'pipelane', slashAlias: string): string {
  if (command === 'deploy') {
    return `
## Blocked deploy follow-up behavior

When ${slashAlias} staging or ${slashAlias} prod exits blocked before starting a
deploy and the recent output or context names an exact deploy-safe path, do not
end with only a summary. If you write "The deploy-safe path is ...", make that
path actionable by presenting explicit choices and asking for confirmation:

\`\`\`text
1. Execute deploy-safe path: <exact commands>
2. Cancel
\`\`\`

Ask "Reply 1 or Y to execute, or 2 to cancel." If the user confirms, run the
listed commands in order from the required worktree(s). Do not bypass Pipelane
gates; use the normal ${slashAlias}, PR, merge, smoke, and clean commands the
path calls for. If any step is not deterministic, state the missing input and
stop before side effects.
`;
  }

  if (command !== 'new') {
    return '';
  }

  return `
## Bare invocation behavior

When the user invokes bare ${slashAlias} after describing an unstarted coding
task, infer a concise task label from the recent request and pass it as
\`--task "<task label>"\`. Do not make the user repeat a task name that is
already clear.

If recent context says the task was already implemented, do not create another
workspace. Continue in the reported worktree and use the PR flow there.

If no task context is available, ask one short question for the task
description. Only use \`--unnamed\` when the operator explicitly wants a
generated task slug.
`;
}

export function renderWorkflowSkillBody(options: WorkflowSkillBodyOptions): string {
  const skillName = aliasCommandName(options.slashAlias);
  const commandLabel = options.command === 'pipelane'
    ? 'the pipelane dispatcher'
    : `the pipelane command currently mapped to ${options.slashAlias}`;
  const runnerCommand = options.command === 'pipelane'
    ? `"${options.runnerPath}" pipelane <parsed arguments>`
    : `"${options.runnerPath}" ${options.command} <parsed arguments>`;

  return `---
name: ${skillName}
version: 1.0.0
description: Run ${commandLabel}.
allowed-tools:
  - Bash
${sideEffectFrontmatter(options.host)}---
${buildSkillMarker(options.markerPrefix, skillName)}

Run ${commandLabel}.

1. Parse any arguments that appear after the requested command invocation.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${runnerCommand}\`
4. Stream the command output directly.
5. If the output prints "Choose the action to take:", ask the user to pick one
   of the printed choices. Do not reduce it to "rerun with --yes"; when the
   user picks a runnable choice, run the matching command.
${renderWorkflowSkillGuidance(options.command, options.slashAlias)}
`;
}

export function renderPromptSkillBody(options: PromptSkillBodyOptions): string {
  return `---
name: ${options.name}
version: 1.0.0
description: ${options.description}
allowed-tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Bash
---
${buildSkillMarker(options.markerPrefix, options.name)}

${options.body}`;
}

export function renderBootstrapSkillBody(options: BootstrapSkillBodyOptions): string {
  return `---
name: ${INIT_PIPELANE_SKILL_NAME}
version: 1.0.0
description: Bootstrap the current repo with pipelane.
allowed-tools:
  - Bash
${sideEffectFrontmatter(options.host)}---
${buildSkillMarker(options.markerPrefix, INIT_PIPELANE_SKILL_NAME)}

Run the global pipelane bootstrap for this machine.

1. Parse any arguments that appear after \`/${INIT_PIPELANE_SKILL_NAME}\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Before running, tell the user: "This can write .pipelane.json, .claude/, .agents/, package.json scripts, docs, and other generated repo files. Do not run this in Rocketboard unless you intentionally want those local or committed surfaces." Ask for confirmation.
4. After the user confirms, run:
   \`${options.bootstrapScriptPath} --yes <parsed arguments>\`
5. Stream the command output directly.
6. After success, tell the user they may need to reopen ${hostDescription(options.host)} so refreshed commands and skills are visible.
`;
}

export function renderBootstrapScript(pipelaneBinPath: string): string {
  return `#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
exec "${pipelaneBinPath}" bootstrap "$@"
`;
}

export function renderManagedRunnerScript(options: ManagedRunnerScriptOptions): string {
  const globalBinFallback = options.globalBinFallback || options.managedPipelaneBin;
  return `#!/bin/sh
set -eu

command="\${1:-}"
if [ -z "$command" ]; then
  echo "usage: run-pipelane.sh <command> [args...]" >&2
  exit 64
fi
shift

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
local_bin="$repo_root/node_modules/.bin/pipelane"
managed_bin="${options.managedPipelaneBin}"
if [ ! -x "$managed_bin" ]; then
  managed_bin="${globalBinFallback}"
fi

run_pipelane() {
  bin="$1"
  shift
  subcommand="$1"
  shift

  if [ "$subcommand" = "pipelane" ]; then
    if [ "$#" -eq 0 ]; then
      echo "pipelane: use /pipelane status, /pipelane web, /pipelane board, or /pipelane update" >&2
      exit 0
    fi
    dispatcher="$1"
    shift
    case "$dispatcher" in
      web|board)
        exec "$bin" board "$@"
        ;;
      status)
        exec "$bin" run status "$@"
        ;;
      update)
        exec "$bin" update "$@"
        ;;
      help|--help|-h)
        echo "pipelane: use /pipelane status, /pipelane web, /pipelane board, or /pipelane update" >&2
        exit 0
        ;;
      *)
        echo "Unknown /pipelane mode: $dispatcher" >&2
        echo "Supported modes: status, web, board, update" >&2
        exit 64
        ;;
    esac
  fi

  exec "$bin" run "$subcommand" "$@"
}

should_use_managed_bootloader() {
  if [ ! -x "$managed_bin" ]; then
    return 1
  fi

  case "$command" in
    pipelane)
      if [ "$#" -eq 0 ]; then
        return 1
      fi
      case "$1" in
        status|web|board|update)
          return 0
          ;;
      esac
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

cd "$repo_root"

# Auto-update-capable commands enter the managed runtime first. The managed
# CLI checks whether the repo-local install is stale, updates it if needed,
# then re-execs the repo-local bin for the real command.
if should_use_managed_bootloader "$@"; then
  export PIPELANE_MANAGED_RUNTIME=1
  export PIPELANE_MANAGED_RUNTIME_ROOT="${options.managedRuntimeRoot}"
  run_pipelane "$managed_bin" "$command" "$@"
fi

if [ -x "$local_bin" ]; then
  run_pipelane "$local_bin" "$command" "$@"
fi

if [ -x "$managed_bin" ]; then
  export PIPELANE_MANAGED_RUNTIME=1
  export PIPELANE_MANAGED_RUNTIME_ROOT="${options.managedRuntimeRoot}"
  run_pipelane "$managed_bin" "$command" "$@"
fi

echo "pipelane is unavailable for this repo." >&2
echo "Checked:" >&2
echo "  - $local_bin" >&2
echo "  - ${options.managedPipelaneBin}" >&2
echo "  - ${globalBinFallback}" >&2
echo "Restore one of these runtimes and retry:" >&2
echo "  - run npm install in the repo to restore node_modules/.bin/pipelane" >&2
echo "  - reinstall ${options.hostLabel} skills to restore the managed pipelane runtime" >&2
exit 1
`;
}

export function desiredHostInstall(
  host: HostInstall,
  scope: HostInstallScope,
  config: WorkflowConfig,
  paths: {
    runnerPath: string;
    bootstrapScriptPath: string;
    managedRuntimeRoot: string;
    managedPipelaneBin: string;
    globalBinFallback?: string;
    fixPromptBody: string;
  },
): DesiredInstall {
  const aliases = resolveWorkflowAliases(config.aliases);
  const markerPrefix = host === 'claude'
    ? MACHINE_CLAUDE_SKILL_MARKER_PREFIX
    : scope === 'machine-local'
      ? MACHINE_CODEX_SKILL_MARKER_PREFIX
      : REPO_CODEX_SKILL_MARKER_PREFIX;
  const entries: DesiredInstallEntry[] = [];

  for (const command of WORKFLOW_COMMANDS) {
    const slashAlias = aliases[command];
    const name = aliasCommandName(slashAlias);
    entries.push({
      kind: 'workflow',
      name,
      slashAlias,
      command,
      required: true,
      body: renderWorkflowSkillBody({
        host,
        scope,
        command,
        slashAlias,
        runnerPath: paths.runnerPath,
        markerPrefix,
      }),
    });
  }

  entries.push({
    kind: 'dispatcher',
    name: PIPELANE_DISPATCH_SKILL_NAME,
    slashAlias: `/${PIPELANE_DISPATCH_SKILL_NAME}`,
    command: 'pipelane',
    required: true,
    body: renderWorkflowSkillBody({
      host,
      scope,
      command: 'pipelane',
      slashAlias: `/${PIPELANE_DISPATCH_SKILL_NAME}`,
      runnerPath: paths.runnerPath,
      markerPrefix,
    }),
  });

  entries.push({
    kind: 'prompt',
    name: PIPELANE_FIX_SKILL_NAME,
    slashAlias: `/${PIPELANE_FIX_SKILL_NAME}`,
    required: true,
    body: renderPromptSkillBody({
      host,
      name: PIPELANE_FIX_SKILL_NAME,
      description: 'Produce durable, root-cause fixes without running a shell wrapper.',
      body: paths.fixPromptBody,
      markerPrefix,
    }),
  });

  entries.push({
    kind: 'prompt',
    name: FIX_SKILL_NAME,
    slashAlias: `/${FIX_SKILL_NAME}`,
    required: false,
    body: renderPromptSkillBody({
      host,
      name: FIX_SKILL_NAME,
      description: 'Produce durable, root-cause fixes without running a shell wrapper.',
      body: paths.fixPromptBody,
      markerPrefix,
    }),
  });

  entries.push({
    kind: 'bootstrap',
    name: INIT_PIPELANE_SKILL_NAME,
    slashAlias: `/${INIT_PIPELANE_SKILL_NAME}`,
    required: true,
    body: renderBootstrapSkillBody({
      host,
      bootstrapScriptPath: paths.bootstrapScriptPath,
      markerPrefix,
    }),
  });

  return {
    host,
    scope,
    entries,
    runnerScript: renderManagedRunnerScript({
      managedRuntimeRoot: paths.managedRuntimeRoot,
      managedPipelaneBin: paths.managedPipelaneBin,
      globalBinFallback: paths.globalBinFallback,
      hostLabel: hostDescription(host),
    }),
    bootstrapScript: renderBootstrapScript(paths.managedPipelaneBin),
  };
}
