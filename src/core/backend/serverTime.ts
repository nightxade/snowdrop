/**
 * When the Signal server received an envelope, kept beside the message it
 * produced. In memory only (never stored with the message): the notification
 * gate reads it to tell an envelope queued while the app was offline from a
 * new one, which the sender's own clock cannot say.
 */
const received = new WeakMap<object, number>();

export function noteServerReceived(message: object, at: number | undefined): void {
  if (at !== undefined) received.set(message, at);
}

export function serverReceivedAt(message: object): number | undefined {
  return received.get(message);
}
