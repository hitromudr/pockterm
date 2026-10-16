// The page coming up when a script it needs did not arrive. Run with: make test-ui
//
// 2026-10-16, «пустой экран при загрузке через раз»: the tunnel behind the door
// blinked, the door answered 502 for vendor/xterm.js, and the module stopped at
// `new Terminal` — blank screen until a reload. The door is played here by a
// route that fails the first request for the file.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStand } from './stand.mjs';

describe('loading through a door that blinks', () => {
  let stand;
  before(async () => { stand = await startStand({ sessions: ['demo'] }); });
  after(async () => { await stand.stop(); });

  test('a 502 for xterm.js costs a retry, not the screen', async () => {
    const { page } = stand;
    let failed = 0;
    await page.route('**/vendor/xterm.js', async (route) => {
      if (failed++ === 0) {
        await route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' });
      } else {
        await route.continue();
      }
    });
    await stand.open();
    await page.unroute('**/vendor/xterm.js');
    assert.ok(failed >= 2, `xterm.js was asked for ${failed} time(s)`);
    assert.ok(await page.locator('#term .xterm').count() > 0, 'no terminal was built');
    assert.deepEqual(stand.pageErrors, []);
  });
});
