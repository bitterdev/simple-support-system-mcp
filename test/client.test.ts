/* Author: Fabian Bitter (fabian@bitter.de) */

import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeForm } from '../src/client.js';
import { ApiError } from '../src/errors.js';
import { createTestClient } from './support.js';

test('every request carries the API key header and asks for JSON', async () => {
  const { client, http } = createTestClient({ body: [] });
  await client.listTickets();
  const request = http.requests[0];
  assert.equal(request?.headers['X-Api-Key'], 'test-key');
  assert.equal(request?.headers.Accept, 'application/json');
});

test('no API key header is sent when none is configured', async () => {
  const { client, http } = createTestClient({ body: [] }, { apiKey: undefined });
  await client.listTickets();
  assert.equal('X-Api-Key' in (http.requests[0]?.headers ?? {}), false);
});

test('listing tickets hits /ticket/list and passes the project filter', async () => {
  const { client, http } = createTestClient({ body: [{ id: 1 }] });
  const tickets = await client.listTickets({ projectId: 4 });
  assert.equal(http.requests[0]?.method, 'GET');
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/ticket/list');
  assert.equal(http.lastUrl().searchParams.get('projectId'), '4');
  assert.deepEqual(tickets, [{ id: 1 }]);
});

test('a single ticket is unwrapped from its resource key', async () => {
  const { client, http } = createTestClient({ body: { ticket: { id: 12, title: 'Broken' } } });
  const ticket = await client.getTicket(12);
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/ticket/12');
  assert.deepEqual(ticket, { id: 12, title: 'Broken' });
});

test('a reply is posted as a form encoded comment', async () => {
  const { client, http } = createTestClient({ body: { comment: { id: 88, content: 'On it' } } });
  const comment = await client.addComment({ ticketId: 12, comment: 'On it', email: 'someone@example.com' });
  const request = http.requests[0];
  assert.equal(request?.method, 'POST');
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/ticket/comment');
  assert.equal(request?.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(http.lastForm().get('ticketId'), '12');
  assert.equal(http.lastForm().get('comment'), 'On it');
  assert.equal(http.lastForm().get('email'), 'someone@example.com');
  assert.deepEqual(comment, { id: 88, content: 'On it' });
});

test('a state change posts to the workflow endpoint', async () => {
  const { client, http } = createTestClient({ body: { ticket: { id: 12, ticketState: 'in_progress' } } });
  const ticket = await client.setTicketState(12, 'in_progress');
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/ticket/12/state');
  assert.equal(http.lastForm().get('ticketState'), 'in_progress');
  assert.equal(ticket.ticketState, 'in_progress');
});

test('an explicit token wins over the configured one', async () => {
  const { client, http } = createTestClient({ body: [] }, { projectToken: 'from-env' });
  await client.listTickets({ token: 'from-call' });
  assert.equal(http.lastUrl().searchParams.get('token'), 'from-call');
  await client.listTickets();
  assert.equal(http.lastUrl().searchParams.get('token'), 'from-env');
});

test('booleans are encoded the way PHP expects them', () => {
  assert.equal(encodeForm({ isPrivate: false }), 'isPrivate=0');
  assert.equal(encodeForm({ isPrivate: true }), 'isPrivate=1');
  assert.equal(encodeForm({ name: undefined, handle: 'demo' }), 'handle=demo');
});

test('array fields are encoded with the PHP bracket syntax', () => {
  assert.equal(decodeURIComponent(encodeForm({ attachmentFileIds: [4, 9] })), 'attachmentFileIds[]=4&attachmentFileIds[]=9');
});

test('attaching files sends the file ids as an array', async () => {
  const { client, http } = createTestClient({ body: { message: 'Attachments saved.' } });
  await client.addAttachments(12, [4, 9]);
  assert.deepEqual(http.lastForm().getAll('attachmentFileIds[]'), ['4', '9']);
});

test('clearing the assignee sends the key with a zero', async () => {
  const { client, http } = createTestClient({ body: { ticket: { id: 12 } } });
  await client.updateTicket(12, { assigneeUserId: null });
  assert.equal(http.lastForm().get('assigneeUserId'), '0');
});

test('an HTTP error becomes an ApiError with the API message', async () => {
  const { client } = createTestClient({ status: 403, body: { errors: ['Permission denied.'] } });
  await assert.rejects(
    () => client.setTicketState(12, 'closed'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      assert.deepEqual(error.errors, ['Permission denied.']);
      assert.match(error.message, /Permission denied\./);
      return true;
    },
  );
});

test('a missing API key is explained on a 401', async () => {
  const { client } = createTestClient({ status: 401, body: { errors: ['Invalid API key.'] } }, { apiKey: undefined });
  await assert.rejects(() => client.deleteTicket(1), /SIMPLE_SUPPORT_SYSTEM_API_KEY/);
});

test('a status 200 with the error flag is still a failure', async () => {
  const { client } = createTestClient({
    status: 200,
    body: { error: true, errors: ['You need to enter a title.'], time: '2026-07-24 10:00:00' },
  });
  await assert.rejects(
    () =>
      client.createTicket({
        projectId: 1,
        title: '',
        content: 'x',
        ticketType: 'bug',
        ticketPriority: 'minor',
      }),
    /You need to enter a title\./,
  );
});

test('the project handle is resolved through the project list', async () => {
  const { client } = createTestClient({ body: [{ id: 2, handle: 'website' }] });
  assert.equal(await client.resolveProjectId('website'), 2);
  const missing = createTestClient({ body: [{ id: 2, handle: 'website' }] });
  await assert.rejects(() => missing.client.resolveProjectId('unknown'), /No project with the handle "unknown"/);
});

test('the download endpoint answers with a redirect that is turned into a URL', async () => {
  const { client, http } = createTestClient({
    status: 302,
    headers: { location: '/application/files/1234/report.pdf' },
    text: '',
  });
  const url = await client.resolveAttachmentUrl(12, 1234);
  assert.equal(http.requests[0]?.redirect, 'manual');
  assert.equal(url, 'https://support.example.com/application/files/1234/report.pdf');
});

test('an upload is sent as multipart form data', async () => {
  const { client, http } = createTestClient({ body: { file: { fID: 77, fileName: 'note.txt' } } });
  const response = (await client.uploadAttachment('note.txt', new TextEncoder().encode('hello'), 'text/plain')) as {
    file: { fID: number };
  };
  const request = http.requests[0];
  assert.ok(request?.body instanceof FormData);
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/ticket/upload_attachment');
  assert.equal(response.file.fID, 77);
});

test('deleting a comment posts to the delete route', async () => {
  const { client, http } = createTestClient({ body: { message: 'Comment deleted.' } });
  await client.deleteComment(12, 88);
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/ticket/12/comment/88/delete');
});

test('projects are read from the bare collection the API returns', async () => {
  const { client, http } = createTestClient({ body: [{ id: 1, name: 'Website', handle: 'website' }] });
  const projects = await client.listProjects();
  assert.equal(http.lastUrl().pathname, '/index.php/api/v1/project/list');
  assert.equal(projects[0]?.handle, 'website');
});
