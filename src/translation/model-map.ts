import { badRequest } from '../util/errors.js';

/**
 * Prefixes that are stripped before model lookup.
 * Allows clients like OpenClaw to send e.g. "claude-code-cli/opus".
 */
const STRIP_PREFIXES = ['claude-code-cli/', 'openai/'];

/**
 * The bare aliases the CLI resolves to "the latest model in this family". A client asking
 * for one of these is explicitly asking not to pin a version, so passing it through is the
 * honest answer.
 */
const FAMILY_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
type Family = (typeof FAMILY_ALIASES)[number];

/**
 * Full model ids this proxy will forward unchanged.
 *
 * Every id here was verified against the CLI in the image: `--model <id>` came back
 * reporting that same id as the model it used. That verification is the whole point of the
 * list — the CLI accepts a full name, but an unrecognised one makes it exit 1 having
 * written nothing, which this proxy can only report as an empty 200. Refusing an id we
 * have not checked turns that silent nothing into a 400 that says what went wrong.
 *
 * Extend it with PROXY_EXTRA_MODELS (comma-separated) when the CLI gains a model, so a new
 * id does not need a rebuild — but check the id by hand first.
 */
const KNOWN_MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
];

// Effort level constraints per model family
const EFFORT_BY_MODEL: Record<string, string[]> = {
  opus: ['low', 'medium', 'high', 'max'],
  sonnet: ['low', 'medium', 'high'],
  haiku: [], // No effort support
  fable: [], // No effort support
};

// Only for reading effort limits off a full id — never for deciding what the CLI is sent.
const FAMILY_REGEX = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:[-/].*)?$/i;

function extraModels(): string[] {
  return (process.env.PROXY_EXTRA_MODELS || '')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);
}

function knownModels(): string[] {
  return [...KNOWN_MODELS, ...extraModels()];
}

/**
 * Strip known prefixes from model names.
 * E.g. "claude-code-cli/opus" → "opus", "openai/gpt-4.1" → "gpt-4.1"
 */
function stripModelPrefix(model: string): string {
  for (const prefix of STRIP_PREFIXES) {
    if (model.startsWith(prefix)) {
      return model.slice(prefix.length);
    }
  }
  return model;
}

function resolveFamily(model: string): Family | null {
  const match = FAMILY_REGEX.exec(model);
  return match ? (match[1].toLowerCase() as Family) : null;
}

/**
 * The model the CLI is asked for, one-to-one with what the client asked for.
 *
 * This used to collapse every id to its family: "claude-opus-4-8" and "claude-opus-4-6"
 * both became "opus", and both answered as whatever the CLI's opus alias points at today.
 * A caller who pinned a version got a different model than the one it named, the response
 * reported the substitute, and nothing anywhere said a substitution had happened — so a
 * UI showing the requested name was simply wrong. The CLI takes full ids; there was never
 * a reason to throw the version away.
 */
export function toCliModel(model: string): string {
  const stripped = stripModelPrefix(model);
  const lower = stripped.toLowerCase();

  if ((FAMILY_ALIASES as readonly string[]).includes(lower)) {
    return lower;
  }
  const known = knownModels().find(m => m.toLowerCase() === lower);
  if (known) {
    return known;
  }

  // Deliberately NOT falling back to the family. A near-miss id — a typo, a model this
  // build has not been checked against — is a question this proxy cannot answer, and
  // answering it with a neighbouring model is the failure that made this function wrong.
  throw badRequest(
    `Unknown model: "${model}". Supported: ${knownModels().join(', ')}, ` +
    `or a family alias (${FAMILY_ALIASES.join(', ')}) for the latest in that family. ` +
    `Set PROXY_EXTRA_MODELS to add an id this build does not list.`
  );
}

export function validateEffort(model: string, effort: string | undefined, defaultEffort: string): string | null {
  const stripped = stripModelPrefix(model);
  const family = resolveFamily(stripped);
  const allowed = family ? EFFORT_BY_MODEL[family] : undefined;

  if (!allowed || allowed.length === 0) {
    return null; // Model doesn't support effort
  }

  const effectiveEffort = effort || defaultEffort;

  if (!allowed.includes(effectiveEffort)) {
    if (!effort) {
      // Default effort not valid for this model; use model's highest supported
      return allowed[allowed.length - 1];
    }
    throw badRequest(
      `Effort level "${effort}" is not supported for model "${model}". Supported: ${allowed.join(', ')}`
    );
  }

  return effectiveEffort;
}

export function getAllModels(): Array<{ id: string; owned_by: string }> {
  return knownModels().map(id => ({ id, owned_by: 'anthropic' }));
}
