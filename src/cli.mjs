#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  CanalError,
  DEFAULT_STATE_FILE,
  postComment,
  readComments,
  sanitizeSecrets,
  watchComments
} from './canal.mjs';

export const HELP_TEXT = `canal — GitHub Issue communication CLI for agents

Usage:
  canal read  --repo <owner/repo> --issue <n> --role <AGENTE|EJECUTOR> [--since-id <id>] [--state-file <path>]
  canal post  --repo <owner/repo> --issue <n> --role <AGENTE|EJECUTOR> (--body <text> | --body-file <path>) [--state-file <path>]
  canal watch --repo <owner/repo> --issue <n> --role <AGENTE|EJECUTOR> [--interval <sec>] [--since-id <id>] [--state-file <path>] [--once]
  canal --help

Environment:
  GH_TOKEN or GITHUB_TOKEN   Required GitHub personal/app access token (never stored in files)

Notes:
  - read  Prints JSON array of comments from the opposite role in ascending chronological order.
  - post  Enforces [AGENTE] or [EJECUTOR] on the first line and deduplicates via SHA-256 hash in .canal-state.json.
  - watch Polls every --interval seconds (default: 5) and emits new comments from the opposite role as JSON.
`;

export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return { command: 'help', flags: {} };
  }

  const command = args.shift();
  const flags = {};

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      return { command: 'help', flags };
    }
    if (!arg.startsWith('--')) {
      throw new CanalError(`Unexpected argument "${arg}". Run with --help for usage.`);
    }
    const eqIndex = arg.indexOf('=');
    let key;
    let value;
    if (eqIndex !== -1) {
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      if (key === 'once') {
        value = true;
      } else {
        if (args.length === 0 || args[0].startsWith('--')) {
          throw new CanalError(`Missing value for --${key}.`);
        }
        value = args.shift();
      }
    }
    flags[key] = value;
  }

  return { command, flags };
}

function requireFlag(flags, name) {
  const val = flags[name];
  if (val === undefined || val === null || val === '' || val === true) {
    throw new CanalError(`Missing required flag --${name}.`);
  }
  return String(val);
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const fetchImpl = io.fetchImpl || globalThis.fetch;

  try {
    const { command, flags } = parseArgs(argv);

    if (command === 'help') {
      stdout.write(HELP_TEXT);
      return 0;
    }

    const stateFile = flags['state-file'] ? String(flags['state-file']) : DEFAULT_STATE_FILE;

    if (command === 'read') {
      const repo = requireFlag(flags, 'repo');
      const issue = requireFlag(flags, 'issue');
      const role = requireFlag(flags, 'role');
      const sinceId = flags['since-id'];
      const comments = await readComments({
        repo,
        issue,
        role,
        sinceId,
        stateFile,
        fetchImpl,
        env
      });
      stdout.write(`${JSON.stringify(comments, null, 2)}\n`);
      return 0;
    }

    if (command === 'post') {
      const repo = requireFlag(flags, 'repo');
      const issue = requireFlag(flags, 'issue');
      const role = requireFlag(flags, 'role');
      const hasBody = flags.body !== undefined;
      const hasBodyFile = flags['body-file'] !== undefined;

      if (hasBody === hasBodyFile) {
        throw new CanalError('Specify exactly one of --body or --body-file.');
      }

      let body;
      if (hasBodyFile) {
        const filePath = requireFlag(flags, 'body-file');
        try {
          body = await fs.readFile(filePath, 'utf8');
        } catch (err) {
          throw new CanalError(`Failed to read --body-file "${filePath}": ${err.message}`);
        }
      } else {
        body = requireFlag(flags, 'body');
      }

      const result = await postComment({
        repo,
        issue,
        role,
        body,
        stateFile,
        fetchImpl,
        env
      });
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    if (command === 'watch') {
      const repo = requireFlag(flags, 'repo');
      const issue = requireFlag(flags, 'issue');
      const role = requireFlag(flags, 'role');
      const intervalSec = flags.interval !== undefined ? Number(flags.interval) : 5;
      const sinceId = flags['since-id'];
      const controller = io.abortController || new AbortController();

      const onSignal = () => controller.abort();
      if (!io.abortController) {
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
      }

      try {
        await watchComments({
          repo,
          issue,
          role,
          intervalSec,
          sinceId,
          stateFile,
          signal: controller.signal,
          maxPolls: flags.once ? 1 : Infinity,
          fetchImpl,
          env,
          onBatch: (batch) => {
            stdout.write(`${JSON.stringify(batch)}\n`);
          }
        });
      } finally {
        if (!io.abortController) {
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
        }
      }
      return 0;
    }

    throw new CanalError(`Unknown command "${command}". Run with --help for usage.`);
  } catch (err) {
    const rawToken = env?.GH_TOKEN || env?.GITHUB_TOKEN || '';
    const message = sanitizeSecrets(err?.message || String(err), rawToken);
    stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

let isMain = false;
if (process.argv[1]) {
  try {
    isMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    isMain = false;
  }
}

if (isMain) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
