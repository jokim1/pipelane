import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = await import(pathToFileURL(path.join(root, 'dist/operator/review-contract.js')).href);
const artifacts = await import(pathToFileURL(path.join(root, 'dist/operator/review-artifacts.js')).href);
const policyModule = await import(pathToFileURL(path.join(root, 'dist/operator/review-gate-policy.js')).href);
const policy = policyModule.reviewGateExecutionPolicy({ id: 'karpathy-diff', type: 'skill' });
const prompt = contract.renderStrictReviewPrompt({
  gate: { id: 'karpathy-diff', phase: 'ai-diff', type: 'skill', blocking: true, skill: 'karpathy-diff' },
  intent: { text: 'Change only the requested adapter behavior.', source: 'explicit-unbound', digest: 'a'.repeat(64) },
  target: {
    baseBranchLabel: 'main', baseTipOid: '1'.repeat(40), mergeBaseOid: '1'.repeat(40), headOid: '2'.repeat(40),
    worktreeStatusDigest: '3'.repeat(64), materialTreeHash: '4'.repeat(64), serializationVersion: 1,
    baseTreeManifestDigest: '5'.repeat(64), materialTreeManifestDigest: '6'.repeat(64), changedFilesDigest: '7'.repeat(64),
    ignorePolicyDigest: '8'.repeat(64), machineFingerprint: '9'.repeat(64), targetDigest: 'a'.repeat(64),
  },
  changedFiles: ['src/operator/review-contract.ts'],
  capability: {
    contract: 'Exact Karpathy traceability contract.',
    evidence: {
      requestedCapability: 'skill:karpathy-diff', effectiveCapability: 'contract-supplied-adapter', adapter: 'codex-native-v1',
      provider: 'codex', contractSupplied: true, wrapperCompatible: true,
    },
  },
});
assert.match(prompt, /PIPELANE_DATA_INTENT_/);
assert.match(prompt, /Change only the requested adapter behavior/);
assert.match(prompt, /PIPELANE_DATA_IMMUTABLE_TARGET_/);
assert.match(prompt, /src\/operator\/review-contract\.ts/);
assert.match(prompt, /Exact Karpathy traceability contract/);

for (const provider of ['codex', 'claude']) {
  for (const status of ['passed', 'failed']) {
    const findings = status === 'passed' ? [] : [{ severity: 'warning', title: `${provider} deterministic finding` }];
    const native = { status, findings: findings.map((finding) => ({ ...finding, location: null })), report: `${provider} ${status} report` };
    const stdout = provider === 'claude'
      ? JSON.stringify({ structured_output: native })
      : JSON.stringify(native);
    const adapted = contract.adaptProviderCompletion({ provider, providerExitCode: 0, stdout });
    const framer = new contract.ReviewProtocolFramer();
    framer.feed(Buffer.from(`${adapted.emission}\n`));
    const parsed = framer.finish(policy);
    assert.equal(parsed.status, status);
    assert.equal((adapted.emission.match(/PIPELANE_REVIEW_GATE_RESULT=/g) ?? []).length, 1);
  }
}

for (const stdout of [
  '',
  'PIPELANE_REVIEW_GATE_RESULT=passed',
  '{"status":"passed","findings":[]}',
  '{"status":"passed","findings":[],"report":"","extra":true}',
]) {
  assert.throws(() => contract.adaptProviderCompletion({ provider: 'codex', providerExitCode: 0, stdout }));
}
assert.throws(() => contract.adaptProviderCompletion({
  provider: 'codex', providerExitCode: 0, adapterExitCode: 2,
  stdout: JSON.stringify({ status: 'passed', findings: [], report: '' }),
}));
assert.throws(() => contract.adaptProviderCompletion({
  provider: 'codex', providerExitCode: null, providerSignal: 'SIGTERM',
  stdout: JSON.stringify({ status: 'failed', findings: [{ severity: 'warning', title: 'signal fixture' }], report: '' }),
}));
assert.throws(() => contract.adaptProviderCompletion({
  provider: 'codex', providerExitCode: 0,
  stdout: Buffer.concat([
    Buffer.from('{"status":"passed","findings":[],"report":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]),
}), /valid UTF-8/);

for (const ambiguous of [
  `${contract.canonicalEnvelopeLine('passed', [])}\n${contract.canonicalEnvelopeLine('passed', [])}\n`,
  `${contract.canonicalEnvelopeLine('passed', [])}\ntrailing\n`,
]) {
  const framer = new contract.ReviewProtocolFramer();
  framer.feed(Buffer.from(ambiguous));
  assert.throws(() => framer.finish(policy));
}

const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'pipelane-adapter-check-'));
try {
  const reference = artifacts.persistReviewArtifact({
    root: artifactRoot,
    runId: 'adapter-check',
    gateRecordId: 'karpathy-diff',
    report: 'authoritative provider report',
    diagnostics: 'bounded provider diagnostics',
  });
  const retained = artifacts.readVerifiedReviewArtifact(artifactRoot, reference);
  assert.equal(retained.report, 'authoritative provider report');
  assert.equal(retained.diagnostics, 'bounded provider diagnostics');
  artifacts.releaseReviewArtifactLease(artifactRoot, 'adapter-check');
} finally {
  rmSync(artifactRoot, { recursive: true, force: true });
}

process.stdout.write('review adapter compliance: prompt mapping; codex/claude wrappers; canonical framing; nonzero/signal/invalid-UTF-8/malformed/duplicate/trailing rejection; artifact persistence passed\n');
