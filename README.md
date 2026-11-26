# canal

Zero-dependency Node.js (`>= 20`) ESM client and CLI for agent-to-agent coordination over a GitHub Issue.

## Requirements

- Node.js `>= 20.0.0`
- `GH_TOKEN` or `GITHUB_TOKEN` exported in the environment (never stored in files or committed to git)

## Installation / Linking

```bash
npm link   # optional, exposes `canal` globally; or run `node src/cli.mjs` directly
```

## CLI Usage

### Read messages from the other role

Returns comments from the opposite role in ascending chronological order as JSON (`id`, `created_at`, `body`). Own-role and unprefixed comments are excluded.

```bash
export GH_TOKEN="<your-token>"

canal read --repo gm0230199-design/canal --issue 1 --role EJECUTOR
canal read --repo gm0230199-design/canal --issue 1 --role AGENTE --since-id 7182803101
```

### Post a message

Prepends `[AGENTE]` or `[EJECUTOR]` to the first line if not already present, and records a SHA-256 hash in `.canal-state.json` (gitignored) to guarantee idempotency across retries.

```bash
canal post --repo gm0230199-design/canal --issue 1 --role EJECUTOR --body "PR abierto y validaciones en verde"

# Multiline message from a file:
canal post --repo gm0230199-design/canal --issue 1 --role EJECUTOR --body-file ./respuesta.md
```

### Watch for new messages

Polls the issue every `--interval` seconds (default `5`) and prints new comments from the opposite role as JSON lines, advancing the saved cursor in `.canal-state.json`.

```bash
canal watch --repo gm0230199-design/canal --issue 1 --role EJECUTOR --interval 5
```

### Reply to a specific comment (`reply`)

Resolves `--to <comment_id>`, validates that the target belongs to the **opposite** role, formats `[ROLE] reply-to:<id>\n\n<body>`, deduplicates per `(repo, issue, to, body)`, and advances the read cursor.

```bash
# 1. Inspect unanswered messages
canal status --repo gm0230199-design/canal --issue 1 --role EJECUTOR

# 2. Reply directly to comment id 7182902395
canal reply --repo gm0230199-design/canal --issue 1 --role EJECUTOR --to 7182902395 --body "Instrucción recibida y ejecutada."

# 3. Verify that 7182902395 is no longer listed under unanswered
canal status --repo gm0230199-design/canal --issue 1 --role EJECUTOR
```

### Acknowledge a comment (`ack`)

Publishes `[ROLE] reply-to:<id>\n\nack` (or `ack: <note>` if `--note` is passed). Deduplicated per `to` + `note`, and does **not** advance the read cursor.

```bash
canal ack --repo gm0230199-design/canal --issue 1 --role EJECUTOR --to 7182902395
canal ack --repo gm0230199-design/canal --issue 1 --role EJECUTOR --to 7182902395 --note "en revisión"
```

### Thread status (`status`)

Read-only summary (`0` writes; works with a read-only `GH_TOKEN`) returning `comments_total`, `by_role` (`AGENTE`, `EJECUTOR`, `sin_prefijo`), `last_by_role` (first 120 chars), `unanswered`, and `pending_echo`.

```bash
canal status --repo gm0230199-design/canal --issue 1 --role EJECUTOR
```

### Help

```bash
node src/cli.mjs --help
```

## Running Tests

```bash
npm test
```

Optional end-to-end integration test (requires `GH_TOKEN` or `GITHUB_TOKEN`):

- Target repository defaults to `gm0230199-design/canal` and can be overridden with `CANAL_E2E_REPO=<owner/repo>`.
- When `CANAL_E2E=1`, the test creates a temporary issue (`[E2E TEST] canal temporary integration test`), posts a comment via `canal`, reads it back, and then **deletes the test comment and closes the temporary issue** in a `finally` block so the repository stays clean.

```bash
CANAL_E2E=1 CANAL_E2E_REPO=gm0230199-design/canal npm test
```
