export interface PullFilePatch {
  filename: string;
  status: string;
  patch?: string | undefined;
  previous_filename?: string | undefined;
}

const DEV_NULL = '/dev/null';

const NO_PATCH_NOTE = '(patch unavailable: binary or too large. Read the file at HEAD instead.)';

function section(file: PullFilePatch): string {
  const previous = file.previous_filename ?? file.filename;
  return [
    `diff --git a/${previous} b/${file.filename}`,
    file.status === 'added' ? `--- ${DEV_NULL}` : `--- a/${previous}`,
    file.status === 'removed' ? `+++ ${DEV_NULL}` : `+++ b/${file.filename}`,
    file.patch ?? NO_PATCH_NOTE,
  ].join('\n');
}

export function buildDiffFromFiles(files: PullFilePatch[]): string {
  if (files.length === 0) return '';
  return `${files.map(section).join('\n')}\n`;
}
