/** Longest tool summary written to the Actions log, before an ellipsis takes over. */
const MAX_SUMMARY = 240;

function clip(value: unknown, max = MAX_SUMMARY): string | undefined {
  if (typeof value !== 'string') return undefined;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max)}... (${value.length} chars)` : flat;
}

function field(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const found = clip(args[name]);
    if (found) return found;
  }
  return undefined;
}

/**
 * The one line that says what a tool call did.
 *
 * Every tool gets a hand-picked field, because an argument dump is how file contents end up in a
 * public Actions log. `write` and `edit` are the clearest case, where the path is the whole story
 * and the body is the thing to keep out. A tool with no rule here logs its name alone.
 */
export function summarizeToolArgs(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;

  switch (toolName) {
    case 'bash': {
      const command = field(a, 'command');
      const timeout = typeof a.timeout === 'number' ? ` (timeout ${a.timeout}s)` : '';
      return command ? `${command}${timeout}` : undefined;
    }
    case 'read': {
      const path = field(a, 'path');
      const range = typeof a.offset === 'number' ? ` from line ${a.offset}` : '';
      return path ? `${path}${range}` : undefined;
    }
    case 'write':
      return field(a, 'path');
    case 'edit': {
      const path = field(a, 'path');
      return path ? `${path}${a.replaceAll ? ' (all occurrences)' : ''}` : undefined;
    }
    case 'grep': {
      const pattern = clip(a.pattern, 80);
      const where = [field(a, 'path'), field(a, 'include')].filter(Boolean).join(' ');
      if (!pattern) return undefined;
      return where ? `${pattern} in ${where}` : pattern;
    }
    case 'glob': {
      const pattern = field(a, 'pattern');
      const where = field(a, 'path');
      if (!pattern) return undefined;
      return where ? `${pattern} in ${where}` : pattern;
    }
    case 'task': {
      const agent = field(a, 'agent');
      const what = clip(a.description ?? a.prompt, 120);
      return [agent, what].filter(Boolean).join(': ') || undefined;
    }
    case 'report_progress':
      return field(a, 'message');
    case 'update_branch':
      return field(a, 'reason');
    case 'remember':
      return field(a, 'name');
    default:
      return undefined;
  }
}
