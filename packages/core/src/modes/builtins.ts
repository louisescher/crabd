import { registerMode } from './registry.ts';
import { mentionMode } from './mention.ts';
import { reviewMode } from './review.ts';
import { implementMode } from './implement.ts';

/** Register the three built-in modes. Idempotent; safe to call at startup. */
export function registerBuiltinModes(): void {
  registerMode(mentionMode);
  registerMode(reviewMode);
  registerMode(implementMode);
}
