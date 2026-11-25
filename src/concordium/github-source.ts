// src/concordium/github-source.ts
// Fetches a public GitHub repository as a tarball and unpacks it into a temp folder,
// without git or a tar binary, so the verifier can run anywhere (laptop, serverless).
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

const MAX_TARBALL_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
  url: string;
}

/** Accepts https://github.com/owner/repo[.git][/tree/<ref>] only. */
export function parseGithubUrl(input: string, ref?: string): RepoRef {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('repo must be a URL like https://github.com/owner/repo');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error('Only public GitHub repositories are supported (https://github.com/owner/repo).');
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  const name = /^[A-Za-z0-9_.-]+$/;
  if (parts.length < 2 || !name.test(parts[0]) || !name.test(parts[1])) {
    throw new Error('repo must be a URL like https://github.com/owner/repo');
  }
  const repo = parts[1].replace(/\.git$/, '');
  const treeRef = parts[2] === 'tree' && parts[3] ? parts.slice(3).join('/') : undefined;
  const chosen = ref ?? treeRef;
  if (chosen !== undefined && !/^[A-Za-z0-9_./-]{1,100}$/.test(chosen)) throw new Error('Invalid ref.');
  return { owner: parts[0], repo, ref: chosen, url: `https://github.com/${parts[0]}/${repo}` };
}

/** Downloads and unpacks the repo; returns the folder to verify and a cleanup function. */
export async function fetchGithubRepo(repo: RepoRef): Promise<{ dir: string; commit?: string; cleanup: () => void }> {
  const tarUrl = `https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/${encodeURIComponent(repo.ref ?? 'HEAD')}`;
  const res = await fetch(tarUrl, { redirect: 'follow' });
  if (res.status === 404) throw new Error(`Repository not found or not public: ${repo.url}`);
  if (!res.ok) throw new Error(`Could not download ${repo.url} (HTTP ${res.status}).`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_TARBALL_BYTES) throw new Error('Repository archive is too large (max 25 MB).');
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_TARBALL_BYTES) throw new Error('Repository archive is too large (max 25 MB).');
  const tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_TARBALL_BYTES * 8 });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apix-verify-'));
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  let commit: string | undefined;
  try {
    commit = extractTar(tar, root).commit;
  } catch (error) {
    cleanup();
    throw error;
  }
  // GitHub archives hold one top-level folder: owner-repo-<sha>/
  const entries = fs.readdirSync(root);
  const dir = entries.length === 1 && fs.statSync(path.join(root, entries[0])).isDirectory() ? path.join(root, entries[0]) : root;
  return { dir, commit, cleanup };
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/**
 * Minimal ustar + pax reader: regular files only, paths kept inside the target folder.
 * Returns the commit GitHub records in the archive's global header (pax "comment").
 */
export function extractTar(tar: Buffer, target: string): { commit?: string } {
  let commit: string | undefined;
  let offset = 0;
  let paxPath: string | undefined;
  const base = path.resolve(target);
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const name = readString(header, 0, 100);
    const size = parseInt(readString(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = readString(header, 345, 155);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
      paxPath = m?.[1];
      continue;
    }
    if (type === 'g') {
      const m = /\d+ comment=([0-9a-f]{40})\n/.exec(data.toString('utf8'));
      if (m) commit = m[1];
      continue;
    }
    const fullName = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = undefined;
    if (type !== '0' && type !== '\0') continue; // directories, links: skip
    if (size > MAX_FILE_BYTES) continue;
    const dest = path.resolve(base, fullName);
    if (!dest.startsWith(base + path.sep)) continue; // no path traversal
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  return { commit };
}

/**
 * Current commit of a public repo's default branch (or of a branch/tag), read like
 * `git ls-remote` does (smart HTTP ref advertisement): no GitHub API, no rate limit.
 */
export async function latestCommit(repo: RepoRef): Promise<string> {
  const res = await fetch(`https://github.com/${repo.owner}/${repo.repo}.git/info/refs?service=git-upload-pack`, {
    headers: { 'user-agent': 'git/2.40 apix-concordium' },
  });
  if (!res.ok) throw new Error(`Could not read the refs of ${repo.url} (HTTP ${res.status}).`);
  const text = await res.text();
  const refs = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /([0-9a-f]{40}) ([^\s\0]+)/.exec(line);
    if (m) refs.set(m[2], m[1]);
  }
  const want = repo.ref;
  if (!want) {
    const head = refs.get('HEAD');
    if (head) return head;
  } else {
    if (/^[0-9a-f]{40}$/.test(want)) return want;
    for (const name of [`refs/heads/${want}`, `refs/tags/${want}^{}`, `refs/tags/${want}`]) {
      const sha = refs.get(name);
      if (sha) return sha;
    }
  }
  throw new Error(`Could not find ${want ?? 'HEAD'} in ${repo.url}.`);
}
