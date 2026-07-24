/* Author: Fabian Bitter (fabian@bitter.de) */

export interface ApiErrorDetails {
  status: number;
  method: string;
  path: string;
  errors: string[];
  body: unknown;
  hint?: string;
}

/** Error raised for every API response the server refuses to treat as a success. */
export class ApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly errors: string[];
  readonly body: unknown;
  readonly hint?: string;

  constructor(details: ApiErrorDetails) {
    const listed = details.errors.length > 0 ? details.errors.join(' ') : 'The API returned an error without a message.';
    const parts = [`Simple Support System API error ${details.status} on ${details.method} ${details.path}: ${listed}`];
    if (details.hint !== undefined) {
      parts.push(details.hint);
    }
    super(parts.join(' '));
    this.name = 'ApiError';
    this.status = details.status;
    this.method = details.method;
    this.path = details.path;
    this.errors = details.errors;
    this.body = details.body;
    this.hint = details.hint;
  }
}
