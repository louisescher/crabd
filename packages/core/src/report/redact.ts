/**
 * Redact known secret values from text before it's posted in a public comment, so a
 * model-authored summary can never echo an API key or token.
 *
 * @param text    The text to sanitize (e.g. a run summary).
 * @param secrets Secret values to remove (provider keys, forge tokens, …).
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    // Ignore empty or trivially short values that aren't real secrets.
    if (!secret || secret.length < 8) continue;
    redacted = redacted.replace(secret, '[redacted]');
  }
  return redacted;
}

/** Collect sensitive values from the environment to redact from posted output. */
export function collectSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.OPENROUTER_API_KEY,
    env.GEMINI_API_KEY,
    env.CRABD_APP_PRIVATE_KEY,
    env.CRABD_GITHUB_TOKEN,
    env.CRABD_FORGE_TOKEN,
    env.GITHUB_TOKEN,
  ].filter((value): value is string => Boolean(value));
}
