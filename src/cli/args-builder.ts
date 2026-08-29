import type { Config, McpServerDefinition } from '../config.js';
import { toCliModel, validateEffort } from '../translation/model-map.js';
import { badRequest } from '../util/errors.js';
import { tempFiles } from '../util/temp-files.js';

/**
 * Linux caps a single argv entry or environment variable at MAX_ARG_STRLEN — 128 KiB, and
 * not raisable. Past it `spawn` fails with E2BIG before the CLI runs, which this proxy can
 * only report as a 500 with no useful detail. Measured: a request carrying 120 KB of tool
 * schemas succeeded, 131 KB failed, which is that limit to the byte.
 *
 * Anything longer than this goes to a file instead; the CLI takes a path everywhere it
 * takes one of these blobs. Well below the ceiling on purpose, because several of these
 * share one command line and the total has its own (much larger) limit.
 */
const MAX_INLINE_BYTES = 32 * 1024;

function tooBig(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') > MAX_INLINE_BYTES;
}

export interface CliArgs {
  /** The system prompt, if any */
  systemPrompt?: string;
  /** The model to use (API format, will be converted) */
  model: string;
  /** The effort level */
  effort?: string;
  /** The prompt text (all messages flattened) */
  prompt: string;
  /** JSON schema for structured output */
  jsonSchema?: Record<string, unknown>;
  /** MCP config JSON for tool use */
  mcpConfig?: Record<string, unknown>;
  /** MCP server names to activate from the registry */
  mcpServerNames?: string[];
  /** Whether to enable thinking */
  enableThinking: boolean;
}

export interface BuiltCliCommand {
  args: string[];
  prompt: string;
  extraEnv?: Record<string, string>;
  /** Removes anything this call had to spill to disk. Call it once the CLI has exited. */
  cleanup: () => void;
}

export function buildArgs(cliArgs: CliArgs, config: Config): BuiltCliCommand {
  const cliModel = toCliModel(cliArgs.model);
  const temp = tempFiles();

  const args: string[] = [
    config.claudePath,
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--model', cliModel,
  ];

  // Effort level (validate and omit for haiku)
  const effort = validateEffort(cliModel, cliArgs.effort, config.defaultEffort);
  if (effort !== null) {
    args.push('--effort', effort);
  }

  // System prompt
  if (cliArgs.systemPrompt) {
    if (tooBig(cliArgs.systemPrompt)) {
      args.push('--system-prompt-file', temp.write('system-prompt.txt', cliArgs.systemPrompt));
    } else {
      args.push('--system-prompt', cliArgs.systemPrompt);
    }
  }

  // Build merged MCP config: client tool bridge + registry servers
  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  let extraEnv: Record<string, string> | undefined;

  // Include client tool bridge config (if tools were provided in request)
  if (cliArgs.mcpConfig) {
    const bridge = cliArgs.mcpConfig as { mcpServers?: Record<string, unknown> };
    if (bridge.mcpServers) {
      Object.assign(mcpServers, bridge.mcpServers);
    }
  }

  // Merge activated registry servers
  if (cliArgs.mcpServerNames && cliArgs.mcpServerNames.length > 0) {
    if (!config.mcpServers) {
      throw badRequest('MCP server registry is not configured. Set PROXY_MCP_CONFIG to enable it.');
    }
    const available = Object.keys(config.mcpServers);
    for (const name of cliArgs.mcpServerNames) {
      const server = config.mcpServers[name];
      if (!server) {
        throw badRequest(`Unknown MCP server: "${name}". Available: ${available.join(', ')}`);
      }
      mcpServers[name] = { command: server.command, args: server.args };
      if (server.env) {
        if (!extraEnv) extraEnv = {};
        Object.assign(extraEnv, server.env);
        mcpServers[name].env = server.env;
      }
    }
  }

  // The tool bridge's definitions are the usual reason a request is too big, and they are
  // doubly exposed: they sit inside the --mcp-config argument here, and the CLI then passes
  // them to the bridge as an environment variable when it launches it. Both are capped, and
  // the second failure is the quieter one — the bridge simply never starts, so the tools
  // appear not to exist rather than reporting an error.
  for (const server of Object.values(mcpServers)) {
    const defs = server.env?.TOOL_DEFINITIONS;
    if (defs && tooBig(defs)) {
      delete server.env!.TOOL_DEFINITIONS;
      server.env!.TOOL_DEFINITIONS_FILE = temp.write('tool-definitions.json', defs);
    }
  }

  args.push('--strict-mcp-config');
  const mcpConfigJson = JSON.stringify({ mcpServers });
  args.push(
    '--mcp-config',
    tooBig(mcpConfigJson) ? temp.write('mcp-config.json', mcpConfigJson) : mcpConfigJson,
  );

  // Disable built-in tools (user-defined MCP tools still work)
  args.push('--tools', '');

  // JSON schema for structured output
  if (cliArgs.jsonSchema) {
    args.push('--json-schema', JSON.stringify(cliArgs.jsonSchema));
  }

  // Prompt goes via stdin, not as a positional arg
  return { args, prompt: cliArgs.prompt, extraEnv, cleanup: temp.cleanup };
}
