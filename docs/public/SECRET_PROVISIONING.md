# Repository secrets and private CI inputs

Pipelane does not require every repository to configure Cloudflare, a corpus,
or additional GitHub secrets. This setup appears only when the current
repository declares private CI inputs in `.github/pipelane-provisioning.json`.
The repository's workflow—not Pipelane—decides whether an input blocks a test
or deployment.

## What this setup does

GitHub Actions runs on a clean remote machine. It cannot see credentials or
private files stored on your computer. Repository secrets give that workflow
the inputs it needs without committing the values to Git.

Depending on the repository, provisioning can:

- let CI authenticate to a deployment or evaluation service;
- let a safety test use private cases that implementation code cannot inspect;
- unblock a workflow that intentionally refuses to deploy without those checks.

Provisioning does not train a model, upload production conversations, or make a
corpus a general Pipelane requirement. Pipelane only validates and transfers
inputs that the repository explicitly declares. It cannot create an external
account permission or invent a meaningful private dataset for you.

## Step-by-step setup

1. Run `/pipelane setup`.
2. Read each declared input:
   - **Why** explains what the repository gains from it.
   - **Status** says whether it is configured, ready, or blocked.
   - **Next** appears only when you need to provide a local input.
3. Provide only the blocked inputs using the printed **Next** instructions.
4. Copy and run the exact provisioning command printed by setup. It includes
   `--approve-secret-manifest=<sha256>`, which binds your approval to this
   repository and the exact manifest you just inspected.
5. Rerun `/pipelane setup`. Every declared input should say
   `already configured`.

That is the normal flow. You do not need to open GitHub Settings or manually
Base64-encode files. Repository-relative private files must be Git-ignored before
Pipelane will read them. Pipelane sends secret values to `gh secret set` over stdin,
does not print them, and preserves existing GitHub secrets. It refuses to run a
repository-local `gh` executable; use a trusted GitHub CLI installed outside the
repository.

## Declaring repository inputs

Repository maintainers opt in with a committed
`.github/pipelane-provisioning.json` manifest. For example:

```json
{
  "version": 1,
  "github": {
    "repositorySecrets": [
      {
        "name": "DEPLOY_API_TOKEN",
        "description": "Authenticates the production deployment workflow",
        "source": {
          "type": "environment",
          "variable": "DEPLOY_API_TOKEN"
        }
      },
      {
        "name": "CLOUDFLARE_AI_EVAL_TOKEN",
        "source": {
          "type": "cloudflare-api-token",
          "variable": "CLOUDFLARE_API_TOKEN",
          "wranglerCwd": "web",
          "dotenvFile": "web/.env",
          "dotenvVariable": "CLOUDFLARE_API_TOKEN"
        }
      },
      {
        "name": "CHAT_HELDOUT_CORPUS_BASE64",
        "source": {
          "type": "file-base64",
          "pathVariable": "CHAT_HELDOUT_PATH",
          "defaultPath": ".pipelane/secrets/chat-heldout-corpus.json",
          "validator": "chat-heldout-corpus-v1"
        }
      }
    ]
  }
}
```

The manifest is strict: unsupported or misspelled fields fail setup instead of
being ignored.

- `name` is the destination GitHub repository-secret name. It must use uppercase
  letters, numbers, and underscores, cannot start with a number or `GITHUB_`,
  and must be unique in the manifest.
- `description` is optional user-facing text explaining why the repository needs
  the input.
- `environment` reads the named uppercase `variable` from the current process.
- `cloudflare-api-token` first checks `variable`, then the optional allowlisted
  `dotenvFile` and `dotenvVariable`, then Wrangler. `wranglerCwd` and
  `dotenvFile` must be repository-relative; the two dotenv fields must be
  provided together.
- `file-base64` reads the path from `pathVariable`, falling back to the optional
  repository-relative `defaultPath`, and installs its Base64 encoding. The only
  current validator is the optional `chat-heldout-corpus-v1` value documented
  below.

Manifest-relative files must remain inside the repository and cannot be
symlinks. Private files inside the repository must also be Git-ignored; Pipelane
adds their declared paths to its PR staging deny checks as defense in depth. An
explicit path environment variable may select another regular file when the
operator intentionally keeps private input elsewhere. The combined set
of existing and declared repository secrets cannot exceed GitHub's 100-secret
limit, and every final secret value must fit within 48 KB.

Use `--rotate-secrets` only when you intentionally want to replace every
declared secret:

```text
/pipelane setup --provision-secrets --rotate-secrets --approve-secret-manifest=<sha256 printed by setup>
```

Before rotation starts, Pipelane resolves and validates every declared
replacement. If any source is blocked, it writes nothing. GitHub does not offer
an atomic multi-secret transaction, so if a later API write fails after an
earlier write succeeds, Pipelane stops immediately and reports the partial
state for you to inspect before rerunning.

## Cloudflare API tokens

A Cloudflare token lets the repository's workflow call the Cloudflare API. The
repository description should say what the workflow uses it for and therefore
which permissions it needs.

Pipelane can read a token only from sources explicitly named by the repository,
such as an environment variable, an allowlisted key in a local `.env` file, or
Wrangler authenticated with a durable API token. It does not copy a refreshable
Wrangler OAuth login into GitHub Actions and cannot grant Cloudflare permissions
on your behalf.

Pipelane never executes a repository-local GitHub CLI or Wrangler binary. Wrangler token
discovery runs only after you explicitly approve the exact manifest; it uses a
Wrangler executable outside the repository with a minimal environment.

Never paste a token into the provisioning manifest, source code, documentation,
or chat. Put it only in one of the local sources printed by `/pipelane setup`.

## Held-out corpus format

A held-out corpus is a private list of test cases. An AI safety workflow uses it
to catch regressions that could be missed if implementation code could see and
tune against every test case. It is relevant only to repositories that declare
this specific check.

When `/pipelane setup` asks for a `chat-heldout-corpus-v1` file, create the path
shown in its **Next** instruction. The file must be a non-empty JSON array:

```json
[
  {
    "id": "unique-case-id",
    "group": "benign",
    "text": "Message to evaluate",
    "expected": "allow",
    "critical": false
  }
]
```

Fields:

- `id`: unique identifier using letters, numbers, `.`, `_`, `:`, or `-`;
- `group`: `benign`, `fantasy_violence`, `harassment`, `hate_threat`,
  `minor_safety`, `self_harm`, `pii_links`, or `unicode`;
- `text`: 1–500 Unicode characters;
- `expected`: `allow` or `reject`;
- `critical`: optional boolean.

No other fields are accepted. This catches misspelled fields before the private
corpus is installed in GitHub.

Keep the file private and use synthetic evaluation cases, not production user
messages. Pipelane validates the structure, Base64-encodes the file, enforces
GitHub's secret-size limit, and installs the encoded result. The GitHub workflow
recreates the temporary file on its runner.

## Status meanings

- `already configured`: GitHub has the secret; Pipelane leaves it unchanged.
- `ready`: the local source is available and can be provisioned.
- `blocked`: the local source is missing or unsafe; follow the printed **Next**
  instruction.
- `provisioned`: Pipelane installed and verified the GitHub secret.

## Troubleshooting

- **GitHub inspection failed:** run `gh auth status` and confirm you can manage
  secrets for the current repository.
- **Wrangler authentication is OAuth:** provide a durable Cloudflare API token
  through one of the sources printed by setup.
- **Corpus file does not exist:** create the default path printed by setup, or
  set the printed path environment variable to another file.
- **Value exceeds 48 KB:** reduce or split the private input. Base64 encoding
  increases file size, so a raw corpus must be smaller than the final limit.
- **A secret already exists:** setup preserves it. Use rotation only when
  replacement is deliberate.
