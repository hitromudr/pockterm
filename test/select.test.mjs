// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotText, chunks, pickedText, markdownFrom, tablesFrom, rulesFrom, headingsFrom } from '../web/js/select.js';

test('rows become lines', () => {
  assert.equal(snapshotText(['one', 'two']), 'one\ntwo');
});

test('the padding every row carries is dropped', () => {
  assert.equal(snapshotText(['ls -la      ', 'total 8   ']), 'ls -la\ntotal 8');
});

test('the empty screen below the last line is not part of the copy', () => {
  assert.equal(snapshotText(['$ echo hi', 'hi', '', '   ', '']), '$ echo hi\nhi');
});

test('blank rows inside the screen stay — they are part of the output', () => {
  assert.equal(snapshotText(['first', '', 'third']), 'first\n\nthird');
});

test('an empty screen gives empty text, not a pile of newlines', () => {
  assert.equal(snapshotText(['', '', '']), '');
  assert.equal(snapshotText([]), '');
  assert.equal(snapshotText(null), '');
});

test('a row that is missing does not break the snapshot', () => {
  assert.equal(snapshotText(['ok', null, 'still ok']), 'ok\n\nstill ok');
});

test('a paragraph is a run of lines with no blank line in it', () => {
  const cut = chunks('one\ntwo\n\nthree');
  assert.deepEqual(cut.map((c) => c.para), [true, false, true]);
  assert.deepEqual(cut.map((c) => c.text), ['one\ntwo\n', '\n', 'three']);
});

test('the chunks put back together are the text they came from', () => {
  // The copy window is laid out from these, so a selection dragged across it
  // reads as it looks only while this holds.
  for (const text of [
    'one\ntwo\n\nthree',
    '\n\nleading blanks\n',
    'trailing blank\n\n',
    'no blanks at all',
    '   \nspaces are blank\n \n',
  ]) assert.equal(chunks(text).map((c) => c.text).join(''), text);
});

test('a line of spaces is blank, and belongs to no paragraph', () => {
  const cut = chunks('above\n   \nbelow');
  assert.deepEqual(cut.map((c) => c.para), [true, false, true]);
});

test('nothing on screen offers nothing to pick', () => {
  assert.deepEqual(chunks(''), []);
  assert.deepEqual(chunks(null), []);
});

test('picked paragraphs come out separated by the blank line that separated them', () => {
  assert.equal(pickedText(['one\ntwo\n', 'four\n']), 'one\ntwo\n\nfour');
});

test('one paragraph comes out without a trailing newline', () => {
  // It is pasted into a shell as often as into a message, and a newline there
  // is a command nobody typed.
  assert.equal(pickedText(['make check\n']), 'make check');
});

test('nothing picked is empty text, not a blank line', () => {
  assert.equal(pickedText([]), '');
  assert.equal(pickedText(null), '');
  assert.equal(pickedText(['\n', '  \n']), '');
});

// --- the Markdown the pane drew --------------------------------------------
// The shapes below were measured off four live panes (Claude Code 2.1.x) rather
// than invented: bold is set per word, an inline code span is the light blue
// `38;5;153` and is split per word too, and the pink beside it is chrome.
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const C = (s) => `\x1b[38;5;153m${s}\x1b[39m`;

test('bold comes back as bold, word by word or not', () => {
  assert.equal(markdownFrom(`${B('Важная')} ${B('поправка,')} ${B('без')} неё нет`),
    '**Важная поправка, без** неё нет');
  assert.equal(markdownFrom(`${B('одно')} слово`), '**одно** слово');
});

test('the light blue is a backtick, and two of them side by side are one span', () => {
  assert.equal(markdownFrom(`Прогон ${C('make')} ${C('check')} прошёл`), 'Прогон `make check` прошёл');
  assert.equal(markdownFrom(`в ${C('scripts/x.py')}.`), 'в `scripts/x.py`.');
});

test('a run the pane wrapped is one run, and a paragraph break is not', () => {
  // The renderer closes the attribute at the end of a line and opens it again on
  // the next: one newline is the wrap, two is another paragraph.
  assert.equal(markdownFrom(`${B('Важная')}\n  ${B('поправка')}`), '**Важная\n  поправка**');
  assert.equal(markdownFrom(`${B('Первый')}\n\n${B('Второй')}`), '**Первый**\n\n**Второй**');
});

test('the marks never wrap the space beside the word', () => {
  // `** foo**` is two asterisks and a word to every Markdown reader there is.
  assert.equal(markdownFrom(`\x1b[1m слово \x1b[0mдальше`), ' **слово** дальше');
});

test('chrome keeps its colours and gets no marks', () => {
  assert.equal(markdownFrom('\x1b[38;5;211m⏵⏵ bypass permissions on\x1b[39m'),
    '⏵⏵ bypass permissions on');
  assert.equal(markdownFrom('\x1b[2mctx 22%\x1b[0m | Opus 4.8'), 'ctx 22% | Opus 4.8');
});

test('an extended colour is one parameter list, not a pile of them', () => {
  // Read parameter by parameter, the `5` of `38;5;153` is a colour of its own and
  // the `153` sets a code span that nobody asked for.
  assert.equal(markdownFrom('\x1b[38;5;244mgrey\x1b[39m'), 'grey');
  assert.equal(markdownFrom('\x1b[38;2;10;20;30mtruecolor\x1b[39m'), 'truecolor');
});

test('bold inside a code span carries both marks, code first', () => {
  assert.equal(markdownFrom('\x1b[1m\x1b[38;5;153mmake\x1b[39m\x1b[0m'), '**`make`**');
});

test('text with no escapes in it is handed back exactly', () => {
  assert.equal(markdownFrom('plain text\nsecond line'), 'plain text\nsecond line');
  assert.equal(markdownFrom(''), '');
  assert.equal(markdownFrom(null), '');
});

test('an escape that is not SGR is dropped rather than shown', () => {
  assert.equal(markdownFrom('a\x1b[2Kb\x1b[Hc'), 'abc');
});

// --- the table the pane drew -----------------------------------------------
// The block below is the real one measured off a live pane (Claude Code 2.1.x):
// three columns, an inner rule between every logical row, and cells that wrap
// down two physical rows.
const TABLE = [
  '  ┌──────────────────────┬──────────┬──────────┐',
  '  │      Приложение      │  Время   │ Открытий │',
  '  ├──────────────────────┼──────────┼──────────┤',
  '  │ Советские            │ 8.5 мин  │ 98       │',
  '  │ мультфильмы          │          │          │',
  '  ├──────────────────────┼──────────┼──────────┤',
  '  │ BSPlayer             │ 0.8 мин  │ 24       │',
  '  └──────────────────────┴──────────┴──────────┘',
].join('\n');

test('a box table becomes a Markdown table, header first', () => {
  assert.equal(tablesFrom(TABLE), [
    '| Приложение | Время | Открытий |',
    '| --- | --- | --- |',
    '| Советские мультфильмы | 8.5 мин | 98 |',
    '| BSPlayer | 0.8 мин | 24 |',
  ].join('\n'));
});

test('a wrapped cell is joined by the space the wrap ate', () => {
  const md = tablesFrom(TABLE).split('\n');
  assert.ok(md.some((l) => l.includes('Советские мультфильмы')), md.join('\n'));
});

test('the text around a table is left exactly as it was', () => {
  const doc = `before\n\n${TABLE}\n\nafter`;
  const md = tablesFrom(doc);
  assert.ok(md.startsWith('before\n\n'), md);
  assert.ok(md.endsWith('\n\nafter'), md);
});

test('a box round prose is not a table — no column junction, left alone', () => {
  // The agent's own input box, and any note/callout: `╭────╮` has no `┬`.
  const box = ['  ╭────────────╮', '  │ > type here │', '  ╰────────────╯'].join('\n');
  assert.equal(tablesFrom(box), box);
});

test('a numbered list in prose is not a table', () => {
  const prose = '1. первый\n2. второй\n\nобычный текст без рамок';
  assert.equal(tablesFrom(prose), prose);
});

test('a pipe inside a cell is escaped, not left to end the cell', () => {
  const t = [
    '┌──────┬──────┐',
    '│ a|b  │ c    │',
    '├──────┼──────┤',
    '│ d    │ e    │',
    '└──────┴──────┘',
  ].join('\n');
  const md = tablesFrom(t).split('\n');
  assert.equal(md[0], '| a\\|b | c |');
});

test('bold and code inside a cell survive the table pass', () => {
  // markdownFrom runs the inline pass first, so a cell can already hold `**`.
  const styled = [
    '┌──────────────┬──────┐',
    `│ \x1b[1m63\x1b[0m \x1b[38;5;153mиз\x1b[39m 63 │ да   │`,
    '├──────────────┼──────┤',
    '│ прочерк      │ нет  │',
    '└──────────────┴──────┘',
  ].join('\n');
  const md = markdownFrom(styled).split('\n');
  assert.equal(md[0], '| **63** `из` 63 | да |');
});

test('a table with no inner rules keeps each line as its own row', () => {
  const t = [
    '┌──────┬──────┐',
    '│ a    │ b    │',
    '│ c    │ d    │',
    '└──────┴──────┘',
  ].join('\n');
  assert.equal(tablesFrom(t), [
    '| a | b |',
    '| --- | --- |',
    '| c | d |',
  ].join('\n'));
});

// --- where the text sits in its cell ---------------------------------------
const mk = (...rows) => rows.join('\n');

test('the padding is read off the data rows, and a centred header decides nothing', () => {
  // The measured table: Claude Code centres every header (`│      Приложение      │`
  // over `│ Советские            │`), and its data cells are padded on the right —
  // left-aligned, which Markdown writes as plain `---`. Three columns, so three.
  assert.equal(tablesFrom(TABLE).split('\n')[1], '| --- | --- | --- |');
});

test('a column with the room in front of the text is right-aligned', () => {
  const t = mk(
    '┌────────────┬────────┐',
    '│    Товар   │  Штук  │',
    '├────────────┼────────┤',
    '│ Болты      │    12  │',
    '├────────────┼────────┤',
    '│ Гайки      │   240  │',
    '└────────────┴────────┘',
  );
  assert.equal(tablesFrom(t).split('\n')[1], '| --- | ---: |');
});

test('a column padded on both sides is centred', () => {
  const t = mk(
    '┌────────────┬────────────┐',
    '│ Файл       │   Статус   │',
    '├────────────┼────────────┤',
    '│ app.js     │    есть    │',
    '├────────────┼────────────┤',
    '│ sw.js      │    нет     │',
    '└────────────┴────────────┘',
  );
  assert.equal(tablesFrom(t).split('\n')[1], '| --- | :---: |');
});

test('a cell filled to its width says nothing, and nothing is claimed', () => {
  // No padding to read: `---` rather than a guess.
  const t = mk(
    '┌──────┬──────┐',
    '│ abcd │ efgh │',
    '├──────┼──────┤',
    '│ ijkl │ mnop │',
    '└──────┴──────┘',
  );
  assert.equal(tablesFrom(t).split('\n')[1], '| --- | --- |');
});

test('one space on each side is not evidence of centring', () => {
  // That is what a cell gets when it fills the column, and it happens on every
  // left-aligned table with a value as wide as its column.
  const t = mk(
    '┌────────┬────────┐',
    '│ Ключ   │ Знач   │',
    '├────────┼────────┤',
    '│ раз    │ 1      │',
    '└────────┴────────┘',
  );
  assert.equal(tablesFrom(t).split('\n')[1], '| --- | --- |');
});

test('padding that disagrees between rows is not an alignment', () => {
  const t = mk(
    '┌──────────┬──────────┐',
    '│ Строка   │ Числа    │',
    '├──────────┼──────────┤',
    '│ первая   │     12   │',
    '├──────────┼──────────┤',
    '│ вторая   │ 240      │',
    '└──────────┴──────────┘',
  );
  assert.equal(tablesFrom(t).split('\n')[1], '| --- | --- |');
});

test('a header without data rows leaves every column plain', () => {
  const t = mk(
    '┌────────────┬────────────┐',
    '│   Только   │   шапка    │',
    '└────────────┴────────────┘',
  );
  assert.equal(tablesFrom(t).split('\n')[1], '| --- | --- |');
});

test('a wrapped cell contributes each of its fragments to the reading', () => {
  const t = mk(
    '┌────────────┬────────┐',
    '│  Что       │  Штук  │',
    '├────────────┼────────┤',
    '│ длинное    │    12  │',
    '│ название   │        │',
    '└────────────┴────────┘',
  );
  const md = tablesFrom(t).split('\n');
  assert.equal(md[1], '| --- | ---: |');
  assert.equal(md[2], '| длинное название | 12 |');
});

// --- the link the terminal made clickable ----------------------------------
// Measured off the owner's own panes: 72 escape bytes survived a screenful of
// scrollback before this, every one of them OSC 8.
const link = (uri, text) => `\x1b]8;id=42;${uri}\x1b\\${text}\x1b]8;;\x1b\\`;

test('a bare URL made clickable keeps its text and loses the sequences', () => {
  assert.equal(markdownFrom(`см. ${link('https://ya.ru/x', 'https://ya.ru/x')} там`),
    'см. https://ya.ru/x там');
});

test('a path an agent printed is not turned into a file:// link', () => {
  // `[STATE.md](file:///home/…/STATE.md)` is worse to paste than `STATE.md`.
  assert.equal(markdownFrom(link('file:///home/dms/work/yarr/STATE.md', 'STATE.md')), 'STATE.md');
});

test('text that is not its own address comes back as a Markdown link', () => {
  assert.equal(markdownFrom(link('https://example.org/doc', 'документация')),
    '[документация](https://example.org/doc)');
});

test('an address with a paren in it takes the angle-bracket form', () => {
  assert.equal(markdownFrom(link('https://ru.wikipedia.org/wiki/Ключ_(замок)', 'ключ')),
    '[ключ](<https://ru.wikipedia.org/wiki/Ключ_(замок)>)');
});

test('a label the pane broke over two spans keeps its text and makes no link', () => {
  // The pane re-opens the hyperlink on every physical line it covers, so a wrapped
  // label arrives as two spans of one address. A link labelled half a sentence is
  // worse than the sentence.
  const uri = 'https://example.org/doc';
  assert.equal(markdownFrom(`${link(uri, 'первая')}\n  ${link(uri, 'вторая')}`), 'первая\n  вторая');
  assert.equal(markdownFrom(link(uri, 'первая\n  вторая')), 'первая\n  вторая');
});

test('a bare URL the pane wrapped comes out whole and once', () => {
  // Measured on three of the owner's four panes: `…/yarr.g` and `it` on the next
  // line, which the first version turned into two links, one labelled `it`.
  const uri = 'http://127.0.0.1:3030/hitromudr/yarr.git';
  const wrapped = `${link(uri, 'http://127.0.0.1:3030/hitromudr/yarr.g')}\n  ${link(uri, 'it')}`;
  assert.equal(markdownFrom(wrapped), uri);
});

test('a word that happens to sit inside its address is left as the word', () => {
  // `yarr` under `…/yarr.git` cannot be told from half a wrapped URL, and rewriting
  // what is on screen into a longer address is the guess that reads as right.
  assert.equal(markdownFrom(link('http://127.0.0.1:3030/hitromudr/yarr.git', 'yarr')), 'yarr');
});

test('a link whose closer never came back is still not left raw', () => {
  // The capture window cuts a sequence in half often enough — 2000 lines end
  // wherever they end.
  assert.equal(markdownFrom('\x1b]8;id=7;https://ya.ru\x1b\\хвост'), 'хвост');
});

test('bold inside a link text survives the link', () => {
  assert.equal(markdownFrom(link('https://example.org/d', `\x1b[1mтут\x1b[0m`)),
    '[**тут**](https://example.org/d)');
});

test('a bell-terminated OSC is read too, not only ESC-backslash', () => {
  assert.equal(markdownFrom('\x1b]8;;https://ya.ru\x07текст\x1b]8;;\x07'),
    '[текст](https://ya.ru)');
});

test('a code span holding a backtick gets a longer fence', () => {
  // Otherwise the span ends at the content's own mark, which reads as the right
  // answer and is not one. No live pane carried this; an agent quoting a backtick
  // would.
  assert.equal(markdownFrom('\x1b[38;5;153ma`b\x1b[39m'), '`` a`b ``');
  assert.equal(markdownFrom('\x1b[38;5;153ma``b\x1b[39m'), '``` a``b ```');
});

test('a URL wrapped with a colour change between its halves is still one URL', () => {
  // Measured on the elect pane: between two spans of one address sits
  // `\n     \x1b[94m` — the pane closes the colour at the end of a line and opens it
  // again on the next, and a gap tested for whitespace with the escapes still in it
  // is never whitespace.
  const uri = 'http://duma.gov.ru/duma/deputies/?letter=&fraction=&district=202';
  const wrapped = `${link(uri, 'http://duma.gov.ru/duma/deputies/?letter=')}\n     \x1b[94m`
    + `${link(uri, '&fraction=&district=202')} -> 404`;
  assert.equal(markdownFrom(wrapped), `${uri} -> 404`);
});

test('the colour reset inside a rejoined URL is not thrown away with it', () => {
  // Dropping a reset leaves the colour on, and one of those colours is what a code
  // span is read from a line later.
  const uri = 'https://example.org/aaa/bbb';
  const wrapped = `${link(uri, 'https://example.org/aaa')}\n  ${link(uri, '/bbb')}`
    + `\x1b[38;5;153mmake\x1b[39m`;
  assert.equal(markdownFrom(wrapped), `${uri}\`make\``);
});

// --- the rule between paragraphs -------------------------------------------
// Measured over four live panes: a lone line of `─` comes in exactly two lengths —
// 40, twenty-four times on one pane and always between two paragraphs, and the
// pane's own width, exactly twice per pane, above and below the `❯`.
test('a rule between paragraphs is the thematic break it was written as', () => {
  assert.equal(rulesFrom('текст\n  ────────────────────\nещё', 163), 'текст\n---\nещё');
});

test("the input box's own frame is left alone, and the width is what says so", () => {
  const frame = '─'.repeat(51);
  assert.equal(rulesFrom(`${frame}\n❯ \n${frame}`, 51), `${frame}\n❯ \n${frame}`);
  // A rule one column short of the pane is still the frame: tmux pads, thumbs
  // resize, and a break of exactly that width has never been seen.
  assert.equal(rulesFrom('─'.repeat(50), 51), '─'.repeat(50));
});

test('with no width given every lone rule reads as a break', () => {
  assert.equal(rulesFrom('─'.repeat(51)), '---');
});

test('a rule with anything else on its line is not a break', () => {
  // A table border carries junctions, a tool line carries text: `tablesFrom` has
  // had its go by now, and what is left with company on the line stays as it is.
  assert.equal(rulesFrom('  ─── и текст\n├────┼────┤', 163), '  ─── и текст\n├────┼────┤');
});

test('a table is still a table, and its borders are not turned into breaks', () => {
  // Order matters: the tables pass runs first and eats its own borders.
  const t = ['┌──────┬──────┐', '│ a    │ b    │', '├──────┼──────┤', '│ c    │ d    │', '└──────┴──────┘'].join('\n');
  assert.equal(markdownFrom(t, 163), ['| a | b |', '| --- | --- |', '| c | d |'].join('\n'));
});

// --- the one header level the pane carries ---------------------------------
// Measured off this program's own pane, Claude Code 2.1.234: a tape of
// `capture-pane -e` while an agent printed all three levels.
//   `# один`  → `\x1b[1;3;4mодин\x1b[0m`   bold + italic + underline
//   `## два`  → `\x1b[1mдва\x1b[0m`        bold, one span
//   `### три` → `\x1b[1mтри\x1b[0m …`      bold, per word
const H1 = (s) => `\x1b[1;3;4m${s}\x1b[0m`;

test('an underlined line is the first-level header it was written as', () => {
  assert.equal(markdownFrom(`  ${H1('Уровень один')}`), '  # Уровень один');
});

test('the levels the pane draws as bold stay bold', () => {
  // `##` comes as one span, `###` per word, and reading that difference as a level
  // would be reading a line-breaking decision.
  assert.equal(markdownFrom(`  \x1b[1mУровень два\x1b[0m`), '  **Уровень два**');
  assert.equal(markdownFrom(`  \x1b[1mУровень\x1b[0m \x1b[1mтри\x1b[0m`), '  **Уровень три**');
});

test('a header the pane wrapped is one header, not two', () => {
  assert.equal(headingsFrom(`  ${H1('Очень длинный')}\n  ${H1('заголовок')}`),
    '  # Очень длинный заголовок');
});

test('a blank line ends the header, so the next one is its own', () => {
  assert.equal(headingsFrom(`  ${H1('Первый')}\n\n  ${H1('Второй')}`),
    '  # Первый\n\n  # Второй');
});

test('a line only partly underlined is no header', () => {
  // An underline inside prose — nothing on the owner's panes carries one, and a
  // header is the whole line or it is not a header.
  assert.equal(headingsFrom(`  \x1b[4mслово\x1b[24m в строке`), '  \x1b[4mслово\x1b[24m в строке');
});

test('the underline that opens on one line and closes on the next is followed', () => {
  // The pane closes a region at the end of a line and opens it again on the next,
  // and this has to read the state across the break rather than per line.
  assert.equal(headingsFrom(`\x1b[4mПервая\nВторая\x1b[24m`), '# Первая Вторая');
});

test('the spaces of an underlined line do not decide it', () => {
  // A pad of underlined trailing spaces is what tmux gives a full-width row.
  assert.equal(headingsFrom(`  \x1b[1;3;4mЗаголовок    \x1b[0m`), '  # Заголовок');
});

test('text with no escapes has no headers to find', () => {
  assert.equal(headingsFrom('# уже написано так\nи текст'), '# уже написано так\nи текст');
});
