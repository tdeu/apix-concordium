// src/cli/concordium-commands.ts
// `apix concordium ...`: Agent Registry (CIS-8004) on Concordium.
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { AccountAddress } from '@concordium/web-sdk';
import { networkConfig, txLink } from '../concordium/config';
import { loadWallet, bigintSafe } from '../concordium/chain';
import { attestOnConcordium, readAttestation } from '../concordium/attest';
import { createVerifierServer } from '../concordium/server';
import { LocalFacilitator, payFor, ccdExplorerTx } from '../concordium/payment';
import { latestCommit, parseGithubUrl } from '../concordium/github-source';
import { reportHash } from '../verify/report';
import { VerifyReport } from '../verify/types';
import {
  agentsByOwner, APIX_SKILLS, buildCard, checkBadge, checkHostedCard, contractInfo, pinCard, registerAgent, sha256Hex,
} from '../concordium/registry';

function run(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(chalk.red(`❌ ${error instanceof Error ? error.message : String(error)}`));
      process.exitCode = 1;
    }
  };
}

const print = (value: unknown) => console.log(JSON.stringify(value, bigintSafe, 2));

/** Refuses key files that sit inside a git repository (they must never be committed). */
function assertKeyOutsideRepo(keyFile: string): void {
  let dir = path.dirname(path.resolve(keyFile));
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      throw new Error(`Key file ${keyFile} is inside a git repository (${dir}). Move it outside any repo.`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function registerConcordiumCommands(program: Command, apixVersion = 'dev'): void {
  const ccd = program.command('concordium').description('Concordium: Agent Registry and badge, on-chain attestations, x402 verifier service and client');

  ccd
    .command('info')
    .description('Show the Agent Registry contracts for a network (from the hosted MCP server)')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async options => {
      print(await contractInfo(networkConfig(options.network)));
    }));

  ccd
    .command('card')
    .description('Build an Agent Card with build_agent_card and write the exact bytes to host')
    .requiredOption('--name <name>', 'Agent name')
    .requiredOption('--description <text>', 'What the agent does')
    .requiredOption('--url <agentUri>', 'Public URL where the card will be hosted')
    .requiredOption('--owner <account>', 'Concordium owner account (Base58)')
    .option('--provider <org>', 'Organisation operating the agent', 'Emtée Studio')
    .option('--provider-url <url>', 'Provider website')
    .option('--token-id <n>', 'Token id from register (second pass: fills the badge)')
    .option('--no-skills', 'Leave the APIX Verifier skills out of the card')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .option('--out <file>', 'Where to write the card', 'agent-card.json')
    .action(run(async options => {
      const cfg = networkConfig(options.network);
      const card = await buildCard(cfg, {
        name: options.name,
        description: options.description,
        agentUri: options.url,
        ownerAccount: options.owner,
        provider: { organization: options.provider, ...(options.providerUrl ? { url: options.providerUrl } : {}) },
        ...(options.skills ? { skills: APIX_SKILLS } : {}),
        ...(options.tokenId !== undefined ? { tokenId: Number(options.tokenId) } : {}),
      });
      fs.writeFileSync(options.out, card.text);
      const rawFile = path.join(process.cwd(), 'agent-card.raw.json');
      fs.writeFileSync(rawFile, JSON.stringify(card.raw, null, 2));
      console.log(chalk.green(`✅ Wrote ${options.out}`));
      console.log(`SHA-256: ${card.sha256}`);
      const notes = (card.raw as { notes?: unknown })?.notes;
      if (notes) console.log(chalk.gray(`Notes from the registry: ${JSON.stringify(notes)}`));
      console.log(chalk.gray(`Raw tool output kept in ${rawFile} (debugging only, do not host it).`));
      console.log(options.tokenId !== undefined
        ? `Next: host ${options.out} byte-for-byte at ${options.url}, then run apix concordium pin.`
        : `Next: host ${options.out} byte-for-byte at ${options.url}, then run apix concordium register.`);
    }));

  ccd
    .command('register')
    .description('Register an agent in the CIS-8004 Agent Registry (signs with your key file)')
    .requiredOption('--key <file>', 'Wallet export file of the owner account (keep it outside the repo)')
    .requiredOption('--card <file>', 'The card file you hosted')
    .requiredOption('--url <agentUri>', 'Public URL serving that card')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async options => {
      const cfg = networkConfig(options.network);
      if (cfg.network === 'mainnet') throw new Error('Mainnet registration is disabled in this build.');
      assertKeyOutsideRepo(options.key);
      const wallet = loadWallet(options.key);
      const hash = sha256Hex(fs.readFileSync(options.card));
      console.log(`Owner: ${AccountAddress.toBase58(wallet.sender)}`);
      console.log(`Card SHA-256: ${hash}`);
      await checkHostedCard(options.url, hash);
      console.log(chalk.green('✓ Hosted card matches the local file'));
      const reg = await registerAgent(cfg, wallet, options.url, hash);
      if (reg.outcome !== 'success') {
        print({ rejected: reg.rejectReason, tx: reg.txHash });
        throw new Error('The register transaction was rejected on-chain.');
      }
      console.log(chalk.green(`✅ Registered. Transaction: ${reg.txHash}`));
      console.log(`Explorer: ${txLink(cfg, reg.txHash)}`);
      console.log(chalk.gray('Agents now owned by this account:'));
      print(await agentsByOwner(cfg, AccountAddress.toBase58(wallet.sender)));
      console.log('Next: apix concordium check <badge or owner account>');
    }));

  ccd
    .command('pin')
    .description('Second pass: pin the hash of the re-hosted card on-chain (setAgentURI), then check the badge')
    .requiredOption('--key <file>', 'Wallet export file of the owner account (outside any repo)')
    .requiredOption('--badge <tokenAddress>', 'The badge (short token address) from apix concordium check')
    .requiredOption('--card <file>', 'The card file you hosted')
    .requiredOption('--url <agentUri>', 'Public URL serving that card')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async options => {
      const cfg = networkConfig(options.network);
      if (cfg.network === 'mainnet') throw new Error('Mainnet is disabled in this build.');
      assertKeyOutsideRepo(options.key);
      const wallet = loadWallet(options.key);
      const hash = sha256Hex(fs.readFileSync(options.card));
      console.log(`Card SHA-256: ${hash}`);
      await checkHostedCard(options.url, hash);
      console.log(chalk.green('✓ Hosted card matches the local file'));
      const tx = await pinCard(cfg, wallet, options.badge, options.url, hash);
      if (tx.outcome !== 'success') {
        print({ rejected: tx.rejectReason, tx: tx.txHash });
        throw new Error('The setAgentURI transaction was rejected on-chain.');
      }
      console.log(chalk.green(`✅ New card hash pinned. Transaction: ${tx.txHash}`));
      console.log(`Explorer: ${txLink(cfg, tx.txHash)}`);
      const result = await checkBadge(options.badge, cfg.network) as { badge_valid?: boolean };
      print(result);
      console.log(result?.badge_valid ? chalk.green('✅ Badge valid') : chalk.yellow('⚠ Badge not valid yet: see issues above'));
    }));

  ccd
    .command('attest [report]')
    .description('Record a verification result on Concordium (RegisterData, signed by the attester account)')
    .requiredOption('--key <file>', 'Wallet export file of the APIX attester account (outside any repo)')
    .option('--subject <badge>', 'Badge of the agent that was verified, recorded with the result')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .option('--out <file>', 'Where to write the attestation record', 'apix-attestation.json')
    .action(run(async (reportFile: string | undefined, options) => {
      const cfg = networkConfig(options.network);
      if (cfg.network === 'mainnet') throw new Error('Mainnet is disabled in this build.');
      assertKeyOutsideRepo(options.key);
      const file = reportFile ?? 'apix-report.json';
      if (!fs.existsSync(file)) throw new Error(`No report at ${file}. Run apix verify --chain concordium first.`);
      const report = JSON.parse(fs.readFileSync(file, 'utf8')) as VerifyReport;
      const hash = reportHash(report);
      const wallet = loadWallet(options.key);
      console.log(`Attester: ${AccountAddress.toBase58(wallet.sender)}`);
      console.log(`Report: ${report.appId}, verdict ${report.summary.verdict.toUpperCase()}, SHA-256 ${hash}`);
      const tx = await attestOnConcordium(cfg, wallet, report, hash, options.subject);
      if (tx.outcome !== 'success') {
        print({ rejected: tx.rejectReason, tx: tx.txHash });
        throw new Error('The attestation transaction was rejected on-chain.');
      }
      const record = {
        txHash: tx.txHash, network: cfg.network, attester: AccountAddress.toBase58(wallet.sender),
        explorer: txLink(cfg, tx.txHash), attestation: tx.attestation, reportFile: file,
      };
      fs.writeFileSync(options.out, JSON.stringify(record, null, 2) + '\n');
      console.log(chalk.green(`✅ Attestation recorded. Transaction: ${tx.txHash}`));
      console.log(`Explorer: ${record.explorer}`);
      console.log(chalk.gray(`Saved to ${options.out}. Anyone can check it with: apix concordium attestation ${tx.txHash} --report ${file}`));
    }));

  ccd
    .command('attestation <txHash>')
    .description('Read an APIX attestation from Concordium and check it (and a report, if given)')
    .option('--report <file>', 'Report to check against the attested hash')
    .option('--attester <account>', 'Attester account you trust (default: APIX_ATTESTER env)')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async (txHash: string, options) => {
      const cfg = networkConfig(options.network);
      const found = await readAttestation(cfg, txHash);
      print(found);
      const trusted = options.attester ?? process.env.APIX_ATTESTER;
      let ok = true;
      if (trusted) {
        const same = trusted === found.attester;
        ok &&= same;
        console.log(same ? chalk.green(`✓ Signed by the trusted attester ${trusted}`) : chalk.red(`✗ Signed by ${found.attester}, not by ${trusted}`));
      } else {
        console.log(chalk.yellow(`⚠ No trusted attester given (--attester): signed by ${found.attester}`));
      }
      if (options.report) {
        const report = JSON.parse(fs.readFileSync(options.report, 'utf8')) as VerifyReport;
        const same = reportHash(report) === found.attestation.h;
        ok &&= same;
        console.log(same ? chalk.green('✓ The report matches the attested hash') : chalk.red('✗ The report does not match the attested hash'));
      }
      const verdict = found.attestation.v.toUpperCase();
      console.log(ok ? chalk.green(`✅ Valid APIX attestation: ${found.attestation.app} = ${verdict}`) : chalk.red('❌ Attestation check failed'));
      if (!ok) process.exitCode = 1;
    }));

  ccd
    .command('serve')
    .description('Run APIX Verifier as a web service: POST /verify {repo} checks the code and attests the verdict')
    .requiredOption('--key <file>', 'Wallet export file of the APIX attester account (outside any repo)')
    .option('--port <port>', 'Port to listen on', '8402')
    .option('--badge <tokenAddress>', 'APIX Verifier badge, shown on GET /')
    .option('--card <url>', 'Agent Card URL, shown on GET /')
    .option('--no-attest', 'Verify only, do not write attestations on-chain')
    .option('--index <file>', 'Where to keep the list of attestations written', 'apix-attestations.json')
    .option('--sponsor-key <file>', 'x402: wallet export of the account that sponsors payment fees (turns payments on)')
    .option('--price <ccd>', 'x402: price per verification in CCD', '1')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async options => {
      const cfg = networkConfig(options.network);
      if (cfg.network === 'mainnet') throw new Error('Mainnet is disabled in this build.');
      assertKeyOutsideRepo(options.key);
      const attester = loadWallet(options.key);
      let payment: { price: { amount: string; asset: string; payTo: string }; facilitator: LocalFacilitator } | undefined;
      if (options.sponsorKey) {
        assertKeyOutsideRepo(options.sponsorKey);
        const sponsor = loadWallet(options.sponsorKey);
        if (AccountAddress.toBase58(sponsor.sender) === AccountAddress.toBase58(attester.sender)) {
          throw new Error('The sponsor must be a different account from the attester (it receives the payments).');
        }
        const micro = Math.round(Number(options.price) * 1_000_000);
        if (!Number.isFinite(micro) || micro <= 0) throw new Error('--price must be a positive number of CCD');
        payment = {
          price: { amount: String(micro), asset: 'CCD', payTo: AccountAddress.toBase58(attester.sender) },
          facilitator: new LocalFacilitator(cfg, sponsor),
        };
      }
      const server = createVerifierServer({
        cfg, attester, apixVersion, badge: options.badge, agentCardUrl: options.card, attest: options.attest, payment, indexFile: options.index,
      });
      server.listen(Number(options.port), () => {
        console.log(chalk.green(`✅ APIX Verifier listening on http://localhost:${options.port}`));
        console.log(`Attester: ${AccountAddress.toBase58(attester.sender)} (${cfg.network})${options.attest ? '' : chalk.yellow(' · attestations OFF')}`);
        console.log(payment
          ? `x402: ${options.price} CCD per verification, paid to the attester, fees sponsored by ${payment.facilitator.sponsor}`
          : chalk.yellow('x402: OFF (free). Add --sponsor-key to require payment.'));
        console.log(chalk.gray('Try: curl -X POST http://localhost:' + options.port + '/verify -H "content-type: application/json" -d "{\\"repo\\":\\"https://github.com/owner/repo\\"}"'));
      });
    }));

  ccd
    .command('request <repo>')
    .description('Act as a client agent: ask an APIX Verifier to check a GitHub repo, paying with x402 if asked')
    .requiredOption('--key <file>', 'Wallet export of the client account that pays (outside any repo)')
    .option('--server <url>', 'APIX Verifier URL', 'http://localhost:8402')
    .option('--subject <badge>', 'Your agent badge, recorded with the attestation')
    .option('--max <ccd>', 'Refuse to pay more than this, in CCD', '5')
    .option('--ref <ref>', 'Branch, tag or commit to check')
    .option('--out <file>', 'Where to write the full response', 'apix-response.json')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async (repo: string, options) => {
      const cfg = networkConfig(options.network);
      if (cfg.network === 'mainnet') throw new Error('Mainnet is disabled in this build.');
      assertKeyOutsideRepo(options.key);
      const wallet = loadWallet(options.key);
      const endpoint = `${options.server.replace(/\/$/, '')}/verify`;
      const body = JSON.stringify({ repo, ...(options.ref ? { ref: options.ref } : {}), ...(options.subject ? { subject: options.subject } : {}) });
      console.log(`Client agent: ${AccountAddress.toBase58(wallet.sender)}`);
      let res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (res.status === 402) {
        const header = res.headers.get('payment-required');
        if (!header) throw new Error('Got 402 without a PAYMENT-REQUIRED header');
        const { header: paymentHeader, requirements } = await payFor(cfg, wallet, header, endpoint);
        const ccd = Number(requirements.amount) / 1_000_000;
        if (requirements.asset !== 'CCD') throw new Error(`The server asks for ${requirements.amount} ${requirements.asset}: only CCD is supported by this client`);
        if (ccd > Number(options.max)) throw new Error(`The server asks for ${ccd} CCD, more than --max ${options.max}`);
        console.log(chalk.cyan(`402 Payment Required: ${ccd} CCD to ${requirements.payTo} (fees sponsored by ${String(requirements.extra?.feePayer)}). Signing and retrying…`));
        res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': paymentHeader }, body });
      }
      const result = await res.json() as Record<string, any>;
      fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n');
      if (!res.ok) throw new Error(`${res.status}: ${result.error ?? 'request failed'} (full response in ${options.out})`);
      if (result.payment) console.log(chalk.green(`✅ Paid ${Number(result.payment.amount) / 1_000_000} CCD: ${result.payment.explorer}`));
      const verdict = String(result.verdict).toUpperCase();
      console.log((verdict === 'PASS' ? chalk.green : verdict === 'FAIL' ? chalk.red : chalk.yellow)(`Verdict: ${verdict}`));
      if (result.attestation?.txHash) console.log(chalk.green(`✅ Attested on Concordium: ${result.attestation.explorer}`));
      console.log(chalk.gray(`Full response in ${options.out}`));
    }));

  ccd
    .command('trust <repo>')
    .description('Before dealing with an app: is its current code attested PASS by a trusted APIX attester? Checks the chain, not the service')
    .requiredOption('--attester <account>', 'APIX attester account you trust')
    .option('--verifier <url>', 'APIX Verifier to ask for the attestation pointer', 'http://localhost:8402')
    .option('--tx <txHash>', 'Use this attestation directly (no verifier needed)')
    .option('--require-badge', 'Also require a valid Verified by Concordium badge for the attested agent')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async (repoUrl: string, options) => {
      const cfg = networkConfig(options.network);
      const repo = parseGithubUrl(repoUrl);
      const reasons: string[] = [];
      const ok = (m: string) => console.log(chalk.green(`  ✓ ${m}`));
      const bad = (m: string) => { reasons.push(m); console.log(chalk.red(`  ✗ ${m}`)); };

      console.log(`Trust check: ${repo.url}${repo.ref ? '@' + repo.ref : ''}`);
      const current = await latestCommit(repo);
      console.log(chalk.gray(`  current commit ${current.slice(0, 12)}`));

      let tx: string | undefined = options.tx;
      if (!tx) {
        const res = await fetch(`${options.verifier.replace(/\/$/, '')}/attestations?app=${encodeURIComponent(repo.url)}`);
        if (!res.ok) throw new Error(`The verifier answered HTTP ${res.status}`);
        const list = (await res.json() as { attestations: Array<{ txHash: string; commit?: string; ref?: string }> }).attestations
          .filter(e => (e.ref ?? undefined) === (repo.ref ?? undefined));
        const match = list.find(e => e.commit === current) ?? list[0];
        tx = match?.txHash;
      }
      if (!tx) {
        bad('no APIX attestation found for this repo');
      } else {
        const found = await readAttestation(cfg, tx);
        const a = found.attestation;
        console.log(chalk.gray(`  attestation ${ccdExplorerTx(cfg, tx)}`));
        found.attester === options.attester ? ok(`signed on-chain by the trusted attester ${options.attester.slice(0, 8)}…`) : bad(`signed by ${found.attester}, not by the trusted attester`);
        a.app.startsWith(repo.url) ? ok('attestation is about this repo') : bad(`attestation is about ${a.app}, not ${repo.url}`);
        if (!a.c) bad('attestation does not record a commit');
        else if (current.startsWith(a.c)) ok(`attested commit ${a.c} is the current code`);
        else bad(`code changed since the attestation (attested ${a.c}, current ${current.slice(0, 12)})`);
        a.v === 'pass' ? ok('verdict PASS') : bad(`verdict ${a.v.toUpperCase()}`);
        if (a.s) {
          const badge = await checkBadge(a.s, cfg.network) as { badge_valid?: boolean };
          badge?.badge_valid ? ok(`agent badge ${a.s} is a valid Verified by Concordium badge`) : bad(`agent badge ${a.s} is not valid`);
        } else if (options.requireBadge) {
          bad('no agent badge recorded in the attestation');
        }
      }
      if (reasons.length === 0) {
        console.log(chalk.green.bold('ALLOW: verified by APIX, attested on Concordium, code unchanged'));
      } else {
        console.log(chalk.red.bold(`DENY: ${reasons[0]}`));
        process.exitCode = 1;
      }
    }));

  ccd
    .command('check <id>')
    .description('Check a badge (token address) or every badge an account owns, via /v1/check-badge')
    .option('--network <network>', 'testnet or mainnet', 'testnet')
    .action(run(async (id: string, options) => {
      print(await checkBadge(id, options.network));
    }));
}
