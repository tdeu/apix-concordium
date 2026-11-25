import path from 'path';
import { verifyConcordiumProject } from '../index';
import { buildAttestation } from '../../concordium/attestation-format';
import { reportHash } from '../report';

const examples = path.join(__dirname, '..', '..', '..', 'examples');

describe('Concordium verification', () => {
  it('fails the unsafe demo agent on its spend route and its unbounded AI tool', async () => {
    const report = await verifyConcordiumProject({ directory: path.join(examples, 'concordium-agent-unsafe'), network: 'testnet', apixVersion: 'test' });
    expect(report.chain).toBe('concordium');
    expect(report.summary.verdict).toBe('fail');
    const rules = report.findings.filter(f => f.severity === 'fail').map(f => f.rule);
    expect(rules).toEqual(expect.arrayContaining(['CCD-UNPROTECTED-SPEND-ROUTE', 'CCD-AGENT-UNBOUNDED-SPEND']));
  });

  it('passes the safe demo agent', async () => {
    const report = await verifyConcordiumProject({ directory: path.join(examples, 'concordium-agent-safe'), network: 'testnet', apixVersion: 'test' });
    expect(report.summary.verdict).toBe('pass');
  });

  it('keeps the on-chain attestation within 256 bytes and pins the report hash', async () => {
    const report = await verifyConcordiumProject({ directory: path.join(examples, 'concordium-agent-safe'), network: 'testnet', apixVersion: 'test' });
    report.appId = 'https://github.com/example/' + 'x'.repeat(400);
    const hash = reportHash(report);
    const { attestation, bytes } = buildAttestation(report, hash, 'JyP9XfKkFPMSms2qdYnyD');
    expect(bytes.length).toBeLessThanOrEqual(256);
    expect(attestation.h).toBe(hash);
    expect(attestation.v).toBe('pass');
    expect(attestation.s).toBe('JyP9XfKkFPMSms2qdYnyD');
  });
});
