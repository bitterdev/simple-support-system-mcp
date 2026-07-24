/* Author: Fabian Bitter (fabian@bitter.de) */

/** Ticket states as defined in Enumeration/TicketState.php. */
export const TICKET_STATES = [
  'new',
  'open',
  'in_progress',
  'on_hold',
  'resolved',
  'duplicate',
  'invalid',
  'wont_fix',
  'closed',
] as const;

/**
 * States the workflow endpoint accepts. The controller rejects "new", a ticket only
 * carries that state right after it was created.
 */
export const TICKET_WORKFLOW_STATES = [
  'open',
  'in_progress',
  'on_hold',
  'resolved',
  'duplicate',
  'invalid',
  'wont_fix',
  'closed',
] as const;

/** Ticket types as defined in Enumeration/TicketType.php. */
export const TICKET_TYPES = ['bug', 'enhancement', 'proposal', 'task'] as const;

/** Ticket priorities as defined in Enumeration/TicketPriority.php. */
export const TICKET_PRIORITIES = ['trivial', 'minor', 'major', 'critical', 'blocker'] as const;

/** States in which the API refuses further edits of a ticket, its comments and attachments. */
export const LOCKED_TICKET_STATES = ['closed', 'invalid'] as const;

export type TicketState = (typeof TICKET_STATES)[number];
export type TicketWorkflowState = (typeof TICKET_WORKFLOW_STATES)[number];
export type TicketType = (typeof TICKET_TYPES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface Attachment {
  fileId?: number;
  filename?: string | null;
  url?: string | null;
}

export interface Ticket {
  id?: number;
  title?: string;
  content?: string;
  ticketState?: string;
  ticketStateDisplay?: string;
  ticketType?: string;
  ticketTypeDisplay?: string;
  ticketPriority?: string;
  ticketPriorityDisplay?: string;
  approved?: boolean;
  authorDisplay?: string;
  assigneeUserId?: number | null;
  assigneeDisplay?: string | null;
  projectId?: number;
  projectName?: string;
  projectHandle?: string;
  attachments?: Attachment[];
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface TicketComment {
  id?: number;
  authorDisplay?: string;
  content?: string;
  approved?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface Project {
  id?: number;
  name?: string;
  handle?: string;
  isPrivate?: boolean;
  accessToken?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}
