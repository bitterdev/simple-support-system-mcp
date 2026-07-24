/* Author: Fabian Bitter (fabian@bitter.de) */

export const ENV_BASE_URL = 'SIMPLE_SUPPORT_SYSTEM_BASE_URL';
export const ENV_API_KEY = 'SIMPLE_SUPPORT_SYSTEM_API_KEY';
export const ENV_API_PATH = 'SIMPLE_SUPPORT_SYSTEM_API_PATH';
export const ENV_PROJECT_TOKEN = 'SIMPLE_SUPPORT_SYSTEM_PROJECT_TOKEN';
export const ENV_TIMEOUT_MS = 'SIMPLE_SUPPORT_SYSTEM_TIMEOUT_MS';

export const API_KEY_HEADER = 'X-Api-Key';
export const DEFAULT_API_PATH = '/index.php/api/v1';
export const DEFAULT_TIMEOUT_MS = 30000;

export interface ServerConfig {
  /** Site base URL without a trailing slash. */
  baseUrl: string;
  /** Full base URL of the v1 API, without a trailing slash. */
  apiUrl: string;
  /** API key sent as X-Api-Key. Absent means public access only. */
  apiKey?: string;
  /** Fallback access token for private projects. */
  projectToken?: string;
  timeoutMs: number;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Build the API base URL. A base URL that already points at an api/v1 endpoint is
 * kept as it is, everything else gets the Concrete CMS dispatcher path appended.
 */
export function resolveApiUrl(baseUrl: string, apiPath?: string): string {
  const base = stripTrailingSlashes(baseUrl.trim());

  if (apiPath !== undefined && apiPath.trim() !== '') {
    const path = stripTrailingSlashes(apiPath.trim());
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  if (/\/api\/v1$/i.test(base)) {
    return base;
  }

  return `${base}${DEFAULT_API_PATH}`;
}

function readOptional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawBaseUrl = readOptional(env, ENV_BASE_URL);
  if (rawBaseUrl === undefined) {
    throw new Error(
      `${ENV_BASE_URL} is not set. Point it at the Concrete CMS site that runs the Simple Support System package, for example https://support.example.com`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`${ENV_BASE_URL} is not a valid URL: ${rawBaseUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${ENV_BASE_URL} must use http or https, got ${parsed.protocol}`);
  }

  const rawTimeout = readOptional(env, ENV_TIMEOUT_MS);
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const parsedTimeout = Number(rawTimeout);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error(`${ENV_TIMEOUT_MS} must be a positive number of milliseconds, got ${rawTimeout}`);
    }
    timeoutMs = Math.floor(parsedTimeout);
  }

  const baseUrl = stripTrailingSlashes(rawBaseUrl);

  return {
    baseUrl,
    apiUrl: resolveApiUrl(baseUrl, readOptional(env, ENV_API_PATH)),
    apiKey: readOptional(env, ENV_API_KEY),
    projectToken: readOptional(env, ENV_PROJECT_TOKEN),
    timeoutMs,
  };
}
