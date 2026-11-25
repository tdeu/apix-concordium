// src/verify/common.ts
// Helpers shared by the code checks: what counts as browser code, a server route,
// authentication, an AI SDK, an amount guard, and following local imports.
import { CheckResult, Finding } from './types';
import { ProjectFiles, SourceFile, resolveImport, importsOf } from './files';

export interface RuleOutput {
  checks: CheckResult[];
  findings: Finding[];
}

export const AUTH_RE = /getServerSession|\bauth\s*\(\s*\)|currentUser\s*\(|@clerk\/|next-auth|verifyToken|jwt\.verify|jwtVerify|authorization|x-api-key|requireAuth|withAuth|getSession|supabase\.auth|verifySignature|verifyMessage|signMessage|timingSafeEqual|ratelimit|rateLimit/i;

export const LLM_IMPORT_RE = /from\s+['"](openai|@anthropic-ai\/sdk|ai|@ai-sdk\/[a-z-]+|langchain|@langchain\/[a-z-]+|@openai\/agents|@mastra\/[a-z-]+)['"]/;

export const AMOUNT_GUARD_RE = /MAX_[A-Z_]*(AMOUNT|SPEND|PAYMENT|TRANSFER)|LIMIT|Math\.min\s*\(|amount\s*[<>]=?|[<>]=?\s*amount|allowlist|allowList|ALLOWED_/;

export function isClientFile(file: SourceFile, project: ProjectFiles): boolean {
  if (/^\s*['"]use client['"]/m.test(file.content.slice(0, 400))) return true;
  const deps = { ...(project.packageJson?.dependencies ?? {}), ...(project.packageJson?.devDependencies ?? {}) };
  const isNext = 'next' in deps;
  const browserOnly = !isNext && ('vite' in deps || 'react-scripts' in deps) && !('express' in deps);
  if (browserOnly && /^(src\/)?/.test(file.path) && /\.(tsx?|jsx?)$/.test(file.path) && !/(^|\/)(server|api|scripts?)\//.test(file.path) && !/vite\.config|\.config\./.test(file.path)) {
    return true;
  }
  return /(^|\/)(components|hooks)\//.test(file.path) && /\.(tsx|jsx)$/.test(file.path);
}

export function isServerRoute(file: SourceFile): boolean {
  return /(^|\/)app\/(.+\/)?route\.(ts|js|mjs)$/.test(file.path)
    || /(^|\/)pages\/api\//.test(file.path)
    || /(^|\/)(api|server|functions)\/.+\.(ts|js|mjs)$/.test(file.path)
    || /\b(app|router)\.(post|put|patch|delete|all)\s*\(/.test(file.content);
}

export function isCode(file: SourceFile): boolean {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(file.path) && !/(^|\/)(__tests__|tests?)\/|\.(test|spec)\./.test(file.path);
}

const IMPORT_DEPTH = 4;
/** File plus the local modules it reaches through imports, a few levels deep (route -> service -> wallet). */
export function withImports(file: SourceFile, files: SourceFile[]): SourceFile[] {
  const out = [file];
  let frontier = [file];
  for (let depth = 0; depth < IMPORT_DEPTH && frontier.length > 0; depth++) {
    const next: SourceFile[] = [];
    for (const current of frontier) {
      for (const spec of importsOf(current)) {
        const target = resolveImport(files, current.path, spec);
        if (target && !out.includes(target)) {
          out.push(target);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return out;
}
