// src/verify/concordium-rules.ts
// Code checks for apps and agents that use Concordium. Each rule records one
// check, and failures carry a plain-words fix.
import { Finding, CheckResult } from './types';
import { ProjectFiles, SourceFile, isEnvFile } from './files';
import {
  RuleOutput, isClientFile, isServerRoute, isCode, withImports, AUTH_RE, LLM_IMPORT_RE, AMOUNT_GUARD_RE,
} from './common';

/** Evidence the code uses Concordium's JS stack */
const CCD_IMPORT_RE = /from\s+['"](@concordium\/[a-z-]+(\/[a-z-]+)?)['"]|require\(\s*['"]@concordium\/[a-z-]+['"]\s*\)/;
/** Code that signs Concordium transactions with a key it holds */
const CCD_SIGNER_RE = /buildAccountSigner|buildBasicAccountSigner|parseWallet\s*\(|signTransaction\s*\(|signAndFinalize|signAccountTransaction/;
/** Code that sends value or transactions */
const CCD_SEND_RE = /sendAccountTransaction|sendTransaction\s*\(|sendSignedTransaction|Transaction\.(transfer|updateContract|tokenUpdate)|AccountTransactionType\.(Transfer|Update)|TokenOperationType\.Transfer|Token\.transfer/;
/** A Concordium wallet export or a raw sign key */
const EXPORT_FILE_RE = /"type"\s*:\s*"concordium-(browser|mobile)-wallet|"accountKeys"\s*:\s*\{[\s\S]{0,400}"signKey"/;
const SIGN_KEY_LITERAL_RE = /signKey['"]?\s*[:=]\s*['"][0-9a-fA-F]{64}['"]/;
const SECRET_ENV_NAME_RE = /[A-Z0-9_]*(PRIVATE_KEY|SECRET_KEY|SIGN_KEY|SEED_PHRASE|MNEMONIC|WALLET_EXPORT)[A-Z0-9_]*/;
const PUBLIC_ENV_RE = /\b(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)[A-Z0-9_]*(PRIVATE_KEY|SECRET_KEY|SIGN_KEY|SEED_PHRASE|MNEMONIC|WALLET_EXPORT)[A-Z0-9_]*/g;
const MAINNET_RE = /grpc\.mainnet\.concordium|ccd:9dd9ca4d19e9393877d2c44b70f89acb|['"]mainnet['"]/;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

export function runConcordiumStaticRules(project: ProjectFiles): RuleOutput {
  const checks: CheckResult[] = [];
  const findings: Finding[] = [];
  const code = project.files.filter(isCode);
  const usesCcd = project.files.some(f => CCD_IMPORT_RE.test(f.content))
    || /@concordium\//.test(JSON.stringify(project.packageJson ?? {}));
  const signs = (f: SourceFile) => CCD_SIGNER_RE.test(f.content) || SECRET_ENV_NAME_RE.test(f.content);

  const record = (rule: string, title: string, found: Finding[], skipped?: string) => {
    if (skipped) {
      checks.push({ rule, title, status: 'skipped', note: skipped });
      return;
    }
    findings.push(...found);
    const status = found.some(f => f.severity === 'fail') ? 'failed' : found.some(f => f.severity === 'warn') ? 'warned' : 'passed';
    checks.push({ rule, title, status });
  };

  // 0. No Concordium code: the generic checks still run, but say so
  if (!usesCcd) {
    findings.push({
      rule: 'CCD-NOTHING-TO-CHECK', severity: 'warn',
      title: 'No Concordium code found',
      detail: 'The project does not import any @concordium package. Only the generic checks (keys, env files, routes, AI tools) ran.',
      fix: 'Run apix verify in the folder of the app or agent that uses Concordium.',
    });
    checks.push({ rule: 'CCD-NOTHING-TO-CHECK', title: 'The project contains Concordium code to check', status: 'warned' });
  } else {
    checks.push({ rule: 'CCD-NOTHING-TO-CHECK', title: 'The project contains Concordium code to check', status: 'passed' });
  }

  // 1. Wallet exports and sign keys in the repository
  {
    const found: Finding[] = [];
    for (const file of project.files) {
      if (file.ignored) continue;
      if (/\.export$/.test(file.path) || EXPORT_FILE_RE.test(file.content)) {
        found.push({
          rule: 'CCD-KEY-IN-REPO', severity: 'fail',
          title: 'Concordium wallet export in the repository',
          detail: `${file.path} holds an account's sign keys. Anyone who can read the repo can spend from that account.`,
          fix: 'Delete the file, add *.export to .gitignore, move the key to a secret store, and move the funds to a new account: a key that was in git is burned.',
          file: file.path,
        });
        continue;
      }
      const m = SIGN_KEY_LITERAL_RE.exec(file.content);
      if (m) {
        found.push({
          rule: 'CCD-KEY-IN-REPO', severity: 'fail',
          title: 'Sign key written in the code',
          detail: `${file.path} contains a 32-byte sign key as a literal.`,
          fix: 'Read the key from a server-side secret (environment variable or secret manager), never from the code.',
          file: file.path, line: lineOf(file.content, m.index),
        });
      }
    }
    record('CCD-KEY-IN-REPO', 'No Concordium keys or wallet exports in the repository', found);
  }

  // 2. Secrets committed in env files
  {
    const found: Finding[] = [];
    for (const file of project.files.filter(f => isEnvFile(f.path.split('/').pop() ?? ''))) {
      if (file.ignored || /\.example$|\.sample$|\.template$/.test(file.path)) continue;
      const m = new RegExp(`^\\s*(${SECRET_ENV_NAME_RE.source})\\s*=\\s*\\S{16,}`, 'm').exec(file.content);
      if (m) {
        found.push({
          rule: 'CCD-ENV-COMMITTED', severity: 'fail',
          title: 'Secret committed in an env file',
          detail: `${file.path} sets ${m[1]} and is not ignored by git, so it ships with the code.`,
          fix: 'Add the file to .gitignore, rotate the key, and keep only an .env.example with empty values.',
          file: file.path, line: lineOf(file.content, m.index),
        });
      }
    }
    record('CCD-ENV-COMMITTED', 'Env files with secrets are not committed', found);
  }

  // 3. Secrets exposed to the browser
  {
    const found: Finding[] = [];
    for (const file of project.files) {
      if (/(^|\/)(__tests__|tests?)\/|\.(test|spec)\./.test(file.path)) continue; // tests name keys on purpose
      PUBLIC_ENV_RE.lastIndex = 0;
      const m = PUBLIC_ENV_RE.exec(file.content);
      if (m) {
        found.push({
          rule: 'CCD-KEY-PUBLIC-ENV', severity: 'fail',
          title: 'Secret exposed to the browser',
          detail: `${file.path} uses ${m[0]}. Variables with that prefix are bundled into the page that every visitor downloads.`,
          fix: 'Rename it without the public prefix and only read it in server code.',
          file: file.path, line: lineOf(file.content, m.index),
        });
      }
    }
    record('CCD-KEY-PUBLIC-ENV', 'No secret is exposed through a public env variable', found);
  }

  // 4. Browser code that signs with a key it holds
  {
    const found: Finding[] = [];
    for (const file of code.filter(f => isClientFile(f, project))) {
      if (CCD_SIGNER_RE.test(file.content)) {
        found.push({
          rule: 'CCD-KEY-IN-CLIENT', severity: 'fail',
          title: 'Browser code handles a sign key',
          detail: `${file.path} runs in the browser and builds a signer from a key. The key travels to every visitor.`,
          fix: 'Let the user sign with their own wallet (Concordium Wallet for Web / WalletConnect), or sign on the server behind authentication.',
          file: file.path,
        });
      }
    }
    record('CCD-KEY-IN-CLIENT', 'Keys are only used in server code', found, usesCcd ? undefined : 'no Concordium code found');
  }

  // 5. Routes that sign or send without checking the caller or the amount
  {
    const found: Finding[] = [];
    for (const route of code.filter(isServerRoute)) {
      const scope = withImports(route, project.files);
      const signer = scope.find(f => signs(f) && CCD_SEND_RE.test(f.content)) ?? scope.find(signs);
      if (!signer) continue;
      const mutating = /export\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(route.content)
        || /\b(app|router)\.(post|put|patch|delete|all)\s*\(/.test(route.content)
        || /req\.method\s*===?\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(route.content);
      if (!mutating && !CCD_SEND_RE.test(route.content)) continue;
      if (!scope.some(f => AUTH_RE.test(f.content))) {
        found.push({
          rule: 'CCD-UNPROTECTED-SPEND-ROUTE', severity: 'fail',
          title: 'Anyone on the internet can make this route spend',
          detail: `${route.path} signs Concordium transactions with the app's key${signer !== route ? ` (through ${signer.path})` : ''} and nothing checks who is calling.`,
          fix: 'Require a signed-in user, a server-to-server secret or a verified payment (x402) before signing, and rate-limit the route.',
          file: route.path,
        });
      }
      const readsBody = /\b(req|request|r)\.(json|formData|text)\(\)|req\.body|req\.query|searchParams/.test(route.content);
      if (readsBody && !scope.some(f => AMOUNT_GUARD_RE.test(f.content))) {
        found.push({
          rule: 'CCD-UNPROTECTED-SPEND-ROUTE', severity: 'warn',
          title: 'Amount comes from the request with no cap',
          detail: `${route.path} takes input from the request and signs a transaction, with no maximum amount or allowlist in sight.`,
          fix: 'Validate amount and receiver against fixed limits on the server before signing.',
          file: route.path,
        });
      }
    }
    record('CCD-UNPROTECTED-SPEND-ROUTE', 'Routes that spend check who is calling and how much', found, usesCcd ? undefined : 'no Concordium code found');
  }

  // 6. AI tools that can move funds with no limit
  {
    const found: Finding[] = [];
    for (const file of code.filter(f => LLM_IMPORT_RE.test(f.content))) {
      const scope = withImports(file, project.files);
      const sender = scope.find(f => signs(f) && CCD_SEND_RE.test(f.content));
      if (!sender) continue;
      if (scope.some(f => AMOUNT_GUARD_RE.test(f.content))) continue;
      found.push({
        rule: 'CCD-AGENT-UNBOUNDED-SPEND', severity: 'fail',
        title: 'An AI model can spend with no limit',
        detail: `${file.path} gives a language model tools that sign and send Concordium transactions${sender !== file ? ` (via ${sender.path})` : ''}, with no amount limit or allowlist. A prompt injection or a bad loop can drain the account.`,
        fix: 'Cap each payment and the daily total in code the model cannot change, allowlist receivers, and keep only small amounts on the agent\'s account.',
        file: file.path,
      });
    }
    record('CCD-AGENT-UNBOUNDED-SPEND', 'AI tools that move funds are bounded', found, usesCcd ? undefined : 'no Concordium code found');
  }

  // 7. Mainnet hardcoded in code that spends
  {
    const found: Finding[] = [];
    for (const file of code.filter(f => CCD_SEND_RE.test(f.content))) {
      const m = MAINNET_RE.exec(file.content);
      if (m) {
        found.push({
          rule: 'CCD-MAINNET-HARDCODED', severity: 'warn',
          title: 'Mainnet is hardcoded in code that spends',
          detail: `${file.path} sends transactions and points at mainnet directly, so a test run spends real funds.`,
          fix: 'Read the network from configuration and default to testnet.',
          file: file.path, line: lineOf(file.content, m.index),
        });
      }
    }
    record('CCD-MAINNET-HARDCODED', 'The network comes from configuration', found, usesCcd ? undefined : 'no Concordium code found');
  }

  return { checks, findings };
}
