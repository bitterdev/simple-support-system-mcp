/* Author: Fabian Bitter (fabian@bitter.de) */

import type { Ticket, TicketComment } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The API wraps payloads in three different ways, depending on the endpoint:
 * a "data" key, a resource key such as "ticket" or "comment", or nothing at all.
 * This peels all of them off so tools always see the bare resource.
 */
export function unwrapResource(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body;
  }
  if (!isRecord(body)) {
    return body;
  }
  for (const key of ['data', 'ticket', 'comment', 'project']) {
    const value = body[key];
    if (value !== undefined) {
      return isRecord(value) || Array.isArray(value) ? unwrapResource(value) : value;
    }
  }
  return body;
}

export function unwrapCollection(body: unknown): unknown[] {
  const unwrapped = unwrapResource(body);
  if (Array.isArray(unwrapped)) {
    return unwrapped;
  }
  if (unwrapped === undefined || unwrapped === null) {
    return [];
  }
  return [unwrapped];
}

/** Read the error messages of both response shapes: {errors: [...]} and the EditResponse object. */
export function collectErrors(body: unknown): string[] {
  if (!isRecord(body)) {
    return [];
  }
  const raw = body.errors;
  const messages: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim() !== '') {
        messages.push(entry.trim());
      } else if (isRecord(entry) && typeof entry.message === 'string') {
        messages.push(entry.message);
      }
    }
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    messages.push(raw.trim());
  }
  if (messages.length === 0 && typeof body.error === 'string' && body.error.trim() !== '') {
    messages.push(body.error.trim());
  }
  return messages;
}

/**
 * Concrete's EditResponse reports failures with an "error" flag and HTTP 200,
 * so a 200 response is not proof of success.
 */
export function hasErrorFlag(body: unknown): boolean {
  if (!isRecord(body)) {
    return false;
  }
  if (body.error === true) {
    return true;
  }
  return collectErrors(body).length > 0;
}

export function parseJson(text: string): unknown {
  if (text.trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Compact ticket view for list output, built only from fields the API returns. */
export function summarizeTicket(ticket: Ticket): Record<string, unknown> {
  return {
    id: ticket.id,
    title: ticket.title,
    ticketState: ticket.ticketState,
    ticketType: ticket.ticketType,
    ticketPriority: ticket.ticketPriority,
    approved: ticket.approved,
    projectId: ticket.projectId,
    projectHandle: ticket.projectHandle,
    authorDisplay: ticket.authorDisplay,
    assigneeDisplay: ticket.assigneeDisplay,
    attachmentCount: Array.isArray(ticket.attachments) ? ticket.attachments.length : 0,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export function summarizeComment(comment: TicketComment): Record<string, unknown> {
  return {
    id: comment.id,
    authorDisplay: comment.authorDisplay,
    content: comment.content,
    approved: comment.approved,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

export interface TicketFilter {
  states?: string[];
  ticketTypes?: string[];
  ticketPriorities?: string[];
  assigneeUserId?: number;
  approved?: boolean;
  search?: string;
  updatedSince?: string;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || value === '') {
    return Number.NaN;
  }
  return Date.parse(value);
}

/** Client side filtering, the API itself only knows the projectId filter. */
export function filterTickets(tickets: Ticket[], filter: TicketFilter): Ticket[] {
  const search = filter.search?.trim().toLowerCase();
  const since = filter.updatedSince !== undefined ? Date.parse(filter.updatedSince) : Number.NaN;

  return tickets.filter((ticket) => {
    if (filter.states !== undefined && filter.states.length > 0) {
      if (typeof ticket.ticketState !== 'string' || !filter.states.includes(ticket.ticketState)) {
        return false;
      }
    }
    if (filter.ticketTypes !== undefined && filter.ticketTypes.length > 0) {
      if (typeof ticket.ticketType !== 'string' || !filter.ticketTypes.includes(ticket.ticketType)) {
        return false;
      }
    }
    if (filter.ticketPriorities !== undefined && filter.ticketPriorities.length > 0) {
      if (typeof ticket.ticketPriority !== 'string' || !filter.ticketPriorities.includes(ticket.ticketPriority)) {
        return false;
      }
    }
    if (filter.assigneeUserId !== undefined && Number(ticket.assigneeUserId ?? 0) !== filter.assigneeUserId) {
      return false;
    }
    if (filter.approved !== undefined && Boolean(ticket.approved) !== filter.approved) {
      return false;
    }
    if (!Number.isNaN(since)) {
      const updated = timestamp(ticket.updatedAt);
      if (Number.isNaN(updated) || updated < since) {
        return false;
      }
    }
    if (search !== undefined && search !== '') {
      const haystack = [ticket.title, ticket.content, ticket.authorDisplay]
        .filter((value): value is string => typeof value === 'string')
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    return true;
  });
}

export type TicketSortField = 'id' | 'createdAt' | 'updatedAt' | 'ticketPriority';
export type SortDirection = 'asc' | 'desc';

const PRIORITY_ORDER: Record<string, number> = {
  trivial: 1,
  minor: 2,
  major: 3,
  critical: 4,
  blocker: 5,
};

export function sortTickets(tickets: Ticket[], field: TicketSortField, direction: SortDirection): Ticket[] {
  const factor = direction === 'asc' ? 1 : -1;
  const weigh = (ticket: Ticket): number => {
    switch (field) {
      case 'id':
        return Number(ticket.id ?? 0);
      case 'createdAt':
        return timestamp(ticket.createdAt) || 0;
      case 'ticketPriority':
        return PRIORITY_ORDER[String(ticket.ticketPriority)] ?? 0;
      default:
        return timestamp(ticket.updatedAt) || 0;
    }
  };

  return [...tickets].sort((left, right) => {
    const a = weigh(left);
    const b = weigh(right);
    if (Number.isNaN(a) && Number.isNaN(b)) {
      return 0;
    }
    if (Number.isNaN(a)) {
      return 1;
    }
    if (Number.isNaN(b)) {
      return -1;
    }
    if (a === b) {
      return (Number(left.id ?? 0) - Number(right.id ?? 0)) * factor;
    }
    return (a - b) * factor;
  });
}
