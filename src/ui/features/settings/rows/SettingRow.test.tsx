import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingRow } from './SettingRow';

afterEach(cleanup);

describe('SettingRow label', () => {
  it('labels a control that takes the id', () => {
    render(<SettingRow id="x" label="Name" control={(ids) => <input id={ids.id} />} />);
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('is not a label pointing at nothing when the control is a plain node', () => {
    render(<SettingRow id="x" label="Permission" control={<button type="button">Go</button>} />);
    expect(document.querySelector('label')).toBeNull();
    expect(screen.getByText('Permission')).toBeTruthy();
  });
});
