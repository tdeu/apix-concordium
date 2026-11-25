// src/verify/index.ts
// apix verify for Concordium apps and agents: collect the code, run the checks, build the report.
import { collectFiles } from './files';
import { runConcordiumStaticRules } from './concordium-rules';
import { summarize } from './report';
import { VerifyReport } from './types';

export interface VerifyOptions {
  directory: string;
  appId?: string;
  network: string;
  apixVersion: string;
  /** Set when the code comes from a downloaded archive: its commit, and no git lookups */
  archive?: { commit?: string };
}

export async function verifyConcordiumProject(options: VerifyOptions): Promise<VerifyReport> {
  const project = await collectFiles(options.directory, { archive: options.archive });
  if (project.files.length === 0) {
    throw new Error(`No source files found in ${options.directory}. Run apix verify in the app's folder.`);
  }
  const { checks, findings } = runConcordiumStaticRules(project);
  return {
    format: 'apix-verify/1',
    apixVersion: options.apixVersion,
    chain: 'concordium',
    network: options.network,
    appId: options.appId ?? project.packageJson?.name ?? 'unnamed-app',
    commit: project.commit,
    treeHash: project.treeHash,
    filesScanned: project.files.length,
    checks,
    findings,
    summary: summarize(checks, findings),
  };
}
