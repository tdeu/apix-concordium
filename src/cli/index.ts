#!/usr/bin/env node
// src/cli/index.ts
// apix: verify agent code, register agents in the Concordium Agent Registry,
// record verification results on Concordium, and sell verification over x402.
import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { verifyConcordiumProject } from '../verify';
import { printReport, reportHash } from '../verify/report';
import { registerConcordiumCommands } from './concordium-commands';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require('../../package.json') as { version: string };

const program = new Command();
program
  .name('apix')
  .description('APIX Verifier on Concordium: verify agent code, attest the result on-chain, get paid with x402')
  .version(packageJson.version);

program
  .command('verify [directory]')
  .description('Check the code of an app or agent that uses Concordium: keys, spending routes, AI spending limits')
  .option('--app-id <id>', 'Name for the report and attestation (default: package.json name)')
  .option('--network <network>', 'testnet or mainnet, recorded in the report', 'testnet')
  .option('--out <file>', 'Where to write the JSON report', 'apix-report.json')
  .option('--json', 'Print the report as JSON instead of text')
  .action(async (directory: string | undefined, options) => {
    try {
      const report = await verifyConcordiumProject({
        directory: directory ?? '.', appId: options.appId, network: options.network, apixVersion: packageJson.version,
      });
      const hash = reportHash(report);
      fs.writeFileSync(path.resolve(options.out), JSON.stringify(report, null, 2) + '\n');
      if (options.json) {
        console.log(JSON.stringify({ ...report, reportHash: hash }, null, 2));
      } else {
        printReport(report, hash);
        console.log(chalk.gray(`Report written to ${options.out}. Record it on Concordium with: apix concordium attest ${options.out} --key <attester key file>`));
      }
      if (report.summary.verdict === 'fail') process.exitCode = 1;
    } catch (error) {
      console.error(chalk.red(`❌ ${error instanceof Error ? error.message : String(error)}`));
      process.exitCode = 1;
    }
  });

registerConcordiumCommands(program, packageJson.version);

program.parseAsync(process.argv);
