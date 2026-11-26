import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const VALID_ROLES = new Set(['AGENTE', 'EJECUTOR']);
export const DEFAULT_API_BASE = 'https://api.github.com';
export const DEFAULT_STATE_FILE = '.canal-state.json';

export class CanalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CanalError';
  }
}

const GITHUB_TOKEN_PATTERN =
  /(?:gh[pousr]|github_pat)_(?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2}){20,}/g;
const TRUNCATED_TOKEN_PATTERN =
  /(?:gh[pousr]|github_pat)_[A-Za-z0-9_]*\.{2,}[A-Za-z0-9_]+/g;

export function sanitizeSecrets(text, token) {
  let str = String(text ?? '');
  if (token) {
    const candidates = new Set([token]);
    try {
      candidates.add(encodeURIComponent(token));
      candidates.add(encodeURI(token));
    } catch {
      // Ignore malformed URI encoding edge cases.
    }
    for (const candidate of candidates) {
      if (candidate) {
        str = str.split(candidate).join('[REDACTED]');
      }
    }
  }
  str = str.replace(GITHUB_TOKEN_PATTERN, '[REDACTED]');
  str = str.replace(TRUNCATED_TOKEN_PATTERN, '[REDACTED]');
  return str;
}

export function getToken(env = process.env) {
  const raw = env?.GH_TOKEN || env?.GITHUB_TOKEN || '';
  const token = String(raw).trim();
  if (!token) {
    throw new CanalError(
      'Missing authentication token: set GH_TOKEN or GITHUB_TOKEN in the environment.'
    );
  }
  return token;
}

export function validateRole(role) {
  if (!VALID_ROLES.has(role)) {
    throw new CanalError(`Invalid role "${role}". Expected AGENTE or EJECUTOR.`);
  }
  return role;
}

export function getOppositeRole(role) {
  validateRole(role);
  return role === 'AGENTE' ? 'EJECUTOR' : 'AGENTE';
}

export function validateRepo(repo) {
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo.trim())) {
    throw new CanalError(`Invalid --repo "${repo}". Expected <owner/repo>.`);
  }
  const [owner, name] = repo.trim().split('/');
  return { repo: `${owner}/${name}`, owner, name };
}

export function validateIssue(issue) {
  const num = typeof issue === 'number' ? issue : Number(String(issue ?? '').trim());
  if (!Number.isInteger(num) || num <= 0) {
    throw new CanalError(`Invalid --issue "${issue}". Expected a positive integer.`);
  }
  return num;
}

export function validateTaskId(taskId) {
  const val = String(taskId ?? '').trim();
  if (!/^T-\d{3}$/.test(val)) {
    throw new CanalError(`Invalid --id "${taskId}". Expected format T-XXX (3 digits, e.g. T-001).`);
  }
  return val;
}

export function validateCommentId(commentId) {
  const num =
    typeof commentId === 'number' ? commentId : Number(String(commentId ?? '').trim());
  if (!Number.isInteger(num) || num <= 0) {
    throw new CanalError(`Invalid --to "${commentId}". Expected a positive integer comment id.`);
  }
  return num;
}

export function parseCommentMeta(body) {
  if (typeof body !== 'string') {
    return { role: null, replyTo: null, isAck: false, task: null };
  }
  const normalized = body.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const firstLine = lines[0].trimStart();
  const trimmedFirstLine = firstLine.trim();
  const roleMatch = firstLine.match(/^\[(AGENTE|EJECUTOR)\](?:$|\s)/);
  const role = roleMatch ? roleMatch[1] : null;

  const hasReplyToken = /\breply-to:/.test(trimmedFirstLine);
  const hasTaskToken = /\btask:/.test(trimmedFirstLine);

  let replyTo = null;
  let isAck = false;
  let task = null;

  // A comment cannot mix reply-to: and task: on the first line.
  if (!(hasReplyToken && hasTaskToken)) {
    const replyMatch = trimmedFirstLine.match(/^\[(?:AGENTE|EJECUTOR)\]\s+reply-to:(\d+)$/);
    if (replyMatch) {
      replyTo = Number(replyMatch[1]);
      const rest = lines.slice(1).join('\n').trim();
      isAck = /^ack(?::\s*.*)?$/i.test(rest);
    } else if (role) {
      const taskMatch = trimmedFirstLine.match(
        /^\[(?:AGENTE|EJECUTOR)\]\s+task:(T-\d{3})(?:\s+(claim|progress|done|blocked))?$/
      );
      if (taskMatch) {
        task = {
          id: taskMatch[1],
          event: taskMatch[2] || 'add'
        };
      }
    }
  }

  return { role, replyTo, isAck, task };
}

export function detectCommentRole(body) {
  return parseCommentMeta(body).role;
}

export function ensureRolePrefix(body, role) {
  validateRole(role);
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new CanalError('Comment body cannot be empty.');
  }
  const normalized = body.replace(/\r\n/g, '\n');
  const trimmedStart = normalized.replace(/^\s+/, '');
  const detected = detectCommentRole(trimmedStart);
  if (detected === role) {
    return trimmedStart;
  }
  if (detected && detected !== role) {
    throw new CanalError(
      `Body starts with [${detected}], which does not match --role ${role}.`
    );
  }
  return `[${role}] ${trimmedStart}`;
}

export function stripRolePrefixForReply(body, role) {
  validateRole(role);
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new CanalError('Comment body cannot be empty.');
  }
  const normalized = body.replace(/\r\n/g, '\n').replace(/^\s+/, '');
  const detected = detectCommentRole(normalized);
  if (detected && detected !== role) {
    throw new CanalError(
      `Body starts with [${detected}], which does not match --role ${role}.`
    );
  }
  let clean = normalized;
  if (detected === role) {
    clean = normalized.slice(`[${role}]`.length).replace(/^[ \t]*\n?/, '').trimStart();
  }
  if (clean.trim().length === 0) {
    throw new CanalError('Comment body cannot be empty.');
  }
  return clean;
}

export function parseNextLink(linkHeader) {
  if (!linkHeader || typeof linkHeader !== 'string') return null;
  const parts = linkHeader.split(',');
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*([^]*)/);
    if (!match) continue;
    const url = match[1];
    const params = match[2];
    if (/rel=["']?next["']?/i.test(params)) {
      return url;
    }
  }
  return null;
}

export function computeBodyHash({ repo, issue, body }) {
  return createHash('sha256').update(`${repo}#${issue}\n${body}`, 'utf8').digest('hex');
}

function emptyState() {
  return {
    postedHashes: {},
    cursors: {},
    repliesTo: {},
    acks: {},
    answered: {},
    taskEvents: {}
  };
}

export async function loadState(stateFile = DEFAULT_STATE_FILE) {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    const base = emptyState();
    if (!parsed || typeof parsed !== 'object') return base;
    for (const key of Object.keys(base)) {
      if (parsed[key] && typeof parsed[key] === 'object') {
        base[key] = parsed[key];
      }
    }
    return base;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return emptyState();
    }
    throw new CanalError(`Failed to read state file "${stateFile}": ${err.message}`);
  }
}

export async function saveState(stateFile = DEFAULT_STATE_FILE, state) {
  const resolved = path.resolve(stateFile);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, resolved);
}

function buildHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'canal-cli/0.1.0',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

export async function fetchAllComments({
  repo,
  issue,
  token,
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_BASE
}) {
  const { owner, name } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  if (typeof fetchImpl !== 'function') {
    throw new CanalError('fetch implementation is not available.');
  }

  let nextUrl = `${apiBase.replace(/\/+$/, '')}/repos/${owner}/${name}/issues/${issueNum}/comments?per_page=100`;
  const visited = new Set();
  const all = [];

  while (nextUrl) {
    if (visited.has(nextUrl)) {
      throw new CanalError('Pagination loop detected while fetching comments.');
    }
    visited.add(nextUrl);

    let res;
    try {
      res = await fetchImpl(nextUrl, {
        method: 'GET',
        headers: buildHeaders(token)
      });
    } catch (err) {
      throw new CanalError(
        `Network error fetching comments: ${sanitizeSecrets(err?.message || err, token)}`
      );
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        detail = '';
      }
      const cleanDetail = sanitizeSecrets(detail.slice(0, 300), token);
      throw new CanalError(
        `GitHub API error (${res.status}) while reading comments${cleanDetail ? `: ${cleanDetail}` : ''}`
      );
    }

    const pageData = await res.json();
    if (!Array.isArray(pageData)) {
      throw new CanalError('Unexpected GitHub API response: expected array of comments.');
    }
    all.push(...pageData);
    nextUrl = parseNextLink(res.headers?.get?.('link'));
  }

  return all;
}

export async function readComments({
  repo,
  issue,
  role,
  sinceId,
  stateFile = DEFAULT_STATE_FILE,
  updateCursor = true,
  useSavedCursor = false,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const token = getToken(env);
  const targetRole = getOppositeRole(role);

  let effectiveSinceId = 0;
  if (sinceId !== undefined && sinceId !== null && String(sinceId).trim() !== '') {
    const parsed = Number(sinceId);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new CanalError(`Invalid --since-id "${sinceId}". Expected a non-negative integer.`);
    }
    effectiveSinceId = parsed;
  } else if (useSavedCursor && stateFile) {
    const state = await loadState(stateFile);
    effectiveSinceId = Number(state.cursors[`${normalizedRepo}#${issueNum}:${role}`] || 0);
  }

  const rawComments = await fetchAllComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });

  const filtered = rawComments
    .filter((c) => c && detectCommentRole(c.body) === targetRole)
    .filter((c) => (effectiveSinceId > 0 ? Number(c.id) > effectiveSinceId : true))
    .map((c) => ({
      id: c.id,
      created_at: c.created_at,
      body: c.body
    }))
    .sort((a, b) => {
      const timeDiff = Date.parse(a.created_at) - Date.parse(b.created_at);
      if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff;
      return Number(a.id) - Number(b.id);
    });

  if (updateCursor && stateFile && filtered.length > 0) {
    const state = await loadState(stateFile);
    const cursorKey = `${normalizedRepo}#${issueNum}:${role}`;
    const prev = Number(state.cursors[cursorKey] || 0);
    const maxId = filtered.reduce((acc, item) => Math.max(acc, Number(item.id)), prev);
    if (maxId > prev) {
      state.cursors[cursorKey] = maxId;
      await saveState(stateFile, state);
    }
  }

  return filtered;
}

export async function ensureIssueOpen({
  repo,
  issue,
  token,
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo, owner, name } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  if (typeof fetchImpl !== 'function') {
    throw new CanalError('fetch implementation is not available.');
  }

  const url = `${apiBase.replace(/\/+$/, '')}/repos/${owner}/${name}/issues/${issueNum}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: buildHeaders(token)
    });
  } catch (err) {
    throw new CanalError(
      `Network error checking issue: ${sanitizeSecrets(err?.message || err, token)}`
    );
  }

  if (res.status === 404) {
    throw new CanalError(`Issue #${issueNum} not found in ${normalizedRepo}.`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    const cleanDetail = sanitizeSecrets(detail.slice(0, 300), token);
    throw new CanalError(
      `GitHub API error (${res.status}) while checking issue #${issueNum}${cleanDetail ? `: ${cleanDetail}` : ''}`
    );
  }

  const issueData = await res.json();
  if (issueData && issueData.state && issueData.state !== 'open') {
    throw new CanalError(`Issue #${issueNum} in ${normalizedRepo} is ${issueData.state}.`);
  }
  return issueData;
}

export async function postComment({
  repo,
  issue,
  role,
  body,
  stateFile = DEFAULT_STATE_FILE,
  stateSection = 'postedHashes',
  idempotencyKey,
  extraState,
  advanceCursorTo,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo, owner, name } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const token = getToken(env);
  const prefixedBody = ensureRolePrefix(body, role);
  const keyMaterial =
    idempotencyKey !== undefined
      ? String(idempotencyKey)
      : `${normalizedRepo}#${issueNum}\n${prefixedBody}`;
  const hash = createHash('sha256').update(keyMaterial, 'utf8').digest('hex');

  const state = stateFile ? await loadState(stateFile) : emptyState();
  const sectionMap =
    state[stateSection] && typeof state[stateSection] === 'object'
      ? state[stateSection]
      : (state[stateSection] = {});
  const existing = sectionMap[hash];
  if (existing) {
    return {
      id: existing.commentId ?? null,
      created_at: existing.created_at ?? null,
      body: prefixedBody,
      skipped: true,
      duplicate: true,
      hash
    };
  }

  if (typeof fetchImpl !== 'function') {
    throw new CanalError('fetch implementation is not available.');
  }

  await ensureIssueOpen({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });

  const url = `${apiBase.replace(/\/+$/, '')}/repos/${owner}/${name}/issues/${issueNum}/comments`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...buildHeaders(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ body: prefixedBody })
    });
  } catch (err) {
    throw new CanalError(
      `Network error posting comment: ${sanitizeSecrets(err?.message || err, token)}`
    );
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    const cleanDetail = sanitizeSecrets(detail.slice(0, 300), token);
    throw new CanalError(
      `GitHub API error (${res.status}) while posting comment${cleanDetail ? `: ${cleanDetail}` : ''}`
    );
  }

  const created = await res.json();
  if (stateFile) {
    sectionMap[hash] = {
      repo: normalizedRepo,
      issue: issueNum,
      commentId: created.id,
      created_at: created.created_at,
      ...(extraState || {})
    };
    if (extraState && extraState.to !== undefined) {
      const answeredKey = `${normalizedRepo}#${issueNum}:${role}`;
      if (!state.answered[answeredKey] || typeof state.answered[answeredKey] !== 'object') {
        state.answered[answeredKey] = {};
      }
      state.answered[answeredKey][String(extraState.to)] = {
        commentId: created.id,
        type: stateSection === 'acks' ? 'ack' : 'reply',
        created_at: created.created_at
      };
    }
    if (advanceCursorTo !== undefined && advanceCursorTo !== null) {
      const cursorKey = `${normalizedRepo}#${issueNum}:${role}`;
      const prev = Number(state.cursors[cursorKey] || 0);
      if (Number(advanceCursorTo) > prev) {
        state.cursors[cursorKey] = Number(advanceCursorTo);
      }
    }
    await saveState(stateFile, state);
  }

  return {
    id: created.id,
    created_at: created.created_at,
    body: created.body ?? prefixedBody,
    skipped: false,
    duplicate: false,
    hash
  };
}

export async function resolveTargetComment({
  repo,
  issue,
  to,
  role,
  token,
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo, owner, name } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  const targetId = validateCommentId(to);
  validateRole(role);
  if (typeof fetchImpl !== 'function') {
    throw new CanalError('fetch implementation is not available.');
  }

  const url = `${apiBase.replace(/\/+$/, '')}/repos/${owner}/${name}/issues/comments/${targetId}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: buildHeaders(token)
    });
  } catch (err) {
    throw new CanalError(
      `Network error fetching comment ${targetId}: ${sanitizeSecrets(err?.message || err, token)}`
    );
  }

  if (res.status === 404) {
    throw new CanalError(`Comment ${targetId} not found in ${normalizedRepo}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      detail = '';
    }
    const cleanDetail = sanitizeSecrets(detail.slice(0, 300), token);
    throw new CanalError(
      `GitHub API error (${res.status}) while reading comment ${targetId}${cleanDetail ? `: ${cleanDetail}` : ''}`
    );
  }

  const comment = await res.json();
  if (comment && typeof comment.issue_url === 'string') {
    const expectedSuffix = `/issues/${issueNum}`;
    if (!comment.issue_url.endsWith(expectedSuffix)) {
      throw new CanalError(
        `Comment ${targetId} does not belong to issue #${issueNum} in ${normalizedRepo}.`
      );
    }
  }

  const originalRole = detectCommentRole(comment?.body);
  if (originalRole === role) {
    throw new CanalError(
      `Comment ${targetId} was posted by ${role}, not the opposite role`
    );
  }
  const expectedOpposite = getOppositeRole(role);
  if (originalRole !== expectedOpposite) {
    throw new CanalError(
      `Comment ${targetId} was not posted by ${expectedOpposite}.`
    );
  }

  return comment;
}

export async function replyComment({
  repo,
  issue,
  role,
  to,
  body,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const targetId = validateCommentId(to);
  const token = getToken(env);
  const cleanBody = stripRolePrefixForReply(body, role);

  await resolveTargetComment({
    repo: normalizedRepo,
    issue: issueNum,
    to: targetId,
    role,
    token,
    fetchImpl,
    apiBase
  });

  const formattedBody = `[${role}] reply-to:${targetId}\n\n${cleanBody}`;
  const idempotencyKey = `${normalizedRepo}#${issueNum}->${targetId}\n${cleanBody}`;

  return postComment({
    repo: normalizedRepo,
    issue: issueNum,
    role,
    body: formattedBody,
    stateFile,
    stateSection: 'repliesTo',
    idempotencyKey,
    extraState: { to: targetId },
    advanceCursorTo: targetId,
    fetchImpl,
    env,
    apiBase
  });
}

export async function ackComment({
  repo,
  issue,
  role,
  to,
  note,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const targetId = validateCommentId(to);
  const token = getToken(env);

  const trimmedNote = note !== undefined && note !== null ? String(note).trim() : '';
  const ackBody = trimmedNote ? `ack: ${trimmedNote}` : 'ack';

  await resolveTargetComment({
    repo: normalizedRepo,
    issue: issueNum,
    to: targetId,
    role,
    token,
    fetchImpl,
    apiBase
  });

  const formattedBody = `[${role}] reply-to:${targetId}\n\n${ackBody}`;
  const idempotencyKey = `${normalizedRepo}#${issueNum}->${targetId}\n${ackBody}`;

  return postComment({
    repo: normalizedRepo,
    issue: issueNum,
    role,
    body: formattedBody,
    stateFile,
    stateSection: 'acks',
    idempotencyKey,
    extraState: { to: targetId, note: trimmedNote || null },
    fetchImpl,
    env,
    apiBase
  });
}

function parseTaskAddBody(body) {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const spec = lines.slice(1).join('\n').trim();
  const nonEmpty = spec
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  let title = '';
  if (nonEmpty.length > 0) {
    const titleMatch = nonEmpty[0].match(/^Title:\s*(.+)$/i);
    title = titleMatch ? titleMatch[1].trim() : nonEmpty[0];
  }
  return { title, spec };
}

function getBodyAfterHeader(body) {
  const normalized = String(body ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  return lines.slice(1).join('\n').trim();
}

export function deriveTasksFromComments(sortedComments) {
  const tasks = new Map();

  for (const comment of sortedComments) {
    const meta = parseCommentMeta(comment?.body);
    if (!meta.task || !meta.role) continue;

    const { id: taskId, event } = meta.task;
    const role = meta.role;

    if (event === 'add') {
      if (tasks.has(taskId)) continue;
      const { title, spec } = parseTaskAddBody(comment.body);
      tasks.set(taskId, {
        id: taskId,
        title,
        estado: 'open',
        asignado_a: null,
        creado_en: comment.created_at,
        creado_por: role,
        ultimo_avance: null,
        bloqueado_en: null,
        done_by: null,
        spec,
        events: [
          {
            id: comment.id,
            type: 'add',
            role,
            created_at: comment.created_at,
            note: null
          }
        ]
      });
      continue;
    }

    const task = tasks.get(taskId);
    if (!task) continue;

    const note = getBodyAfterHeader(comment.body) || null;

    if (event === 'claim') {
      if (task.estado === 'open') {
        task.estado = 'claimed';
        task.asignado_a = role;
        task.bloqueado_en = null;
        task.events.push({
          id: comment.id,
          type: 'claim',
          role,
          created_at: comment.created_at,
          note: null
        });
      }
      continue;
    }

    if (event === 'progress') {
      if (task.estado === 'claimed' || task.estado === 'in_progress') {
        task.estado = 'in_progress';
        task.ultimo_avance = {
          id: comment.id,
          role,
          created_at: comment.created_at,
          note
        };
        task.events.push({
          id: comment.id,
          type: 'progress',
          role,
          created_at: comment.created_at,
          note
        });
      }
      continue;
    }

    if (event === 'done') {
      if (
        (task.estado === 'claimed' ||
          task.estado === 'in_progress' ||
          task.estado === 'blocked') &&
        task.asignado_a === role
      ) {
        task.estado = 'done';
        task.done_by = role;
        task.bloqueado_en = null;
        task.events.push({
          id: comment.id,
          type: 'done',
          role,
          created_at: comment.created_at,
          note
        });
      }
      continue;
    }

    if (event === 'blocked') {
      task.estado = 'blocked';
      task.bloqueado_en = {
        id: comment.id,
        role,
        created_at: comment.created_at,
        reason: note
      };
      task.events.push({
        id: comment.id,
        type: 'blocked',
        role,
        created_at: comment.created_at,
        note
      });
    }
  }

  return tasks;
}

export function formatTaskSummary(task) {
  return {
    id: task.id,
    title: task.title,
    estado: task.estado,
    asignado_a: task.asignado_a,
    creado_en: task.creado_en,
    ultimo_avance: task.ultimo_avance,
    ...(task.bloqueado_en ? { bloqueado_en: task.bloqueado_en } : {})
  };
}

export function formatTaskBoard(tasksMap) {
  return [...tasksMap.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(formatTaskSummary);
}

async function fetchSortedComments({ repo, issue, token, fetchImpl, apiBase }) {
  const rawComments = await fetchAllComments({
    repo,
    issue,
    token,
    fetchImpl,
    apiBase
  });

  return [...rawComments].sort((a, b) => {
    const timeDiff = Date.parse(a.created_at) - Date.parse(b.created_at);
    if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff;
    return Number(a.id) - Number(b.id);
  });
}

export async function statusIssue({
  repo,
  issue,
  role,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  if (role !== undefined && role !== null && String(role).trim() !== '') {
    validateRole(role);
  } else {
    role = undefined;
  }
  const token = getToken(env);

  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });

  const annotated = sorted.map((c) => ({
    comment: c,
    meta: parseCommentMeta(c?.body)
  }));

  const byRole = { AGENTE: 0, EJECUTOR: 0, sin_prefijo: 0 };
  const lastByRole = { AGENTE: null, EJECUTOR: null };

  for (const { comment, meta } of annotated) {
    if (meta.role === 'AGENTE' || meta.role === 'EJECUTOR') {
      byRole[meta.role] += 1;
      lastByRole[meta.role] = {
        id: comment.id,
        created_at: comment.created_at,
        body: String(comment.body ?? '').slice(0, 120)
      };
    } else {
      byRole.sin_prefijo += 1;
    }
  }

  function hasReplyAfter(idx, targetId, responderRole) {
    for (let j = idx + 1; j < annotated.length; j += 1) {
      const candidate = annotated[j];
      if (candidate.meta.role === responderRole && candidate.meta.replyTo === targetId) {
        return true;
      }
    }
    return false;
  }

  function computeUnansweredFor(responderRole) {
    const senderRole = getOppositeRole(responderRole);
    const ids = [];
    for (let i = 0; i < annotated.length; i += 1) {
      const { comment, meta } = annotated[i];
      if (meta.role !== senderRole) continue;
      if (!hasReplyAfter(i, Number(comment.id), responderRole)) {
        ids.push(comment.id);
      }
    }
    return ids;
  }

  function computePendingEchoFor(authorRole) {
    const responderRole = getOppositeRole(authorRole);
    const ids = [];
    for (let i = 0; i < annotated.length; i += 1) {
      const { comment, meta } = annotated[i];
      if (meta.role !== authorRole || meta.isAck) continue;
      if (!hasReplyAfter(i, Number(comment.id), responderRole)) {
        ids.push(comment.id);
      }
    }
    return ids;
  }

  const tasksMap = deriveTasksFromComments(sorted);

  return {
    repo: normalizedRepo,
    issue: issueNum,
    ...(role ? { role } : {}),
    comments_total: annotated.length,
    by_role: byRole,
    last_by_role: lastByRole,
    unanswered: role
      ? computeUnansweredFor(role)
      : {
          AGENTE: computeUnansweredFor('AGENTE'),
          EJECUTOR: computeUnansweredFor('EJECUTOR')
        },
    pending_echo: role
      ? computePendingEchoFor(role)
      : {
          AGENTE: computePendingEchoFor('AGENTE'),
          EJECUTOR: computePendingEchoFor('EJECUTOR')
        },
    tasks: formatTaskBoard(tasksMap)
  };
}

export async function taskList({
  repo,
  issue,
  role,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  if (role !== undefined && role !== null && String(role).trim() !== '') {
    validateRole(role);
  }
  const token = getToken(env);
  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });
  return formatTaskBoard(deriveTasksFromComments(sorted));
}

export async function taskShow({
  repo,
  issue,
  id,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  const taskId = validateTaskId(id);
  const token = getToken(env);
  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });
  const tasksMap = deriveTasksFromComments(sorted);
  const task = tasksMap.get(taskId);
  if (!task) {
    throw new CanalError(`Task ${taskId} not found in ${normalizedRepo}#${issueNum}.`);
  }
  return {
    ...formatTaskSummary(task),
    creado_por: task.creado_por,
    spec: task.spec,
    events: task.events
  };
}

function nextTaskId(tasksMap) {
  let maxNum = 0;
  for (const key of tasksMap.keys()) {
    const n = Number(key.slice(2));
    if (Number.isInteger(n) && n > maxNum) {
      maxNum = n;
    }
  }
  const next = maxNum + 1;
  if (next > 999) {
    throw new CanalError('Task ID limit reached (T-999).');
  }
  return `T-${String(next).padStart(3, '0')}`;
}

export async function taskAdd({
  repo,
  issue,
  role,
  title,
  body = '',
  id,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const trimmedTitle = String(title ?? '').trim();
  if (!trimmedTitle) {
    throw new CanalError('Task --title cannot be empty.');
  }
  const token = getToken(env);
  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });
  const tasksMap = deriveTasksFromComments(sorted);

  let taskId;
  if (id !== undefined && id !== null && String(id).trim() !== '') {
    taskId = validateTaskId(id);
    if (tasksMap.has(taskId)) {
      throw new CanalError(`Task ${taskId} already exists`);
    }
  } else {
    taskId = nextTaskId(tasksMap);
  }

  const trimmedBody = String(body ?? '').replace(/\r\n/g, '\n').trim();
  const formattedBody = trimmedBody
    ? `[${role}] task:${taskId}\n\nTitle: ${trimmedTitle}\n\n${trimmedBody}`
    : `[${role}] task:${taskId}\n\nTitle: ${trimmedTitle}`;

  const result = await postComment({
    repo: normalizedRepo,
    issue: issueNum,
    role,
    body: formattedBody,
    stateFile,
    stateSection: 'taskEvents',
    idempotencyKey: `${normalizedRepo}#${issueNum}:task:${taskId}:add`,
    extraState: { taskId, event: 'add' },
    fetchImpl,
    env,
    apiBase
  });

  return { ...result, taskId };
}

export async function taskClaim({
  repo,
  issue,
  role,
  id,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const taskId = validateTaskId(id);
  const token = getToken(env);

  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });
  const tasksMap = deriveTasksFromComments(sorted);
  const task = tasksMap.get(taskId);
  if (!task) {
    throw new CanalError(`Task ${taskId} not found in ${normalizedRepo}#${issueNum}.`);
  }

  if (task.estado === 'claimed' && task.asignado_a === role) {
    const claimEv = [...task.events].reverse().find((e) => e.type === 'claim');
    return {
      id: claimEv?.id ?? null,
      created_at: claimEv?.created_at ?? null,
      body: `[${role}] task:${taskId} claim`,
      skipped: true,
      duplicate: true,
      taskId
    };
  }

  if (task.estado !== 'open') {
    if (task.asignado_a && (task.estado === 'claimed' || task.estado === 'in_progress')) {
      throw new CanalError(`Task ${taskId} is already claimed by ${task.asignado_a}`);
    }
    throw new CanalError(`Task ${taskId} is already ${task.estado}`);
  }

  const formattedBody = `[${role}] task:${taskId} claim`;
  const result = await postComment({
    repo: normalizedRepo,
    issue: issueNum,
    role,
    body: formattedBody,
    stateFile,
    stateSection: 'taskEvents',
    idempotencyKey: `${normalizedRepo}#${issueNum}:task:${taskId}:claim:${role}`,
    extraState: { taskId, event: 'claim' },
    fetchImpl,
    env,
    apiBase
  });

  return { ...result, taskId };
}

export async function taskProgress({
  repo,
  issue,
  role,
  id,
  note,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const taskId = validateTaskId(id);
  const cleanNote = String(note ?? '').replace(/\r\n/g, '\n').trim();
  if (!cleanNote) {
    throw new CanalError('Task progress requires a non-empty --note.');
  }
  const token = getToken(env);

  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });
  const tasksMap = deriveTasksFromComments(sorted);
  const task = tasksMap.get(taskId);
  if (!task) {
    throw new CanalError(`Task ${taskId} not found in ${normalizedRepo}#${issueNum}.`);
  }

  if (task.estado !== 'claimed' && task.estado !== 'in_progress') {
    throw new CanalError(
      `Task ${taskId} cannot record progress in state "${task.estado}" (must be claimed or in_progress).`
    );
  }

  const formattedBody = `[${role}] task:${taskId} progress\n\n${cleanNote}`;
  const result = await postComment({
    repo: normalizedRepo,
    issue: issueNum,
    role,
    body: formattedBody,
    stateFile,
    stateSection: 'taskEvents',
    idempotencyKey: `${normalizedRepo}#${issueNum}:task:${taskId}:progress:${role}\n${cleanNote}`,
    extraState: { taskId, event: 'progress' },
    fetchImpl,
    env,
    apiBase
  });

  return { ...result, taskId };
}

export async function taskDone({
  repo,
  issue,
  role,
  id,
  note,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const taskId = validateTaskId(id);
  const token = getToken(env);

  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });
  const tasksMap = deriveTasksFromComments(sorted);
  const task = tasksMap.get(taskId);
  if (!task) {
    throw new CanalError(`Task ${taskId} not found in ${normalizedRepo}#${issueNum}.`);
  }

  if (task.asignado_a && task.asignado_a !== role) {
    throw new CanalError(
      `Task ${taskId} was claimed by ${task.asignado_a}; only the claiming role can close it`
    );
  }

  if (task.estado === 'done' && task.done_by === role) {
    const doneEv = [...task.events].reverse().find((e) => e.type === 'done');
    return {
      id: doneEv?.id ?? null,
      created_at: doneEv?.created_at ?? null,
      body: `[${role}] task:${taskId} done`,
      skipped: true,
      duplicate: true,
      taskId
    };
  }

  if (
    task.estado !== 'claimed' &&
    task.estado !== 'in_progress' &&
    !(task.estado === 'blocked' && task.asignado_a === role)
  ) {
    throw new CanalError(
      `Task ${taskId} cannot be marked done in state "${task.estado}".`
    );
  }

  const cleanNote = note !== undefined && note !== null ? String(note).replace(/\r\n/g, '\n').trim() : '';
  const formattedBody = cleanNote
    ? `[${role}] task:${taskId} done\n\n${cleanNote}`
    : `[${role}] task:${taskId} done`;

  const lastEventId = task.events.length > 0 ? task.events[task.events.length - 1].id : 0;

  const result = await postComment({
    repo: normalizedRepo,
    issue: issueNum,
    role,
    body: formattedBody,
    stateFile,
    stateSection: 'taskEvents',
    idempotencyKey: `${normalizedRepo}#${issueNum}:task:${taskId}:done:${role}:after:${lastEventId}`,
    extraState: { taskId, event: 'done' },
    fetchImpl,
    env,
    apiBase
  });

  return { ...result, taskId };
}

export async function taskBlocked({
  repo,
  issue,
  role,
  id,
  note,
  stateFile = DEFAULT_STATE_FILE,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const taskId = validateTaskId(id);
  const cleanNote = String(note ?? '').replace(/\r\n/g, '\n').trim();
  if (!cleanNote) {
    throw new CanalError('Task blocked requires a non-empty --note.');
  }
  const token = getToken(env);

  const sorted = await fetchSortedComments({
    repo: normalizedRepo,
    issue: issueNum,
    token,
    fetchImpl,
    apiBase
  });
  const tasksMap = deriveTasksFromComments(sorted);
  const task = tasksMap.get(taskId);
  if (!task) {
    throw new CanalError(`Task ${taskId} not found in ${normalizedRepo}#${issueNum}.`);
  }

  const lastEventId = task.events.length > 0 ? task.events[task.events.length - 1].id : 0;
  const formattedBody = `[${role}] task:${taskId} blocked\n\n${cleanNote}`;
  const result = await postComment({
    repo: normalizedRepo,
    issue: issueNum,
    role,
    body: formattedBody,
    stateFile,
    stateSection: 'taskEvents',
    idempotencyKey: `${normalizedRepo}#${issueNum}:task:${taskId}:blocked:${role}:after:${lastEventId}\n${cleanNote}`,
    extraState: { taskId, event: 'blocked' },
    fetchImpl,
    env,
    apiBase
  });

  return { ...result, taskId };
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export async function watchComments({
  repo,
  issue,
  role,
  intervalSec = 5,
  sinceId,
  stateFile = DEFAULT_STATE_FILE,
  onBatch,
  signal,
  maxPolls = Infinity,
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE,
  sleepImpl = defaultSleep
}) {
  const { repo: normalizedRepo } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const interval = Number(intervalSec);
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new CanalError(`Invalid --interval "${intervalSec}". Expected a positive number of seconds.`);
  }
  getToken(env);

  const cursorKey = `${normalizedRepo}#${issueNum}:${role}`;
  let cursor = 0;
  if (sinceId !== undefined && sinceId !== null && String(sinceId).trim() !== '') {
    const parsed = Number(sinceId);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new CanalError(`Invalid --since-id "${sinceId}". Expected a non-negative integer.`);
    }
    cursor = parsed;
  } else if (stateFile) {
    const state = await loadState(stateFile);
    cursor = Number(state.cursors[cursorKey] || 0);
  }

  let polls = 0;
  while (!signal?.aborted && polls < maxPolls) {
    polls += 1;
    const batch = await readComments({
      repo: normalizedRepo,
      issue: issueNum,
      role,
      sinceId: cursor,
      stateFile,
      updateCursor: true,
      fetchImpl,
      env,
      apiBase
    });

    if (batch.length > 0) {
      cursor = Number(batch[batch.length - 1].id);
      if (typeof onBatch === 'function') {
        await onBatch(batch);
      }
    }

    if (signal?.aborted || polls >= maxPolls) break;
    await sleepImpl(interval * 1000, signal);
  }
}
