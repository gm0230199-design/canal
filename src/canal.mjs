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

export function detectCommentRole(body) {
  if (typeof body !== 'string') return null;
  const firstLine = body.replace(/\r\n/g, '\n').split('\n', 1)[0].trimStart();
  const match = firstLine.match(/^\[(AGENTE|EJECUTOR)\](?:$|\s)/);
  return match ? match[1] : null;
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

export async function loadState(stateFile = DEFAULT_STATE_FILE) {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      postedHashes:
        parsed && typeof parsed.postedHashes === 'object' && parsed.postedHashes
          ? parsed.postedHashes
          : {},
      cursors:
        parsed && typeof parsed.cursors === 'object' && parsed.cursors
          ? parsed.cursors
          : {}
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { postedHashes: {}, cursors: {} };
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
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiBase = DEFAULT_API_BASE
}) {
  const { repo: normalizedRepo, owner, name } = validateRepo(repo);
  const issueNum = validateIssue(issue);
  validateRole(role);
  const token = getToken(env);
  const prefixedBody = ensureRolePrefix(body, role);
  const hash = computeBodyHash({
    repo: normalizedRepo,
    issue: issueNum,
    body: prefixedBody
  });

  const state = stateFile ? await loadState(stateFile) : { postedHashes: {}, cursors: {} };
  const existing = state.postedHashes[hash];
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
    state.postedHashes[hash] = {
      repo: normalizedRepo,
      issue: issueNum,
      commentId: created.id,
      created_at: created.created_at
    };
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
