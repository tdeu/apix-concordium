// src/concordium/attestation-format.ts
// The on-chain format of an APIX attestation (no SDK imports: testable, reusable by any reader).
import { VerifyReport } from '../verify/types';

export const ATTESTATION_FORMAT = 'apix-verify/1';
const MAX_DATA = 256;

/** What goes on-chain. Short keys: RegisterData holds 256 bytes at most. */
export interface Attestation {
  p: string; // format
  app: string; // app id (repo URL or name), truncated to fit
  v: 'pass' | 'warn' | 'fail'; // verdict
  h: string; // SHA-256 of the canonical report
  t: string; // tree hash of the checked code (first 32 hex)
  c?: string; // git commit (first 12 hex)
  s?: string; // subject: badge of the agent that was verified, if any
}

/** CBOR text string, so explorers can show it as text. */
function cborText(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  if (body.length < 24) return Buffer.concat([Buffer.from([0x60 + body.length]), body]);
  if (body.length < 256) return Buffer.concat([Buffer.from([0x78, body.length]), body]);
  return Buffer.concat([Buffer.from([0x79, body.length >> 8, body.length & 0xff]), body]);
}

export function decodeCborText(bytes: Buffer): string | undefined {
  if (bytes.length === 0) return undefined;
  const head = bytes[0];
  if (head >= 0x60 && head < 0x78) return bytes.subarray(1, 1 + head - 0x60).toString('utf8');
  if (head === 0x78) return bytes.subarray(2, 2 + bytes[1]).toString('utf8');
  if (head === 0x79) return bytes.subarray(3, 3 + ((bytes[1] << 8) | bytes[2])).toString('utf8');
  return undefined;
}

export function buildAttestation(report: VerifyReport, reportHash: string, subject?: string): { attestation: Attestation; bytes: Buffer } {
  const base: Attestation = {
    p: ATTESTATION_FORMAT,
    app: '',
    v: report.summary.verdict,
    h: reportHash,
    t: report.treeHash.slice(0, 32),
    ...(report.commit ? { c: report.commit.slice(0, 12) } : {}),
    ...(subject ? { s: subject } : {}),
  };
  const room = MAX_DATA - cborText(JSON.stringify(base)).length;
  if (room < 8) throw new Error('Attestation does not fit in 256 bytes. Drop --subject or shorten the app id.');
  const app = report.appId.length > room ? report.appId.slice(0, room - 1) + '…' : report.appId;
  let attestation = { ...base, app };
  let bytes = cborText(JSON.stringify(attestation));
  while (bytes.length > MAX_DATA) {
    // multi-byte characters: trim until it fits
    attestation = { ...attestation, app: attestation.app.slice(0, -2) + '…' };
    bytes = cborText(JSON.stringify(attestation));
  }
  return { attestation, bytes };
}

