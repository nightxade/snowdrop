import { tauriIpc, type TauriIpc } from './ipc';
import { validateClipboardFiles } from './ipcValidate';

export async function readClipboardFiles(ipc: TauriIpc = tauriIpc): Promise<File[]> {
  const raw = await ipc.invoke<unknown>('clipboard_read_files');
  const files = validateClipboardFiles('clipboard_read_files', raw);
  return files.map((file) => {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    return new File([bytes], file.name, { type: file.contentType });
  });
}
