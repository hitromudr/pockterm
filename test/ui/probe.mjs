// Not a test: a probe. Opens the app, walks the selection flow step by step
// and prints what the page actually does, with screenshots at every stage.
//   node test/ui/probe.mjs [outdir]
import { startStand } from './stand.mjs';

const out = process.argv[2] || '/tmp/pockterm-shots';

const stand = await startStand({ sessions: ['demo', 'work'] });
const { page } = stand;
try {
  await stand.open();
  await page.screenshot({ path: `${out}/1-sessions.png` });

  await stand.attach('demo');
  await page.click('#term');
  await page.keyboard.type('ls -la /etc | head -20');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/2-terminal.png` });

  // Probe: does a copy event reach the document at all?
  await page.evaluate(() => {
    window.__copies = [];
    document.addEventListener('copy', (e) => window.__copies.push(e.isTrusted));
  });

  await page.click('#select');
  await page.waitForSelector('#snapshot:not([hidden])');
  await page.screenshot({ path: `${out}/3-select-mode.png` });

  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('snapshot'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.screenshot({ path: `${out}/4-selected.png` });

  const before = await page.evaluate(() => ({
    selectMode: !document.getElementById('selbar').hidden,
    snapshotHidden: document.getElementById('snapshot').hidden,
    selection: String(document.getSelection() || '').slice(0, 40),
  }));
  console.log('до копирования:', JSON.stringify(before));

  const exec = await page.evaluate(() => document.execCommand('copy'));
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    execReturned: undefined,
    copyEvents: window.__copies,
    snapshotHidden: document.getElementById('snapshot').hidden,
    selbarHidden: document.getElementById('selbar').hidden,
    toast: document.getElementById('toast').textContent,
  }));
  console.log('execCommand вернул:', exec);
  console.log('после копирования:', JSON.stringify(after));
  await page.screenshot({ path: `${out}/5-after-copy.png` });

  // Prompt mode, for the UI review.
  if (!after.snapshotHidden) await page.click('#sel-done');
  await page.click('#mode');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/6-prompt-mode.png` });

  console.log('ошибки страницы:', JSON.stringify(stand.consoleErrors));
} finally {
  await stand.stop();
}
