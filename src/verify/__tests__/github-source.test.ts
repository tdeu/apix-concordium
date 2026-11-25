import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';
import { extractTar, parseGithubUrl } from '../../concordium/github-source';

describe('GitHub source', () => {
  it('accepts only https://github.com/owner/repo URLs', () => {
    expect(parseGithubUrl('https://github.com/tdeu/concordium-agent-safe').url).toBe('https://github.com/tdeu/concordium-agent-safe');
    expect(parseGithubUrl('https://github.com/tdeu/x.git/tree/main').ref).toBe('main');
    expect(() => parseGithubUrl('https://evil.example/tdeu/x')).toThrow();
    expect(() => parseGithubUrl('http://github.com/tdeu/x')).toThrow();
  });

  it('unpacks long paths and refuses path traversal', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apix-tar-'));
    const deep = path.join(tmp, 'src', 'a'.repeat(60), 'b'.repeat(60));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'f.ts'), 'ok');
    const archive = path.join(os.tmpdir(), `apix-${Date.now()}.tgz`);
    execFileSync('tar', ['--format=pax', '-czf', archive, '-C', tmp, 'src']);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'apix-out-'));
    extractTar(zlib.gunzipSync(fs.readFileSync(archive)), out);
    expect(fs.readFileSync(path.join(out, 'src', 'a'.repeat(60), 'b'.repeat(60), 'f.ts'), 'utf8')).toBe('ok');
  });
});
