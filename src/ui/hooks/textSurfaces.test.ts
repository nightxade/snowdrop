import { afterEach, describe, expect, it } from 'vitest';
import { describeFocus } from './textSurfaces';

afterEach(() => {
  document.body.innerHTML = '';
});

function html(markup: string): void {
  document.body.innerHTML = markup;
}

describe('describeFocus overlay detection', () => {
  it('ignores a persistent listbox that neither contains nor is controlled by focus', () => {
    html('<ul role="listbox" id="side"><li role="option">a</li></ul><button id="b">x</button>');
    document.getElementById('b')!.focus();
    expect(describeFocus(document, false).overlay).toBe(false);
    document.body.focus();
    expect(describeFocus(document, false)).toMatchObject({ target: 'none', overlay: false });
  });

  it('counts an overlay that contains focus', () => {
    html('<div role="dialog" data-state="open"><button id="in">x</button></div>');
    document.getElementById('in')!.focus();
    expect(describeFocus(document, false).overlay).toBe(true);
  });

  it('counts a popup the focused field controls (composer suggestions)', () => {
    html('<textarea id="t" aria-controls="sugg"></textarea><div id="sugg" role="listbox"></div>');
    document.getElementById('t')!.focus();
    expect(describeFocus(document, false)).toMatchObject({ target: 'input', overlay: true });
  });

  it('counts an open modal even before focus moves into it', () => {
    html('<button id="b">x</button><div role="alertdialog" data-state="open"></div>');
    document.getElementById('b')!.focus();
    expect(describeFocus(document, false).overlay).toBe(true);
  });

  it('defers to the app modal flag', () => {
    html('<button id="b">x</button>');
    document.getElementById('b')!.focus();
    expect(describeFocus(document, true).overlay).toBe(true);
  });
});
