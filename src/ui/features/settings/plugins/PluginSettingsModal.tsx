import { RotateCcw } from 'lucide-react';
import { useStore } from 'zustand';
import type { PluginDefinition } from '@/core/plugins';
import { useStores } from '@/ui/hooks';
import { Button, Modal } from '@/ui/primitives';
import { PluginSettingsForm } from './PluginSettingsForm';

export function PluginSettingsModal({
  plugin,
  onClose,
}: {
  plugin: PluginDefinition;
  onClose: () => void;
}) {
  const stores = useStores();
  const customised = useStore(
    stores.settings,
    (s) => Object.keys(s.plugins[plugin.id]?.settings ?? {}).length > 0,
  );
  return (
    <Modal
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={plugin.name}
      description="Changes apply immediately."
      footer={
        <>
          <Button
            variant="ghost"
            icon={<RotateCcw size={16} />}
            disabled={!customised}
            onClick={() => {
              stores.settings.getState().resetPluginSettings(plugin.id);
            }}
          >
            Reset to defaults
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <PluginSettingsForm plugin={plugin} />
    </Modal>
  );
}
