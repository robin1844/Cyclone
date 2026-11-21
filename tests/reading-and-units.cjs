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
    await page.addInitScript(() => {
      if (localStorage.getItem('reading-fixture')) return;
      localStorage.setItem('reading-fixture', '1');
      localStorage.setItem('cyclone-typhoon-distances-migrated-v1', '1');
      localStorage.setItem('cyclone-typhoon-distances-v1', JSON.stringify([
        { id: 'old', source: 'cyclone', km: 1, endedAt: new Date().toISOString(), metrics: {
          durationSeconds: 60, weightKg: 75, fields: { heartRate: { peak: 140, integral: 8000, seconds: 60 } }
        } }
      ]));
    });
    await page.clock.install();
    await page.goto(base);
    await page.waitForFunction(() => typeof Bike !== 'undefined' && Bike.isConnected());
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cyclone-typhoon-distances-v1'))[0].metrics.fields.heartRate), undefined);
    await page.locator('#open-typhoon').click();
    assert.equal(await page.locator('#typhoon-more-data-btn').isVisible(), false);
    assert.equal(await page.locator('#typhoon-workout-unit-btn').isVisible(), false);
    await page.locator('#typhoon-section [data-minutes="3"]').click();
    assert.equal(await page.locator('#typhoon-more-data-btn').isVisible(), true);
    await page.locator('#typhoon-workout-unit-btn').click();
    await page.locator('#typhoon-more-data-btn').click();
    assert.equal(await page.locator('#typhoon-main-action').isVisible(), false);
    assert.equal(await page.locator('#more-data-dialog [role], #more-data-dialog [aria-label], #more-data-dialog [aria-labelledby], #more-data-dialog [aria-pressed], #more-data-dialog dl, #more-data-dialog dt, #more-data-dialog dd').count(), 0);
    assert.equal(await page.locator('#more-data-content .data-row').evaluateAll(rows => rows.every(row => row.childNodes.length === 1 && row.firstChild.nodeType === Node.TEXT_NODE && row.textContent.includes(': '))), true);
    const reading = await page.locator('#more-data-dialog').ariaSnapshot();
    assert(!/\b(dialog|region|group|term|definition|status):/.test(reading));
    assert(!/heart rate|bpm/i.test(reading));
    assert(reading.includes('Distance: 0.62 miles'));
    assert.equal(await page.evaluate(() => {
      const unit = document.getElementById('data-unit-btn');
      const note = [...document.querySelectorAll('#more-data-dialog p')].find(item => item.textContent.startsWith('Combined rides'));
      return Boolean(unit.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), true);
    await page.locator('#data-unit-btn').click();
    assert.equal(await page.locator('#more-data-content [data-label="Distance"]').textContent(), 'Distance: 1.00 km');
    await page.screenshot({ path: process.env.TEMP + '/cyclone-plain-more-data.png', fullPage: true });
    await page.goBack();
    await page.waitForFunction(() => document.getElementById('more-data-dialog').hidden);
    assert.equal(await page.locator('#typhoon-main-action').isVisible(), true);
    await page.locator('#typhoon-main-action').click();
    assert.equal(await page.locator('#typhoon-more-data-btn').isVisible(), false);
    for (let i = 0; i < 9 && !await page.locator('#typhoon-workout-section').isVisible(); i++) await page.clock.runFor(1000);
    assert.equal(await page.locator('#typhoon-more-data-btn').isVisible(), true);
    await page.locator('#typhoon-main-action').click();
    await page.waitForFunction(() => !document.getElementById('typhoon-results-section').hidden);
    assert.equal(await page.locator('#typhoon-more-data-btn').isVisible(), false);
    assert.equal(await page.locator('#typhoon-workout-unit-btn').isVisible(), false);
    await page.locator('#typhoon-home-btn').click();
    await page.locator('#open-cyclone').click();
    assert.equal(await page.locator('#cyclone-stat-today').textContent(), 'Today: 1.00 km');
    assert.equal(await page.locator('#cyclone-stat-today').evaluate(node => node.childNodes.length), 1);
    await page.locator('#cyclone-workout-unit-btn').click();
    assert.equal(await page.locator('#cyclone-stat-today').textContent(), 'Today: 0.62 miles');
    await page.locator('#cyclone-main-btn').click();
    await page.clock.runFor(4500);
    await page.locator('#cyclone-more-data-btn').click();
    await page.evaluate(() => { sendBikeData(0); sendBikeData(50, 95); });
    await page.clock.runFor(200);
    assert.equal(await page.locator('#cyclone-spoken').textContent(), '95');
    assert.equal(await page.locator('#cyclone-spoken').evaluate(node => node.closest('[hidden]') === null), true);
    await page.locator('#data-all-time').click();
    await page.locator('#data-unit-btn').click();
    assert.equal(await page.locator('#data-all-time').textContent(), 'All time (selected)');
    await page.locator('#close-more-data').click();
    await page.waitForFunction(() => document.getElementById('more-data-dialog').hidden);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'cyclone-more-data-btn');
    assert.equal(await page.locator('#cyclone-main-btn').textContent(), 'Stop');
    await page.locator('#cyclone-main-btn').click();
    await page.locator('#cyclone-home-btn').click();
    await page.locator('#open-mistral').click();
    assert.equal(await page.locator('#mistral-more-data-btn').isVisible(), false);
    await page.locator('#mistral-section [data-distance="5"]').click();
    await page.locator('#mistral-main-btn').click();
    await page.clock.runFor(4500);
    await page.evaluate(() => { sendBikeData(0); sendBikeData(3219); });
    await page.locator('#mistral-more-data-btn').click();
    await page.locator('#data-unit-btn').click();
    await page.evaluate(() => sendBikeData(5000));
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Stop');
    assert.equal(await page.locator('#mistral-distance-progress').textContent(), 'Distance: 5K of 8.05K');
    await page.locator('#close-more-data').click();
    await page.waitForFunction(() => document.getElementById('more-data-dialog').hidden);
    await page.evaluate(() => sendBikeData(8047));
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Start');
    await page.clock.runFor(1300);
    assert.match(await page.locator('#mistral-spoken').textContent(), /Workout complete.*kilometres per hour/);
    assert.match(await page.locator('#mistral-result-speed').textContent(), /^Average speed: [\d.]+ km\/h$/);
    const finalKm = await page.evaluate(() => JSON.parse(localStorage.getItem('cyclone-typhoon-distances-v1')).at(-1).km);
    assert.equal(finalKm, 8.047);
    assert.equal(await page.evaluate(() => bikeCalls.connect), 1);
    await page.reload();
    await page.waitForFunction(() => typeof DistanceUnits !== 'undefined');
    assert.equal(await page.evaluate(() => DistanceUnits.get('mistral')), 'km');
    assert.equal(await page.locator('#mistral-section [data-distance="5"]').textContent(), '5 km');
    assert.deepEqual(errors, []);
    console.log('PASS: plain reading structure, single-node label/value stats, heart-rate removal, workout-only tools, unit controls in every section and More data, period retention, live speech while viewing data, safe Mistral target conversion, focus/history and saved units.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
