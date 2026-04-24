# Dashboard Implementation Guide

This folder contains `pipelane`'s local Pipelane Board reference implementation.

Files:

- `server.ts`: local HTTP adapter over a target repo's `pipelane:api`
- `public/index.html`: zero-dependency dashboard UI

## Quick start

From the `pipelane` repo:

```bash
npm run dashboard -- --repo /absolute/path/to/your/repo
```

Open the reported local URL, typically:

```text
http://127.0.0.1:3033
```

The target repo must expose:

- `npm run pipelane:api -- snapshot --json`
- `npm run pipelane:api -- branch --branch <branch> --json`
- `npm run pipelane:api -- branch --branch <branch> --file <path> --patch --json`
- `npm run pipelane:api -- action <id> --json`
- `npm run pipelane:api -- action <id> --execute --confirm-token <token> --json`

## Architecture

The dashboard is a thin local adapter.

### Server responsibilities

`server.ts` is responsible for:

- spawning `pipelane:api` commands in the target repo
- forwarding JSON envelopes unchanged
- caching snapshots briefly
- managing action execution streams
- enriching branch rows with local author data
- persisting local dashboard settings

### UI responsibilities

`public/index.html` is responsible for:

- rendering the opinionated board layout
- opening branch detail and settings drawers
- calling the dashboard HTTP routes
- showing action feedback and execution logs
- preserving the workflow state vocabulary from the repo contract

## Local HTTP routes

The server exposes:

- `GET /api/health`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/snapshot`
- `GET /api/branch/:branch`
- `GET /api/branch/:branch/patch?file=<path>&scope=<branch|workspace>`
- `POST /api/action/:id/preflight`
- `POST /api/action/:id/execute`
- `GET /api/executions/:id`
- `GET /api/executions/:id/events`

## Settings

Settings are stored per target repo in:

```text
~/.pipelane/dashboard/<repo>-<hash>.json
```

Current settings schema:

```json
{
  "boardTitle": "Pipelane Board",
  "boardSubtitle": "Pipelane - release pipeline management and safety for AI vibe coders. Branch pipeline triage, action preflight, execution follow-through, smoke gates, and cleanup discipline.",
  "preferredPort": 3033,
  "autoRefreshSeconds": 30
}
```

Notes:

- `preferredPort` applies on the next dashboard start
- `autoRefreshSeconds` takes effect immediately after saving
- settings are local-only and should not be committed into consumer repos

## Customization guidance

The reference implementation is intentionally opinionated, but customization is expected.

Good customization targets:

- board title and subtitle
- port
- refresh cadence
- copy tone and labels
- additional local presentation preferences

Bad customization targets:

- inventing new workflow action semantics in the UI
- bypassing the repo contract and reading private files directly
- duplicating workflow state derivation in the dashboard

## Design rules worth preserving

If you modify or fork this dashboard, keep these properties:

- one active pipeline card per branch
- sticky branch column
- explicit actions over drag-and-drop
- exact lane reasons shown in detail
- lazy branch-file and patch loading
- visible action feedback after every click
- local settings instead of tracked repo config
