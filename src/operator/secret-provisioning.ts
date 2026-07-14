import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export const SECRET_PROVISIONING_MANIFEST = '.github/pipelane-provisioning.json';
const GITHUB_SECRET_MAX_BYTES = 48 * 1024;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HELDOUT_GROUPS = new Set([
  'benign',
  'fantasy_violence',
  'harassment',
  'hate_threat',
  'minor_safety',
  'self_harm',
  'pii_links',
  'unicode',
]);

interface EnvironmentSecretSource {
  type: 'environment';
  variable: string;
}

interface CloudflareApiTokenSource {
  type: 'cloudflare-api-token';
  variable: string;
  wranglerCwd?: string;
  dotenvFile?: string;
  dotenvVariable?: string;
}

interface Base64FileSecretSource {
  type: 'file-base64';
  pathVariable: string;
  defaultPath?: string;
  validator?: 'chat-heldout-corpus-v1';
}

export type RepositorySecretSource =
  | EnvironmentSecretSource
  | CloudflareApiTokenSource
  | Base64FileSecretSource;

export interface RepositorySecretProvision {
  name: string;
  description?: string;
  source: RepositorySecretSource;
}

export interface SecretProvisioningManifest {
  version: 1;
  github: {
    repositorySecrets: RepositorySecretProvision[];
  };
}

export type SecretProvisioningStatus = 'existing' | 'ready' | 'provisioned' | 'blocked';

export interface SecretProvisioningEntryResult {
  name: string;
  status: SecretProvisioningStatus;
  detail: string;
}

export interface SecretProvisioningResult {
  manifestPath: string;
  applied: boolean;
  rotate: boolean;
  ok: boolean;
  entries: SecretProvisioningEntryResult[];
}

export interface SecretProvisioningOptions {
  apply?: boolean;
  rotate?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface ResolvedSecretValue {
  ok: true;
  value: string;
  detail: string;
}

interface UnresolvedSecretValue {
  ok: false;
  detail: string;
}

export function loadSecretProvisioningManifest(repoRoot: string): SecretProvisioningManifest | null {
  const manifestPath = path.join(repoRoot, SECRET_PROVISIONING_MANIFEST);
  if (!existsSync(manifestPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${SECRET_PROVISIONING_MANIFEST} is not valid JSON: ${detail}`);
  }
  if (!isRecord(raw) || raw.version !== 1) {
    throw new Error(`${SECRET_PROVISIONING_MANIFEST} must be an object with version 1.`);
  }
  assertAllowedKeys(raw, ['version', 'github'], SECRET_PROVISIONING_MANIFEST);
  if (!isRecord(raw.github) || !Array.isArray(raw.github.repositorySecrets)) {
    throw new Error(`${SECRET_PROVISIONING_MANIFEST} must declare github.repositorySecrets as an array.`);
  }
  assertAllowedKeys(raw.github, ['repositorySecrets'], `${SECRET_PROVISIONING_MANIFEST} github`);
  if (raw.github.repositorySecrets.length > 100) {
    throw new Error(`${SECRET_PROVISIONING_MANIFEST} declares more than GitHub's 100 repository-secret limit.`);
  }

  const seen = new Set<string>();
  const repositorySecrets = raw.github.repositorySecrets.map((entry, index) => {
    const location = `${SECRET_PROVISIONING_MANIFEST} github.repositorySecrets[${index}]`;
    if (!isRecord(entry)) throw new Error(`${location} must be an object.`);
    assertAllowedKeys(entry, ['name', 'description', 'source'], location);
    const name = requiredName(entry.name, `${location}.name`, SECRET_NAME_PATTERN);
    if (seen.has(name)) throw new Error(`${SECRET_PROVISIONING_MANIFEST} declares duplicate secret ${name}.`);
    seen.add(name);
    const description = optionalString(entry.description, `${location}.description`);
    const source = parseSecretSource(entry.source, `${location}.source`, repoRoot);
    return { name, ...(description ? { description } : {}), source };
  });

  return {
    version: 1,
    github: { repositorySecrets },
  };
}

export function provisionRepositorySecrets(
  repoRoot: string,
  options: SecretProvisioningOptions = {},
): SecretProvisioningResult | null {
  const manifest = loadSecretProvisioningManifest(repoRoot);
  if (!manifest) return null;
  const manifestPath = path.join(repoRoot, SECRET_PROVISIONING_MANIFEST);
  const apply = options.apply === true;
  const rotate = options.rotate === true;
  const env = options.env ?? process.env;
  const existing = listRepositorySecretNames(repoRoot);
  const entries: SecretProvisioningEntryResult[] = [];
  const resolvedValues = new Map<string, string>();

  for (const secret of manifest.github.repositorySecrets) {
    if (existing.has(secret.name) && !rotate) {
      entries.push({ name: secret.name, status: 'existing', detail: 'already configured; preserved' });
      continue;
    }
    const resolved = resolveSecretValue(repoRoot, secret.source, env);
    if (!resolved.ok) {
      entries.push({ name: secret.name, status: 'blocked', detail: resolved.detail });
      continue;
    }
    resolvedValues.set(secret.name, resolved.value);
    entries.push({
      name: secret.name,
      status: apply ? 'provisioned' : 'ready',
      detail: apply ? `${resolved.detail}; installed through gh stdin` : resolved.detail,
    });
  }

  if (apply) {
    for (const [name, value] of resolvedValues) {
      setRepositorySecret(repoRoot, name, value);
    }
    const verified = listRepositorySecretNames(repoRoot);
    for (const entry of entries) {
      if (entry.status === 'provisioned' && !verified.has(entry.name)) {
        entry.status = 'blocked';
        entry.detail = 'gh accepted the write but the secret was absent during verification';
      }
    }
  }

  return {
    manifestPath,
    applied: apply,
    rotate,
    ok: entries.every((entry) => entry.status !== 'blocked'),
    entries,
  };
}

export function formatSecretProvisioningResult(
  result: SecretProvisioningResult,
  provisionCommand = '/pipelane configure --provision-secrets',
): string[] {
  const lines = [
    `Repository secret provisioning (${SECRET_PROVISIONING_MANIFEST}):`,
  ];
  for (const entry of result.entries) {
    const marker = entry.status === 'existing'
      ? '✓'
      : entry.status === 'provisioned'
        ? '+'
        : entry.status === 'ready'
          ? '~'
          : '!';
    lines.push(`- ${marker} ${entry.name}: ${entry.detail}`);
  }
  if (!result.applied && result.entries.some((entry) => entry.status === 'ready')) {
    lines.push(`Run \`${provisionCommand}\` to install the ready values.`);
  }
  if (result.entries.some((entry) => entry.status === 'blocked')) {
    lines.push('Blocked values were not installed. Supply the named environment/file source, then rerun provisioning.');
  }
  if (result.applied && result.ok) {
    lines.push('All declared repository secrets are configured. Existing values were preserved unless rotation was requested.');
  }
  return lines;
}

function parseSecretSource(raw: unknown, location: string, repoRoot: string): RepositorySecretSource {
  if (!isRecord(raw) || typeof raw.type !== 'string') {
    throw new Error(`${location} must be an object with a supported type.`);
  }
  if (raw.type === 'environment') {
    assertAllowedKeys(raw, ['type', 'variable'], location);
    return {
      type: raw.type,
      variable: requiredName(raw.variable, `${location}.variable`, ENVIRONMENT_NAME_PATTERN),
    };
  }
  if (raw.type === 'cloudflare-api-token') {
    assertAllowedKeys(raw, ['type', 'variable', 'wranglerCwd', 'dotenvFile', 'dotenvVariable'], location);
    const variable = requiredName(raw.variable, `${location}.variable`, ENVIRONMENT_NAME_PATTERN);
    const wranglerCwd = optionalString(raw.wranglerCwd, `${location}.wranglerCwd`);
    const dotenvFile = optionalString(raw.dotenvFile, `${location}.dotenvFile`);
    const dotenvVariable = optionalString(raw.dotenvVariable, `${location}.dotenvVariable`);
    if (wranglerCwd) assertRepoRelativeDirectory(repoRoot, wranglerCwd, `${location}.wranglerCwd`);
    if (dotenvFile) assertRepoRelativePath(repoRoot, dotenvFile, `${location}.dotenvFile`);
    if (dotenvVariable && !dotenvFile) {
      throw new Error(`${location}.dotenvVariable requires dotenvFile.`);
    }
    if (dotenvFile && !dotenvVariable) {
      throw new Error(`${location}.dotenvFile requires dotenvVariable.`);
    }
    if (dotenvVariable) requiredName(dotenvVariable, `${location}.dotenvVariable`, ENVIRONMENT_NAME_PATTERN);
    return {
      type: raw.type,
      variable,
      ...(wranglerCwd ? { wranglerCwd } : {}),
      ...(dotenvFile ? { dotenvFile, dotenvVariable } : {}),
    };
  }
  if (raw.type === 'file-base64') {
    assertAllowedKeys(raw, ['type', 'pathVariable', 'defaultPath', 'validator'], location);
    const pathVariable = requiredName(raw.pathVariable, `${location}.pathVariable`, ENVIRONMENT_NAME_PATTERN);
    const defaultPath = optionalString(raw.defaultPath, `${location}.defaultPath`);
    if (defaultPath) assertRepoRelativePath(repoRoot, defaultPath, `${location}.defaultPath`);
    if (raw.validator !== undefined && raw.validator !== 'chat-heldout-corpus-v1') {
      throw new Error(`${location}.validator must be chat-heldout-corpus-v1 when provided.`);
    }
    const validator = raw.validator === 'chat-heldout-corpus-v1' ? raw.validator : undefined;
    return {
      type: raw.type,
      pathVariable,
      ...(defaultPath ? { defaultPath } : {}),
      ...(validator ? { validator } : {}),
    };
  }
  throw new Error(`${location}.type must be environment, cloudflare-api-token, or file-base64.`);
}

function resolveSecretValue(
  repoRoot: string,
  source: RepositorySecretSource,
  env: NodeJS.ProcessEnv,
): ResolvedSecretValue | UnresolvedSecretValue {
  if (source.type === 'environment') {
    const value = env[source.variable];
    return value && value.trim()
      ? checkedSecretValue(value, `read from environment variable ${source.variable}`)
      : { ok: false, detail: `environment variable ${source.variable} is not set` };
  }
  if (source.type === 'cloudflare-api-token') {
    const direct = env[source.variable];
    if (direct && direct.trim()) {
      return checkedSecretValue(direct, `read from environment variable ${source.variable}`);
    }
    if (source.dotenvFile && source.dotenvVariable) {
      const dotenvPath = path.resolve(repoRoot, source.dotenvFile);
      if (existsSync(dotenvPath) && !isSafeManifestFile(repoRoot, dotenvPath)) {
        return { ok: false, detail: `allowlisted dotenv file ${source.dotenvFile} escapes the repository or is a symlink` };
      }
      const dotenvValue = readDotenvValue(dotenvPath, source.dotenvVariable);
      if (dotenvValue) {
        return checkedSecretValue(
          dotenvValue,
          `read allowlisted ${source.dotenvVariable} from ${source.dotenvFile}`,
        );
      }
    }
    return readWranglerApiToken(repoRoot, source, env);
  }

  const rawPath = env[source.pathVariable]?.trim() || source.defaultPath;
  if (!rawPath) return { ok: false, detail: `file path environment variable ${source.pathVariable} is not set` };
  const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(repoRoot, rawPath);
  const sourceLabel = env[source.pathVariable]?.trim()
    ? `file from ${source.pathVariable}`
    : `default file ${source.defaultPath}`;
  if (!existsSync(filePath)) return { ok: false, detail: `${sourceLabel} does not exist` };
  if (!env[source.pathVariable]?.trim() && !isSafeManifestFile(repoRoot, filePath)) {
    return { ok: false, detail: `${sourceLabel} escapes the repository or is a symlink` };
  }
  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch {
    return { ok: false, detail: `${sourceLabel} could not be inspected` };
  }
  if (!fileStat.isFile()) return { ok: false, detail: `${sourceLabel} is not a regular file` };
  if (4 * Math.ceil(fileStat.size / 3) > GITHUB_SECRET_MAX_BYTES) {
    return { ok: false, detail: `${sourceLabel} exceeds GitHub's 48 KB secret limit after Base64 encoding` };
  }
  const body = readFileSync(filePath);
  if (source.validator === 'chat-heldout-corpus-v1') validateChatHeldoutCorpus(body);
  const encoded = body.toString('base64');
  return checkedSecretValue(encoded, `validated and Base64-encoded ${sourceLabel}`);
}

function readDotenvValue(filePath: string, variable: string): string | null {
  if (!existsSync(filePath)) return null;
  let body: string;
  try {
    const fileStat = statSync(filePath);
    if (!fileStat.isFile() || fileStat.size > 1024 * 1024) return null;
    body = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== variable) continue;
    const raw = match[2].trim();
    if (!raw) return null;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1) || null;
    }
    return raw;
  }
  return null;
}

function readWranglerApiToken(
  repoRoot: string,
  source: CloudflareApiTokenSource,
  env: NodeJS.ProcessEnv,
): ResolvedSecretValue | UnresolvedSecretValue {
  const wranglerCwd = path.resolve(repoRoot, source.wranglerCwd ?? '.');
  if (!isSafeManifestDirectory(repoRoot, wranglerCwd)) {
    return { ok: false, detail: 'Wrangler working directory escapes the repository or is not a directory' };
  }
  const localWrangler = path.join(
    wranglerCwd,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
  );
  const executable = existsSync(localWrangler) ? localWrangler : findExecutableOnPath('wrangler', env.PATH);
  if (!executable) {
    return {
      ok: false,
      detail: `environment variable ${source.variable} is not set and Wrangler is unavailable`,
    };
  }
  const result = spawnSync(executable, ['auth', 'token', '--json'], {
    cwd: wranglerCwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      detail: `environment variable ${source.variable} is not set and Wrangler has no usable authentication`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout ?? '') as Record<string, unknown>;
    if (parsed.type !== 'api_token' || typeof parsed.token !== 'string' || !parsed.token.trim()) {
      return {
        ok: false,
        detail: `Wrangler authentication is ${typeof parsed.type === 'string' ? parsed.type : 'unknown'}; CI requires a durable API token via ${source.variable}`,
      };
    }
    return checkedSecretValue(parsed.token, 'read a durable API token from Wrangler authentication');
  } catch {
    return { ok: false, detail: 'Wrangler returned an unreadable authentication response' };
  }
}

function validateChatHeldoutCorpus(body: Buffer): void {
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString('utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`held-out corpus is not valid JSON: ${detail}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('held-out corpus must be a non-empty JSON array.');
  }
  const ids = new Set<string>();
  raw.forEach((entry, index) => {
    const location = `held-out corpus case[${index}]`;
    if (!isRecord(entry)) throw new Error(`${location} must be an object.`);
    const id = requiredName(entry.id, `${location}.id`, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
    if (ids.has(id)) throw new Error(`held-out corpus contains duplicate id ${id}.`);
    ids.add(id);
    if (typeof entry.group !== 'string' || !HELDOUT_GROUPS.has(entry.group)) {
      throw new Error(`${location}.group is not a supported moderation group.`);
    }
    if (typeof entry.text !== 'string' || !entry.text.trim() || [...entry.text].length > 500) {
      throw new Error(`${location}.text must contain 1-500 Unicode characters.`);
    }
    if (entry.expected !== 'allow' && entry.expected !== 'reject') {
      throw new Error(`${location}.expected must be allow or reject.`);
    }
    if (entry.critical !== undefined && typeof entry.critical !== 'boolean') {
      throw new Error(`${location}.critical must be a boolean when provided.`);
    }
  });
}

function checkedSecretValue(value: string, detail: string): ResolvedSecretValue | UnresolvedSecretValue {
  if (Buffer.byteLength(value, 'utf8') > GITHUB_SECRET_MAX_BYTES) {
    return { ok: false, detail: `${detail}, but the encoded value exceeds GitHub's 48 KB secret limit` };
  }
  return { ok: true, value, detail };
}

function listRepositorySecretNames(repoRoot: string): Set<string> {
  const result = spawnSync('gh', ['secret', 'list', '--json', 'name'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error('GitHub repository secret inspection failed. Run `gh auth status` and confirm repository write access.');
  }
  try {
    const parsed = JSON.parse(result.stdout ?? '') as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return new Set(parsed.flatMap((entry) => isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : []));
  } catch {
    throw new Error('GitHub repository secret inspection returned an unreadable response.');
  }
}

function setRepositorySecret(repoRoot: string, name: string, value: string): void {
  const result = spawnSync('gh', ['secret', 'set', name], {
    cwd: repoRoot,
    input: value,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`GitHub repository secret ${name} could not be installed. Pipelane did not log or persist the secret value locally.`);
  }
}

function findExecutableOnPath(name: string, pathValue: string | undefined): string | null {
  const candidates = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const directory of (pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const file = path.join(directory, candidate);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function assertRepoRelativePath(repoRoot: string, value: string, location: string): void {
  if (path.isAbsolute(value)) throw new Error(`${location} must be repository-relative.`);
  const resolved = path.resolve(repoRoot, value);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${location} must stay inside the repository.`);
  }
}

const assertRepoRelativeDirectory = assertRepoRelativePath;

function isSafeManifestFile(repoRoot: string, filePath: string): boolean {
  try {
    return !lstatSync(filePath).isSymbolicLink()
      && statSync(filePath).isFile()
      && isResolvedInsideRepo(repoRoot, filePath);
  } catch {
    return false;
  }
}

function isSafeManifestDirectory(repoRoot: string, directory: string): boolean {
  try {
    return statSync(directory).isDirectory() && isResolvedInsideRepo(repoRoot, directory);
  } catch {
    return false;
  }
}

function isResolvedInsideRepo(repoRoot: string, target: string): boolean {
  const realRepoRoot = realpathSync(repoRoot);
  const realTarget = realpathSync(target);
  const relative = path.relative(realRepoRoot, realTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertAllowedKeys(raw: Record<string, unknown>, allowed: string[], location: string): void {
  const unexpected = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${location} has unsupported field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}.`);
  }
}

function requiredName(value: unknown, location: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${location} has an invalid name.`);
  }
  return value;
}

function optionalString(value: unknown, location: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${location} must be a string when provided.`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
