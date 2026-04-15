## Workflow

This repo uses `workflow-kit`, the repo-specific workflow layer for AI-first builders.

It is designed to work well with Claude, Codex, and similar tools by keeping the release flow
deterministic:

- repo-native commands are the source of truth
- slash commands are thin adapters
- `/new` creates explicit isolated task workspaces
- `/resume` recovers them later when needed

### Two dev modes

`workflow-kit` gives this repo two lanes:

- `build`: the fast lane, where merge is expected to hand off production deploy
- `release`: the protected lane, where staging happens before prod for the same merged SHA

### Build mode user journey

User-facing:

1. `/devmode build`
2. `/new <task-name>`
3. `/pr`
4. `/merge`
5. `/clean`

Repo-native:

```bash
npm run workflow:devmode -- build
npm run workflow:new -- --task "example-task"
npm run workflow:pr -- --title "Example PR title"
npm run workflow:merge
npm run workflow:clean
```

### Release mode user journey

User-facing:

1. `/devmode release`
2. `/new <task-name>`
3. `/pr`
4. `/merge`
5. `/deploy staging`
6. `/deploy prod`
7. `/clean`

Repo-native:

```bash
npm run workflow:devmode -- release
npm run workflow:new -- --task "example-task"
npm run workflow:pr -- --title "Example PR title"
npm run workflow:merge
npm run workflow:deploy -- staging
npm run workflow:deploy -- prod
npm run workflow:clean
```

### Command surface

- `/devmode`
- `/new`
- `/resume`
- `/pr`
- `/merge`
- `/deploy`
- `/clean`

Canonical repo-native commands:

- `npm run workflow:setup`
- `npm run workflow:devmode -- ...`
- `npm run workflow:new -- --task "<task-name>"` (the `--task` flag is optional; omitting it generates a `task-<hex>` slug)
- `npm run workflow:resume -- --task "<task-name>"`
- `npm run workflow:pr -- ...`
- `npm run workflow:merge`
- `npm run workflow:release-check`
- `npm run workflow:task-lock -- verify --task "<task-name>"`
- `npm run workflow:deploy -- staging|prod ...`
- `npm run workflow:clean`

### workflow-kit + gstack

Use both.

- use `workflow-kit` for task workspaces, PR prep, merge, and deploy flow
- use gstack for review, QA, architecture review, deploy bootstrap, docs, and investigation

If this repo is adopting workflow-kit for the first time, commit the tracked workflow files
before using `workflow:new` in a remote-backed repo.

Use [docs/RELEASE_WORKFLOW.md](./docs/RELEASE_WORKFLOW.md) for the full operator workflow.
