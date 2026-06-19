import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ReviewGateConfig,
  ReviewGatePhase,
  ReviewGateType,
  ReviewGatesConfig,
  ReviewPlanGateConfig,
} from './state.ts';

export type ReviewGateCatalogKind = 'plan' | 'review';

export interface ReviewGateCatalogEntry {
  id: string;
  kind: ReviewGateCatalogKind;
  phase: ReviewGatePhase | 'plan';
  type: ReviewGateType;
  recommended?: boolean;
  command?: string;
  scriptNames?: string[];
  skill?: string;
  role?: string;
  when?: string;
  whenChanged?: string[];
  userCommands?: string[];
  optional?: boolean;
}

export interface PackageScriptDetection {
  packageJsonPath: string;
  found: boolean;
  malformed: boolean;
  parseError?: string;
  scripts: Record<string, string>;
}

export interface ResolvedReviewGateCatalogEntry extends ReviewGateCatalogEntry {
  available: boolean;
  command?: string;
  matchedScript?: string;
  missingReason?: string;
}

export interface ReviewGateDefaultResolution {
  planReview: {
    gates: ReviewPlanGateConfig[];
  };
  gates: ReviewGateConfig[];
  missing: Array<{
    id: string;
    reason: string;
  }>;
  catalog: ResolvedReviewGateCatalogEntry[];
}

export const REVIEW_GATE_ALIAS_MAP: Record<string, string> = {
  '/karpathy diff': 'karpathy-diff',
  '/karpathy-diff': 'karpathy-diff',
  '/karpathy:diff': 'karpathy-diff',
  'karpathy diff': 'karpathy-diff',
  'karpathy-diff': 'karpathy-diff',
  'karpathy:diff': 'karpathy-diff',
  '/karpathy audit': 'karpathy-audit',
  '/karpathy-audit': 'karpathy-audit',
  '/karpathy:audit': 'karpathy-audit',
  'karpathy audit': 'karpathy-audit',
  'karpathy-audit': 'karpathy-audit',
  'karpathy:audit': 'karpathy-audit',
  '/review': 'gstack-review',
  '/gstack review': 'gstack-review',
  '/gstack-review': 'gstack-review',
  'gstack review': 'gstack-review',
  'gstack-review': 'gstack-review',
  '/claude review': 'adversarial-review',
  '/claude review code': 'adversarial-review',
  '/codex challenge': 'adversarial-review',
  'claude review': 'adversarial-review',
  'claude review code': 'adversarial-review',
  'codex challenge': 'adversarial-review',
};

export const REVIEW_GATE_CATALOG: ReviewGateCatalogEntry[] = [
  {
    id: 'plan-eng-review',
    kind: 'plan',
    phase: 'plan',
    type: 'skill',
    skill: 'plan-eng-review',
    recommended: true,
  },
  {
    id: 'plan-design-review',
    kind: 'plan',
    phase: 'plan',
    type: 'skill',
    skill: 'plan-design-review',
    when: 'surface:frontend',
    recommended: true,
  },
  {
    id: 'security-data-review',
    kind: 'plan',
    phase: 'plan',
    type: 'skill',
    skill: 'cso',
    when: 'risk:auth|billing|sql|secrets|deploy|infra',
    recommended: false,
  },
  {
    id: 'typecheck',
    kind: 'review',
    phase: 'static',
    type: 'command',
    scriptNames: ['typecheck', 'check:types', 'tsc'],
    recommended: true,
  },
  {
    id: 'lint',
    kind: 'review',
    phase: 'static',
    type: 'command',
    scriptNames: ['lint', 'eslint'],
    recommended: true,
    optional: true,
  },
  {
    id: 'format-check',
    kind: 'review',
    phase: 'static',
    type: 'command',
    scriptNames: ['format:check', 'format:ci', 'check:format', 'prettier:check'],
    recommended: true,
    optional: true,
  },
  {
    id: 'secret-scan',
    kind: 'review',
    phase: 'static',
    type: 'command',
    scriptNames: ['secrets:scan', 'secret:scan', 'scan:secrets', 'gitleaks'],
    recommended: false,
    optional: true,
  },
  {
    id: 'dependency-audit',
    kind: 'review',
    phase: 'static',
    type: 'command',
    scriptNames: ['audit', 'security:audit', 'audit:deps'],
    recommended: false,
    optional: true,
  },
  {
    id: 'test',
    kind: 'review',
    phase: 'behavioral',
    type: 'command',
    scriptNames: ['test', 'test:unit'],
    recommended: true,
  },
  {
    id: 'build',
    kind: 'review',
    phase: 'behavioral',
    type: 'command',
    scriptNames: ['build'],
    recommended: true,
  },
  {
    id: 'karpathy-diff',
    kind: 'review',
    phase: 'ai-diff',
    type: 'skill',
    skill: 'karpathy-diff',
    userCommands: ['/karpathy diff', '/karpathy-diff', '/karpathy:diff'],
    recommended: true,
  },
  {
    id: 'gstack-review',
    kind: 'review',
    phase: 'ai-diff',
    type: 'skill',
    skill: 'review',
    userCommands: ['/review', '/gstack review', '/gstack-review'],
    recommended: true,
  },
  {
    id: 'adversarial-review',
    kind: 'review',
    phase: 'ai-diff',
    type: 'agent',
    role: 'adversarial-code-reviewer',
    userCommands: ['/claude review code', '/codex challenge'],
    recommended: false,
  },
  {
    id: 'karpathy-audit',
    kind: 'review',
    phase: 'instruction',
    type: 'skill',
    skill: 'karpathy-audit',
    whenChanged: ['CLAUDE.md', 'AGENTS.md', '.cursor/rules/**', '.codex/skills/**'],
    userCommands: ['/karpathy audit', '/karpathy-audit', '/karpathy:audit'],
    recommended: true,
  },
  {
    id: 'browser-qa',
    kind: 'review',
    phase: 'runtime',
    type: 'skill',
    skill: 'qa-only',
    when: 'surface:frontend',
    recommended: false,
  },
  {
    id: 'human-merge-approval',
    kind: 'review',
    phase: 'human',
    type: 'approval',
    when: 'before:merge',
    recommended: false,
  },
  {
    id: 'human-prod-deploy-approval',
    kind: 'review',
    phase: 'human',
    type: 'approval',
    when: 'before:prod-deploy',
    recommended: false,
  },
  {
    id: 'human-rollback-approval',
    kind: 'review',
    phase: 'human',
    type: 'approval',
    when: 'before:rollback',
    recommended: false,
  },
];

export function detectPackageScripts(repoRoot: string): PackageScriptDetection {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return { packageJsonPath, found: false, malformed: false, scripts: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: unknown };
    const scripts = parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
      ? Object.fromEntries(
          Object.entries(parsed.scripts)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0),
        )
      : {};
    return { packageJsonPath, found: true, malformed: false, scripts };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    return { packageJsonPath, found: true, malformed: true, parseError, scripts: {} };
  }
}

export function resolveReviewGateAlias(input: string): string | null {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, ' ');
  return REVIEW_GATE_ALIAS_MAP[normalized] ?? null;
}

export function resolveReviewGateCatalog(options: {
  repoRoot?: string;
  scripts?: Record<string, string>;
  includeMissingCoreScripts?: boolean;
} = {}): ResolvedReviewGateCatalogEntry[] {
  const detection = options.scripts ? undefined : (options.repoRoot ? detectPackageScripts(options.repoRoot) : undefined);
  const scripts = options.scripts ?? detection?.scripts ?? {};
  const packageJsonParseError = detection?.malformed === true
    ? detection.parseError ?? 'malformed JSON'
    : undefined;
  return REVIEW_GATE_CATALOG.map((entry) => resolveCatalogEntry(
    entry,
    scripts,
    options.includeMissingCoreScripts === true,
    packageJsonParseError,
  ));
}

export function resolveDefaultReviewGates(options: {
  repoRoot?: string;
  scripts?: Record<string, string>;
  includeMissingCoreScripts?: boolean;
} = {}): ReviewGateDefaultResolution {
  const catalog = resolveReviewGateCatalog({
    repoRoot: options.repoRoot,
    scripts: options.scripts,
    includeMissingCoreScripts: options.includeMissingCoreScripts,
  }).filter((entry) => entry.recommended === true);

  const planGates = catalog
    .filter((entry) => entry.kind === 'plan' && entry.available)
    .map(toPlanGateConfig);
  const gates = catalog
    .filter((entry) => entry.kind === 'review' && entry.available)
    .map(toReviewGateConfig);
  const missing = catalog
    .filter((entry) => !entry.available)
    .map((entry) => ({
      id: entry.id,
      reason: entry.missingReason ?? 'gate unavailable',
    }));

  return {
    planReview: { gates: planGates },
    gates,
    missing,
    catalog,
  };
}

export function buildDefaultReviewGatesConfig(options: {
  repoRoot?: string;
  scripts?: Record<string, string>;
} = {}): ReviewGatesConfig {
  return buildReviewGatesConfig({
    repoRoot: options.repoRoot,
    scripts: options.scripts,
    includeRuntimeGates: false,
  });
}

export function buildReviewGatesConfig(
  options: {
    includeRuntimeGates?: boolean;
    repoRoot?: string;
    scripts?: Record<string, string>;
    includeMissingCoreScripts?: boolean;
  } = {},
): ReviewGatesConfig {
  const resolution = resolveDefaultReviewGates({
    repoRoot: options.repoRoot,
    scripts: options.scripts,
    includeMissingCoreScripts: options.includeMissingCoreScripts === true,
  });
  return {
    planReview: resolution.planReview,
    gates: options.includeRuntimeGates === false
      ? resolution.gates.filter((gate) => gate.id !== 'browser-qa')
      : resolution.gates,
  };
}

function resolveCatalogEntry(
  entry: ReviewGateCatalogEntry,
  scripts: Record<string, string>,
  includeMissingCoreScripts: boolean,
  packageJsonParseError?: string,
): ResolvedReviewGateCatalogEntry {
  if (!entry.scriptNames || entry.scriptNames.length === 0) {
    return { ...entry, available: true };
  }

  const matchedScript = entry.scriptNames.find((scriptName) => Object.prototype.hasOwnProperty.call(scripts, scriptName));
  if (matchedScript) {
    return {
      ...entry,
      available: true,
      command: `npm run ${matchedScript}`,
      matchedScript,
    };
  }

  if (packageJsonParseError) {
    return {
      ...entry,
      available: false,
      missingReason: `package.json could not be parsed; cannot detect scripts ${entry.scriptNames.map((script) => `"${script}"`).join(', ')}: ${packageJsonParseError}`,
    };
  }

  if (includeMissingCoreScripts && !entry.optional) {
    const scriptName = entry.scriptNames[0];
    return {
      ...entry,
      available: true,
      command: `npm run ${scriptName}`,
      matchedScript: scriptName,
      missingReason: `package.json script "${scriptName}" was not detected; using standard default command`,
    };
  }

  return {
    ...entry,
    available: false,
    missingReason: `package.json script not detected; tried ${entry.scriptNames.map((script) => `"${script}"`).join(', ')}`,
  };
}

function toPlanGateConfig(entry: ResolvedReviewGateCatalogEntry): ReviewPlanGateConfig {
  return {
    id: entry.id,
    phase: 'plan',
    type: entry.type as ReviewPlanGateConfig['type'],
    blocking: true,
    skill: entry.skill,
    role: entry.role,
    when: entry.when,
  };
}

function toReviewGateConfig(entry: ResolvedReviewGateCatalogEntry): ReviewGateConfig {
  return {
    id: entry.id,
    phase: entry.phase as ReviewGatePhase,
    type: entry.type,
    blocking: true,
    command: entry.command,
    skill: entry.skill,
    role: entry.role,
    when: entry.when,
    whenChanged: entry.whenChanged,
    userCommands: entry.userCommands,
  };
}
