export interface SurfaceBuckets {
  surfaces: Record<string, string[]>;
  other: string[];
}

interface NormalizedSurface {
  surface: string;
  exactFiles: Set<string>;
  dirPrefixes: string[];
}

// Map a surface map to a pre-normalized list used by matchSurfacesFast.
// Keys are pre-sorted alphabetically so iteration order is deterministic
// across Node versions. Each pattern is classified once, avoiding repeated
// string work for every changed file.
function buildNormalizedSurfaceMap(map: Record<string, string[]>): NormalizedSurface[] {
  const surfaces = Object.keys(map).sort();
  return surfaces.map((surface) => {
    const exactFiles = new Set<string>();
    const dirPrefixes: string[] = [];
    for (const rawPattern of map[surface] ?? []) {
      if (!rawPattern) continue;
      const pattern = toPosixPath(rawPattern);
      if (pattern.endsWith('/')) {
        dirPrefixes.push(pattern);
      } else {
        exactFiles.add(pattern);
        dirPrefixes.push(`${pattern}/`);
      }
    }
    return { surface, exactFiles, dirPrefixes };
  });
}

export function bucketPathsBySurface(paths: string[], map: Record<string, string[]> = {}): SurfaceBuckets {
  const normalizedMap = buildNormalizedSurfaceMap(map);
  const surfaces: Record<string, string[]> = {};
  const other: string[] = [];

  for (const file of paths) {
    const normalizedFile = toPosixPath(file);
    const matched = matchSurfacesFast(normalizedFile, normalizedMap);
    if (matched.length === 0) {
      other.push(file);
      continue;
    }
    for (const surface of matched) {
      if (!surfaces[surface]) surfaces[surface] = [];
      surfaces[surface].push(file);
    }
  }

  for (const list of Object.values(surfaces)) list.sort();
  other.sort();
  return { surfaces, other };
}

function matchSurfacesFast(file: string, surfaces: NormalizedSurface[]): string[] {
  const matched: string[] = [];
  for (const { surface, exactFiles, dirPrefixes } of surfaces) {
    if (exactFiles.has(file)) {
      matched.push(surface);
      continue;
    }
    if (dirPrefixes.some((prefix) => file.startsWith(prefix))) {
      matched.push(surface);
    }
  }
  return matched;
}

function toPosixPath(file: string): string {
  return file.replace(/\\/g, '/');
}
