import { describe, expect, it } from 'vitest';
import { parseKeySequence } from '@/core/commands';
import {
  createVimState,
  enterInsert,
  feed,
  modeLabel,
  selectionFor,
  sync,
  type Mode,
  type VimEffect,
  type VimState,
} from './engine';
import { TextModel } from './text';

/**
 * Test notation: "|" marks the cursor in the input and output text. Keys use
 * Vim notation ("d2w", "ciwnew<Esc>"); while the engine is in Insert mode,
 * keys are typed into the text the way the browser would.
 */
function start(marked: string, mode: Mode = 'normal'): VimState {
  const cursor = marked.indexOf('|');
  const text = marked.replace('|', '');
  return createVimState(text, cursor === -1 ? 0 : cursor, mode);
}

function typeNative(s: VimState, token: string): VimState {
  const sel = { start: s.cursor, end: s.cursor };
  let { text } = s;
  let cursor = sel.start;
  if (token === '<BS>') {
    if (cursor > 0) {
      text = text.slice(0, cursor - 1) + text.slice(cursor);
      cursor--;
    }
  } else if (token.length === 1 || token === '<CR>') {
    const ch = token === '<CR>' ? '\n' : token;
    text = text.slice(0, cursor) + ch + text.slice(cursor);
    cursor += ch.length;
  } else if (token === '<Left>') cursor = Math.max(0, cursor - 1);
  return sync(s, { text, selectionStart: cursor, selectionEnd: cursor });
}

function press(s: VimState, keys: string): { state: VimState; effects: VimEffect[] } {
  let state = s;
  const effects: VimEffect[] = [];
  for (const token of parseKeySequence(keys)) {
    const r = feed(state, token);
    if (!r.handled && state.mode === 'insert') {
      state = typeNative(state, token);
      continue;
    }
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

function show(s: VimState): string {
  return `${s.text.slice(0, s.cursor)}|${s.text.slice(s.cursor)}`;
}

function run(marked: string, keys: string): string {
  return show(press(start(marked), keys).state);
}

describe('TextModel', () => {
  it('treats grapheme clusters as single characters', () => {
    const m = new TextModel('a👨‍👩‍👧b🇫🇷\nx');
    expect(m.n).toBe(6);
    expect(m.g[1]).toBe('👨‍👩‍👧');
    expect(m.lineCount).toBe(2);
    expect(m.indexAt(m.offset(2))).toBe(2);
    // An offset inside a cluster snaps to its start.
    expect(m.indexAt(2)).toBe(1);
  });

  it('handles empty text', () => {
    const m = new TextModel('');
    expect(m.n).toBe(0);
    expect(m.lineCount).toBe(1);
    expect(m.lineEnd(0)).toBe(0);
  });
});

describe('motions', () => {
  it.each([
    ['hello w|orld', 'h', 'hello |world'],
    ['hello w|orld', '3h', 'hell|o world'],
    ['|hello', 'h', '|hello'],
    ['hel|lo', 'l', 'hell|o'],
    ['hel|lo', '9l', 'hell|o'],
    ['he|llo', '$', 'hell|o'],
    ['  he|llo', '0', '|  hello'],
    ['  he|llo', '^', '  |hello'],
    ['|one two-three  four', 'w', 'one |two-three  four'],
    ['|one two-three  four', '3w', 'one two-|three  four'],
    ['|one two-three  four', '2W', 'one two-three  |four'],
    ['one two-three  fo|ur', 'b', 'one two-three  |four'],
    ['one two-three  fo|ur', '2b', 'one two-|three  four'],
    ['one two-three  fo|ur', 'B', 'one two-three  |four'],
    ['one two-three  |four', 'B', 'one |two-three  four'],
    ['|one two-three', 'e', 'on|e two-three'],
    ['|one two-three', '2e', 'one tw|o-three'],
    ['|one two-three', '2E', 'one two-thre|e'],
    ['|a\n\nb', 'w', 'a\n|\nb'],
    ['a\n|\nb', 'w', 'a\n\n|b'],
    ['a\n\n|b', 'b', 'a\n|\nb'],
    ['ab|c\nd\nefgh', 'j', 'abc\n|d\nefgh'],
    ['ab|c\nd\nefgh', '2j', 'abc\nd\nef|gh'],
    ['abc\nd\nef|gh', 'k', 'abc\n|d\nefgh'],
    ['abc\nd\nef|gh', '2k', 'ab|c\nd\nefgh'],
    ['|abc\nd', 'k', '|abc\nd'],
    ['abc\n|d', 'j', 'abc\n|d'],
    ['a|bc\nlonger line', '$j', 'abc\nlonger lin|e'],
    ['a\n  b\n|c', 'gg', 'a\n  b\nc'.replace(/^/u, '|')],
    ['|a\n  b\nc', 'G', 'a\n  b\n|c'],
    ['|a\n  b\nc', '2G', 'a\n  |b\nc'],
    ['a\n  b\n|c', '2gg', 'a\n  |b\nc'],
    ['|say (hi [there])', '%', 'say (hi [there]|)'],
    ['say (hi [there]|)', '%', 'say |(hi [there])'],
    ['say (hi |[there])', '%', 'say (hi [there|])'],
    ['|a,b,c,d', 'f,', 'a|,b,c,d'],
    ['|a,b,c,d', '2f,', 'a,b|,c,d'],
    ['|a,b,c,d', 'f,;;', 'a,b,c|,d'],
    ['|a,b,c,d', 'f,;,', 'a|,b,c,d'],
    ['|a,b,c,d', 't,', '|a,b,c,d'],
    ['a|,b,c,d', 't,', 'a,|b,c,d'],
    ['|a,b,c,d', 't,;', 'a,|b,c,d'],
    ['a,b,c,|d', 'F,', 'a,b,c|,d'],
    ['a,b,c,|d', '2F,', 'a,b|,c,d'],
    ['a,b,c,|d', 'T,', 'a,b,c,|d'],
    ['a,b,c|,d', 'T,', 'a,b,|c,d'],
    ['|abc', 'fz', '|abc'],
  ])('%j  %s  →  %j', (input, keys, expected) => {
    expect(run(input, keys)).toBe(expected);
  });

  it('moves over a ZWJ emoji as one character (h/l)', () => {
    expect(run('a|👨‍👩‍👧b', 'l')).toBe('a👨‍👩‍👧|b');
    expect(run('a👨‍👩‍👧|b', 'h')).toBe('a|👨‍👩‍👧b');
    expect(run('|🇫🇷🇩🇪x', '2l')).toBe('🇫🇷🇩🇪|x');
  });

  it('keeps the column goal across short lines', () => {
    expect(run('abc|def\nx\nabcdefgh', 'jj')).toBe('abcdef\nx\nabc|defgh');
  });
});

describe('operators and text objects', () => {
  it.each([
    ['one |two three', 'dw', 'one |three'],
    ['one |two three', 'd2w', 'one| '],
    ['one |two three', '2dw', 'one| '],
    ['one |two\nthree', 'dw', 'one| \nthree'],
    ['one |two three', 'de', 'one | three'],
    ['one |two three', 'db', '|two three'],
    ['one t|wo three', 'd$', 'one |t'],
    ['one t|wo three', 'D', 'one |t'],
    ['one t|wo three', 'd0', '|wo three'],
    ['one t|wo three', 'dfe', 'one t|e'],
    ['one t|wo three', 'dte', 'one t|ee'],
    ['a\n|b\nc', 'dd', 'a\n|c'],
    ['a\nb\n|c', 'dd', 'a\n|b'],
    ['|only', 'dd', '|'],
    ['|a\nb\nc', '2dd', '|c'],
    ['|a\nb\nc', 'dj', '|c'],
    ['a\nb\n|c', 'dk', '|a'],
    ['a\n|b\nc', 'dG', '|a'],
    ['a\n|b\nc', 'dgg', '|c'],
    ['x (a|b c) y', 'di(', 'x (|) y'],
    ['x (a|b c) y', 'da(', 'x | y'],
    ['x (a (b|) c) y', 'd2i(', 'x (|) y'],
    ['x [a|b] y', 'di[', 'x [|] y'],
    ['x {a|b} y', 'diB', 'x {|} y'],
    ['x <a|b> y', 'di<', 'x <|> y'],
    ['x (a|b) y', 'dib', 'x (|) y'],
    ['f(|) y', 'di(', 'f(|) y'],
    ['say "he|llo" now', 'di"', 'say "|" now'],
    ['say "he|llo" now', 'da"', 'say |now'],
    ['say |"hello" now', 'di"', 'say "|" now'],
    ['|say "hello" now', 'di"', 'say "|" now'],
    ["it's 'q|uote' ok", "di'", "it's '|' ok"],
    ['one t|wo three', 'diw', 'one | three'],
    ['one t|wo three', 'daw', 'one |three'],
    ['one two t|hree', 'daw', 'one tw|o'],
    ['a-b c|-d e', 'diW', 'a-b | e'],
    ['a-b c|-d e', 'daW', 'a-b |e'],
    ['one |  two', 'diw', 'one|two'],
  ])('%j  %s  →  %j', (input, keys, expected) => {
    expect(run(input, keys)).toBe(expected);
  });

  it('changes with c (cw, ciw, cc, C, s, S) and enters Insert mode', () => {
    const cases: [string, string, string][] = [
      ['one |two three', 'cwnew<Esc>', 'one ne|w three'],
      ['one |two three', 'c2wx<Esc>', 'one |x'],
      ['one t|wo three', 'ciwX<Esc>', 'one |X three'],
      ['say "he|llo"', 'ci"bye<Esc>', 'say "by|e"'],
      ['a\n  |bc\nd', 'ccnew<Esc>', 'a\nne|w\nd'],
      ['one t|wo', 'Cx<Esc>', 'one t|x'],
      ['a|bc', 'sX<Esc>', 'a|Xc'],
      ['a|bc', '2sX<Esc>', 'a|X'],
      ['a|bc\nd', 'Snew<Esc>', 'ne|w\nd'],
    ];
    for (const [input, keys, out] of cases) expect(run(input, keys), `${input} ${keys}`).toBe(out);
  });

  it('yanks and puts (charwise and linewise)', () => {
    expect(run('|one two', 'yiwP')).toBe('on|eone two');
    expect(run('|one two', 'yiw$p')).toBe('one twoon|e');
    expect(run('|one two', 'yw$p')).toBe('one twoone| ');
    expect(run('|a\nb', 'yyp')).toBe('a\n|a\nb');
    expect(run('|a\nb', 'yyjp')).toBe('a\nb\n|a');
    expect(run('a\n|b', 'yyP')).toBe('a\n|b\nb');
    expect(run('a\n|b', 'Yp')).toBe('a\nb\n|b');
    expect(run('|a', 'yy3p')).toBe('a\n|a\na\na');
    expect(run('|ab', 'xp')).toBe('b|a');
    expect(run('|a\nb', 'ddp')).toBe('b\n|a');
    expect(run('|one', 'y$')).toBe('|one');
  });

  it('reports "+ yanks for the clipboard and keeps the unnamed register', () => {
    const { state, effects } = press(start('|hello world'), '"+yiw');
    expect(effects).toContainEqual({ type: 'clipboard', text: 'hello' });
    expect(state.register).toEqual({ text: 'hello', linewise: false });
    expect(press(start('|hello'), 'yiw').effects.some((e) => e.type === 'clipboard')).toBe(false);
  });

  it('indents and outdents lines', () => {
    expect(run('|a\nb', '>>')).toBe('  |a\nb');
    expect(run('|a\nb', '2>>')).toBe('  |a\n  b');
    expect(run('|a\nb', '>j')).toBe('  |a\n  b');
    expect(run('    |a', '<<')).toBe('  |a');
  });
});

describe('simple commands', () => {
  it.each([
    ['a|bcd', 'x', 'a|cd'],
    ['a|bcd', '2x', 'a|d'],
    ['a|bcd', '9x', '|a'],
    ['abc|d', 'x', 'ab|c'],
    ['ab|cd', 'X', 'a|cd'],
    ['ab|cd', '5X', '|cd'],
    ['a|bcd', 'rZ', 'a|Zcd'],
    ['a|bcd', '3rZ', 'aZZ|Z'],
    ['a|bcd', '4rZ', 'a|bcd'],
    ['a|b cd', 'r<CR>', 'a\n| cd'],
    ['|abC', '~', 'A|bC'],
    ['|abC', '3~', 'AB|c'],
    ['a|\n  b\nc', 'J', 'a| b\nc'],
    ['|a\nb\nc', '3J', 'a b| c'],
    ['|a\n', 'J', '|a'],
    ['|f(\n)', 'J', 'f(|)'],
  ])('%j  %s  →  %j', (input, keys, expected) => {
    expect(run(input, keys)).toBe(expected);
  });

  it('deletes a whole ZWJ emoji with x and replaces one with r', () => {
    expect(run('a|👨‍👩‍👧b', 'x')).toBe('a|b');
    expect(run('a|👨‍👩‍👧b', 'r!')).toBe('a|!b');
    expect(run('|🇫🇷', 'x')).toBe('|');
  });

  it('opens lines with o and O', () => {
    expect(run('|a\nb', 'onew<Esc>')).toBe('a\nne|w\nb');
    expect(run('a\n|b', 'Onew<Esc>')).toBe('a\nne|w\nb');
    expect(run('|a', 'ox<Esc>')).toBe('a\n|x');
  });

  it('enters Insert mode at the right places (i a I A)', () => {
    expect(run('a|bc', 'iX<Esc>')).toBe('a|Xbc');
    expect(run('a|bc', 'aX<Esc>')).toBe('ab|Xc');
    expect(run('  a|bc', 'IX<Esc>')).toBe('  |Xabc');
    expect(run('a|bc\nd', 'AX<Esc>')).toBe('abc|X\nd');
    expect(run('a|b', '3ixy<Esc>')).toBe('axyxyx|yb');
  });

  it('leaves Insert mode with Esc and Ctrl+[ (cursor steps back)', () => {
    const s = start('ab|', 'insert');
    expect(show(feed(s, '<Esc>').state)).toBe('a|b');
    expect(feed(s, '<C-[>').state.mode).toBe('normal');
    expect(show(feed(start('|ab', 'insert'), '<Esc>').state)).toBe('|ab');
  });

  it('passes Insert-mode typing through to the field', () => {
    const r = feed(start('|', 'insert'), 'j');
    expect(r.handled).toBe(false);
  });
});

describe('empty text', () => {
  it.each([
    'h',
    'l',
    'j',
    'k',
    'w',
    'b',
    'e',
    '$',
    '0',
    'x',
    'X',
    'dd',
    'dw',
    'D',
    'J',
    '~',
    'p',
    'u',
    '.',
    '%',
    'gg',
    'G',
    'yy',
    'diw',
    'ci"',
  ])('%s on empty text is safe', (keys) => {
    const { state } = press(start('|'), keys);
    expect(state.text).toBe('');
    expect(state.cursor).toBe(0);
  });

  it('can insert into empty text', () => {
    expect(run('|', 'ihi<Esc>')).toBe('h|i');
    expect(run('|', 'ahi<Esc>')).toBe('h|i');
  });
});

describe('counts', () => {
  it('multiplies operator and motion counts', () => {
    expect(run('|a b c d e f g', '2d3w')).toBe('|g');
  });

  it('treats a leading 0 as a motion but a later 0 as part of the count', () => {
    expect(run('abc|def', '0')).toBe('|abcdef');
    expect(run('|abcdefghijklm', '10l')).toBe('abcdefghij|klm');
  });
});

describe('undo and redo', () => {
  it('undoes each Normal-mode change and redoes it', () => {
    let { state } = press(start('|one two three'), 'dwdw');
    expect(show(state)).toBe('|three');
    state = press(state, 'u').state;
    expect(show(state)).toBe('|two three');
    state = press(state, 'u').state;
    expect(show(state)).toBe('|one two three');
    state = press(state, 'u').state;
    expect(state.text).toBe('one two three');
    state = press(state, '<C-r>').state;
    expect(state.text).toBe('two three');
    state = press(state, '<C-r><C-r>').state;
    expect(state.text).toBe('three');
  });

  it('undoes a change plus its typed text as one step', () => {
    let { state } = press(start('one |two'), 'cwthree<Esc>');
    expect(state.text).toBe('one three');
    state = press(state, 'u').state;
    expect(state.text).toBe('one two');
  });

  it('undoes text typed in an Insert session started by the host', () => {
    let state = start('|', 'insert');
    state = press(state, 'hello<Esc>').state;
    expect(state.text).toBe('hello');
    state = press(state, 'u').state;
    expect(state.text).toBe('');
  });

  it('a new change clears redo; counts undo several steps', () => {
    let { state } = press(start('|abcd'), 'xxx');
    state = press(state, '2u').state;
    expect(state.text).toBe('bcd');
    state = press(state, 'x').state;
    state = press(state, '<C-r>').state;
    expect(state.text).toBe('cd');
  });
});

describe('dot repeat', () => {
  it.each([
    ['|abcdef', 'x..', '|def'],
    ['|abcdef', '2x.', '|ef'],
    ['|abcdef', 'x3.', '|ef'],
    ['|a\nb\nc\nd', 'dd.', '|c\nd'],
    ['|one two three four', 'cwX<Esc>w.', 'X |X three four'],
    ['|a b', 'iZ<Esc>w.', 'Za |Zb'],
    ['|ab', 'AZ<Esc>j.', 'abZ|Z'],
    ['|abc', '~.', 'AB|c'],
    ['|a b c', 'dw.', '|c'],
    ['a\n|b', 'onew<Esc>.', 'a\nb\nnew\nne|w'],
  ])('%j  %s  →  %j', (input, keys, expected) => {
    expect(run(input, keys)).toBe(expected);
  });

  it('repeats as one undo step', () => {
    let { state } = press(start('one |two three'), 'cwX<Esc>w.');
    expect(state.text).toBe('one X X');
    state = press(state, 'u').state;
    expect(state.text).toBe('one X three');
  });

  it('does nothing before any change', () => {
    expect(run('a|bc', '.')).toBe('a|bc');
  });
});

describe('visual mode', () => {
  const sel = (s: VimState) => {
    const { start: a, end: b } = selectionFor(s);
    return s.text.slice(a, b);
  };

  it('extends a charwise selection with motions and shows it natively', () => {
    const { state } = press(start('one |two three'), 've');
    expect(state.mode).toBe('visual');
    expect(sel(state)).toBe('two');
    expect(sel(press(state, 'o').state)).toBe('two');
    expect(sel(press(start('one tw|o three'), 'vb').state)).toBe('two');
  });

  it('selects text objects', () => {
    expect(sel(press(start('say "he|llo" ok'), 'vi"').state)).toBe('hello');
    expect(sel(press(start('f(a, |b)'), 'va(').state)).toBe('(a, b)');
  });

  it.each([
    ['one |two three', 'ved', 'one | three'],
    ['one |two three', 'vex', 'one | three'],
    ['one |two three', 'vecX<Esc>', 'one |X three'],
    ['one |two three', 'veyP', 'one tw|otwo three'],
    ['one |two three', 've~', 'one |TWO three'],
    ['one |two three', 'veU', 'one |TWO three'],
    ['one |TWO three', 'veu', 'one |two three'],
    ['one |two three', 'verx', 'one |xxx three'],
    ['a\n|b\nc', 'Vd', 'a\n|c'],
    ['a\n|b\nc', 'Vjd', '|a'],
    ['a\n|b\nc', 'Vy', 'a\n|b\nc'],
    ['a\n|b\nc', 'Vj>', 'a\n  |b\n  c'],
    ['|a\nb\nc', 'VjJ', 'a| b\nc'],
    ['|ab cd', 'vd', '|b cd'],
    ['one |two', 'v<Esc>', 'one |two'],
    ['one |two', 'vv', 'one |two'],
  ])('%j  %s  →  %j', (input, keys, expected) => {
    expect(run(input, keys)).toBe(expected);
  });

  it('switches between charwise and linewise', () => {
    let { state } = press(start('a|b\ncd'), 'V');
    expect(state.mode).toBe('visual-line');
    expect(sel(state)).toBe('ab');
    state = press(state, 'v').state;
    expect(state.mode).toBe('visual');
    state = press(state, 'V').state;
    state = press(state, 'V').state;
    expect(state.mode).toBe('normal');
  });

  it('replaces a selection with p and keeps what was replaced', () => {
    let { state } = press(start('|one two'), 'yiwwviwp');
    expect(state.text).toBe('one one');
    expect(state.register.text).toBe('two');
    state = press(state, 'u').state;
    expect(state.text).toBe('one two');
  });

  it('labels modes', () => {
    expect(modeLabel('visual-line')).toBe('V-LINE');
    expect(modeLabel('normal')).toBe('NORMAL');
  });
});

describe('host bridge', () => {
  it('shows the Normal cursor as a one-character (grapheme) block', () => {
    const s = start('a|👨‍👩‍👧b');
    expect(selectionFor(s)).toEqual({ start: 1, end: 1 + '👨‍👩‍👧'.length });
    expect(selectionFor(start('ab|'))).toEqual({ start: 1, end: 2 });
    expect(selectionFor(start('|'))).toEqual({ start: 0, end: 0 });
    expect(selectionFor(start('a\n|\nb'))).toEqual({ start: 2, end: 2 });
  });

  it('adopts text and caret changes made in the field', () => {
    let s = start('abc|');
    s = sync(s, { text: 'abcdef', selectionStart: 1, selectionEnd: 1 });
    expect(show(s)).toBe('a|bcdef');
    // Unchanged field: same state object.
    const shown = selectionFor(s);
    expect(sync(s, { text: s.text, selectionStart: shown.start, selectionEnd: shown.end })).toBe(s);
  });

  it('turns a mouse selection in Normal mode into Visual mode', () => {
    const s = sync(start('|hello world'), {
      text: 'hello world',
      selectionStart: 6,
      selectionEnd: 11,
    });
    expect(s.mode).toBe('visual');
    expect(selectionFor(s)).toEqual({ start: 6, end: 11 });
  });

  it('enters Insert mode from outside at the cursor, after it, or at the ends', () => {
    expect(show(enterInsert(start('a|bc'), 'after'))).toBe('ab|c');
    expect(show(enterInsert(start('a|bc'), 'end'))).toBe('abc|');
    expect(show(enterInsert(start('a|bc'), 'start'))).toBe('|abc');
  });

  it('emits submit on Enter and escape on Esc with nothing pending', () => {
    expect(press(start('|hi'), '<CR>').effects).toContainEqual({ type: 'submit' });
    expect(press(start('|hi'), '<Esc>').effects).toContainEqual({ type: 'escape' });
    // Esc with a pending operator only cancels it.
    const r = press(start('|hi'), 'd<Esc>');
    expect(r.effects).toEqual([]);
    expect(r.state.pending).toEqual([]);
  });

  it('reports mode changes as effects', () => {
    expect(press(start('|hi'), 'i').effects).toEqual([{ type: 'mode', mode: 'insert' }]);
    expect(press(start('|hi'), 'v').effects).toEqual([{ type: 'mode', mode: 'visual' }]);
    expect(press(start('|hi', 'insert'), '<Esc>').effects).toEqual([
      { type: 'mode', mode: 'normal' },
    ]);
  });

  it('rejects unknown keys so the host can try app bindings, swallowing printable ones', () => {
    const gt = press(start('|hi'), 'g');
    expect(gt.state.pending).toEqual(['g']);
    const r = feed(gt.state, 't');
    expect(r.rejected).toEqual(['g', 't']);
    expect(r.handled).toBe(true);
    const space = feed(start('|hi'), ' ');
    expect(space.handled).toBe(true);
    expect(space.rejected).toEqual([' ']);
    const chord = feed(start('|hi'), '<C-k>');
    expect(chord.handled).toBe(false);
    expect(feed(start('|hi'), '<Tab>').handled).toBe(false);
    // Paste/cut would replace the block cursor: swallowed.
    expect(feed(start('|hi'), '<C-v>').handled).toBe(true);
  });
});
