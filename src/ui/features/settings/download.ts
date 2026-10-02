/** Saves text as a file via a temporary <a download> (no server round trip). */
export function downloadText(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
