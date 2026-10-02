import { SectionHeader } from './SectionHeader';
import { useCategoryMenu } from './CategoryHeaderMenu';

/** A space category's header, with its menu. */
export function CategoryHeader({
  spaceId,
  categoryId,
  ...header
}: {
  spaceId: string;
  categoryId: string;
  title: string;
  collapsed: boolean;
  controls: string;
  onToggle: () => void;
}) {
  const entries = useCategoryMenu(spaceId, categoryId);
  return <SectionHeader {...header} entries={entries} />;
}
