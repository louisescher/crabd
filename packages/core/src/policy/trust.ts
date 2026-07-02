import type { ForgeActor } from '../forge/types.ts';

export interface AuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether an actor may trigger crab'd. Bots are always denied (to prevent
 * comment loops), and the actor's association must be in the configured allowlist.
 */
export function authorizeActor(actor: ForgeActor, allowedAssociations: readonly string[]): AuthorizationResult {
  if (actor.isBot) {
    return { allowed: false, reason: `actor ${actor.login} is a bot` };
  }
  const allowed = new Set(allowedAssociations.map((a) => a.toUpperCase()));
  if (!allowed.has(actor.association.toUpperCase())) {
    return {
      allowed: false,
      reason: `actor ${actor.login} has association ${actor.association}, which is not in the allowlist`,
    };
  }
  return { allowed: true };
}
