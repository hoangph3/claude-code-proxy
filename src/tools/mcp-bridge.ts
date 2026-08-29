import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';

interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/**
 * MCP Bridge Server
 *
 * Runs as a child process, speaking MCP stdio protocol.
 * The CLI connects to this server to discover and call tools.
 *
 * Tool definitions arrive by file (TOOL_DEFINITIONS_FILE) when there are enough of them to
 * matter, and inline (TOOL_DEFINITIONS) otherwise. The file is not an optimisation: an
 * environment variable is capped at MAX_ARG_STRLEN, 128 KiB, so a large enough tool set
 * makes the CLI fail to spawn this bridge at all.
 *
 * Uses the low-level Server API so that JSON Schema input_schema objects are
 * passed through directly, instead of being converted via Zod (which would
 * strip the properties and produce empty schemas).
 *
 * When a tool is called by the Claude CLI, this bridge returns a placeholder
 * result. The proxy process detects the tool_use block in the CLI's output
 * stream and surfaces it to the HTTP client as stop_reason: "tool_use".
 * The client then sends a follow-up request with the actual tool_result.
 */

async function main(): Promise<void> {
  const toolDefsFile = process.env.TOOL_DEFINITIONS_FILE;
  let toolDefsJson: string | undefined;
  if (toolDefsFile) {
    try {
      toolDefsJson = readFileSync(toolDefsFile, 'utf-8');
    } catch (err) {
      process.stderr.write(`ERROR: cannot read TOOL_DEFINITIONS_FILE ${toolDefsFile}: ${err}\n`);
      process.exit(1);
    }
  } else {
    toolDefsJson = process.env.TOOL_DEFINITIONS;
  }
  if (!toolDefsJson) {
    process.stderr.write('ERROR: neither TOOL_DEFINITIONS_FILE nor TOOL_DEFINITIONS is set\n');
    process.exit(1);
  }

  let toolDefs: ToolDefinition[];
  try {
    toolDefs = JSON.parse(toolDefsJson);
  } catch {
    process.stderr.write('ERROR: Failed to parse TOOL_DEFINITIONS JSON\n');
    process.exit(1);
  }

  const toolMap = new Map<string, ToolDefinition>();
  for (const tool of toolDefs) {
    toolMap.set(tool.name, tool);
  }

  const server = new Server(
    { name: 'client_tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Return tool definitions with raw JSON Schema (no Zod conversion)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.input_schema,
    })),
  }));

  // Handle tool calls with a placeholder result
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'pending',
          message: 'Tool execution delegated to client. Result will be provided in follow-up request.',
          tool_name: request.params.name,
          arguments: request.params.arguments,
        }),
      },
    ],
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP Bridge fatal error: ${err}\n`);
  process.exit(1);
});
