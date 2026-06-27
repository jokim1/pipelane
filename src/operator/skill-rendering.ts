import { aliasCommandName, MANAGED_WORKFLOW_COMMANDS, resolveWorkflowAliases, type WorkflowCommand, type WorkflowConfig } from './state.ts';

export type HostInstall = 'codex' | 'claude';
export type HostInstallScope = 'repo-local' | 'machine-local';

export const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';
export const PIPELANE_DISPATCH_SKILL_NAME = 'pipelane';
export const PIPELANE_FIX_SKILL_NAME = 'pipelane-fix';
export const FIX_SKILL_NAME = 'fix';
export const LESSON_SKILL_NAME = 'lesson';

export const MACHINE_CODEX_SKILL_MARKER_PREFIX = '<!-- pipelane:codex-global-skill:';
export const MACHINE_CLAUDE_SKILL_MARKER_PREFIX = '<!-- pipelane:claude-global-skill:';
export const REPO_CODEX_SKILL_MARKER_PREFIX = '<!-- pipelane:codex-skill:';

export type DesiredInstallEntryKind = 'workflow' | 'dispatcher' | 'prompt';

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

Treat \`${slashAlias} setup\` as the normal clean repo setup and repair path and
\`${slashAlias} configure\` as the normal deploy configuration path. Do not ask
the user to run \`! pipelane configure\` in a terminal; the durable runner knows
where the managed pipelane runtime is even when \`pipelane\` is not on PATH.
Do not substitute repo-local \`npm run pipelane:*\` or \`npm run workflow:*\`
scripts for bootstrap/task-start flows in a fresh checkout; npm resolves those
through \`node_modules/.bin/pipelane\` and can fail before Pipelane links or
installs dependencies.

Plain \`${slashAlias} setup\` should not be treated as consent to materialize
tracked repo-local adapters. It uses the machine-local Pipelane runtime and
only syncs repo-local files for repos that have explicitly opted into those
surfaces. Plain
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
through the runner command above. The CLI prints a non-interactive selector
with gate numbers, Claude setup status, installable gaps, and exact follow-up
commands.

Relay the opinionated review shape to the user. The recommended AI stack is
\`karpathy-diff\` as author self-review, \`code-review-high\` when Claude review
support is available, \`gstack-review\` as the independent fallback, and
\`adversarial-review\` for a cross-model pass when installed. High-stakes diffs
can add \`code-review-ultra\` and human approval. Independent AI gates must be
run from a fresh reviewer session; do not let the authoring session attest its
own independent review. Same-session evidence will block \`/pr\`.

Do not reduce the review setup output to only a category summary or only
\`review setup --yes\`. Preserve the printed selector choices and exact commands,
especially \`/karpathy diff\`, \`/code-review high\`, \`/claude review code\`, and
\`review setup --install adversarial-review\` when they appear. After relaying the
choices, it is fine to recommend saving the current selection. If the user opts
out of a recommended gate, say that the consequence is less review coverage
before you save the change. When the user chooses gates, run the matching
deterministic command exactly:

- \`review setup --yes\` to save the current recommended selection.
- \`review setup --enable <gate-id>\` to enable an available gate.
- \`review setup --disable <gate-id>\` to disable a preselected gate.
- \`review setup --install <gate-id>\` to install and enable an optional gate
  such as \`lint\` or \`adversarial-review\`.
- Gate values may be repeated or comma-separated, for example
  \`review setup --enable 3, 4, 5, 13\`.
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
2. Decompose the plan into phases and slices. Write a slices JSON file to a scratch path:
   \`{ "slices": [ { "id", "title", "phase", "text" } ], "coverage": [ { "section", "disposition": "slice|deferred|excluded", "sliceId", "reason" } ] }\`
   Then write an analysis JSON file with the real plan file's SHA-256 as \`sourceSha256\`,
   your analyzer identity, \`identityReliable\`, strengths, risks, ambiguities,
   sensitiveAreas, and recommendedScope. Record analysis WITHOUT starting workers
   and capture the run id:
   \`${slashAlias} orchestrate analyze --plan-file <real-plan> --analysis-file <analysis.json> --slices-file <scratch.json> --json\`
   The run's audit source stays bound to the real plan file, not either scratch file.
3. Relay the CLI outline verbatim (do not hand-format it):
   \`${slashAlias} orchestrate outline --run-id <id>\`
   Then print the **review model** as bullets: static checks, tests, independent AI
   review of each slice diff, and human confirm on sensitive slices.
4. **Recommend a scope**: the full plan, or a justified partial boundary (e.g. land
   a sensitive schema/RLS phase first because everything depends on it). Offer:
   approve / edit scope / cancel. For a partial scope run
   \`${slashAlias} orchestrate scope --run-id <id> --through <last-slice-id-in-scope>\`.
5. Before prepare, complete every pending plan-review gate: run the configured
   reviewer, then record \`${slashAlias} orchestrate plan-review pass --run-id <id> --gate <gate-id> --message <summary>\`
   or consciously bypass with \`${slashAlias} orchestrate plan-review bypass --run-id <id> --gate <gate-id> --reason <reason>\`.
   Then drive in order: \`${slashAlias} orchestrate prepare --run-id <id>\`,
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
## Fresh checkout behavior

Use this slash command through the managed runner when starting a task from a
fresh checkout. Do not substitute repo-local \`npm run pipelane:new\` or
\`npm run workflow:new\` before \`node_modules/.bin/pipelane\` exists; npm will
fail before Pipelane can create the task worktree or link dependencies.

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

// Prompt body for the optional /lesson explicit-capture command. Deliberate
// counterpart to the automatic capture the planted CLAUDE.md instruction drives:
// /lesson lets the operator log one specific lesson on demand. No CLI call — the
// agent edits CLAUDE.md directly (Kun Chen's direct-to-CLAUDE.md method).
const LESSON_PROMPT_BODY = `Append a dated lesson to this repo's local CLAUDE.md so it accretes across sessions (both Claude and Codex read it).

1. Take the lesson text from the arguments after \`/lesson\`. If none was given, ask the user for the one-line lesson and stop.
2. Open \`CLAUDE.md\` at the repo root. If it has no \`<!-- pipelane:lessons:entries:end -->\` marker, the managed Lessons block is not provisioned yet — tell the user to run \`/pipelane setup\` (\`--yes\` to apply) first, then stop without editing.
3. Insert a single new line immediately BEFORE the \`<!-- pipelane:lessons:entries:end -->\` marker (entries stay newest-last), formatted exactly:
   \`- <YYYY-MM-DD>: <lesson>\`
   Use today's date. Keep it to one line. Do not edit, reorder, or rewrite any existing entries or the instruction prose above the entries region.
4. Confirm to the user the exact line you added.

Dedup and pruning are \`/karpathy audit\`'s job, not this command's.`;

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
Pipelane is a build, release, and development orchestrator for AI-assisted
codebases. It keeps task worktrees, PRs, review gates, deploy promotion,
rollback, cleanup, and multi-agent implementation work on an explicit path so
agents do not invent local process or skip release safety.

The normal first-run path is clean: /pipelane setup uses the machine-local
runtime and should not create tracked repo files unless the repo has explicitly
opted into repo-local generated surfaces. /pipelane configure is the place to
add deploy targets, health checks, and release-mode details. /pipelane update
only updates Pipelane itself.

Usage:
  /pipelane <command> [args...]
  /pipelane help

Start here:
  /pipelane setup [--yes]
      Run clean first-time setup or repair. Uses local defaults unless the repo
      has explicitly opted into generated command/docs/package-script surfaces.

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

  /pipelane review setup [--yes] [--print] [--list-gates]
                         [--enable <gate[,gate...]>] [--disable <gate[,gate...]>] [--install <gate[,gate...]>]
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
      body: LESSON_PROMPT_BODY,
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
