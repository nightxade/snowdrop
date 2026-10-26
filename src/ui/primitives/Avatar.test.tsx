import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Avatar } from './Avatar';

afterEach(cleanup);

describe('<Avatar />', () => {
  it('shows the initials on its colour when there is no picture', () => {
    const { container } = render(<Avatar fallback="AB" color="tomato" size={40} />);
    expect(screen.getByText('AB')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue('--avatar-size'),
    ).toBe('40px');
  });

  it('shows the picture, and the initials again if it cannot load', () => {
    const { container } = render(
      <Avatar fallback="AB" color="tomato" src="data:image/png;base64,x" />,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,x');
    expect(screen.queryByText('AB')).toBeNull();
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('AB')).toBeTruthy();
  });

  it('hands its outer element to a ref', () => {
    const ref = vi.fn();
    const { container } = render(<Avatar fallback="AB" color="tomato" ref={ref} />);
    expect(ref).toHaveBeenCalledWith(container.firstElementChild);
  });

  describe('veil', () => {
    it('is a button over the initials that reveals on request, named by its label', () => {
      const onReveal = vi.fn();
      render(
        <Avatar
          fallback="AB"
          color="tomato"
          label="Zed"
          veil={{ label: 'View photo', onReveal }}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'View photo' }));
      expect(onReveal).toHaveBeenCalledTimes(1);
      // The avatar is not also an image with a name: that would hide the button from a reader.
      expect(screen.queryByRole('img')).toBeNull();
    });

    it('goes away once there is a picture', () => {
      render(
        <Avatar
          fallback="AB"
          color="tomato"
          src="data:image/png;base64,x"
          veil={{ label: 'View photo', onReveal: vi.fn() }}
        />,
      );
      expect(screen.queryByRole('button')).toBeNull();
    });
  });
});
