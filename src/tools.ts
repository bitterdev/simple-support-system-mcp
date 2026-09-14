/* Author: Fabian Bitter (fabian@bitter.de) */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z, type ZodRawShape } from 'zod';
import type { SupportSystemClient } from './client.js';
import { filterTickets, sortTickets, summarizeComment, summarizeTicket } from './format.js';
import {
  LOCKED_TICKET_STATES,
  TICKET_PRIORITIES,
  TICKET_STATES,
  TICKET_TYPES,
  TICKET_WORKFLOW_STATES,
  type Ticket,
} from './types.js';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function guessContentType(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const tokenField = z
  .string()
  .optional()
  .describe('Access token of a private project. Only needed without an API key, or for projects behind a private link.');

const lockedStatesNote = `Tickets in the states ${LOCKED_TICKET_STATES.join(' or ')} are locked by the API and reject edits.`;

export function createTools(client: SupportSystemClient): ToolDefinition[] {
  const define = (definition: Omit<ToolDefinition, 'handler'> & { handler: ToolDefinition['handler'] }): ToolDefinition => ({
    ...definition,
    handler: async (input) => {
      try {
        return await definition.handler(input);
      } catch (error) {
        return failure(error);
      }
    },
  });

  const pinnedProjectId = client.settings.projectId;

  const ensureProjectInScope = (projectId: number): void => {
    if (pinnedProjectId !== undefined && projectId !== pinnedProjectId) {
      throw new Error(`This server is limited to project ${pinnedProjectId}, project ${projectId} is not reachable through it.`);
    }
  };

  const refuseWhenPinned = (action: string): void => {
    if (pinnedProjectId !== undefined) {
      throw new Error(`This server is limited to project ${pinnedProjectId}, ${action} is not available.`);
    }
  };

  const ensureTicketInScope = (ticket: Ticket, ticketId: number): void => {
    if (pinnedProjectId !== undefined && ticket.projectId !== pinnedProjectId) {
      throw new Error(
        `Ticket ${ticketId} belongs to project ${ticket.projectId ?? 'unknown'}, this server is limited to project ${pinnedProjectId}.`,
      );
    }
  };

  // Ticket ids are global, so a pinned server has to look up the project before acting on one.
  const guardTicket = async (ticketId: number, token?: string): Promise<void> => {
    if (pinnedProjectId === undefined) {
      return;
    }
    ensureTicketInScope(await client.getTicket(ticketId, token), ticketId);
  };

  const resolveProject = async (input: Record<string, unknown>): Promise<number | undefined> => {
    let projectId: number | undefined;
    if (typeof input.projectId === 'number') {
      projectId = input.projectId;
    } else if (typeof input.projectHandle === 'string' && input.projectHandle !== '') {
      projectId = await client.resolveProjectId(input.projectHandle, input.token as string | undefined);
    }
    if (pinnedProjectId === undefined) {
      return projectId;
    }
    if (projectId !== undefined) {
      ensureProjectInScope(projectId);
    }
    return pinnedProjectId;
  };

  return [
    define({
      name: 'list_tickets',
      title: 'List tickets',
      description:
        'List tickets, optionally filtered by project, state, type, priority, assignee or a text search. The API itself only filters by project, every other filter is applied by this server on the returned list. Returns a compact summary per ticket by default, set format to "full" for the complete records including attachments. This is the default way to find a ticket id.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        projectId: z.number().int().positive().optional().describe('Numeric project id to filter by.'),
        projectHandle: z.string().optional().describe('Project handle to filter by, resolved to its id first.'),
        states: z.array(z.enum(TICKET_STATES)).optional().describe('Keep only tickets in these states.'),
        state: z.enum(TICKET_STATES).optional().describe('Shorthand for a single state filter.'),
        ticketTypes: z.array(z.enum(TICKET_TYPES)).optional().describe('Keep only these ticket types.'),
        ticketPriorities: z.array(z.enum(TICKET_PRIORITIES)).optional().describe('Keep only these priorities.'),
        assigneeUserId: z.number().int().optional().describe('Keep only tickets assigned to this user id, 0 means unassigned.'),
        approved: z.boolean().optional().describe('Keep only approved or only unapproved tickets. Unapproved ones are visible with an API key.'),
        search: z.string().optional().describe('Case insensitive substring search over title, content and author.'),
        updatedSince: z.string().optional().describe('ISO date or date-time, keeps tickets updated at or after it.'),
        sortBy: z.enum(['id', 'createdAt', 'updatedAt', 'ticketPriority']).optional().describe('Sort field, default updatedAt.'),
        sortDirection: z.enum(['asc', 'desc']).optional().describe('Sort direction, default desc.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum number of tickets to return, default 50.'),
        offset: z.number().int().min(0).optional().describe('Number of tickets to skip, default 0.'),
        format: z.enum(['summary', 'full']).optional().describe('Level of detail, default summary.'),
        token: tokenField,
      },
      handler: async (input) => {
        const projectId = await resolveProject(input);
        const tickets = await client.listTickets({
          ...(projectId !== undefined ? { projectId } : {}),
          ...(typeof input.token === 'string' ? { token: input.token } : {}),
        });

        const states = [
          ...((input.states as string[] | undefined) ?? []),
          ...(typeof input.state === 'string' ? [input.state] : []),
        ];

        const filtered = filterTickets(tickets, {
          ...(states.length > 0 ? { states } : {}),
          ...(input.ticketTypes !== undefined ? { ticketTypes: input.ticketTypes as string[] } : {}),
          ...(input.ticketPriorities !== undefined ? { ticketPriorities: input.ticketPriorities as string[] } : {}),
          ...(typeof input.assigneeUserId === 'number' ? { assigneeUserId: input.assigneeUserId } : {}),
          ...(typeof input.approved === 'boolean' ? { approved: input.approved } : {}),
          ...(typeof input.search === 'string' ? { search: input.search } : {}),
          ...(typeof input.updatedSince === 'string' ? { updatedSince: input.updatedSince } : {}),
        });

        const sorted = sortTickets(
          filtered,
          (input.sortBy as 'id' | 'createdAt' | 'updatedAt' | 'ticketPriority' | undefined) ?? 'updatedAt',
          (input.sortDirection as 'asc' | 'desc' | undefined) ?? 'desc',
        );

        const offset = typeof input.offset === 'number' ? input.offset : 0;
        const limit = typeof input.limit === 'number' ? input.limit : 50;
        const page = sorted.slice(offset, offset + limit);
        const full = input.format === 'full';

        return json({
          totalReturnedByApi: tickets.length,
          matchedFilters: sorted.length,
          offset,
          returned: page.length,
          tickets: page.map((ticket: Ticket) => (full ? ticket : summarizeTicket(ticket))),
        });
      },
    }),

    define({
      name: 'get_ticket',
      title: 'Get ticket',
      description:
        'Read a single ticket with its attachments and, unless switched off, all comments in one call. Use this before replying or changing a state so the current content and state are known.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Numeric ticket id.'),
        includeComments: z.boolean().optional().describe('Load the comments as well, default true.'),
        token: tokenField,
      },
      handler: async (input) => {
        const ticketId = input.ticketId as number;
        const token = input.token as string | undefined;
        const ticket = await client.getTicket(ticketId, token);
        ensureTicketInScope(ticket, ticketId);
        if (input.includeComments === false) {
          return json({ ticket });
        }
        const comments = await client.listComments(ticketId, token);
        return json({ ticket, comments: comments.map(summarizeComment) });
      },
    }),

    define({
      name: 'reply_to_ticket',
      title: 'Reply to ticket',
      description:
        'Post a reply as a comment on a ticket. This is the normal way to answer a ticket. The reply triggers the notification mails of the package. Without an API key and without a logged in session the email field is required, and moderation may hold the comment back until it is approved.',
      annotations: { openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket the reply belongs to.'),
        comment: z.string().min(1).describe('Text of the reply.'),
        email: z.string().optional().describe('Author email, required for unauthenticated calls.'),
        token: tokenField,
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number, input.token as string | undefined);
        const comment = await client.addComment({
          ticketId: input.ticketId as number,
          comment: input.comment as string,
          ...(typeof input.email === 'string' ? { email: input.email } : {}),
          ...(typeof input.token === 'string' ? { token: input.token } : {}),
        });
        return json({ posted: true, comment: summarizeComment(comment) });
      },
    }),

    define({
      name: 'set_ticket_state',
      title: 'Change ticket state',
      description: `Move a ticket to another workflow state and notify the people involved. Requires an API key. The state "new" is only set when a ticket is created and is rejected here. ${lockedStatesNote}`,
      annotations: { idempotentHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket to transition.'),
        state: z.enum(TICKET_WORKFLOW_STATES).describe('Target state.'),
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number);
        const ticket = await client.setTicketState(input.ticketId as number, input.state as string);
        return json({ updated: true, ticket: summarizeTicket(ticket) });
      },
    }),

    define({
      name: 'create_ticket',
      title: 'Create ticket',
      description:
        'Create a new ticket in a project, identified by projectId or projectHandle. Attachments have to be uploaded first with upload_attachment, then passed as attachmentFileIds. The API answers with a status envelope and not with the new ticket, so use list_tickets afterwards to get the id.',
      annotations: { openWorldHint: true },
      inputSchema: {
        projectId: z.number().int().positive().optional().describe('Target project id, required unless projectHandle is given.'),
        projectHandle: z.string().optional().describe('Target project handle, alternative to projectId.'),
        title: z.string().min(1).describe('Ticket title.'),
        content: z.string().min(1).describe('Ticket description.'),
        ticketType: z.enum(TICKET_TYPES).describe('Ticket type.'),
        ticketPriority: z.enum(TICKET_PRIORITIES).describe('Ticket priority.'),
        email: z.string().optional().describe('Reporter email, required for unauthenticated calls.'),
        attachmentFileIds: z.array(z.number().int().positive()).optional().describe('File ids returned by upload_attachment.'),
        token: tokenField,
      },
      handler: async (input) => {
        if (pinnedProjectId === undefined && input.projectId === undefined && input.projectHandle === undefined) {
          throw new Error('Either projectId or projectHandle has to be given.');
        }
        const project =
          pinnedProjectId !== undefined
            ? { projectId: await resolveProject(input) }
            : {
                ...(typeof input.projectId === 'number' ? { projectId: input.projectId } : {}),
                ...(typeof input.projectHandle === 'string' ? { projectHandle: input.projectHandle } : {}),
              };
        const response = await client.createTicket({
          ...project,
          title: input.title as string,
          content: input.content as string,
          ticketType: input.ticketType as string,
          ticketPriority: input.ticketPriority as string,
          ...(typeof input.email === 'string' ? { email: input.email } : {}),
          ...(Array.isArray(input.attachmentFileIds) ? { attachmentFileIds: input.attachmentFileIds as number[] } : {}),
          ...(typeof input.token === 'string' ? { token: input.token } : {}),
        });
        return json({
          created: true,
          note: 'The API does not return the created ticket. Use list_tickets for the project to get its id.',
          response,
        });
      },
    }),

    define({
      name: 'update_ticket',
      title: 'Update ticket',
      description: `Change title, content, type, priority or assignee of a ticket. Only the given fields are touched, and the API rejects a call that changes nothing. Set assigneeUserId to null to unassign. ${lockedStatesNote} Use set_ticket_state for the workflow state.`,
      annotations: { idempotentHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket to update.'),
        title: z.string().optional().describe('New title.'),
        content: z.string().optional().describe('New description.'),
        ticketType: z.enum(TICKET_TYPES).optional().describe('New type.'),
        ticketPriority: z.enum(TICKET_PRIORITIES).optional().describe('New priority.'),
        assigneeUserId: z.number().int().nullable().optional().describe('Concrete CMS user id of the assignee, null unassigns.'),
      },
      handler: async (input) => {
        const fields = {
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(typeof input.content === 'string' ? { content: input.content } : {}),
          ...(typeof input.ticketType === 'string' ? { ticketType: input.ticketType } : {}),
          ...(typeof input.ticketPriority === 'string' ? { ticketPriority: input.ticketPriority } : {}),
          ...('assigneeUserId' in input ? { assigneeUserId: input.assigneeUserId as number | null } : {}),
        };
        if (Object.keys(fields).length === 0) {
          throw new Error('Give at least one field to update.');
        }
        await guardTicket(input.ticketId as number);
        const ticket = await client.updateTicket(input.ticketId as number, fields);
        return json({ updated: true, ticket: summarizeTicket(ticket) });
      },
    }),

    define({
      name: 'delete_ticket',
      title: 'Delete ticket',
      description:
        'Permanently delete a ticket together with all its comments and attachment links. This cannot be undone, there is no trash and no restore. Requires an API key and confirm set to true. Prefer set_ticket_state with "closed" or "invalid" unless the record really has to disappear.',
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket to delete for good.'),
        confirm: z.literal(true).describe('Set to true to confirm the irreversible deletion.'),
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number);
        const response = await client.deleteTicket(input.ticketId as number);
        return json({ deleted: true, ticketId: input.ticketId, response });
      },
    }),

    define({
      name: 'approve_ticket',
      title: 'Approve ticket',
      description:
        'Approve a moderated ticket so it becomes visible and editable through the API. Requires an API key.',
      annotations: { idempotentHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket to approve.'),
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number);
        const ticket = await client.approveTicket(input.ticketId as number);
        return json({ approved: true, ticket: summarizeTicket(ticket) });
      },
    }),

    define({
      name: 'list_ticket_comments',
      title: 'List ticket comments',
      description:
        'List the comments of a ticket, oldest first as the API returns them. With an API key unapproved comments are included as well.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket whose comments are read.'),
        token: tokenField,
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number, input.token as string | undefined);
        const comments = await client.listComments(input.ticketId as number, input.token as string | undefined);
        return json({ ticketId: input.ticketId, count: comments.length, comments: comments.map(summarizeComment) });
      },
    }),

    define({
      name: 'update_comment',
      title: 'Update comment',
      description: `Replace the text of an existing comment and notify the people involved. ${lockedStatesNote}`,
      annotations: { idempotentHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket the comment belongs to.'),
        commentId: z.number().int().positive().describe('Comment to update.'),
        content: z.string().min(1).describe('New comment text.'),
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number);
        const comment = await client.updateComment(
          input.ticketId as number,
          input.commentId as number,
          input.content as string,
        );
        return json({ updated: true, comment: summarizeComment(comment) });
      },
    }),

    define({
      name: 'delete_comment',
      title: 'Delete comment',
      description:
        'Permanently delete a comment from a ticket. This cannot be undone, the text is gone afterwards. Requires confirm set to true.',
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket the comment belongs to.'),
        commentId: z.number().int().positive().describe('Comment to delete for good.'),
        confirm: z.literal(true).describe('Set to true to confirm the irreversible deletion.'),
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number);
        const response = await client.deleteComment(input.ticketId as number, input.commentId as number);
        return json({ deleted: true, commentId: input.commentId, response });
      },
    }),

    define({
      name: 'approve_comment',
      title: 'Approve comment',
      description: 'Approve a moderated comment so it becomes publicly visible. Requires an API key.',
      annotations: { idempotentHint: true, openWorldHint: true },
      inputSchema: {
        commentId: z.number().int().positive().describe('Comment to approve.'),
      },
      handler: async (input) => {
        refuseWhenPinned('approving a comment by its id alone');
        const comment = await client.approveComment(input.commentId as number);
        return json({ approved: true, comment: summarizeComment(comment) });
      },
    }),

    define({
      name: 'list_projects',
      title: 'List projects',
      description:
        'List the support projects. With an API key all projects are returned including private ones and their access tokens, otherwise only public projects and those matching the given token.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        token: tokenField,
      },
      handler: async (input) => {
        const all = await client.listProjects(input.token as string | undefined);
        const projects = pinnedProjectId === undefined ? all : all.filter((project) => project.id === pinnedProjectId);
        return json({ count: projects.length, projects });
      },
    }),

    define({
      name: 'get_project',
      title: 'Get project',
      description: 'Read a single project by its numeric id.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        projectId: z.number().int().positive().describe('Numeric project id.'),
        token: tokenField,
      },
      handler: async (input) => {
        ensureProjectInScope(input.projectId as number);
        const project = await client.getProject(input.projectId as number, input.token as string | undefined);
        return json({ project });
      },
    }),

    define({
      name: 'create_project',
      title: 'Create project',
      description:
        'Create a support project. The handle has to be unique, a duplicate is rejected with status 409. A private project gets an access token generated by the API, which is returned in the response. Requires an API key.',
      annotations: { openWorldHint: true },
      inputSchema: {
        name: z.string().min(1).describe('Display name of the project.'),
        handle: z.string().min(1).describe('Unique handle, used as the slug of the project.'),
        isPrivate: z.boolean().optional().describe('Private projects are only reachable with their access token, default false.'),
      },
      handler: async (input) => {
        refuseWhenPinned('creating a project');
        const project = await client.createProject({
          name: input.name as string,
          handle: input.handle as string,
          ...(typeof input.isPrivate === 'boolean' ? { isPrivate: input.isPrivate } : {}),
        });
        return json({ created: true, project });
      },
    }),

    define({
      name: 'update_project',
      title: 'Update project',
      description:
        'Change name, handle or visibility of a project. Only the given fields are touched. Switching a public project to private generates an access token. Requires an API key.',
      annotations: { idempotentHint: true, openWorldHint: true },
      inputSchema: {
        projectId: z.number().int().positive().describe('Project to update.'),
        name: z.string().optional().describe('New display name.'),
        handle: z.string().optional().describe('New handle, has to stay unique.'),
        isPrivate: z.boolean().optional().describe('New visibility.'),
      },
      handler: async (input) => {
        const fields = {
          ...(typeof input.name === 'string' ? { name: input.name } : {}),
          ...(typeof input.handle === 'string' ? { handle: input.handle } : {}),
          ...(typeof input.isPrivate === 'boolean' ? { isPrivate: input.isPrivate } : {}),
        };
        if (Object.keys(fields).length === 0) {
          throw new Error('Give at least one field to update.');
        }
        ensureProjectInScope(input.projectId as number);
        const project = await client.updateProject(input.projectId as number, fields);
        return json({ updated: true, project });
      },
    }),

    define({
      name: 'delete_project',
      title: 'Delete project',
      description:
        'Permanently delete a project together with every ticket, every comment and every attachment link inside it. This is the most destructive call of the whole API, it cannot be undone. Requires an API key and confirm set to true.',
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        projectId: z.number().int().positive().describe('Project to delete for good, including all of its tickets.'),
        confirm: z.literal(true).describe('Set to true to confirm the irreversible deletion.'),
      },
      handler: async (input) => {
        ensureProjectInScope(input.projectId as number);
        const response = await client.deleteProject(input.projectId as number);
        return json({ deleted: true, projectId: input.projectId, response });
      },
    }),

    define({
      name: 'list_ticket_attachments',
      title: 'List ticket attachments',
      description: 'List the files attached to a ticket, with their file id, file name and public URL.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket whose attachments are listed.'),
        token: tokenField,
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number, input.token as string | undefined);
        const attachments = await client.listAttachments(input.ticketId as number, input.token as string | undefined);
        return json({ ticketId: input.ticketId, count: attachments.length, attachments });
      },
    }),

    define({
      name: 'upload_attachment',
      title: 'Upload a file',
      description:
        'Upload a local file into the file manager of the site and return its file id. The file is not linked to a ticket yet, pass the id to add_ticket_attachments or to create_ticket.',
      annotations: { openWorldHint: true },
      inputSchema: {
        filePath: z.string().min(1).describe('Absolute path of the local file to upload.'),
        fileName: z.string().optional().describe('File name to store it under, defaults to the name of the local file.'),
      },
      handler: async (input) => {
        const filePath = input.filePath as string;
        const bytes = new Uint8Array(await readFile(filePath));
        const fileName = typeof input.fileName === 'string' && input.fileName !== '' ? input.fileName : path.basename(filePath);
        const response = await client.uploadAttachment(fileName, bytes, guessContentType(fileName));
        const file = (response as { file?: { fID?: number } } | undefined)?.file;
        return json({
          uploaded: true,
          fileId: file?.fID,
          fileName,
          sizeBytes: bytes.length,
          response,
        });
      },
    }),

    define({
      name: 'add_ticket_attachments',
      title: 'Attach files to a ticket',
      description: `Link already uploaded files to a ticket by their file ids. Files that are attached already are skipped, and the API rejects a call that would add nothing. ${lockedStatesNote}`,
      annotations: { openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket the files are attached to.'),
        fileIds: z.array(z.number().int().positive()).min(1).describe('File ids returned by upload_attachment.'),
        token: tokenField,
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number, input.token as string | undefined);
        const response = await client.addAttachments(
          input.ticketId as number,
          input.fileIds as number[],
          input.token as string | undefined,
        );
        return json({ attached: true, ticketId: input.ticketId, fileIds: input.fileIds, response });
      },
    }),

    define({
      name: 'download_attachment',
      title: 'Download an attachment',
      description:
        'Resolve the download URL of a ticket attachment and, when outputPath is given, save the file to that local path. Without outputPath only the URL is returned.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket the file belongs to.'),
        fileId: z.number().int().positive().describe('File id of the attachment.'),
        outputPath: z.string().optional().describe('Absolute path to write the file to. Existing files are overwritten.'),
        token: tokenField,
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number, input.token as string | undefined);
        const url = await client.resolveAttachmentUrl(
          input.ticketId as number,
          input.fileId as number,
          input.token as string | undefined,
        );
        if (typeof input.outputPath !== 'string' || input.outputPath === '') {
          return json({ ticketId: input.ticketId, fileId: input.fileId, url });
        }
        const bytes = await client.fetchBinary(url);
        const target = path.resolve(input.outputPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
        return json({ ticketId: input.ticketId, fileId: input.fileId, url, path: target, sizeBytes: bytes.length });
      },
    }),

    define({
      name: 'delete_attachment',
      title: 'Delete an attachment',
      description: `Remove a file from a ticket. The link between ticket and file is gone for good and cannot be restored from here, the file itself stays in the file manager of the site. Requires confirm set to true. ${lockedStatesNote}`,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: {
        ticketId: z.number().int().positive().describe('Ticket the file is attached to.'),
        fileId: z.number().int().positive().describe('File id to remove from the ticket.'),
        confirm: z.literal(true).describe('Set to true to confirm the irreversible removal.'),
        token: tokenField,
      },
      handler: async (input) => {
        await guardTicket(input.ticketId as number, input.token as string | undefined);
        const response = await client.deleteAttachment(
          input.ticketId as number,
          input.fileId as number,
          input.token as string | undefined,
        );
        return json({ deleted: true, ticketId: input.ticketId, fileId: input.fileId, response });
      },
    }),

    define({
      name: 'get_server_info',
      title: 'Server info',
      description:
        'Show how this server is configured: the API base URL it talks to, whether an API key is present, and the ticket states, types and priorities the API accepts. The API key itself is never returned.',
      annotations: { readOnlyHint: true },
      inputSchema: {},
      handler: async () => {
        const settings = client.settings;
        return json({
          baseUrl: settings.baseUrl,
          apiUrl: settings.apiUrl,
          apiKeyConfigured: settings.apiKey !== undefined,
          projectTokenConfigured: settings.projectToken !== undefined,
          projectId: settings.projectId ?? null,
          timeoutMs: settings.timeoutMs,
          ticketStates: TICKET_STATES,
          workflowStates: TICKET_WORKFLOW_STATES,
          ticketTypes: TICKET_TYPES,
          ticketPriorities: TICKET_PRIORITIES,
          lockedStates: LOCKED_TICKET_STATES,
        });
      },
    }),
  ];
}
