import type { AnthropicToolDefinition } from '../protocol/anthropic-types.js';

export interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

/**
 * Build an MCP config that launches a bridge server with the given tool definitions.
 * The bridge server script path must be provided (it's the compiled mcp-bridge.js).
 *
 * Returns the MCP config object and a cleanup function to remove temp files.
 */
export function buildMcpConfig(
  tools: AnthropicToolDefinition[],
  bridgeScriptPath: string,
): { mcpConfig: McpConfig; toolDefs: string } {
  const toolDefs = JSON.stringify(tools);

  const mcpConfig: McpConfig = {
    mcpServers: {
      client_tools: {
        command: 'node',
        args: [bridgeScriptPath],
        // Inline here; buildArgs moves it to a file when it is too large to be an
        // environment variable. That decision lives there because the same limit applies to
        // the CLI's own arguments, and one place should own it.
        env: {
          TOOL_DEFINITIONS: toolDefs,
        },
      },
    },
  };

  return { mcpConfig, toolDefs };
}

/**
 * Build an empty MCP config (no tools) for isolation.
 */
export function emptyMcpConfig(): McpConfig {
  return { mcpServers: {} };
}

/**
 * The MCP server name used for client-defined tools.
 * The CLI prefixes tool names with `mcp__<server_name>__`.
 */
const MCP_TOOL_PREFIX = 'mcp__client_tools__';

/**
 * Strip the `mcp__client_tools__` prefix that the CLI adds to MCP tool names.
 * If a reverseToolMap is provided, also maps the stripped name back to the
 * original client tool name (e.g. "Bash" → "exec" for OpenClaw).
 */
export function stripMcpToolPrefix(name: string, reverseToolMap?: Record<string, string>): string {
  const stripped = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
  if (reverseToolMap && stripped in reverseToolMap) {
    return reverseToolMap[stripped];
  }
  return stripped;
}
