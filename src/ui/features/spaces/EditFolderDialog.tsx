import { useState } from 'react';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Modal, TextInput } from '@/ui/primitives';
import { HuePicker } from './HuePicker';
import styles from './SpaceForm.module.css';

export function EditFolderDialog({ folderId, onClose }: { folderId: string; onClose: () => void }) {
  const { stores } = useSnowdrop();
  const folder = stores.spaces
    .getState()
    .rail.find((e) => e.type === 'folder' && e.id === folderId);
  const [name, setName] = useState(folder?.type === 'folder' ? folder.name : '');
  const [hue, setHue] = useState<number | null>(
    folder?.type === 'folder' ? (folder.hue ?? null) : null,
  );
  if (folder?.type !== 'folder') return null;
  const valid = name.trim().length > 0;
  const save = () => {
    if (!valid) return;
    const s = stores.spaces.getState();
    s.renameFolder(folderId, name);
    s.setFolderHue(folderId, hue);
    onClose();
  };
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Edit folder"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextInput
          label="Folder name"
          value={name}
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <HuePicker value={hue} onChange={setHue} allowNone />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
