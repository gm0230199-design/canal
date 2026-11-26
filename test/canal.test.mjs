import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  ackComment,
  CanalError,
  ensureRolePrefix,
  loadState,
  postComment,
  readComments,
  replyComment,
  sanitizeSecrets,
  statusIssue,
  watchComments
} from '../src/canal.mjs';
import { runCli } from '../src/cli.mjs';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, '../src/cli.mjs');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canal-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeResponse(body, { status = 200, headers = {} } = {}) {
  const map = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return map.get(String(name).toLowerCase()) ?? null;
      }
    },
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

test('ensureRolePrefix prepends prefix when missing and preserves multiline body', () => {
  const out = ensureRolePrefix('línea 1\nlínea 2', 'EJECUTOR');
  assert.equal(out, '[EJECUTOR] línea 1\nlínea 2');

  const already = ensureRolePrefix('[AGENTE] orden lista\ndetalle', 'AGENTE');
  assert.equal(already, '[AGENTE] orden lista\ndetalle');

  assert.throws(
    () => ensureRolePrefix('[AGENTE] spoof', 'EJECUTOR'),
    CanalError
  );
  assert.throws(() => ensureRolePrefix('   \n  ', 'AGENTE'), CanalError);
});

test('readComments excludes own role, sorts chronologically, and respects sinceId', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    const comments = [
      {
        id: 30,
        created_at: '2026-11-26T04:02:00Z',
        body: '[AGENTE] segundo mensaje'
      },
      {
        id: 20,
        created_at: '2026-11-26T04:01:00Z',
        body: '[EJECUTOR] respuesta propia que debe excluirse'
      },
      {
        id: 10,
        created_at: '2026-11-26T04:00:00Z',
        body: '[AGENTE] primer mensaje'
      },
      {
        id: 25,
        created_at: '2026-11-26T04:01:30Z',
        body: 'comentario sin prefijo'
      }
    ];

    const fetchImpl = async () => makeResponse(comments);

    const all = await readComments({
      repo: 'gm0230199-design/canal',
      issue: 1,
      role: 'EJECUTOR',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });

    assert.deepEqual(all, [
      {
        id: 10,
        created_at: '2026-11-26T04:00:00Z',
        body: '[AGENTE] primer mensaje'
      },
      {
        id: 30,
        created_at: '2026-11-26T04:02:00Z',
        body: '[AGENTE] segundo mensaje'
      }
    ]);

    const since = await readComments({
      repo: 'gm0230199-design/canal',
      issue: 1,
      role: 'EJECUTOR',
      sinceId: 10,
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });

    assert.deepEqual(since, [
      {
        id: 30,
        created_at: '2026-11-26T04:02:00Z',
        body: '[AGENTE] segundo mensaje'
      }
    ]);
  });
});

test('readComments traverses all API pages using Link rel=next', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    const seenUrls = [];

    const fetchImpl = async (url) => {
      seenUrls.push(url);
      if (url.includes('page=2')) {
        return makeResponse(
          [
            {
              id: 2,
              created_at: '2026-11-26T04:01:00Z',
              body: '[EJECUTOR] página 2'
            }
          ],
          {
            headers: {
              Link: '<https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=3>; rel="next"'
            }
          }
        );
      }
      if (url.includes('page=3')) {
        return makeResponse([
          {
            id: 3,
            created_at: '2026-11-26T04:02:00Z',
            body: '[EJECUTOR] página 3'
          }
        ]);
      }
      return makeResponse(
        [
          {
            id: 1,
            created_at: '2026-11-26T04:00:00Z',
            body: '[EJECUTOR] página 1'
          }
        ],
        {
          headers: {
            Link: '<https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=3>; rel="last"'
          }
        }
      );
    };

    const result = await readComments({
      repo: 'o/r',
      issue: 1,
      role: 'AGENTE',
      stateFile,
      fetchImpl,
      env: { GITHUB_TOKEN: 'dummy-token' }
    });

    assert.equal(seenUrls.length, 3);
    assert.deepEqual(
      result.map((c) => c.id),
      [1, 2, 3]
    );
  });
});

test('postComment enforces idempotency via state file and allows retry after network failure', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    let postCalls = 0;
    let shouldFail = true;

    const fetchImpl = async (url, opts) => {
      if (opts.method === 'GET' && url.endsWith('/issues/1')) {
        return makeResponse({ number: 1, state: 'open' }, { status: 200 });
      }
      assert.equal(opts.method, 'POST');
      const payload = JSON.parse(opts.body);
      assert.ok(payload.body.startsWith('[EJECUTOR] '));
      postCalls += 1;
      if (shouldFail) {
        throw new Error('ECONNRESET');
      }
      return makeResponse(
        {
          id: 501,
          created_at: '2026-11-26T04:10:00Z',
          body: payload.body
        },
        { status: 201 }
      );
    };

    await assert.rejects(
      () =>
        postComment({
          repo: 'o/r',
          issue: 1,
          role: 'EJECUTOR',
          body: 'PR listo',
          stateFile,
          fetchImpl,
          env: { GH_TOKEN: 'dummy-token' }
        }),
      /Network error/
    );
    assert.equal(postCalls, 1);

    shouldFail = false;
    const firstSuccess = await postComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      body: 'PR listo',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(firstSuccess.skipped, false);
    assert.equal(firstSuccess.id, 501);
    assert.equal(postCalls, 2);

    const duplicate = await postComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      body: '[EJECUTOR] PR listo',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(duplicate.skipped, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.id, 501);
    assert.equal(postCalls, 2);
  });
});

test('postComment validates that issue exists and is open before posting', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    let postCalls = 0;

    const fetchImpl = async (url, opts) => {
      if (opts.method === 'POST') {
        postCalls += 1;
        return makeResponse({ id: 999 }, { status: 201 });
      }
      if (url.endsWith('/issues/999999')) {
        return makeResponse({ message: 'Not Found' }, { status: 404 });
      }
      if (url.endsWith('/issues/2')) {
        return makeResponse({ number: 2, state: 'closed' }, { status: 200 });
      }
      return makeResponse({ number: 1, state: 'open' }, { status: 200 });
    };

    await assert.rejects(
      () =>
        postComment({
          repo: 'o/r',
          issue: 999999,
          role: 'EJECUTOR',
          body: 'no debe publicarse',
          stateFile,
          fetchImpl,
          env: { GH_TOKEN: 'dummy-token' }
        }),
      /Issue #999999 not found in o\/r/
    );

    await assert.rejects(
      () =>
        postComment({
          repo: 'o/r',
          issue: 2,
          role: 'EJECUTOR',
          body: 'issue cerrado',
          stateFile,
          fetchImpl,
          env: { GH_TOKEN: 'dummy-token' }
        }),
      /Issue #2 in o\/r is closed/
    );

    assert.equal(postCalls, 0);
  });
});

test('watchComments emits only new comments since cursor', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    let poll = 0;
    const emitted = [];

    const fetchImpl = async () => {
      poll += 1;
      if (poll === 1) {
        return makeResponse([
          { id: 100, created_at: '2026-11-26T04:00:00Z', body: '[AGENTE] msg 1' }
        ]);
      }
      return makeResponse([
        { id: 100, created_at: '2026-11-26T04:00:00Z', body: '[AGENTE] msg 1' },
        { id: 101, created_at: '2026-11-26T04:00:05Z', body: '[AGENTE] msg 2' }
      ]);
    };

    await watchComments({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      intervalSec: 0.01,
      maxPolls: 2,
      stateFile,
      fetchImpl,
      sleepImpl: async () => {},
      env: { GH_TOKEN: 'dummy-token' },
      onBatch: (batch) => emitted.push(batch)
    });

    assert.equal(emitted.length, 2);
    assert.deepEqual(
      emitted[0].map((c) => c.id),
      [100]
    );
    assert.deepEqual(
      emitted[1].map((c) => c.id),
      [101]
    );
  });
});

test('CLI fails with non-zero exit code and does not leak token when GH_TOKEN is missing or on API error', async () => {
  let out = '';
  let err = '';
  const codeMissing = await runCli(
    ['read', '--repo', 'o/r', '--issue', '1', '--role', 'EJECUTOR'],
    {
      env: {},
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) }
    }
  );
  assert.notEqual(codeMissing, 0);
  assert.equal(out, '');
  assert.match(err, /GH_TOKEN|GITHUB_TOKEN/);

  const secret = 'ghp_SUPERSECRETVALUE123456';
  let errApi = '';
  const codeApiErr = await runCli(
    ['read', '--repo', 'o/r', '--issue', '1', '--role', 'EJECUTOR'],
    {
      env: { GH_TOKEN: secret },
      fetchImpl: async () =>
        makeResponse(`Bad token ${secret}`, { status: 401 }),
      stdout: { write: () => {} },
      stderr: { write: (s) => (errApi += s) }
    }
  );
  assert.notEqual(codeApiErr, 0);
  assert.ok(!errApi.includes(secret), 'Token must never appear in error output');
  assert.ok(errApi.includes('[REDACTED]'));
});

test('sanitizeSecrets redacts literal, URL-encoded, pattern-matched, and truncated tokens', () => {
  const secretWithSymbols = 'ghp_12345/67890:abcdefghij123456';
  const encoded = encodeURIComponent(secretWithSymbols);
  assert.match(encoded, /%2F/);
  assert.match(encoded, /%3A/);

  const msg = [
    `literal=${secretWithSymbols}`,
    `encoded=${encoded}`,
    'truncated=ghp_...A1B2',
    'truncated_pat=github_pat_11AA...9Z8Y',
    'other_gho=gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
    'other_ghu=ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
    'other_ghs=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
    'other_ghr=ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
    'other_pat=github_pat_11ABCDEFGH_IJKLMNOPQRSTUVWXYZ12'
  ].join(' ');

  const sanitized = sanitizeSecrets(msg, secretWithSymbols);
  assert.ok(!sanitized.includes(secretWithSymbols));
  assert.ok(!sanitized.includes(encoded));
  assert.ok(!sanitized.includes('A1B2'));
  assert.ok(!sanitized.includes('9Z8Y'));
  assert.ok(!sanitized.includes('gho_'));
  assert.ok(!sanitized.includes('ghu_'));
  assert.ok(!sanitized.includes('ghs_'));
  assert.ok(!sanitized.includes('ghr_'));
  assert.ok(!sanitized.includes('github_pat_'));
  assert.equal(
    sanitized,
    'literal=[REDACTED] encoded=[REDACTED] truncated=[REDACTED] truncated_pat=[REDACTED] other_gho=[REDACTED] other_ghu=[REDACTED] other_ghs=[REDACTED] other_ghr=[REDACTED] other_pat=[REDACTED]'
  );
});

test('CLI --help exits 0 without stack traces and --body-file works', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, '--help'], {
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' }
  });
  assert.match(stdout, /Usage:/);
  assert.equal(stderr, '');
  assert.doesNotMatch(stdout, /\bat\s+.*\(.+:\d+:\d+\)/);

  await withTempDir(async (dir) => {
    const bodyFile = path.join(dir, 'msg.txt');
    const stateFile = path.join(dir, '.canal-state.json');
    await fs.writeFile(bodyFile, 'primera línea\nsegunda línea', 'utf8');

    let out = '';
    let err = '';
    const code = await runCli(
      [
        'post',
        '--repo',
        'o/r',
        '--issue',
        '1',
        '--role',
        'EJECUTOR',
        '--body-file',
        bodyFile,
        '--state-file',
        stateFile
      ],
      {
        env: { GH_TOKEN: 'dummy-token' },
        fetchImpl: async (url, opts) => {
          if (opts.method === 'GET' && url.endsWith('/issues/1')) {
            return makeResponse({ number: 1, state: 'open' }, { status: 200 });
          }
          const payload = JSON.parse(opts.body);
          return makeResponse(
            { id: 99, created_at: '2026-11-26T04:15:00Z', body: payload.body },
            { status: 201 }
          );
        },
        stdout: { write: (s) => (out += s) },
        stderr: { write: (s) => (err += s) }
      }
    );

    assert.equal(code, 0);
    assert.equal(err, '');
    const parsed = JSON.parse(out);
    assert.equal(parsed.body, '[EJECUTOR] primera línea\nsegunda línea');
  });
});

test('replyComment composes exact header, updates cursor, and avoids collision with plain post', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    const postedBodies = [];
    let nextId = 800;

    const fetchImpl = async (url, opts) => {
      if (opts.method === 'GET' && url.endsWith('/issues/comments/123')) {
        return makeResponse(
          {
            id: 123,
            issue_url: 'https://api.github.com/repos/o/r/issues/1',
            body: '[AGENTE] orden original'
          },
          { status: 200 }
        );
      }
      if (opts.method === 'GET' && url.endsWith('/issues/1')) {
        return makeResponse({ number: 1, state: 'open' }, { status: 200 });
      }
      assert.equal(opts.method, 'POST');
      const payload = JSON.parse(opts.body);
      postedBodies.push(payload.body);
      nextId += 1;
      return makeResponse(
        { id: nextId, created_at: '2026-11-26T05:00:00Z', body: payload.body },
        { status: 201 }
      );
    };

    const res = await replyComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 123,
      body: 'cuerpo exacto\nsegunda línea',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });

    assert.equal(res.skipped, false);
    assert.equal(
      postedBodies[0],
      '[EJECUTOR] reply-to:123\n\ncuerpo exacto\nsegunda línea'
    );

    const stateAfterReply = await loadState(stateFile);
    assert.equal(stateAfterReply.cursors['o/r#1:EJECUTOR'], 123);

    // Plain post with the exact same text must NOT be treated as duplicate of a reply
    const plainPost = await postComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      body: 'cuerpo exacto\nsegunda línea',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(plainPost.skipped, false);
    assert.equal(postedBodies.length, 2);
  });
});

test('replyComment fails without POST when target comment does not exist or belongs to own role', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    let postCalls = 0;

    const fetchImpl = async (url, opts) => {
      if (opts.method === 'POST') {
        postCalls += 1;
        return makeResponse({ id: 999 }, { status: 201 });
      }
      if (url.endsWith('/issues/comments/404')) {
        return makeResponse({ message: 'Not Found' }, { status: 404 });
      }
      if (url.endsWith('/issues/comments/555')) {
        return makeResponse(
          {
            id: 555,
            issue_url: 'https://api.github.com/repos/o/r/issues/1',
            body: '[EJECUTOR] mensaje propio'
          },
          { status: 200 }
        );
      }
      return makeResponse({ number: 1, state: 'open' }, { status: 200 });
    };

    await assert.rejects(
      () =>
        replyComment({
          repo: 'o/r',
          issue: 1,
          role: 'EJECUTOR',
          to: 404,
          body: 'no debe salir',
          stateFile,
          fetchImpl,
          env: { GH_TOKEN: 'dummy-token' }
        }),
      /Comment 404 not found in o\/r/
    );

    await assert.rejects(
      () =>
        replyComment({
          repo: 'o/r',
          issue: 1,
          role: 'EJECUTOR',
          to: 555,
          body: 'autorespuesta prohibida',
          stateFile,
          fetchImpl,
          env: { GH_TOKEN: 'dummy-token' }
        }),
      /Comment 555 was posted by EJECUTOR, not the opposite role/
    );

    assert.equal(postCalls, 0);
  });
});

test('replyComment deduplicates same to+body, allows same body to different to, and handles role prefixes', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    const postedBodies = [];

    const fetchImpl = async (url, opts) => {
      if (opts.method === 'GET' && /\/issues\/comments\/(10|20)$/.test(url)) {
        const id = Number(url.split('/').pop());
        return makeResponse(
          {
            id,
            issue_url: 'https://api.github.com/repos/o/r/issues/1',
            body: '[AGENTE] orden'
          },
          { status: 200 }
        );
      }
      if (opts.method === 'GET' && url.endsWith('/issues/1')) {
        return makeResponse({ number: 1, state: 'open' }, { status: 200 });
      }
      const payload = JSON.parse(opts.body);
      postedBodies.push(payload.body);
      return makeResponse(
        { id: 700 + postedBodies.length, created_at: '2026-11-26T05:01:00Z', body: payload.body },
        { status: 201 }
      );
    };

    // Strip own prefix [EJECUTOR] without duplicating
    const r1 = await replyComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 10,
      body: '[EJECUTOR] hecho',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(r1.skipped, false);
    assert.equal(postedBodies[0], '[EJECUTOR] reply-to:10\n\nhecho');

    // Same to + same body (without prefix) -> duplicate, skipped
    const r1Dup = await replyComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 10,
      body: 'hecho',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(r1Dup.skipped, true);
    assert.equal(postedBodies.length, 1);

    // Different to + same body -> NOT duplicate, posted
    const r2 = await replyComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 20,
      body: 'hecho',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(r2.skipped, false);
    assert.equal(postedBodies[1], '[EJECUTOR] reply-to:20\n\nhecho');
    assert.equal(postedBodies.length, 2);

    // Body with opposite role prefix fails
    await assert.rejects(
      () =>
        replyComment({
          repo: 'o/r',
          issue: 1,
          role: 'EJECUTOR',
          to: 10,
          body: '[AGENTE] suplantacion',
          stateFile,
          fetchImpl,
          env: { GH_TOKEN: 'dummy-token' }
        }),
      /does not match --role EJECUTOR/
    );
    assert.equal(postedBodies.length, 2);
  });
});

test('ackComment posts once per to+note, allows different note, and does not advance read cursor', async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, '.canal-state.json');
    const postedBodies = [];

    const fetchImpl = async (url, opts) => {
      if (opts.method === 'GET' && url.endsWith('/issues/comments/321')) {
        return makeResponse(
          {
            id: 321,
            issue_url: 'https://api.github.com/repos/o/r/issues/1',
            body: '[AGENTE] revisa esto'
          },
          { status: 200 }
        );
      }
      if (opts.method === 'GET' && url.endsWith('/issues/1')) {
        return makeResponse({ number: 1, state: 'open' }, { status: 200 });
      }
      const payload = JSON.parse(opts.body);
      postedBodies.push(payload.body);
      return makeResponse(
        { id: 900 + postedBodies.length, created_at: '2026-11-26T05:02:00Z', body: payload.body },
        { status: 201 }
      );
    };

    const a1 = await ackComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 321,
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(a1.skipped, false);
    assert.equal(postedBodies[0], '[EJECUTOR] reply-to:321\n\nack');

    // Duplicate ack without note -> skipped
    const a1Dup = await ackComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 321,
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(a1Dup.skipped, true);
    assert.equal(postedBodies.length, 1);

    // Ack with distinct note -> posted
    const a2 = await ackComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 321,
      note: 'en progreso',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(a2.skipped, false);
    assert.equal(postedBodies[1], '[EJECUTOR] reply-to:321\n\nack: en progreso');

    // Same note again -> skipped
    const a2Dup = await ackComment({
      repo: 'o/r',
      issue: 1,
      role: 'EJECUTOR',
      to: 321,
      note: 'en progreso',
      stateFile,
      fetchImpl,
      env: { GH_TOKEN: 'dummy-token' }
    });
    assert.equal(a2Dup.skipped, true);
    assert.equal(postedBodies.length, 2);

    // Read cursor must NOT have advanced
    const state = await loadState(stateFile);
    assert.equal(state.cursors['o/r#1:EJECUTOR'], undefined);
  });
});

test('statusIssue counts roles including unprefixed, finds unanswered/pending_echo, and makes 0 POST calls', async () => {
  let postCalls = 0;
  const comments = [
    {
      id: 1,
      created_at: '2026-11-26T04:00:00Z',
      body: '[AGENTE] primera orden'
    },
    {
      id: 2,
      created_at: '2026-11-26T04:01:00Z',
      body: '[EJECUTOR] reply-to:1\n\nprimera orden hecha'
    },
    {
      id: 3,
      created_at: '2026-11-26T04:02:00Z',
      body: 'comentario humano sin prefijo'
    },
    {
      id: 4,
      created_at: '2026-11-26T04:03:00Z',
      body: `[AGENTE] segunda orden ${'x'.repeat(150)}`
    },
    {
      id: 5,
      created_at: '2026-11-26T04:04:00Z',
      body: '[EJECUTOR] mensaje propio esperando eco'
    }
  ];

  const fetchImpl = async (_url, opts) => {
    if (opts?.method && opts.method !== 'GET') {
      postCalls += 1;
    }
    return makeResponse(comments, { status: 200 });
  };

  let out = '';
  let err = '';
  const code = await runCli(
    ['status', '--repo', 'o/r', '--issue', '1', '--role', 'EJECUTOR'],
    {
      env: { GH_TOKEN: 'read-only-token' },
      fetchImpl,
      stdout: { write: (s) => (out += s) },
      stderr: { write: (s) => (err += s) }
    }
  );

  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(postCalls, 0);

  const summary = JSON.parse(out);
  assert.equal(summary.comments_total, 5);
  assert.deepEqual(summary.by_role, { AGENTE: 2, EJECUTOR: 2, sin_prefijo: 1 });
  assert.equal(summary.last_by_role.AGENTE.id, 4);
  assert.equal(summary.last_by_role.AGENTE.body.length, 120);
  assert.equal(summary.last_by_role.EJECUTOR.id, 5);
  assert.deepEqual(summary.unanswered, [4]);
  assert.deepEqual(summary.pending_echo, [2, 5]);
});

test(
  'E2E integration (CANAL_E2E=1): creates temporary issue, posts, reads back, and cleans up',
  {
    skip:
      process.env.CANAL_E2E !== '1' ||
      !(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
  },
  async () => {
    const repo = process.env.CANAL_E2E_REPO || 'gm0230199-design/canal';
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'canal-e2e-test/0.1.0',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    const createRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: '[E2E TEST] canal temporary integration test',
        body: 'Temporary issue created by CANAL_E2E=1 test; will be closed immediately.'
      })
    });
    assert.equal(createRes.status, 201);
    const issueData = await createRes.json();
    const issueNum = issueData.number;
    let commentId = null;

    try {
      await withTempDir(async (dir) => {
        const stateFile = path.join(dir, '.canal-state.json');
        const uniqueMsg = `e2e-probe-${Date.now()}`;

        const posted = await postComment({
          repo,
          issue: issueNum,
          role: 'AGENTE',
          body: uniqueMsg,
          stateFile
        });
        commentId = posted.id;
        assert.equal(posted.skipped, false);

        const readBack = await readComments({
          repo,
          issue: issueNum,
          role: 'EJECUTOR',
          stateFile
        });
        assert.ok(readBack.some((c) => c.id === commentId && c.body.includes(uniqueMsg)));
      });
    } finally {
      if (commentId) {
        await fetch(
          `https://api.github.com/repos/${repo}/issues/comments/${commentId}`,
          { method: 'DELETE', headers }
        );
      }
      await fetch(`https://api.github.com/repos/${repo}/issues/${issueNum}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' })
      });
    }
  }
);
