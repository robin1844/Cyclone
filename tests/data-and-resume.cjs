const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { installBike } = require('./journeys.cjs');
const browserType = process.env.CYCLONE_BROWSER === 'webkit' ? webkit : chromium;
const base = process.env.CYCLONE_TEST_URL || 'http://127.0.0.1:8765/';

async function main() {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await installBike(page, true);
    await page.clock.install();
    await page.goto(base);
    await page.waitForFunction(() => typeof Bike !== 'undefined' && Bike.isConnected());

    // Exercise every optional FTMS field, with current and deployed resistance layouts.
    const decoded = await page.evaluate(() => {
      function packet(legacy) {
        const buffer = new ArrayBuffer(legacy ? 30 : 29), view = new DataView(buffer);
        let offset = 0;
        const u8 = n => view.setUint8(offset++, n);
        const u16 = n => { view.setUint16(offset, n, true); offset += 2; };
        u16(8190); u16(3000); u16(2800); u16(180); u16(160);
        u8(57); u8(48); u8(0); // 12,345 metres
        if (legacy) u16(70); else u8(7);
        u16(200); u16(180); u16(100); u16(600); u8(10);
        u8(120); u8(75); u16(10); u16(200);
        return BikeData.parse(view);
      }
      return [packet(false), packet(true)];
    });
    for (const value of decoded) {
      assert.equal(value.powerW, 200); assert.equal(value.energyKcal, 100);
      assert.equal(value.heartRate, 120); assert.equal(value.met, 7.5);
      assert.equal(value.resistance, 7); assert.equal(value.bikeRemainingSeconds, 200);
    }
    assert.equal(await page.evaluate(() => BikeData.distanceDelta(100, 10000, 1, 20)), 0);
    assert.equal(await page.evaluate(() => BikeData.distanceDelta(0xfffffe, 2, 1, 20)), 4);
    assert.equal(await page.evaluate(() => BikeData.distanceDelta(100, 105, 30, 20)), 0);

    // Capture time-weighted metrics, reported calories, and snapshot body weight.
    await page.evaluate(() => {
      WorkoutData.start('cyclone');
      WorkoutData.feed({ powerW: 200, cadenceRpm: 90, heartRate: 120, energyKcal: 100, met: 7.5 });
    });
    await page.clock.runFor(2000);
    await page.evaluate(() => WorkoutData.feed({ powerW: 300, cadenceRpm: 100, heartRate: 140, energyKcal: 101 }));
    await page.clock.runFor(2000);
    const metrics = await page.evaluate(() => {
      WorkoutData.feed({ powerW: 100, energyKcal: 103 });
      return WorkoutData.attach({ id: 'test-cyclone', source: 'cyclone', km: 1, endedAt: new Date().toISOString() }).metrics;
    });
    assert(Math.abs(metrics.fields.powerW.integral - 1000) < 30);
    assert.equal(metrics.energyKcal, 3); assert.equal(metrics.weightKg, 75);
    assert.equal(metrics.fields.powerW.peak, 300);

    // Seed clear Today / All time fixtures, including distance-only historical data.
    await page.evaluate(metrics => {
      const today = new Date().toISOString(), yesterday = new Date(Date.now() - 86400000).toISOString();
      metrics.durationSeconds = 3600;
      metrics.fields.powerW = { integral: 720000, seconds: 3600, peak: 400 };
      localStorage.setItem('cyclone-typhoon-distances-v1', JSON.stringify([
        { id: 'c', source: 'cyclone', km: 20, endedAt: today, metrics },
        { id: 'm', source: 'mistral', km: 10, endedAt: today, metrics: { ...metrics, durationSeconds: 1800 } },
        { id: 'old', source: 'cyclone', km: 5, endedAt: yesterday }
      ]));
    }, metrics);
    await page.locator('#open-cyclone').click();
    await page.locator('#cyclone-more-data-btn').click();
    assert.equal(await page.locator('#data-today').getAttribute('aria-pressed'), 'true');
    async function row(label) {
      return page.locator('#more-data-content .data-row').filter({ has: page.locator('dt', { hasText: label }) }).first().locator('dd').textContent();
    }
    assert.equal(await row(/^Distance$/), '30.00 km');
    assert.equal(await row(/^Total time$/), '1:30:00');
    assert.equal(await row(/^Average power$/), '200.0 W');
    assert.equal(await row(/^Total work$/), '1440.0 kJ');
    assert.equal(await row(/^Average Watts per kilo$/), '2.67 W/kg');
    await page.locator('#data-all-time').click();
    assert.equal(await row(/^Distance$/), '35.00 km');
    assert.match(await page.locator('#data-coverage').textContent(), /1 older ride has distance only/);
    await page.locator('#data-weight').fill('80');
    await page.locator('#data-weight-form button').click();
    assert.equal(await page.evaluate(() => WorkoutData.weight()), 80);
    assert.equal(await row(/^Average Watts per kilo$/), '2.67 W/kg');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#more-data-dialog').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'cyclone-more-data-btn');
    await page.locator('#cyclone-home-btn').click();
    await page.locator('#open-mistral').click();
    await page.locator('#mistral-section [data-distance="5"]').click();
    await page.locator('#mistral-more-data-btn').click();
    assert.equal(await row(/^Distance$/), '18.64 miles');
    assert.equal(await row(/^Average speed$/), '12.4 mph');
    await page.screenshot({ path: process.env.TEMP + '/cyclone-more-data.png', fullPage: true });
    await page.locator('#close-more-data').click();
    console.log('PASS: full FTMS packet alignment, cumulative-counter guards, time-weighted metrics, calories, historical coverage, combined Today/All time, captured weight, unit conversions and accessible modal close.');

    await page.locator('#mistral-home-btn').click();
    await page.locator('#open-typhoon').click();
    await page.locator('#typhoon-more-data-btn').click();
    assert.equal(await page.locator('#data-today').getAttribute('aria-pressed'),'true');
    assert.equal(await row(/^Distance$/),'30.00 km');
    await page.locator('#close-more-data').click();
    await page.locator('#typhoon-home-btn').click();
    await page.locator('#open-mistral').click();
    await page.locator('#mistral-section [data-distance="5"]').click();

    await page.evaluate(() => { sendRawBikeData(0); window.notificationDelayMs=1000; });
    await page.clock.fastForward(31000);
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.clock.runFor(100);
    assert.equal(await page.locator('#mistral-main-btn').textContent(),'Connect');
    assert.equal(await page.locator('#mistral-main-btn').isDisabled(),true);
    await page.clock.runFor(1500);
    assert.equal(await page.locator('#mistral-main-btn').textContent(),'Start');
    await page.evaluate(() => { window.notificationDelayMs=0; });

    // Native raw-counter jumps must not auto-complete a newly started Mistral ride.
    await page.locator('#mistral-main-btn').click();
    await page.evaluate(() => { sendRawBikeData(0); sendRawBikeData(10000); });
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Stop');
    assert.equal(await page.locator('#mistral-distance-progress').textContent(), 'Distance: 0 miles of 5 miles');
    await page.evaluate(() => sendRawBikeData(10005));
    await page.clock.runFor(4500);
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Stop');
    // An abandoned session is retired at its last real data, before new packets.
    await page.clock.fastForward(24 * 60 * 60 * 1000);
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Start');
    await page.locator('#mistral-main-btn').click();
    await page.evaluate(() => { sendRawBikeData(50000); sendRawBikeData(50005); });
    await page.clock.runFor(5000);
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Stop');
    assert.equal(await page.evaluate(() => bikeCalls.chooser), 0);
    await page.locator('#mistral-more-data-btn').click();
    assert.match(await page.locator('#data-coverage').textContent(), /current workout/);
    await page.locator('#close-more-data').click();
    await page.locator('#mistral-main-btn').click();
    assert.deepEqual(errors, []);
    console.log('PASS: stale raw bike counter cannot cause a false finish; after a day-long gap, a fresh Start remains active without another Bluetooth chooser; More data does not stop a ride.');

    // A delayed interrupted AudioContext must resume before the first tone is scheduled.
    const resumePage = await browser.newPage();
    await installBike(resumePage, true);
    await resumePage.addInitScript(() => {
      window.testTones = [];
      class AudioContext {
        constructor() { this.state = 'interrupted'; this.destination = {}; }
        get currentTime() { return performance.now() / 1000; }
        resume() { return new Promise(resolve => setTimeout(() => { this.state = 'running'; resolve(); }, 1500)); }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
        createMediaElementSource() { return { connect() {} }; }
        createOscillator() {
          const node = { frequency: {}, connect(destination) { return destination; }, stop() {}, start(time) { testTones.push({ frequency: node.frequency.value, time }); } };
          return node;
        }
      }
      window.AudioContext = AudioContext;
    });
    await resumePage.clock.install();
    await resumePage.goto(base);
    await resumePage.waitForFunction(() => typeof Bike !== 'undefined' && Bike.isConnected());
    await resumePage.locator('#open-cyclone').click();
    await resumePage.locator('#cyclone-main-btn').click();
    await resumePage.clock.runFor(1000);
    assert.equal(await resumePage.evaluate(() => testTones.length), 0);
    await resumePage.clock.runFor(1000);
    assert.deepEqual(await resumePage.evaluate(() => testTones.map(tone => tone.frequency)), [500, 500, 500, 1000]);
    await resumePage.clock.runFor(5000);
    assert.equal(await resumePage.locator('#cyclone-main-btn').textContent(), 'Stop');
    console.log('PASS: interrupted audio resumes before scheduling the complete countdown; startup stays active.');
    await resumePage.locator('#cyclone-main-btn').click();
    await resumePage.locator('#cyclone-home-btn').click();
    await resumePage.locator('#open-typhoon').click();
    await resumePage.locator('#typhoon-section [data-minutes="3"]').click();
    await resumePage.locator('#typhoon-main-action').click();
    await resumePage.clock.runFor(100);
    await resumePage.clock.fastForward(24 * 60 * 60 * 1000);
    await resumePage.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    assert.equal(await resumePage.locator('#typhoon-countdown-section').isVisible(),false);
    assert.equal(await resumePage.locator('#typhoon-main-action').textContent(),'Start');
    await resumePage.locator('#typhoon-main-action').click();
    for(let i=0;i<9 && !await resumePage.locator('#typhoon-workout-section').isVisible();i++) await resumePage.clock.runFor(1000);
    assert.equal(await resumePage.locator('#typhoon-main-action').textContent(),'Stop');
    console.log('PASS: a day-old Typhoon countdown cannot resume partway through; the next fresh start completes normally.');

  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
