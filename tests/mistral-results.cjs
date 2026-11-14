const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { installBike } = require('./journeys.cjs');
const browserType = process.env.CYCLONE_BROWSER === 'webkit' ? webkit : chromium;
const base = process.env.CYCLONE_TEST_URL || 'http://127.0.0.1:8765/';

async function main() {
  const browser = await browserType.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await installBike(page, true);
    await page.clock.install();
    await page.goto(base);
    await page.waitForFunction(() => typeof Bike !== 'undefined' && Bike.isConnected());
    await page.locator('#open-mistral').click();
    await page.locator('#mistral-unit-btn').click();
    await page.locator('#mistral-section [data-distance="5"]').click();

    async function start() {
      await page.evaluate(() => {
        document.getElementById('mistral-main-btn').click();
        window.testStartedAt = performance.now();
        sendBikeData(0);
      });
    }
    async function atElapsed(seconds) {
      const elapsed = await page.evaluate(() => performance.now() - window.testStartedAt);
      assert(elapsed <= seconds * 1000);
      await page.clock.runFor(seconds * 1000 - elapsed);
    }
    async function send(metres) {
      await page.evaluate(metres => sendBikeData(metres), metres);
      await page.clock.runFor(150);
    }
    const speech = () => page.locator('#mistral-spoken').textContent();
    await start();
    await send(4799);
    assert(!/metres to go/.test(await speech()));
    for (const [metres, remaining] of [[4800, 200], [4900, 100], [4950, 50]]) {
      await send(metres);
      assert.equal(await speech(), `${remaining} metres to go.`);
      // Repeated packets and cadence changes must not repeat or interrupt it.
      await page.evaluate(metres => sendBikeData(metres, 100), metres);
      assert.equal(await speech(), `${remaining} metres to go.`);
      assert.equal(await page.locator('#mistral-cadence-spoken').textContent(), '');
    }
    await atElapsed(600);
    await page.evaluate(() => sendBikeData(5000));
    assert.equal(await page.locator('#mistral-results-section').isVisible(), true);
    assert.equal(await page.locator('#mistral-result-time').textContent(), '10:00');
    assert.equal(await page.locator('#mistral-result-speed').textContent(), '30.0 km/h');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'mistral-results-heading');
    await page.clock.runFor(1300);
    assert.equal(await speech(), 'Workout complete. Time: 10 minutes. Average speed: 30.0 kilometres per hour.');
    assert.equal(await page.locator('#mistral-stat-alltime').textContent(), '5.00 km');
    await page.screenshot({ path: process.env.TEMP + '/mistral-results-km.png', fullPage: true });

    // A second workout resets both summary and threshold state.
    await start();
    assert.equal(await page.locator('#mistral-results-section').isVisible(), false);
    await send(4800);
    assert.equal(await speech(), '200 metres to go.');
    await atElapsed(1200);
    await page.evaluate(() => document.getElementById('mistral-main-btn').click());
    assert.equal(await page.locator('#mistral-result-time').textContent(), '20:00');
    assert.equal(await page.locator('#mistral-result-speed').textContent(), '14.4 km/h');
    await page.clock.runFor(1300);
    assert.match(await speech(), /^Workout stopped\. Time: 20 minutes\./);

    // Miles use true yard conversions, including the exact 50-yard boundary.
    await page.locator('#mistral-change-distance-btn').click();
    await page.locator('#mistral-unit-btn').click();
    await page.locator('#mistral-section [data-distance="5"]').click();
    await start();
    await send(7863);
    assert(!/yards to go/.test(await speech()));
    for (const [metres, remaining] of [[7864, 200], [7956, 100], [8001, 50]]) {
      await send(metres);
      assert.equal(await speech(), `${remaining} yards to go.`);
    }
    await atElapsed(1800);
    await page.evaluate(() => sendBikeData(8047));
    assert.equal(await page.locator('#mistral-result-time').textContent(), '30:00');
    assert.equal(await page.locator('#mistral-result-speed').textContent(), '10.0 mph');
    await page.clock.runFor(1300);
    assert.equal(await speech(), 'Workout complete. Time: 30 minutes. Average speed: 10.0 miles per hour.');

    // Long, zero-duration and interrupted starts must stay well defined.
    await start();
    await atElapsed(3661);
    await page.evaluate(() => { sendBikeData(1609); document.getElementById('mistral-main-btn').click(); });
    assert.equal(await page.locator('#mistral-result-time').textContent(), '1:01:01');
    await page.clock.runFor(1300);
    assert.match(await speech(), /Time: 1 hour, 1 minute, 1 second/);
    await page.evaluate(() => {
      document.getElementById('mistral-main-btn').click();
      document.getElementById('mistral-main-btn').click();
    });
    assert.equal(await page.locator('#mistral-result-time').textContent(), '0:00');
    assert.equal(await page.locator('#mistral-result-speed').textContent(), '0.0 mph');
    await start();
    await page.locator('#mistral-home-btn').click();
    await page.clock.runFor(6000);
    assert.equal(await page.locator('#launcher').isVisible(), true);
    assert.equal(await speech(), '');
    assert.equal(await page.evaluate(() => bikeCalls.connect), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: metre and yard finish thresholds, cadence priority, threshold reset, completed/early-stop summaries, exact elapsed time and average speed in both units, long/zero durations, navigation cleanup, shared data and retained Bluetooth.');
    await context.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
