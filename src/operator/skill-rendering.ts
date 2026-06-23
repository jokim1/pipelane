import { aliasCommandName, MANAGED_WORKFLOW_COMMANDS, resolveWorkflowAliases, type WorkflowCommand, type WorkflowConfig } from './state.ts';

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
  if (command === 'pipelane') {
    return `
## Setup and configure behavior

Treat \`${slashAlias} setup\` as the normal repo setup path and
\`${slashAlias} configure\` as the normal deploy configuration path. Do not ask
the user to run \`! pipelane configure\` in a terminal; the durable runner knows
where the managed pipelane runtime is even when \`pipelane\` is not on PATH.

Plain \`${slashAlias} setup\` configures the repo-wide Pipelane files. Plain
\`${slashAlias} review setup\` configures the pre-PR review gates. Keep those
two setup flows distinct.

When \`${slashAlias} configure\` prints "Choose the action to take:", ask the
user for the deploy values in chat, then run the matching
\`${slashAlias} configure --json ...\` command with the provided flags.

## Help behavior

Bare \`${slashAlias}\`, \`${slashAlias} help\`, and \`${slashAlias} --help\`
print the dispatcher command reference. Use that output when the user asks what
Pipelane can do instead of guessing from memory.

## Interactive review setup behavior

Agent Bash tools commonly run commands without an interactive TTY, and shell
pipes make stdout non-TTY. When the user invokes bare
\`${slashAlias} review setup\` with no flags, run the setup command directly
through the runner command above. The CLI prints a non-interactive selector
with gate numbers, installable gaps, and exact follow-up commands.

Relay the selectable gates to the user, especially the AI review gates
\`karpathy-diff\`, \`gstack-review\`, and \`adversarial-review\`. When the user
chooses gates, run the matching deterministic command exactly:

- \`review setup --yes\` to save the current recommended selection.
- \`review setup --enable <gate-id>\` to enable an available gate.
- \`review setup --disable <gate-id>\` to disable a preselected gate.
- \`review setup --install <gate-id>\` to install and enable an optional gate
  such as \`lint\` or \`adversarial-review\`.
- \`review setup --list-gates\` to inspect the full catalog.
- \`review setup --print\` to print the effective config.

If the user supplied any setup flag, run the command directly through the
runner. Do not add shell pipes to setup commands that may need interactivity.

## Orchestration behavior (${slashAlias} orchestrate <plan-file>)

When the first token is \`orchestrate\` and a plan file (or a goal to implement) is
given, do NOT just run \`--yes\` and wait silently. Drive a communicative,
slice-by-slice flow and keep the operator oriented at every step:

1. Read the plan file yourself. Print **Plan read** as bullets: strengths, then
   risks/gaps. Then print a **coverage map** that accounts for every section of the
   plan as one of: in-scope (maps to a slice), deferred, or excluded (with a
   one-line reason). Nothing is silently dropped.
2. Decompose the plan into phases and slices. Write a JSON file to a scratch path:
   \`{ "slices": [ { "id", "title", "phase", "text" } ], "coverage": [ { "section", "disposition": "slice|deferred|excluded", "sliceId", "reason" } ] }\`
   then compile it WITHOUT starting workers and capture the run id:
   \`${slashAlias} orchestrate plan --plan-file <real-plan> --slices-file <scratch.json> --json\`
   The run's audit source stays bound to the real plan file, not the scratch file.
3. Relay the CLI outline verbatim (do not hand-format it):
   \`${slashAlias} orchestrate outline --run-id <id>\`
   Then print the **review model** as bullets: static checks, tests, independent AI
   review of each slice diff, and human confirm on sensitive slices.
4. **Recommend a scope**: the full plan, or a justified partial boundary (e.g. land
   a sensitive schema/RLS phase first because everything depends on it). Offer:
   approve / edit scope / cancel. For a partial scope run
   \`${slashAlias} orchestrate scope --run-id <id> --through <last-slice-id-in-scope>\`.
5. On approval, drive in order: \`${slashAlias} orchestrate prepare --run-id <id>\`,
   then \`${slashAlias} orchestrate dispatch --run-id <id>\`, then for each in-scope
   slice \`${slashAlias} orchestrate start --run-id <id> --slice-id <id>\` followed by
   \`${slashAlias} orchestrate review --run-id <id> --slice-id <id>\`. After EACH
   slice, relay \`${slashAlias} orchestrate outline --run-id <id>\` so the operator
   sees the updated outline and where the run is. Never use \`--yes\` on this path.
6. When the in-scope slices pass: if the outline shows deferred slices, tell the
   operator the run is paused and a later \`${slashAlias} orchestrate\` resumes it
   (re-scope with \`--through <next>\`, then continue). Use
   \`${slashAlias} orchestrate finalize --run-id <id>\` only to deliberately abandon
   the deferred remainder (it is kept in the ledger with a reason for audit).

If the plan compiles to a single unstructured slice, say so and propose a
phase/slice breakdown before running one long opaque slice.
`;
  }

  if (command === 'deploy') {
    return `
## PR shorthand behavior

When the user writes \`PR #625\`, \`PR 625\`, or \`#625\` as the target PR,
pass it as \`--pr 625\`. Do not pass a raw unquoted \`#625\` token to a shell;
\`#\` starts a shell comment before Pipelane can parse it.

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
gates; use the normal ${slashAlias}, PR, merge, deploy, and clean commands the
path calls for. If any step is not deterministic, state the missing input and
stop before side effects.
	`;
  }

  if (command === 'merge') {
    return `
## PR shorthand behavior

When the user writes \`PR #625\`, \`PR 625\`, or \`#625\` as the target PR,
pass it as \`--pr 625\`. Do not pass a raw unquoted \`#625\` token to a shell;
\`#\` starts a shell comment before Pipelane can parse it.
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
3. Before running, tell the user: "This can write .pipelane.json, .claude/, .agents/, package.json scripts, docs, and other generated repo files. Do not run this in public, open-source, or otherwise clean repos unless you intentionally want those local or committed surfaces." Ask for confirmation.
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

print_pipelane_help() {
  cat <<'PIPELANE_HELP'
Pipelane dispatcher

Usage:
  /pipelane <command> [args...]
  /pipelane help

Setup and maintenance:
  /pipelane setup [--yes]
      Sync or repair repo-local Pipelane files: generated commands, Codex
      skills, docs, package scripts, and local guidance scaffolds.

  /pipelane configure [--json] [flags...]
      Fill or update Deploy Configuration values such as staging/prod URLs,
      deploy workflow names, healthchecks, edge/sql commands, and Supabase refs.

  /pipelane update [--check] [--yes] [--json]
      Check or update the repo-local Pipelane install used by slash commands.

Status and UI:
  /pipelane status [--json]
      Show the current lane state and next recommended action.

  /pipelane board [status|stop] [--port <port>] [--no-open]
      Open, inspect, or stop the local Pipelane board.

  /pipelane web [status|stop] [--port <port>] [--no-open]
      Alias for /pipelane board.

Review gates:
  /pipelane review [--dry-run] [--gate <id>] [--phase <phase>]
      Run configured review gates and write evidence for the current diff.

  /pipelane review setup [--yes] [--print] [--list-gates]
                         [--enable <gate>] [--disable <gate>] [--install <gate>]
      Configure pre-PR review gates. This is different from /pipelane setup,
      which configures repo-wide Pipelane files.

Orchestration:
  /pipelane orchestrate --plan-file <file> --yes
      Plan, prepare, dispatch, start, and review a multi-slice implementation.

  /pipelane orchestrate plan|prepare|dispatch|start|review
      Run one orchestration phase at a time.

  /pipelane orchestrate goal-spec [--plan-file <file>] [--slice-id <id>]
      Draft a provider-neutral implementation goal spec.

Common companion slash commands after setup:
  /new, /resume, /repo-guard, /pr, /merge, /deploy, /clean, /doctor,
  /rollback

Tip:
  Use /pipelane setup as the guided first-run repair flow. Use
  /pipelane configure later when only deploy values need to change.
PIPELANE_HELP
}

run_pipelane() {
  bin="$1"
  shift
  subcommand="$1"
  shift

  if [ "$subcommand" = "pipelane" ]; then
    if [ "$#" -eq 0 ]; then
      print_pipelane_help
      exit 0
    fi
    dispatcher="$1"
    shift
    case "$dispatcher" in
      setup)
        exec "$bin" setup "$@"
        ;;
      configure)
        exec "$bin" configure "$@"
        ;;
      web|board)
        exec "$bin" board "$@"
        ;;
      status)
        exec "$bin" run status "$@"
        ;;
      review)
        exec "$bin" run review "$@"
        ;;
      orchestrate)
        exec "$bin" run orchestrate "$@"
        ;;
      update)
        exec "$bin" update "$@"
        ;;
      help|--help|-h)
        print_pipelane_help
        exit 0
        ;;
      *)
        echo "Unknown /pipelane mode: $dispatcher" >&2
        echo "" >&2
        print_pipelane_help >&2
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
        setup|configure|status|review|orchestrate|web|board|update|help|--help|-h)
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

  for (const command of MANAGED_WORKFLOW_COMMANDS) {
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
