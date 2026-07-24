/* Author: Fabian Bitter (fabian@bitter.de) */

import { SupportSystemClient } from '../src/client.js';
import type { ServerConfig } from '../src/config.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/http.js';

export interface StubResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

export interface HttpStub {
  client: HttpClient;
  requests: HttpRequest[];
  /** Body of the last request, decoded as form fields. */
  lastForm(): URLSearchParams;
  lastUrl(): URL;
}

/** Mocked HTTP layer. No test ever opens a socket. */
export function createHttpStub(responses: StubResponse | StubResponse[]): HttpStub {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const requests: HttpRequest[] = [];
  let last: StubResponse = { status: 200, body: {} };

  const client: HttpClient = async (request) => {
    requests.push(request);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    last = next ?? last;
    const response: HttpResponse = {
      status: last.status ?? 200,
      headers: last.headers ?? {},
      text: last.text ?? (last.body === undefined ? '' : JSON.stringify(last.body)),
      ...(last.bytes !== undefined ? { bytes: last.bytes } : {}),
    };
    return response;
  };

  return {
    client,
    requests,
    lastForm(): URLSearchParams {
      const body = requests[requests.length - 1]?.body;
      return new URLSearchParams(typeof body === 'string' ? body : '');
    },
    lastUrl(): URL {
      return new URL(requests[requests.length - 1]?.url ?? 'http://localhost/');
    },
  };
}

export const testConfig: ServerConfig = {
  baseUrl: 'https://support.example.com',
  apiUrl: 'https://support.example.com/index.php/api/v1',
  apiKey: 'test-key',
  timeoutMs: 5000,
};

export function createTestClient(
  responses: StubResponse | StubResponse[],
  config: Partial<ServerConfig> = {},
): { client: SupportSystemClient; http: HttpStub } {
  const http = createHttpStub(responses);
  return { client: new SupportSystemClient({ ...testConfig, ...config }, http.client), http };
}
