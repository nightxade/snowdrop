/**
 * What may be attached to a message. One place, so the composer, the forward
 * flow, the send service and the backend all agree on what is too much.
 */

/** Largest file we send or download through the daemon's JSON API. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Most files one message carries (the same number Signal Desktop's composer allows). */
export const MAX_ATTACHMENTS = 32;

export type AttachmentProblem = 'too-large' | 'empty' | 'too-many';

/** Why a file can't be attached, or null when it can. */
export function attachmentProblem(file: {
  size: number;
  name?: string;
  type?: string;
}): AttachmentProblem | null {
  if (file.size === 0) return 'empty';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'too-large';
  return null;
}

const quoted = (name: string | undefined): string =>
  name === undefined || name === '' ? 'This file' : `“${name}”`;

const COUNT_TEXT = `a message has at most ${MAX_ATTACHMENTS} files`;
const SIZE_TEXT = `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`;

/** The sentence for one refused file. */
export function attachmentProblemMessage(
  name: string | undefined,
  problem: AttachmentProblem,
): string {
  if (problem === 'too-many') return `${quoted(name)} isn’t added: ${COUNT_TEXT}.`;
  return problem === 'too-large'
    ? `${quoted(name)} is over ${SIZE_TEXT}, so it can’t be sent.`
    : `${quoted(name)} is empty.`;
}

/** Up to three names read out ("a", "a and b", "a, b and c"); more are counted. */
function nameList(names: readonly string[]): { text: string; many: boolean } {
  const q = names.map((n) => quoted(n));
  if (q.length > 3) return { text: `${q.length} files`, many: true };
  if (q.length === 1) return { text: q[0] as string, many: false };
  return { text: `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`, many: true };
}

/** The sentence for the files a drop or pick refused (one or several, of either kind). */
export function rejectedFilesMessage(
  rejected: readonly { name: string; problem: AttachmentProblem }[],
): string {
  const parts: string[] = [];
  const large = rejected.filter((r) => r.problem === 'too-large').map((r) => r.name);
  const empty = rejected.filter((r) => r.problem === 'empty').map((r) => r.name);
  if (large.length === 1) parts.push(attachmentProblemMessage(large[0], 'too-large'));
  else if (large.length > 1) {
    const { text } = nameList(large);
    parts.push(`${text} are over ${SIZE_TEXT}, so they can’t be sent.`);
  }
  if (empty.length === 1) parts.push(attachmentProblemMessage(empty[0], 'empty'));
  else if (empty.length > 1) parts.push(`${nameList(empty).text} are empty.`);
  const extra = rejected.filter((r) => r.problem === 'too-many').map((r) => r.name);
  if (extra.length === 1) parts.push(attachmentProblemMessage(extra[0], 'too-many'));
  else if (extra.length > 1) parts.push(`${nameList(extra).text} aren’t added: ${COUNT_TEXT}.`);
  return parts.join(' ');
}
