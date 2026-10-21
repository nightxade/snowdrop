/** Saves a blob as a file via a temporary <a download> (no server round trip). */
function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Let the download start before revoking.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/** Saves text as a file via a temporary <a download> (no server round trip). */
export function downloadText(fileName: string, text: string, type = 'application/json'): void {
  downloadBlob(fileName, new Blob([text], { type }));
}

/** Saves bytes as a file, the same way as {@link downloadText}. */
export function downloadBytes(
  fileName: string,
  bytes: Uint8Array,
  type = 'application/octet-stream',
): void {
  downloadBlob(fileName, new Blob([new Uint8Array(bytes)], { type }));
}
