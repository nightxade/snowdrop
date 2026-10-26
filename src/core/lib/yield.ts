/**
 * Lets the event loop run (input, paint, timers) before a long job goes on.
 * A MessageChannel task is not subject to the clamp setTimeout gets once
 * nested, so a job that yields hundreds of times loses almost no time.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      resolve();
    };
    port2.postMessage(null);
  });
}
