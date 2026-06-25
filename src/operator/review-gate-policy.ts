import type { ReviewGateType } from './state.ts';

export const REVIEW_GATES_POLICY_VERSION = 2;

export type ReviewGatePolicyRole =
  | 'self-review'
  | 'deterministic'
  | 'primary-independent-review'
  | 'cross-model-review'
  | 'instruction-audit'
  | 'runtime-qa'
  | 'high-stakes-review'
  | 'high-stakes-human'
  | 'human-approval'
  | 'other';

type ReviewGatePolicySubject =
  | { id: string; type: ReviewGateType }
  | { gateId: string; type: ReviewGateType };

const RISK_PATTERNS: Record<string, string[]> = {
  auth: ['**/auth/**', '**/session/**', '**/sessions/**', '**/login/**', '**/permission/**', '**/permissions/**', '**/acl/**', '**/oauth/**', 'token:auth', 'token:session', 'token:login', 'token:permission', 'token:permissions', 'token:acl', 'token:oauth'],
  billing: ['**/billing/**', '**/payment/**', '**/payments/**', '**/stripe/**', '**/checkout/**', '**/invoice/**', '**/invoices/**', 'token:billing', 'token:payment', 'token:payments', 'token:stripe', 'token:checkout', 'token:invoice', 'token:invoices'],
  concurrency: ['**/queue/**', '**/queues/**', '**/worker/**', '**/workers/**', '**/job/**', '**/jobs/**', '**/lock/**', '**/locks/**', 'token:queue', 'token:queues', 'token:worker', 'token:workers', 'token:job', 'token:jobs', 'token:lock', 'token:locks'],
  deploy: ['.github/workflows/**', '**/.gitlab-ci.yml', '**/Dockerfile', '**/docker-compose*.yml', '**/fly.toml', '**/wrangler.toml', '**/deploy/**', '**/infra/**', '**/terraform/**'],
  infra: ['.github/workflows/**', '**/.gitlab-ci.yml', '**/Dockerfile', '**/docker-compose*.yml', '**/fly.toml', '**/wrangler.toml', '**/infra/**', '**/terraform/**', '**/cloudformation/**'],
  migrations: ['**/migrations/**', '**/migration/**', '**/schema.sql', '**/schema.ts', '**/schema.rb', '**/prisma/**', 'token:migration', 'token:migrations'],
  rollback: ['**/rollback/**', '**/revert/**', '**/deploy/**', '**/migration/**', '**/migrations/**', 'token:rollback', 'token:revert'],
  secrets: ['.env*', '**/secrets/**', '**/secret/**', 'token:secret', 'token:secrets', 'token:token', 'token:credential', 'token:credentials'],
  sql: ['**/*.sql', '**/queries/**', '**/query/**', '**/db/**', '**/database/**', '**/schema.sql', '**/schema.ts', '**/schema.rb', 'token:sql', 'token:query', 'token:queries'],
  api: ['**/api/**', '**/routes/**', '**/router/**', '**/controllers/**', '**/endpoints/**', '**/handlers/**', 'token:api', 'token:route', 'token:routes', 'token:router', 'token:controller', 'token:controllers', 'token:endpoint', 'token:endpoints', 'token:handler', 'token:handlers'],
};

export function reviewGatePolicyRole(gate: ReviewGatePolicySubject): ReviewGatePolicyRole {
  const id = 'gateId' in gate ? gate.gateId : gate.id;
  if (id === 'karpathy-diff') return 'self-review';
  if (id === 'karpathy-audit') return 'instruction-audit';
  if (id === 'browser-qa') return 'runtime-qa';
  if (id === 'code-review-high' || id === 'gstack-review') return 'primary-independent-review';
  if (id === 'adversarial-review') return 'cross-model-review';
  if (id === 'code-review-ultra') return 'high-stakes-review';
  if (id === 'high-stakes-human-approval') return 'high-stakes-human';
  if (gate.type === 'approval') return 'human-approval';
  if (gate.type === 'command' || gate.type === 'pipelane') return 'deterministic';
  return 'other';
}

export function isIndependentAiReviewGate(gate: ReviewGatePolicySubject): boolean {
  const role = reviewGatePolicyRole(gate);
  if (role === 'primary-independent-review' || role === 'cross-model-review' || role === 'high-stakes-review') {
    return true;
  }
  if (role !== 'other') return false;
  return gate.type === 'skill' || gate.type === 'agent';
}

export function isCrossModelReviewGate(gate: ReviewGatePolicySubject): boolean {
  return reviewGatePolicyRole(gate) === 'cross-model-review';
}

export function matchesReviewRisk(changedFiles: string[], when: string | undefined): boolean {
  const riskExpression = parseRiskExpression(when);
  if (riskExpression.length === 0) return false;
  const patterns = riskExpression.flatMap((risk) => RISK_PATTERNS[risk] ?? []);
  if (patterns.length === 0) return false;
  return changedFiles.some((file) => patterns.some((pattern) => matchesPathPattern(file, pattern)));
}

function parseRiskExpression(when: string | undefined): string[] {
  if (!when?.startsWith('risk:')) return [];
  return when
    .slice('risk:'.length)
    .split('|')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function matchesPathPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizeRepoPath(file);
  const normalizedPattern = normalizeRepoPath(pattern);
  if (!normalizedPattern) return false;
  if (normalizedPattern.startsWith('token:')) {
    return pathHasToken(normalizedFile, normalizedPattern.slice('token:'.length));
  }
  if (!normalizedPattern.includes('*')) return normalizedFile === normalizedPattern;
  return globPatternToRegExp(normalizedPattern).test(normalizedFile);
}

function normalizeRepoPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function pathHasToken(file: string, token: string): boolean {
  const normalizedToken = token.trim().toLowerCase();
  if (!normalizedToken) return false;
  return file
    .split('/')
    .flatMap((segment) => tokenizePathSegment(segment))
    .includes(normalizedToken);
}

function tokenizePathSegment(segment: string): string[] {
  return segment
    .replace(/\.[^.]*$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegExp(char);
  }
  source += '$';
  return new RegExp(source);
}
