import { bucketPathsBySurface } from './surface-map.ts';
import { runGit, type WorkflowConfig } from './state.ts';
import { sanitizeForTerminal } from './text-output.ts';

export interface TargetSurfaceInference {
  changedPaths: string[];
  surfaces: string[];
  other: string[];
  unsupportedSurfaces: string[];
  unresolvedTarget?: string;
}

export function inferTargetSurfacesFromSurfacePathMap(options: {
  repoRoot: string;
  config: WorkflowConfig;
  targetSha: string;
}): TargetSurfaceInference | null {
  const map = options.config.surfacePathMap;
  if (!map || Object.keys(map).length === 0 || !options.targetSha.trim()) {
    return null;
  }

  const target = runGit(options.repoRoot, ['rev-parse', '--verify', options.targetSha], true)?.trim();
  if (!target) {
    return {
      changedPaths: [],
      surfaces: [],
      other: [],
      unsupportedSurfaces: [],
      unresolvedTarget: options.targetSha,
    };
  }

  const changedPaths = listTargetChangedPaths(options.repoRoot, options.config.baseBranch, target);
  if (changedPaths.length === 0) return null;

  const buckets = bucketPathsBySurface(changedPaths, map);
  const mappedSurfaces = Object.keys(buckets.surfaces).sort();
  const configured = new Set(options.config.surfaces);
  return {
    changedPaths,
    surfaces: mappedSurfaces.filter((surface) => configured.has(surface)),
    unsupportedSurfaces: mappedSurfaces.filter((surface) => !configured.has(surface)),
    other: buckets.other,
  };
}

export function targetSurfaceInferenceBlockers(inference: TargetSurfaceInference | null): string[] {
  if (!inference) return [];
  const blockers: string[] = [];
  if (inference.unresolvedTarget) {
    blockers.push(`could not inspect target SHA ${sanitizeForTerminal(inference.unresolvedTarget)} to infer deploy surfaces.`);
  }
  if (inference.unsupportedSurfaces.length > 0) {
    blockers.push(
      `surfacePathMap maps target changes to unsupported surface(s): ${inference.unsupportedSurfaces.map(sanitizeForTerminal).join(', ')}.`,
    );
  }
  if (inference.other.length > 0) {
    blockers.push([
      `${inference.other.length} target file(s) do not match surfacePathMap: ${previewPaths(inference.other)}.`,
      'Map them to a surface before deploying without --surfaces.',
    ].join(' '));
  }
  if (
    inference.changedPaths.length > 0
    && inference.surfaces.length === 0
    && inference.unsupportedSurfaces.length === 0
    && inference.other.length === 0
  ) {
    blockers.push('target changed files were detected, but none resolved to a configured surface.');
  }
  return blockers;
}

function listTargetChangedPaths(repoRoot: string, baseBranch: string, targetSha: string): string[] {
  const base = resolveDiffBase(repoRoot, baseBranch, targetSha);
  const raw = base
    ? runGit(repoRoot, ['diff', '--name-only', '-z', `${base}..${targetSha}`], true)
    : runGit(repoRoot, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', targetSha], true);
  return splitNul(raw).sort();
}

function resolveDiffBase(repoRoot: string, baseBranch: string, target: string): string | null {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const base = runGit(repoRoot, ['merge-base', target, ref], true)?.trim();
    if (base && base !== target) return base;
  }

  const parentsLine = runGit(repoRoot, ['rev-list', '--parents', '-n', '1', target], true)?.trim();
  const parents = parentsLine ? parentsLine.split(/\s+/u).slice(1) : [];
  return parents[0] ?? null;
}

function splitNul(raw: string | null): string[] {
  return (raw ?? '').split('\0').filter((entry) => entry.length > 0);
}

function previewPaths(paths: string[]): string {
  const preview = paths.slice(0, 5).map(sanitizeForTerminal).join(', ');
  return paths.length > 5 ? `${preview}, +${paths.length - 5} more` : preview;
}
