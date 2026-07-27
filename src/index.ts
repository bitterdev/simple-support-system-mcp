#!/usr/bin/env node
/* Author: Fabian Bitter (fabian@bitter.de) */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SupportSystemClient } from './client.js';
import { loadConfig } from './config.js';
import { createTools } from './tools.js';

const packageVersion = ((): string => {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const instructions = [
  'Talks to the REST API of the Simple Support System add-on for Concrete CMS.',
  'The everyday flow is: list_tickets to find a ticket, get_ticket to read it with its comments, reply_to_ticket to answer, set_ticket_state to move it through the workflow.',
  'Reading tools are always safe. Everything named delete_ removes data for good and needs confirm: true.',
  'Administrative calls such as changing a state, deleting or approving need an API key in SIMPLE_SUPPORT_SYSTEM_API_KEY, private projects need their access token.',
].join(' ');

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SupportSystemClient(config);

  const server = new McpServer({ name: 'simple-support-system-mcp', version: packageVersion }, { instructions });

  for (const tool of createTools(client)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      // The MCP SDK types the callback against the concrete schema, the tool
      // definitions keep their handlers generic.
      tool.handler as never,
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`simple-support-system-mcp failed to start: ${message}\n`);
  process.exit(1);
});
