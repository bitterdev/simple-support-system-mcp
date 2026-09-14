/* Author: Fabian Bitter (fabian@bitter.de) */

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { createTools, type ToolDefinition } from '../src/tools.js';
import { createTestClient, type StubResponse } from './support.js';

function toolsFor(responses: StubResponse | StubResponse[]) {
  const { client, http } = createTestClient(responses);
  const tools = createTools(client);
  const byName = (name: string): ToolDefinition => {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool !== undefined, `tool ${name} is missing`);
    return tool;
  };
  return { tools, byName, http };
}

function payload(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

test('the documented surface is covered by tools', () => {
  const { tools } = toolsFor({ body: [] });
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'add_ticket_attachments',
    'approve_comment',
    'approve_ticket',
    'create_project',
    'create_ticket',
    'delete_attachment',
    'delete_comment',
    'delete_project',
    'delete_ticket',
    'download_attachment',
    'get_project',
    'get_server_info',
    'get_ticket',
    'list_projects',
    'list_ticket_attachments',
    'list_ticket_comments',
    'list_tickets',
    'reply_to_ticket',
    'set_ticket_state',
    'update_comment',
    'update_project',
    'update_ticket',
    'upload_attachment',
  ]);
});

test('reading tools are marked read only, deleting tools as destructive', () => {
  const { tools } = toolsFor({ body: [] });
  for (const name of ['list_tickets', 'get_ticket', 'list_projects', 'list_ticket_comments']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.equal(tool?.annotations.readOnlyHint, true, `${name} should be read only`);
  }
  for (const name of ['delete_ticket', 'delete_comment', 'delete_project', 'delete_attachment']) {
    const tool = tools.find((entry) => entry.name === name);
    assert.equal(tool?.annotations.destructiveHint, true, `${name} should be destructive`);
    assert.match(tool?.description ?? '', /cannot be undone|gone for good|cannot be restored/);
    assert.ok(tool?.inputSchema.confirm !== undefined, `${name} should require a confirmation`);
  }
});

test('a delete tool refuses a call without confirmation', () => {
  const { byName } = toolsFor({ body: {} });
  const schema = z.object(byName('delete_ticket').inputSchema);
  assert.equal(schema.safeParse({ ticketId: 4 }).success, false);
  assert.equal(schema.safeParse({ ticketId: 4, confirm: false }).success, false);
  assert.equal(schema.safeParse({ ticketId: 4, confirm: true }).success, true);
});

test('list_tickets filters, sorts and pages the API result', async () => {
  const { byName, http } = toolsFor({
    body: [
      { id: 1, title: 'A', ticketState: 'open', ticketPriority: 'minor', updatedAt: '2026-07-01T00:00:00+00:00' },
      { id: 2, title: 'B', ticketState: 'closed', ticketPriority: 'major', updatedAt: '2026-07-02T00:00:00+00:00' },
      { id: 3, title: 'C', ticketState: 'open', ticketPriority: 'blocker', updatedAt: '2026-07-03T00:00:00+00:00' },
    ],
  });
  const result = await byName('list_tickets').handler({ state: 'open', limit: 1 });
  const data = payload(result);
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/ticket/list');
  assert.equal(data.totalReturnedByApi, 3);
  assert.equal(data.matchedFilters, 2);
  assert.equal(data.returned, 1);
  assert.deepEqual((data.tickets as { id: number }[]).map((ticket) => ticket.id), [3]);
});

test('get_ticket loads the ticket and its comments', async () => {
  const { byName, http } = toolsFor([
    { body: { ticket: { id: 12, title: 'Broken' } } },
    { body: [{ id: 5, content: 'Looking into it' }] },
  ]);
  const data = payload(await byName('get_ticket').handler({ ticketId: 12 }));
  assert.equal(http.requests.length, 2);
  assert.equal(http.requests[1]?.url.endsWith('/ticket/12/comments'), true);
  assert.deepEqual(data.ticket, { id: 12, title: 'Broken' });
  assert.equal((data.comments as { content: string }[])[0]?.content, 'Looking into it');
});

test('reply_to_ticket posts the comment', async () => {
  const { byName, http } = toolsFor({ body: { comment: { id: 5, content: 'On it' } } });
  const data = payload(await byName('reply_to_ticket').handler({ ticketId: 12, comment: 'On it' }));
  assert.equal(data.posted, true);
  assert.equal(http.lastForm().get('comment'), 'On it');
});

test('set_ticket_state only accepts states the API allows', () => {
  const { byName } = toolsFor({ body: {} });
  const schema = z.object(byName('set_ticket_state').inputSchema);
  assert.equal(schema.safeParse({ ticketId: 1, state: 'closed' }).success, true);
  assert.equal(schema.safeParse({ ticketId: 1, state: 'new' }).success, false);
  assert.equal(schema.safeParse({ ticketId: 1, state: 'done' }).success, false);
});

test('update_ticket needs at least one field', async () => {
  const { byName } = toolsFor({ body: { ticket: { id: 1 } } });
  const result = await byName('update_ticket').handler({ ticketId: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /at least one field/);
});

test('an API error is returned as a tool error instead of throwing', async () => {
  const { byName } = toolsFor({ status: 404, body: { errors: ['Invalid ticket id.'] } });
  const result = await byName('get_ticket').handler({ ticketId: 999, includeComments: false });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /Invalid ticket id\./);
});

test('create_ticket insists on a project', async () => {
  const { byName } = toolsFor({ body: {} });
  const result = await byName('create_ticket').handler({
    title: 'T',
    content: 'C',
    ticketType: 'bug',
    ticketPriority: 'minor',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /projectId or projectHandle/);
});

test('create_ticket resolves the project handle into the form field', async () => {
  const { byName, http } = toolsFor({ body: { time: '2026-07-24 10:00:00', message: null } });
  const data = payload(
    await byName('create_ticket').handler({
      projectHandle: 'website',
      title: 'T',
      content: 'C',
      ticketType: 'bug',
      ticketPriority: 'minor',
    }),
  );
  assert.equal(data.created, true);
  assert.equal(http.lastForm().get('projectHandle'), 'website');
});

test('download_attachment returns the URL when no output path is given', async () => {
  const { byName } = toolsFor({ status: 302, headers: { location: 'https://support.example.com/files/x.pdf' }, text: '' });
  const data = payload(await byName('download_attachment').handler({ ticketId: 12, fileId: 3 }));
  assert.equal(data.url, 'https://support.example.com/files/x.pdf');
  assert.equal('path' in data, false);
});

test('get_server_info never exposes the API key', async () => {
  const { byName } = toolsFor({ body: {} });
  const text = (await byName('get_server_info').handler({})).content[0]?.text ?? '';
  assert.match(text, /"apiKeyConfigured": true/);
  assert.equal(text.includes('test-key'), false);
});

function pinnedTools(responses: StubResponse | StubResponse[]) {
  const { client, http } = createTestClient(responses, { apiKey: undefined, projectToken: 'project-token', projectId: 59 });
  const tools = createTools(client);
  const byName = (name: string): ToolDefinition => {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool !== undefined, `tool ${name} is missing`);
    return tool;
  };
  return { byName, http };
}

test('a pinned server lists the tickets of its own project without being asked', async () => {
  const { byName, http } = pinnedTools({ body: [{ id: 1, projectId: 59 }] });
  const data = payload(await byName('list_tickets').handler({}));
  assert.equal(http.lastUrl().searchParams.get('projectId'), '59');
  assert.equal(data.returned, 1);
});

test('a pinned server refuses another project', async () => {
  const { byName, http } = pinnedTools({ body: [] });
  const result = await byName('list_tickets').handler({ projectId: 60 });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /limited to project 59/);
  assert.equal(http.requests.length, 0);
});

test('a pinned server refuses a project handle that resolves elsewhere', async () => {
  const { byName } = pinnedTools({ body: [{ id: 60, handle: 'other' }, { id: 59, handle: 'mine' }] });
  const result = await byName('create_ticket').handler({
    projectHandle: 'other',
    title: 'T',
    content: 'C',
    ticketType: 'bug',
    ticketPriority: 'minor',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /limited to project 59/);
});

test('a pinned server only shows its own project', async () => {
  const { byName } = pinnedTools({
    body: [
      { id: 1, handle: 'public_addon', isPrivate: false },
      { id: 59, handle: 'mine', isPrivate: true },
    ],
  });
  const data = payload(await byName('list_projects').handler({}));
  assert.equal(data.count, 1);
  assert.deepEqual((data.projects as { id: number }[]).map((project) => project.id), [59]);
});

test('a pinned server creates tickets in its own project by default', async () => {
  const { byName, http } = pinnedTools({ body: { time: '2026-09-14 12:00:00', message: null } });
  const data = payload(
    await byName('create_ticket').handler({ title: 'T', content: 'C', ticketType: 'bug', ticketPriority: 'minor', email: 'a@b.c' }),
  );
  assert.equal(data.created, true);
  assert.equal(http.lastForm().get('projectId'), '59');
  assert.equal(http.lastForm().get('token'), 'project-token');
});

test('a pinned server does not read a ticket of another project', async () => {
  const { byName, http } = pinnedTools([{ body: { ticket: { id: 7, projectId: 3 } } }, { body: [] }]);
  const result = await byName('get_ticket').handler({ ticketId: 7 });
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /Ticket 7 belongs to project 3/);
  assert.equal(http.requests.length, 1);
});

test('a pinned server does not reply to a ticket of another project', async () => {
  const { byName, http } = pinnedTools([{ body: { ticket: { id: 7, projectId: 3 } } }, { body: { comment: { id: 1 } } }]);
  const result = await byName('reply_to_ticket').handler({ ticketId: 7, comment: 'Hi', email: 'a@b.c' });
  assert.equal(result.isError, true);
  assert.equal(http.requests.length, 1);
});

test('a pinned server replies to a ticket of its own project', async () => {
  const { byName, http } = pinnedTools([{ body: { ticket: { id: 8, projectId: 59 } } }, { body: { comment: { id: 2, content: 'Hi' } } }]);
  const data = payload(await byName('reply_to_ticket').handler({ ticketId: 8, comment: 'Hi', email: 'a@b.c' }));
  assert.equal(data.posted, true);
  assert.equal(http.requests.length, 2);
  assert.equal(http.lastForm().get('ticketId'), '8');
});

test('get_server_info reports the pinned project', async () => {
  const { byName } = pinnedTools({ body: {} });
  const data = payload(await byName('get_server_info').handler({}));
  assert.equal(data.projectId, 59);
  assert.equal(data.apiKeyConfigured, false);
});
