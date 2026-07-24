/* Author: Fabian Bitter (fabian@bitter.de) */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectErrors,
  filterTickets,
  hasErrorFlag,
  sortTickets,
  summarizeTicket,
  unwrapCollection,
  unwrapResource,
} from '../src/format.js';
import type { Ticket } from '../src/types.js';

test('every envelope shape of the API is unwrapped', () => {
  assert.deepEqual(unwrapResource({ ticket: { id: 7 } }), { id: 7 });
  assert.deepEqual(unwrapResource({ comment: { id: 3 } }), { id: 3 });
  assert.deepEqual(unwrapResource({ data: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(unwrapResource([{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(unwrapResource({ id: 9, title: 'bare item' }), { id: 9, title: 'bare item' });
});

test('collections always come back as an array', () => {
  assert.deepEqual(unwrapCollection({ data: [{ id: 1 }, { id: 2 }] }), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(unwrapCollection([]), []);
  assert.deepEqual(unwrapCollection(undefined), []);
  assert.deepEqual(unwrapCollection({ id: 4 }), [{ id: 4 }]);
});

test('both error shapes are recognised', () => {
  assert.deepEqual(collectErrors({ errors: ['Invalid API key.'] }), ['Invalid API key.']);
  assert.deepEqual(collectErrors({ error: true, errors: ['Permission denied.'] }), ['Permission denied.']);
  assert.deepEqual(collectErrors({ message: 'Ticket deleted.' }), []);
  assert.equal(hasErrorFlag({ error: true, errors: ['You need to enter a title.'] }), true);
  assert.equal(hasErrorFlag({ error: false, message: null }), false);
  assert.equal(hasErrorFlag({ id: 1 }), false);
});

const tickets: Ticket[] = [
  {
    id: 1,
    title: 'Login broken',
    content: 'Nobody can log in',
    ticketState: 'open',
    ticketType: 'bug',
    ticketPriority: 'blocker',
    approved: true,
    assigneeUserId: 5,
    updatedAt: '2026-07-20T10:00:00+00:00',
    attachments: [{ fileId: 12 }],
  },
  {
    id: 2,
    title: 'Add dark mode',
    content: 'Would be nice',
    ticketState: 'closed',
    ticketType: 'enhancement',
    ticketPriority: 'minor',
    approved: true,
    assigneeUserId: null,
    updatedAt: '2026-07-22T10:00:00+00:00',
    attachments: [],
  },
  {
    id: 3,
    title: 'Typo on the start page',
    content: 'Missing letter',
    ticketState: 'open',
    ticketType: 'task',
    ticketPriority: 'trivial',
    approved: false,
    updatedAt: '2026-07-24T10:00:00+00:00',
  },
];

test('tickets are filtered by state, type, priority and assignee', () => {
  assert.deepEqual(filterTickets(tickets, { states: ['open'] }).map((ticket) => ticket.id), [1, 3]);
  assert.deepEqual(filterTickets(tickets, { ticketTypes: ['bug', 'task'] }).map((ticket) => ticket.id), [1, 3]);
  assert.deepEqual(filterTickets(tickets, { ticketPriorities: ['blocker'] }).map((ticket) => ticket.id), [1]);
  assert.deepEqual(filterTickets(tickets, { assigneeUserId: 5 }).map((ticket) => ticket.id), [1]);
  assert.deepEqual(filterTickets(tickets, { assigneeUserId: 0 }).map((ticket) => ticket.id), [2, 3]);
  assert.deepEqual(filterTickets(tickets, { approved: false }).map((ticket) => ticket.id), [3]);
});

test('the text search covers title, content and author', () => {
  assert.deepEqual(filterTickets(tickets, { search: 'DARK' }).map((ticket) => ticket.id), [2]);
  assert.deepEqual(filterTickets(tickets, { search: 'letter' }).map((ticket) => ticket.id), [3]);
  assert.deepEqual(filterTickets(tickets, { search: 'nothing here' }), []);
});

test('updatedSince keeps the newer tickets', () => {
  assert.deepEqual(filterTickets(tickets, { updatedSince: '2026-07-22' }).map((ticket) => ticket.id), [2, 3]);
});

test('sorting works on dates and on the priority order', () => {
  assert.deepEqual(sortTickets(tickets, 'updatedAt', 'desc').map((ticket) => ticket.id), [3, 2, 1]);
  assert.deepEqual(sortTickets(tickets, 'updatedAt', 'asc').map((ticket) => ticket.id), [1, 2, 3]);
  assert.deepEqual(sortTickets(tickets, 'ticketPriority', 'desc').map((ticket) => ticket.id), [1, 2, 3]);
  assert.deepEqual(sortTickets(tickets, 'id', 'asc').map((ticket) => ticket.id), [1, 2, 3]);
});

test('the summary keeps only fields the API returns', () => {
  const summary = summarizeTicket(tickets[0] as Ticket);
  assert.equal(summary.id, 1);
  assert.equal(summary.ticketState, 'open');
  assert.equal(summary.attachmentCount, 1);
  assert.equal('content' in summary, false);
});
