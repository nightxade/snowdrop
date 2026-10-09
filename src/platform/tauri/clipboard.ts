import { tauriIpc, type TauriIpc } from './ipc';

interface ClipboardFile {
  name: string;
  contentType: string;
  base64: string;
}

export async function readClipboardFiles(ipc: TauriIpc = tauriIpc): Promise<File[]> {
  const files = await ipc.invoke<ClipboardFile[]>('clipboard_read_files');
  return files.map((file) => {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    return new File([bytes], file.name, { type: file.contentType });
  });
}
