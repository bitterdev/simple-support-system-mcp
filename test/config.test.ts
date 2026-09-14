/* Author: Fabian Bitter (fabian@bitter.de) */

import assert from 'node:assert/strict';
import test from 'node:test';
import { API_KEY_HEADER, DEFAULT_TIMEOUT_MS, loadConfig, resolveApiUrl } from '../src/config.js';

test('the API path is appended to a plain site URL', () => {
  assert.equal(resolveApiUrl('https://example.com'), 'https://example.com/index.php/api/v1');
  assert.equal(resolveApiUrl('https://example.com/'), 'https://example.com/index.php/api/v1');
  assert.equal(resolveApiUrl('https://example.com/support/'), 'https://example.com/support/index.php/api/v1');
});

test('a URL that already points at the API is kept', () => {
  assert.equal(resolveApiUrl('https://example.com/api/v1'), 'https://example.com/api/v1');
  assert.equal(resolveApiUrl('https://example.com/index.php/api/v1/'), 'https://example.com/index.php/api/v1');
});

test('a custom API path overrides the default', () => {
  assert.equal(resolveApiUrl('https://example.com', '/api/v1'), 'https://example.com/api/v1');
  assert.equal(resolveApiUrl('https://example.com', 'api/v1'), 'https://example.com/api/v1');
});

test('the config is read from the environment', () => {
  const config = loadConfig({
    SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'https://example.com/',
    SIMPLE_SUPPORT_SYSTEM_API_KEY: 'secret',
    SIMPLE_SUPPORT_SYSTEM_PROJECT_TOKEN: 'token',
  });
  assert.equal(config.baseUrl, 'https://example.com');
  assert.equal(config.apiUrl, 'https://example.com/index.php/api/v1');
  assert.equal(config.apiKey, 'secret');
  assert.equal(config.projectToken, 'token');
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('a pinned project id is read from the environment', () => {
  const config = loadConfig({
    SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'https://example.com',
    SIMPLE_SUPPORT_SYSTEM_PROJECT_ID: '59',
  });
  assert.equal(config.projectId, 59);
  assert.equal(loadConfig({ SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'https://example.com' }).projectId, undefined);
});

test('a malformed pinned project id is rejected', () => {
  for (const value of ['abc', '0', '-3', '5.5']) {
    assert.throws(
      () => loadConfig({ SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'https://example.com', SIMPLE_SUPPORT_SYSTEM_PROJECT_ID: value }),
      /SIMPLE_SUPPORT_SYSTEM_PROJECT_ID must be a positive integer/,
    );
  }
});

test('empty environment values count as unset', () => {
  const config = loadConfig({
    SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'https://example.com',
    SIMPLE_SUPPORT_SYSTEM_API_KEY: '   ',
  });
  assert.equal(config.apiKey, undefined);
});

test('a missing base URL is reported by name', () => {
  assert.throws(() => loadConfig({}), /SIMPLE_SUPPORT_SYSTEM_BASE_URL is not set/);
});

test('a malformed base URL is rejected', () => {
  assert.throws(() => loadConfig({ SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'not a url' }), /not a valid URL/);
  assert.throws(() => loadConfig({ SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'ftp://example.com' }), /must use http or https/);
});

test('a bad timeout is rejected', () => {
  assert.throws(
    () =>
      loadConfig({
        SIMPLE_SUPPORT_SYSTEM_BASE_URL: 'https://example.com',
        SIMPLE_SUPPORT_SYSTEM_TIMEOUT_MS: 'soon',
      }),
    /positive number of milliseconds/,
  );
});

test('the auth header name matches the middleware', () => {
  assert.equal(API_KEY_HEADER, 'X-Api-Key');
});
