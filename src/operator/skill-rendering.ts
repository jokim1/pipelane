import { aliasCommandName, MANAGED_WORKFLOW_COMMANDS, resolveWorkflowAliases, type WorkflowCommand, type WorkflowConfig } from './state.ts';

export type HostInstall = 'codex' | 'claude';
export type HostInstallScope = 'repo-local' | 'machine-local';

export const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';
export const PIPELANE_DISPATCH_SKILL_NAME = 'pipelane';
export const PIPELANE_FIX_SKILL_NAME = 'pipelane-fix';
export const FIX_SKILL_NAME = 'fix';
export const LESSON_SKILL_NAME = 'lesson';
export const ORCHESTRATE_SKILL_NAME = 'orchestrate';

export const MACHINE_CODEX_SKILL_MARKER_PREFIX = '<!-- pipelane:codex-global-skill:';
export const MACHINE_CLAUDE_SKILL_MARKER_PREFIX = '<!-- pipelane:claude-global-skill:';
export const REPO_CODEX_SKILL_MARKER_PREFIX = '<!-- pipelane:codex-skill:';

export type DesiredInstallEntryKind = 'workflow' | 'dispatcher' | 'prompt';

export interface DesiredInstallEntry {
  kind: DesiredInstallEntryKind;
  name: string;
  slashAlias: string;
  body: string;
  command?: WorkflowCommand | 'pipelane' | 'orchestrate';
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
  command: WorkflowCommand | 'pipelane' | 'orchestrate';
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

function renderOrchestrationGuidance(invocation: string, trigger: string): string {
  return `## Orchestration behavior (${invocation} <plan-file>)

${trigger}, do NOT just run \`--yes\` and wait silently. Drive a communicative,
slice-by-slice flow and keep the operator oriented at every step:

1. Read the plan file yourself. Print **Plan read** as bullets: strengths, then
   risks/gaps. Then print a **coverage map** that accounts for every section of the
   plan as one of: in-scope (maps to a slice), deferred, or excluded (with a
   one-line reason). Nothing is silently dropped.
2. Decompose the plan into phases and slices. Write a slices JSON file to a scratch path:
   \`{ "slices": [ { "id", "title", "phase", "text" } ], "coverage": [ { "section", "disposition": "slice|deferred|excluded", "sliceId", "reason" } ] }\`
   Then write an analysis JSON file with the real plan file's SHA-256 as \`sourceSha256\`,
   your analyzer identity, \`identityReliable\`, strengths, risks, ambiguities,
   sensitiveAreas, and recommendedScope. Record analysis WITHOUT starting workers
   and capture the run id:
   \`${invocation} analyze --plan-file <real-plan> --analysis-file <analysis.json> --slices-file <scratch.json> --json\`
   The run's audit source stays bound to the real plan file, not either scratch file.
3. Relay the CLI outline verbatim (do not hand-format it):
   \`${invocation} outline --run-id <id>\`
   Then print the **review model** as bullets: static checks, tests, independent AI
   review of each slice diff, and human confirm on sensitive slices.
4. **Recommend a scope**: the full plan, or a justified partial boundary (e.g. land
   a sensitive schema/RLS phase first because everything depends on it). Offer:
   approve / edit scope / cancel. For a partial scope run
   \`${invocation} scope --run-id <id> --through <last-slice-id-in-scope>\`.
5. Before prepare, complete every pending plan-review gate: run the configured
   reviewer, then record \`${invocation} plan-review pass --run-id <id> --gate <gate-id> --message <summary>\`
   or consciously bypass with \`${invocation} plan-review bypass --run-id <id> --gate <gate-id> --reason <reason>\`.
   Then drive in order: \`${invocation} prepare --run-id <id>\`,
   then \`${invocation} dispatch --run-id <id>\`, then for each in-scope
   slice \`${invocation} start --run-id <id> --slice-id <id>\` followed by
   \`${invocation} review --run-id <id> --slice-id <id>\`. After EACH
   slice, relay \`${invocation} outline --run-id <id>\` so the operator
   sees the updated outline and where the run is. Never use \`--yes\` on this path.
6. When the in-scope slices pass: if the outline shows deferred slices, tell the
   operator the run is paused and a later \`${invocation}\` resumes it
   (re-scope with \`--through <next>\`, then continue). Use
   \`${invocation} finalize --run-id <id>\` only to deliberately abandon
   the deferred remainder (it is kept in the ledger with a reason for audit).

If the plan compiles to a single unstructured slice, say so and propose a
phase/slice breakdown before running one long opaque slice.`;
}

function renderWorkflowSkillGuidance(command: WorkflowCommand | 'pipelane' | 'orchestrate', slashAlias: string): string {
  if (command === 'orchestrate') {
    return `${renderOrchestrationGuidance(slashAlias, `When you invoke \`${slashAlias}\` with a plan file (or a goal to implement)`)}

## Argument handling

If the argument looks like a path (it contains \`/\` or ends in \`.md\`) but no
such file exists, stop and report "plan file not found" instead of treating it as
a goal to implement. Forward any extra flags (e.g. \`--provider\`, \`--max-minutes\`)
as separate tokens; never fold them into the plan-file path.`;
  }
  if (command === 'pipelane') {
    return `
## Setup and configure behavior

Treat \`${slashAlias} setup\` as the normal clean repo setup and repair path and
\`${slashAlias} configure\` as the normal deploy configuration path. Do not ask
the user to run \`! pipelane configure\` in a terminal; the durable runner knows
where the managed pipelane runtime is even when \`pipelane\` is not on PATH.
Do not substitute repo-local npm scripts or repo-local binaries for
setup/task-start flows in a fresh checkout; durable commands use the
machine-local runtime only.

Plain \`${slashAlias} setup\` is the only supported setup and repair path. It
uses the machine-local Pipelane runtime and must not materialize tracked
repo-local adapters, command files, Codex skills, package scripts, or docs.
Plain
\`${slashAlias} review setup\` configures the pre-PR review gates. Keep those
two setup flows distinct.

When \`${slashAlias} configure\` prints "Choose the action to take:", ask the
user for the deploy values in chat, then run the matching
\`${slashAlias} configure --json ...\` command with the provided flags.

## Help behavior

Bare \`${slashAlias}\`, \`${slashAlias} help\`, and \`${slashAlias} --help\`
print the dispatcher command reference. Use that output when the user asks what
Pipelane can do instead of guessing from memory.

## Choice handoff behavior

If \`${slashAlias} update\`, setup, status, or any other dispatcher flow runs
after a prior command printed a numbered selector, do not refer back to only
"option 1" or "option 2". Restate the number with its action label and command,
for example \`1 (Continue to /deploy staging: run /merge, then /deploy staging)\`
or \`2 (Take one step only: run /merge)\`.

## Interactive review setup behavior

Agent Bash tools commonly run commands without an interactive TTY, and shell
pipes make stdout non-TTY. When the user invokes bare
\`${slashAlias} review setup\` with no flags, run the setup command directly
through the runner command above. Bare review setup is read-only: the CLI prints
the saved grouped gate state when config exists, or inferred recommended
defaults when it does not. It must not be reduced to a request to rerun with
\`--yes\`.

Relay the opinionated review shape to the user. The recommended AI stack is
\`karpathy-diff\` as author self-review, \`code-review-high\` when Claude review
support is available, \`gstack-review\` as the independent fallback, and
\`adversarial-review\` for a cross-model pass when installed. High-stakes diffs
can add \`code-review-ultra\` and human approval. Independent AI gates must be
run from a fresh reviewer session; do not let the authoring session attest its
own independent review. Same-session evidence will block \`/pr\`.

Do not reduce the review setup output to only a category summary. Preserve the
grouped rows, stable ids such as \`C3\`, and exact commands, especially
\`/karpathy diff\`, \`/code-review high\`, \`/gstack review\`,
\`/claude review code\`, \`code-review-ultra\`, and \`/karpathy-audit\` when they
appear. If the user's next reply is only one or more displayed row ids such as
\`C4\` or \`C3,H1\`, treat it as a review setup selection. When the user chooses
gates, run the matching deterministic command exactly; every mutation writes
immediately and reprints the grouped state:

- \`review setup <display-id-or-gate-id>\` toggles a displayed row directly,
  for example \`review setup C4\`.
- \`review setup --toggle <display-id-or-gate-id>\` to flip a displayed row.
- \`review setup --enable <gate-id>\` to enable an available gate.
- \`review setup --disable <gate-id>\` to disable a preselected gate.
- \`review setup --install <gate-id>\` to install and enable an optional gate
  such as \`lint\` or \`adversarial-review\`.
- \`review setup --reset\` to restore recommended defaults.
- Gate values may be repeated or comma-separated, for example
  \`review setup C3,H1\` or \`review setup --toggle C3,H1\`.
- \`review setup --list-gates\` to inspect the full catalog.
- \`review setup --print\` to print the effective config.
\`review setup --yes\` is legacy-compatible and acts like intentional reset to
recommended defaults, but it is not the normal path to advertise.

If the user supplied any setup flag, run the command directly through the
runner. Do not add shell pipes to setup commands that may need interactivity.

${renderOrchestrationGuidance(`${slashAlias} orchestrate`, 'When the first token is `orchestrate` and a plan file (or a goal to implement) is given')}
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
## Fresh checkout behavior

Use this slash command through the managed runner when starting a task from a
fresh checkout. Do not substitute repo-local npm scripts or repo-local binaries;
durable commands use the machine-local runtime before Pipelane creates the task
worktree or links dependencies.

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

If ${slashAlias} fails, stop instead of editing in the current checkout. If it
succeeds and reports that the chat/workspace has not moved, switch to the
reported worktree before reading or editing task files.
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
   of the printed numbered choices and preserve each number, label, and command
   in your chat prompt. Do not reduce it to "rerun with --yes", "option 1", or
   "option 2"; when the user picks a runnable choice, run the matching command.
   In follow-up reminders, restate the action label, for example
   "1 (Continue to /deploy staging)" or "2 (Take one step only)".
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

export function renderBootstrapScript(_pipelaneBinPath: string): string {
  return `#!/bin/sh
set -eu

echo "pipelane bootstrap and /init-pipelane are no longer supported." >&2
echo "Run pipelane install-codex or pipelane install-claude once per machine, then run pipelane setup in the repo." >&2
exit 1
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
managed_bin="${options.managedPipelaneBin}"
if [ ! -x "$managed_bin" ]; then
  managed_bin="${globalBinFallback}"
fi

print_pipelane_help() {
  cat <<'PIPELANE_HELP'
Pipelane is a build, release, and development orchestrator for AI-assisted
codebases. It keeps task worktrees, PRs, review gates, deploy promotion,
rollback, cleanup, and multi-agent implementation work on an explicit path so
agents do not invent local process or skip release safety.

The normal first-run path is clean: /pipelane setup uses the machine-local
runtime and must not create tracked repo-local adapters, command files, Codex
skills, package scripts, or docs. /pipelane configure is the place to add deploy
targets, health checks, and release-mode details. /pipelane update only updates
Pipelane itself.

Usage:
  /pipelane <command> [args...]
  /pipelane help

Start here:
  /pipelane setup [--yes]
      Run clean first-time setup or repair with the machine-local runtime.

  /pipelane configure [--json] [flags...]
      Fill or update Deploy Configuration values such as staging/prod URLs,
      deploy workflow names, healthchecks, edge/sql commands, and Supabase refs.

  /pipelane update [--check] [--yes] [--json]
      Check or update Pipelane itself when this repo has a pinned install.

Status and UI:
  /pipelane status [--json]
      Show the current lane state and next recommended action.

  /pipelane board [status|stop] [--port <port>] [--no-open]
      Open, inspect, or stop the local Pipelane board.

  /pipelane web [status|stop] [--port <port>] [--no-open]
      Alias for /pipelane board.

Review gates:
  /pipelane review [--dry-run] [--gate <id>] [--phase <phase>]
      Run configured review gates for the current diff and write evidence that
      /pr and orchestrated slice review can trust.

  /pipelane review setup [gate[,gate...]...] [--yes] [--reset] [--print] [--list-gates]
                         [--toggle <gate[,gate...]>] [--enable <gate[,gate...]>] [--disable <gate[,gate...]>] [--install <gate[,gate...]>]
      Choose the pre-PR review model. This is different from /pipelane setup;
      it configures quality gates such as tests, self-review, independent AI
      review, instruction audit, and human approval for high-stakes changes.

Orchestration:
  /pipelane orchestrate --plan-file <file> --analysis-file <file> --yes
      Turn a plan into reviewed implementation slices with isolated worktrees,
      worker prompts, status tracking, and per-slice review before merge.

  /pipelane orchestrate plan|analyze|prepare|dispatch|start|review|plan-review
      Run one orchestration phase at a time.

  /pipelane orchestrate goal-spec [--plan-file <file>] [--slice-id <id>]
      Draft a provider-neutral implementation goal spec.

Build and release companion commands:
  /new              Create an isolated task worktree.
  /pr               Prepare and gate a pull request.
  /merge            Merge an approved PR.
  /deploy staging   Deploy the merged SHA to staging.
  /deploy prod      Promote a verified staging SHA to production.
  /clean            Close out merged/deployed task worktrees.
  /doctor           Diagnose deploy and runtime configuration.
  /rollback         Roll back staging or production to a prior verified deploy.

Tip:
  Use /pipelane status when you are unsure what is safe next.
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

cd "$repo_root"

if [ -x "$managed_bin" ]; then
  export PIPELANE_MANAGED_RUNTIME=1
  export PIPELANE_MANAGED_RUNTIME_ROOT="${options.managedRuntimeRoot}"
  run_pipelane "$managed_bin" "$command" "$@"
fi

echo "pipelane is unavailable for this repo." >&2
echo "Checked:" >&2
echo "  - ${options.managedPipelaneBin}" >&2
echo "  - ${globalBinFallback}" >&2
echo "Restore one of these runtimes and retry:" >&2
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
    managedRuntimeRoot: string;
    managedPipelaneBin: string;
    globalBinFallback?: string;
    fixPromptBody: string;
    lessonPromptBody: string;
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

  // Top-level /orchestrate alias. Drives the same guided slice-by-slice flow as
  // `/pipelane orchestrate` (shared renderOrchestrationGuidance), just discoverable
  // at the top level. required:false so an existing non-pipelane /orchestrate skill
  // is skipped gracefully instead of failing the whole install.
  entries.push({
    kind: 'workflow',
    name: ORCHESTRATE_SKILL_NAME,
    slashAlias: `/${ORCHESTRATE_SKILL_NAME}`,
    command: 'orchestrate',
    required: false,
    body: renderWorkflowSkillBody({
      host,
      scope,
      command: 'orchestrate',
      slashAlias: `/${ORCHESTRATE_SKILL_NAME}`,
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

  // Optional /lesson — the deliberate, on-demand counterpart to the automatic
  // capture the planted CLAUDE.md instruction drives. required:false so a
  // pre-existing unmanaged /lesson is skipped instead of failing the whole
  // install (a common name, same posture as /fix).
  entries.push({
    kind: 'prompt',
    name: LESSON_SKILL_NAME,
    slashAlias: `/${LESSON_SKILL_NAME}`,
    required: false,
    body: renderPromptSkillBody({
      host,
      name: LESSON_SKILL_NAME,
      description: 'Append a dated lesson to the repo CLAUDE.md ## Lessons block.',
      body: paths.lessonPromptBody,
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
