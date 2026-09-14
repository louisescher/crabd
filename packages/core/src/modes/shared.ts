import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import type { ForgeAdapter } from '../forge/types.ts';
import { type Baseline, collectChangesSinceBaseline, hasChanges, TooManyChangesError } from '../git/changes.ts';
import { SensitivePathError } from '../git/sensitive.ts';
import { renderVetFailureMessage, scanForSecrets } from '../git/vet.ts';
import { log } from '../logger.ts';

/** The issue/PR number the event concerns. */
export function subjectNumber(context: ForgeContext, event: ForgeEvent): number | undefined {
  return context.pullRequest?.number ?? context.issue?.number ?? event.pullRequest?.number ?? event.issue?.number;
}

export interface CommitOptions {
  adapter: ForgeAdapter;
  cwd: string;
  branch: string;
  message: string;
  baseBranch?: string;
  /**
   * `config.permissions.write`. Optional only so custom modes written against the old signature
   * still compile; pass it. An explicit `false` throws rather than committing.
   */
  writesAllowed?: boolean;
  baseline: Baseline;
  secretScan?: boolean;
  /** `config.limits.maxCommitFiles`. Over it the commit is refused and nothing is read from disk. */
  maxFiles?: number;
  expectedParentSha?: string;
}

/**
 * What a caller sees when the working tree is far larger than a commit should be.
 *
 * This is the shape of an accident, so the message names the likely cause. A repo-wide formatter,
 * a package manager, or a dependency install rewrites thousands of files, and committing that
 * buries the change the run was asked to make.
 */
function renderTooManyChangesMessage(error: TooManyChangesError): string {
  const sample = error.sample.map((path) => `\`${path}\``).join(', ');
  return [
    `crabd: refusing to commit ${error.fileCount} changed files, over the limit of ${error.maxFiles}.`,
    'A change this wide usually means a repo-wide formatter, a linter with `--fix`, or a package manager rewrote the working tree.',
    `First few paths: ${sample}.`,
    'Raise `limits.max_commit_files` if a change this size is intended.',
  ].join(' ');
}

/**
 * What a caller sees when the commit would have carried a credential.
 *
 * Named rather than summarised, because the person reading it has to go and rotate something, and
 * the first question is always which file. The likely cause is named too: the file is untracked and
 * looked pre-existing to the baseline until something rewrote it.
 */
function renderSensitivePathMessage(error: SensitivePathError): string {
  const paths = error.paths.map((path) => `\`${path}\``).join(', ');
  const plural = error.paths.length > 1;
  return [
    `crabd: refusing to commit ${paths}. ${plural ? 'Those paths look' : 'That path looks'} like a credential, and ${plural ? 'they are' : 'it is'} not tracked in this repository.`,
    'A workflow step that writes a credential into the checkout, or a repo-wide formatter that rewrote one, is the usual cause.',
    `Move the file outside the checkout or add it to \`.gitignore\`, then run again. ${plural ? 'If they are' : 'If it is'} meant to be in the repository, commit ${plural ? 'them' : 'it'} yourself.`,
  ].join(' ');
}

/**
 * Commit the working-tree changes the model made to `branch` via the forge API.
 * Returns `false` (committing nothing) when the working tree is clean.
 *
 * The last line of defense for `permissions.write`: modes are expected to check it themselves and
 * say something useful, but every write funnels through here, so a mode that forgets fails loudly
 * instead of pushing.
 */
export async function commitWorkingChanges(options: CommitOptions): Promise<boolean> {
  if (options.writesAllowed === false) {
    throw new Error('crabd: refusing to commit: writes are disabled for this repository (permissions.write: false)');
  }
  if (!hasChanges(options.cwd)) return false;

  let changes;
  try {
    changes = collectChangesSinceBaseline(options.cwd, options.baseline, {
      ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    });
  } catch (error) {
    if (error instanceof SensitivePathError) throw new Error(renderSensitivePathMessage(error));
    if (error instanceof TooManyChangesError) throw new Error(renderTooManyChangesMessage(error));
    throw error;
  }
  if (changes.length === 0) return false;

  if (options.secretScan !== false) {
    const vet = scanForSecrets(changes);
    if (!vet.ok) {
      throw new Error(`crabd: refusing to commit, ${renderVetFailureMessage(vet)}`);
    }
  }

  await options.adapter.commitToBranch({
    branch: options.branch,
    message: options.message,
    changes,
    baseBranch: options.baseBranch,
    ...(options.expectedParentSha ? { expectedParentSha: options.expectedParentSha } : {}),
  });
  log(`committed ${changes.length} change(s) to \`${options.branch}\``);
  return true;
}
