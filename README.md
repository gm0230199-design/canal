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

Read-only summary (`0` writes; works with a read-only `GH_TOKEN`) returning `comments_total`, `by_role` (`AGENTE`, `EJECUTOR`, `sin_prefijo`), `last_by_role` (first 120 chars), `unanswered`, `pending_echo`, and `tasks` (identical array to `canal task list`).

> **Why `ack` does not generate `pending_echo`:** an `ack` comment is an explicit receipt confirmation rather than a new prompt or question, so `status` excludes own `ack` comments from `pending_echo` to avoid infinite acknowledgement loops, and `ack` never alters task state.

> **Filtering rule for `--role`:** when `--role <AGENTE|EJECUTOR>` is passed to either `canal task list` or `canal status`, both commands filter `tasks` using the exact same assignee rule (`asignado_a === <ROLE>`). When `--role` is omitted, both return the full task board sorted by `id` ascending.

```bash
canal status --repo gm0230199-design/canal --issue 1 --role EJECUTOR
```

### Reentry brief (`brief`)

Single read-only call (`0` writes; works with a read-only `GH_TOKEN`) returning everything needed to resume work on the thread:

```bash
canal brief --repo gm0230199-design/canal --issue 1 --role EJECUTOR
```

**Fields:**
- `repo`, `issue`, `role`: target repository, issue number, and optional `--role` filter.
- `ultimo_por_rol`: latest comment `{ id, created_at, primera_linea }` for `AGENTE` and `EJECUTOR` (first line only).
- `sin_responder`: comment IDs from the opposite role without a subsequent `reply-to:<id>` from your role.
- `esperando_a_mi`: your own non-ack comment IDs that the opposite role has not replied to yet.
- `sin_responder_mensajes`: same as `sin_responder` but **only real messages**: the task headers (`task:T-001 claim`) are machine markers, not something to answer, and counting them made re-entry say "respond to 17 comments" when there were 8 messages.
- `esperando_a_mi_mensajes`: same as `esperando_a_mi`, without the task headers.
- `tasks`: task board array (identical to `canal task list` and `canal status`, filtered by `asignado_a === role` when `--role` is given).
- `en_curso`: all non-`done` tasks (`open`, `claimed`, `in_progress`, `blocked`) with `{ id, estado, asignado_a }`.
- `siguiente_paso`: single derived action sentence summarizing blocked tasks (most recent first with reason), in-progress/claimed tasks for your role, open unclaimed tasks, or pending **messages** (headers are reported apart, not counted as messages).
- `generado_en`: ISO-8601 UTC generation timestamp.

**Example output** — this is the **real output** of the command over the fixed fixture
`test/fixtures/thread-brief.json` (a synthetic thread, so it does not change under our feet).
The test `test/readme-example.test.mjs` compares this block with what `briefIssue()` actually
returns, so the documentation cannot drift away from the code again.
<!-- canal-brief-example:start -->
<!-- canal-brief-example:start -->
<!-- canal-brief-example:start -->
<!-- canal-brief-example:start -->
```json
{
  "repo": "gm0230199-design/canal",
  "issue": 1,
  "role": "EJECUTOR",
  "ultimo_por_rol": {
    "AGENTE": {
      "id": 110,
      "created_at": "2026-11-26T06:05:00Z",
      "primera_linea": "[AGENTE] Estado del bloque 5 pendiente de revision"
    },
    "EJECUTOR": {
      "id": 111,
      "created_at": "2026-11-26T06:06:00Z",
      "primera_linea": "[EJECUTOR] reply-to:110"
    }
  },
  "sin_responder": [
    106
  ],
  "esperando_a_mi": [
    102,
    103,
    105,
    107,
    108,
    109,
    111
  ],
  "sin_responder_mensajes": [
    106
  ],
  "esperando_a_mi_mensajes": [
    102,
    111
  ],
  "tasks": [
    {
      "id": "T-001",
      "title": "Brief de reentrada solo lectura",
      "estado": "in_progress",
      "asignado_a": "EJECUTOR",
      "creado_en": "2026-11-26T06:01:00Z",
      "ultimo_avance": {
        "id": 105,
        "role": "EJECUTOR",
        "created_at": "2026-11-26T06:02:00Z",
        "note": "Ejemplos regenerados"
      }
    },
    {
      "id": "T-002",
      "title": "buildHeaders con token vacio",
      "estado": "blocked",
      "asignado_a": "EJECUTOR",
      "creado_en": "2026-11-26T06:03:00Z",
      "ultimo_avance": null,
      "bloqueado_en": {
        "id": 109,
        "role": "EJECUTOR",
        "created_at": "2026-11-26T06:04:00Z",
        "reason": "falta el test de la cabecera Authorization"
      }
    }
  ],
  "en_curso": [
    {
      "id": "T-001",
      "estado": "in_progress",
      "asignado_a": "EJECUTOR"
    },
    {
      "id": "T-002",
      "estado": "blocked",
      "asignado_a": "EJECUTOR"
    }
  ],
  "siguiente_paso": "Bloqueado T-002: falta el test de la cabecera Authorization. En progreso (EJECUTOR): T-001.",
  "generado_en": "2026-11-26T06:06:00.000Z"
}
```
<!-- canal-brief-example:end -->
<!-- canal-brief-example:end -->
<!-- canal-brief-example:end -->
<!-- canal-brief-example:end -->

### Task board (`task`)

Append-only task board derived directly from issue comments (no local task database). Headers follow `[ROLE] task:T-XXX` (`add`) or `[ROLE] task:T-XXX <claim|progress|done|blocked>`, and cannot be combined with `reply-to:`.

**State machine:**
- `open`: `task add` created the block and no role has claimed it yet.
- `claimed`: claimed by one role (`task claim`), from either `open` or an unassigned `blocked` block (`blocked -> claim -> claimed`), with no subsequent `progress`/`done`/`blocked`.
- `in_progress`: at least one `task progress` recorded after `claim`.
- `done`: closed by the claiming role (`task done`); cannot be undone, though a later `task blocked` reopens it to `blocked`.
- `blocked`: `task blocked` recorded (from `open`, `claimed`, `in_progress`, or `done`). If unassigned (`asignado_a: null`), any role can recover it via `task claim` (`blocked -> claim -> claimed`); if already assigned, only the claiming role can resolve it via `task done` (`blocked -> done`).

**Role filtering (`--role`):** `canal task list --role <ROLE>` filters tasks by assignee (`asignado_a === <ROLE>`), matching `canal status --role <ROLE>`. Without `--role`, both return the full board.

```bash
canal task add      --repo gm0230199-design/canal --issue 1 --role AGENTE   --title "Construir módulo X" --body "Especificación..."
canal task list     --repo gm0230199-design/canal --issue 1 --role EJECUTOR
canal task show     --repo gm0230199-design/canal --issue 1 --id T-001
canal task claim    --repo gm0230199-design/canal --issue 1 --role EJECUTOR --id T-001
canal task progress --repo gm0230199-design/canal --issue 1 --role EJECUTOR --id T-001 --note "Avance parcial"
canal task done     --repo gm0230199-design/canal --issue 1 --role EJECUTOR --id T-001 --note "Pruebas en verde"
canal task blocked  --repo gm0230199-design/canal --issue 1 --role EJECUTOR --id T-002 --note "Falta credencial"
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
