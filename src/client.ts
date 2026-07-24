/* Author: Fabian Bitter (fabian@bitter.de) */

import { API_KEY_HEADER, type ServerConfig } from './config.js';
import { ApiError } from './errors.js';
import { collectErrors, hasErrorFlag, parseJson, unwrapCollection, unwrapResource } from './format.js';
import { fetchHttpClient, type HttpClient, type HttpResponse } from './http.js';
import type { Attachment, Project, Ticket, TicketComment } from './types.js';

export type FormScalar = string | number | boolean | null;
export type FormFields = Record<string, FormScalar | FormScalar[] | undefined>;
export type QueryFields = Record<string, string | number | undefined>;

function encodeScalar(value: FormScalar): string {
  if (typeof value === 'boolean') {
    // PHP casts the raw string, so "false" and "0" must be sent as "0".
    return value ? '1' : '0';
  }
  if (value === null) {
    return '';
  }
  return String(value);
}

/** Encode a form body the way the PHP controllers expect it, arrays as name[]. */
export function encodeForm(fields: FormFields): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        params.append(`${key}[]`, encodeScalar(entry));
      }
      continue;
    }
    params.append(key, encodeScalar(value));
  }
  return params.toString();
}

export function buildUrl(apiUrl: string, path: string, query?: QueryFields): string {
  const url = `${apiUrl}${path.startsWith('/') ? path : `/${path}`}`;
  if (query === undefined) {
    return url;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue;
    }
    params.append(key, String(value));
  }
  const search = params.toString();
  return search === '' ? url : `${url}?${search}`;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: QueryFields;
  form?: FormFields;
  formData?: FormData;
  redirect?: 'follow' | 'manual';
  responseType?: 'text' | 'binary';
  /** Accept 3xx responses instead of treating them as an error. */
  allowRedirect?: boolean;
}

export interface RawResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  text: string;
  bytes?: Uint8Array;
}

export class SupportSystemClient {
  private readonly config: ServerConfig;
  private readonly http: HttpClient;

  constructor(config: ServerConfig, http: HttpClient = fetchHttpClient) {
    this.config = config;
    this.http = http;
  }

  get settings(): ServerConfig {
    return this.config;
  }

  /** Token precedence: explicit call argument first, configured fallback second. */
  private token(token?: string): string | undefined {
    const explicit = token?.trim();
    if (explicit !== undefined && explicit !== '') {
      return explicit;
    }
    return this.config.projectToken;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extra };
    if (this.config.apiKey !== undefined) {
      headers[API_KEY_HEADER] = this.config.apiKey;
    }
    return headers;
  }

  private async send(options: RequestOptions): Promise<RawResult> {
    const url = buildUrl(this.config.apiUrl, options.path, options.query);
    let body: string | FormData | undefined;
    let extraHeaders: Record<string, string> | undefined;

    if (options.formData !== undefined) {
      body = options.formData;
    } else if (options.method === 'POST') {
      body = encodeForm(options.form ?? {});
      extraHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }

    const response: HttpResponse = await this.http({
      method: options.method,
      url,
      headers: this.headers(extraHeaders),
      body,
      redirect: options.redirect,
      responseType: options.responseType,
      timeoutMs: this.config.timeoutMs,
    });

    const parsed = parseJson(response.text);
    const result: RawResult = {
      status: response.status,
      headers: response.headers,
      body: parsed,
      text: response.text,
      ...(response.bytes !== undefined ? { bytes: response.bytes } : {}),
    };

    const redirected = response.status >= 300 && response.status < 400;
    if (redirected && options.allowRedirect === true) {
      return result;
    }

    if (response.status >= 400 || hasErrorFlag(parsed)) {
      throw new ApiError({
        status: response.status,
        method: options.method,
        path: options.path,
        errors: this.describeErrors(parsed, response),
        body: parsed ?? response.text,
        ...(this.hint(response.status) !== undefined ? { hint: this.hint(response.status) as string } : {}),
      });
    }

    return result;
  }

  private describeErrors(parsed: unknown, response: HttpResponse): string[] {
    const errors = collectErrors(parsed);
    if (errors.length > 0) {
      return errors;
    }
    const snippet = response.text.trim().slice(0, 300);
    return snippet === '' ? [] : [snippet];
  }

  private hint(status: number): string | undefined {
    if ((status === 401 || status === 403) && this.config.apiKey === undefined) {
      return 'No API key is configured, so the call was made as an anonymous visitor. Set SIMPLE_SUPPORT_SYSTEM_API_KEY for administrative operations.';
    }
    if (status === 404) {
      return 'Check the id, and check that SIMPLE_SUPPORT_SYSTEM_BASE_URL points at the site that runs the package.';
    }
    return undefined;
  }

  // Projects

  async listProjects(token?: string): Promise<Project[]> {
    const result = await this.send({
      method: 'GET',
      path: '/project/list',
      query: { token: this.token(token) },
    });
    return unwrapCollection(result.body) as Project[];
  }

  async getProject(id: number, token?: string): Promise<Project> {
    const result = await this.send({
      method: 'GET',
      path: `/project/${id}`,
      query: { token: this.token(token) },
    });
    return unwrapResource(result.body) as Project;
  }

  async createProject(fields: { name: string; handle: string; isPrivate?: boolean }): Promise<Project> {
    const result = await this.send({
      method: 'POST',
      path: '/project/create',
      form: { name: fields.name, handle: fields.handle, isPrivate: fields.isPrivate },
    });
    return unwrapResource(result.body) as Project;
  }

  async updateProject(id: number, fields: { name?: string; handle?: string; isPrivate?: boolean }): Promise<Project> {
    const result = await this.send({
      method: 'POST',
      path: `/project/${id}/update`,
      form: { name: fields.name, handle: fields.handle, isPrivate: fields.isPrivate },
    });
    return unwrapResource(result.body) as Project;
  }

  async deleteProject(id: number): Promise<unknown> {
    const result = await this.send({ method: 'POST', path: `/project/${id}/delete` });
    return result.body;
  }

  /** Resolve a project handle to its numeric id, using the project list. */
  async resolveProjectId(handle: string, token?: string): Promise<number> {
    const projects = await this.listProjects(token);
    const match = projects.find((project) => project.handle === handle);
    if (match === undefined || typeof match.id !== 'number') {
      const known = projects
        .map((project) => project.handle)
        .filter((value): value is string => typeof value === 'string')
        .join(', ');
      throw new Error(`No project with the handle "${handle}" was found. Known handles: ${known === '' ? 'none' : known}`);
    }
    return match.id;
  }

  // Tickets

  async listTickets(options: { projectId?: number; token?: string } = {}): Promise<Ticket[]> {
    const result = await this.send({
      method: 'GET',
      path: '/ticket/list',
      query: { projectId: options.projectId, token: this.token(options.token) },
    });
    return unwrapCollection(result.body) as Ticket[];
  }

  async getTicket(id: number, token?: string): Promise<Ticket> {
    const result = await this.send({
      method: 'GET',
      path: `/ticket/${id}`,
      query: { token: this.token(token) },
    });
    return unwrapResource(result.body) as Ticket;
  }

  async createTicket(fields: {
    projectId?: number;
    projectHandle?: string;
    title: string;
    content: string;
    ticketType: string;
    ticketPriority: string;
    email?: string;
    token?: string;
    attachmentFileIds?: number[];
  }): Promise<unknown> {
    const result = await this.send({
      method: 'POST',
      path: '/ticket/create',
      form: {
        projectId: fields.projectId,
        projectHandle: fields.projectHandle,
        title: fields.title,
        content: fields.content,
        ticketType: fields.ticketType,
        ticketPriority: fields.ticketPriority,
        email: fields.email,
        token: this.token(fields.token),
        attachmentFileIds: fields.attachmentFileIds,
      },
    });
    return result.body;
  }

  async updateTicket(
    id: number,
    fields: {
      title?: string;
      content?: string;
      ticketType?: string;
      ticketPriority?: string;
      assigneeUserId?: number | null;
    },
  ): Promise<Ticket> {
    const form: FormFields = {
      title: fields.title,
      content: fields.content,
      ticketType: fields.ticketType,
      ticketPriority: fields.ticketPriority,
    };
    if (fields.assigneeUserId !== undefined) {
      // 0 clears the assignee, the controller only looks at the key being present.
      form.assigneeUserId = fields.assigneeUserId === null ? 0 : fields.assigneeUserId;
    }
    const result = await this.send({ method: 'POST', path: `/ticket/${id}/update`, form });
    return unwrapResource(result.body) as Ticket;
  }

  async setTicketState(id: number, ticketState: string): Promise<Ticket> {
    const result = await this.send({
      method: 'POST',
      path: `/ticket/${id}/state`,
      form: { ticketState },
    });
    return unwrapResource(result.body) as Ticket;
  }

  async deleteTicket(id: number): Promise<unknown> {
    const result = await this.send({ method: 'POST', path: `/ticket/${id}/delete` });
    return result.body;
  }

  async approveTicket(id: number): Promise<Ticket> {
    const result = await this.send({ method: 'POST', path: `/ticket/${id}/approve` });
    return unwrapResource(result.body) as Ticket;
  }

  // Comments

  async listComments(ticketId: number, token?: string): Promise<TicketComment[]> {
    const result = await this.send({
      method: 'GET',
      path: `/ticket/${ticketId}/comments`,
      query: { token: this.token(token) },
    });
    return unwrapCollection(result.body) as TicketComment[];
  }

  async addComment(fields: {
    ticketId: number;
    comment: string;
    email?: string;
    token?: string;
  }): Promise<TicketComment> {
    const result = await this.send({
      method: 'POST',
      path: '/ticket/comment',
      form: {
        ticketId: fields.ticketId,
        comment: fields.comment,
        email: fields.email,
        token: this.token(fields.token),
      },
    });
    return unwrapResource(result.body) as TicketComment;
  }

  async updateComment(ticketId: number, commentId: number, content: string): Promise<TicketComment> {
    const result = await this.send({
      method: 'POST',
      path: `/ticket/${ticketId}/comment/${commentId}/update`,
      form: { content },
    });
    return unwrapResource(result.body) as TicketComment;
  }

  async deleteComment(ticketId: number, commentId: number): Promise<unknown> {
    const result = await this.send({
      method: 'POST',
      path: `/ticket/${ticketId}/comment/${commentId}/delete`,
    });
    return result.body;
  }

  async approveComment(commentId: number): Promise<TicketComment> {
    const result = await this.send({ method: 'POST', path: `/ticket/comment/${commentId}/approve` });
    return unwrapResource(result.body) as TicketComment;
  }

  // Attachments

  async listAttachments(ticketId: number, token?: string): Promise<Attachment[]> {
    const result = await this.send({
      method: 'GET',
      path: `/ticket/${ticketId}/attachments`,
      query: { token: this.token(token) },
    });
    return unwrapCollection(result.body) as Attachment[];
  }

  async addAttachments(ticketId: number, attachmentFileIds: number[], token?: string): Promise<unknown> {
    const result = await this.send({
      method: 'POST',
      path: `/ticket/${ticketId}/attachments`,
      form: { attachmentFileIds, token: this.token(token) },
    });
    return result.body;
  }

  async deleteAttachment(ticketId: number, fileId: number, token?: string): Promise<unknown> {
    const result = await this.send({
      method: 'POST',
      path: `/ticket/${ticketId}/attachments/${fileId}/delete`,
      form: { token: this.token(token) },
    });
    return result.body;
  }

  async uploadAttachment(fileName: string, bytes: Uint8Array, contentType?: string): Promise<unknown> {
    const formData = new FormData();
    const blob = new Blob([bytes], { type: contentType ?? 'application/octet-stream' });
    formData.append('file', blob, fileName);
    const result = await this.send({ method: 'POST', path: '/ticket/upload_attachment', formData });
    return result.body;
  }

  /** The download endpoint answers with a redirect, this returns its target URL. */
  async resolveAttachmentUrl(ticketId: number, fileId: number, token?: string): Promise<string> {
    const result = await this.send({
      method: 'GET',
      path: `/ticket/${ticketId}/attachments/${fileId}/download`,
      query: { token: this.token(token) },
      redirect: 'manual',
      allowRedirect: true,
    });
    const location = result.headers.location;
    if (typeof location !== 'string' || location === '') {
      throw new Error(`The download endpoint did not return a location header for file ${fileId} of ticket ${ticketId}.`);
    }
    return new URL(location, this.config.baseUrl).toString();
  }

  /** Fetch a file from a resolved URL. No API key is sent to that URL. */
  async fetchBinary(url: string): Promise<Uint8Array> {
    const response = await this.http({
      method: 'GET',
      url,
      headers: {},
      responseType: 'binary',
      timeoutMs: this.config.timeoutMs,
    });
    if (response.status >= 400) {
      throw new Error(`Downloading ${url} failed with status ${response.status}.`);
    }
    return response.bytes ?? new Uint8Array();
  }
}
