export { classifyModelError, type ModelErrorClass } from './classify.ts';
export { computeBackoffDelayMs } from './backoff.ts';
export { buildAttemptChain, isInFallbackScope } from './plan.ts';
export {
  runWithFallback,
  type RunExhausted,
  type RunOutcome,
  type RunSuccess,
  type RunWithFallbackOptions,
} from './run.ts';
