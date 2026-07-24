/* Author: Fabian Bitter (fabian@bitter.de) */

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** Form encoded string or multipart form data. */
  body?: string | FormData;
  /** "manual" keeps redirects unfollowed so the Location header can be read. */
  redirect?: 'follow' | 'manual';
  /** "binary" fills the bytes field of the response instead of the text field. */
  responseType?: 'text' | 'binary';
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes?: Uint8Array;
}

/** The single seam that talks to the network. Tests replace it with a stub. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

export const fetchHttpClient: HttpClient = async (request) => {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect ?? 'follow',
  };

  if (request.body !== undefined) {
    init.body = request.body;
  }

  if (request.timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(request.timeoutMs);
  }

  let response: Response;
  try {
    response = await fetch(request.url, init);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Request to ${request.url} failed: ${reason}`);
  }

  if (request.responseType === 'binary') {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      headers: collectHeaders(response.headers),
      text: '',
      bytes: buffer,
    };
  }

  return {
    status: response.status,
    headers: collectHeaders(response.headers),
    text: await response.text(),
  };
};
