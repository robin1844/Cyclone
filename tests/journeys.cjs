// Run against `python -m http.server 8765`. Install Playwright outside this repo.
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browserType = process.env.CYCLONE_BROWSER === 'webkit' ? webkit : chromium;
const base = process.env.CYCLONE_TEST_URL || 'http://127.0.0.1:8765/';

async function installBike(page, remembered = false, realMedia = false) {
  await page.addInitScript(({ remembered, realMedia }) => {
    Object.defineProperty(navigator, 'wakeLock', {value:{request:async()=>({release:async()=>{}})}});
    const calls = window.bikeCalls = { chooser: 0, connect: 0, notifications: 0, disconnect: 0, samples: 0 };
    const characteristic = new EventTarget();
    characteristic.startNotifications = async () => { calls.notifications++; return characteristic; };
    const bike = new EventTarget();
    bike.name = 'Sport01 Test';
    bike.gatt = {
      connected: false,
      async connect() { calls.connect++; this.connected = true; return this; },
      async getPrimaryService() { return { getCharacteristic: async () => characteristic }; },
      disconnect() { calls.disconnect++; this.connected = false; bike.dispatchEvent(new Event('gattserverdisconnected')); }
    };
    Object.defineProperty(navigator, 'bluetooth', { value: {
      requestDevice: async () => { calls.chooser++; return bike; },
      getDevices: async () => remembered ? [bike] : []
    } });
    window.sendBikeData = (metres, cadence = 90, speed = 20, power = 150) => {
      const buffer = new ArrayBuffer(11), view = new DataView(buffer);
      view.setUint16(0, 4 | 16 | 64, true);
      view.setUint16(2, speed * 100, true);
      view.setUint16(4, cadence * 2, true);
      view.setUint8(6, metres & 255);
      view.setUint8(7, (metres >> 8) & 255);
      view.setUint8(8, (metres >> 16) & 255);
      view.setInt16(9, power, true);
      characteristic.value = view;
      calls.samples++;
      characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
    };
    window.dropBike = () => bike.gatt.disconnect();
    if (realMedia) return;
    window.mediaEvents = [];
    window.mediaActions = {};
    Object.defineProperty(navigator,'mediaSession',{value:{setActionHandler:(action,handler)=>{window.mediaActions[action]=handler}}});
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return this._paused !== false; } });
    HTMLMediaElement.prototype.play = function () {
      this._paused = false;
      window.mediaEvents.push({ id: this.id, action: 'play', muted: this.muted, at: performance.now() });
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      this._paused = true;
      window.mediaEvents.push({ id: this.id, action: 'pause', at: performance.now() });
      this.dispatchEvent(new Event('pause'));
    };
    HTMLMediaElement.prototype.load = function () {};
  }, { remembered, realMedia });
}

async function main() {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.log('BROWSER ERROR',error.message); });
    await installBike(page);
    await page.clock.install();
    await page.goto(base);
    await page.waitForFunction(() => typeof sections !== 'undefined' && Object.keys(sections).length === 3);
    assert.equal(await page.locator('#launcher button:visible').count(), 3);
    assert.equal(await page.locator('#open-mistral').evaluate(button => getComputedStyle(button).color),'rgb(255, 255, 255)');
    assert.equal(await page.locator('main:visible').count(), 0);
    await page.screenshot({path:process.env.TEMP+'/cyclone-combined-launcher.png',fullPage:true});
    const duplicateIds = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    assert.deepEqual(duplicateIds, []);
    await page.locator('#open-cyclone').click();
    await page.locator('#cyclone-main-btn').click();
    await page.waitForFunction(() => document.getElementById('cyclone-main-btn').textContent === 'Start');
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Start');
    await page.screenshot({path:process.env.TEMP+'/cyclone-combined-workout.png',fullPage:true});
    await page.locator('#cyclone-audio-file').setInputFiles({ name: 'workout.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('test media') });
    await page.locator('#cyclone-main-btn').click();
    await page.clock.runFor(4500);
    await page.evaluate(() => { sendBikeData(1000); sendBikeData(2000); });
    await page.locator('#cyclone-main-btn').click();
    assert.equal(await page.locator('#cyclone-stat-today').textContent(), '1.00 km');
    await page.locator('#cyclone-home-btn').click();
    await page.waitForFunction(() => !document.getElementById('launcher').hidden);
    await page.locator('#open-mistral').click();
    await page.locator('#mistral-unit-btn').click();
    await page.locator('#mistral-section [data-distance="5"]').click();
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Start');
    assert.equal(await page.locator('#mistral-stat-today').textContent(), '1.00 km');
    await page.locator('#mistral-audio-file').setInputFiles({ name: 'ride.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('test media') });
    await page.locator('#mistral-main-btn').click();
    await page.clock.runFor(4500);
    assert.equal(await page.evaluate(() => document.getElementById('mistral-workout-audio').paused), false);
    await page.evaluate(() => { sendBikeData(2000); sendBikeData(2500); });
    await page.clock.runFor(200);
    assert.equal(await page.locator('#mistral-spoken').textContent(), '0.5K down, 4.5 to go.');
    await page.evaluate(() => sendBikeData(7000));
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Start');
    assert.equal(await page.locator('#mistral-stat-today').textContent(), '6.00 km');
    assert.equal(await page.evaluate(() => document.getElementById('mistral-workout-audio').paused), true);
    await page.locator('#mistral-home-btn').click();
    await page.locator('#open-typhoon').click();
    await page.locator('#typhoon-section [data-minutes="3"]').click();
    assert.equal(await page.locator('#typhoon-main-action').textContent(), 'Start');
    await page.locator('#typhoon-main-action').click();
    for (let i=0;i<8 && !await page.locator('#typhoon-workout-section').isVisible();i++) await page.clock.runFor(1000);
    assert.equal(await page.locator('#typhoon-workout-section').isVisible(),true);
    assert.equal(await page.locator('#typhoon-main-action').isVisible(),true);
    assert.equal(await page.locator('#typhoon-main-action').textContent(),'Stop');
    const firstSong=await page.locator('#typhoon-music').getAttribute('src');
    await page.locator('#typhoon-next-song').click();
    assert.notEqual(await page.locator('#typhoon-music').getAttribute('src'),firstSong);
    const secondSong=await page.locator('#typhoon-music').getAttribute('src');
    await page.evaluate(() => window.mediaActions.nexttrack());
    assert.notEqual(await page.locator('#typhoon-music').getAttribute('src'),secondSong);
    assert.equal(await page.evaluate(() => document.getElementById('typhoon-music-preload').paused && document.getElementById('typhoon-music-preload').muted),true);
    await page.screenshot({path:process.env.TEMP+'/cyclone-combined-typhoon.png',fullPage:true});
    await page.evaluate(() => sendBikeData(7000));
    await page.clock.runFor(1000);
    await page.evaluate(() => { for(let m=7050;m<=8000;m+=50) sendBikeData(m); });
    await page.clock.fastForward(181000);
    await page.clock.runFor(1500);
    assert.equal(await page.locator('#typhoon-results-section').isVisible(), true);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cyclone-typhoon-distances-v1')));
    assert.deepEqual(saved.map(item => item.source), ['cyclone', 'mistral', 'typhoon']);
    assert.equal(saved.reduce((sum, item) => sum + item.km, 0), 7);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('typhoon-sessions-v1')).length), 1);
    await page.locator('#typhoon-update-weight').click();
    await page.getByLabel('Weight in kilograms').fill('80');
    await page.locator('#typhoon-weight-editor button[type=submit]').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('typhoon-weight-kg')),'80');
    await page.locator('#typhoon-home-btn').click();
    assert.equal(await page.evaluate(() => window.mediaActions.nexttrack),null);
    await page.locator('#open-cyclone').click();
    assert.equal(await page.locator('#cyclone-stat-today').textContent(), '7.00 km');
    const calls = await page.evaluate(() => bikeCalls);
    assert.equal(calls.chooser, 1);
    assert.equal(calls.connect, 1);
    assert.equal(calls.notifications, 1);
    assert.equal(calls.disconnect, 0);
    console.log('PASS: one chooser, one connection and one subscription across all three sections; shared Today and history; Mistral target; Typhoon completion.');

    // Leaving during a start sequence must never launch a hidden workout or audio.
    await page.locator('#cyclone-main-btn').click();
    await page.locator('#cyclone-home-btn').click();
    await page.locator('#open-typhoon').click();
    await page.locator('#typhoon-section [data-minutes="3"]').click();
    await page.locator('#typhoon-main-action').click();
    await page.clock.runFor(100);
    await page.locator('#typhoon-home-btn').click();
    await page.clock.runFor(6000);
    assert.equal(await page.locator('#launcher').isVisible(), true);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('audio')].every(audio => audio.paused)), true);
    await page.locator('#open-mistral').click();
    assert.equal(await page.locator('#mistral-distance-setup').isVisible(), true);
    await page.locator('#mistral-section [data-distance="5"]').click();
    await page.locator('#mistral-main-btn').click();
    await page.clock.runFor(4500);
    await page.evaluate(() => { sendBikeData(8000); sendBikeData(8500); dropBike(); });
    assert.equal(await page.locator('#mistral-main-btn').textContent(), 'Stop');
    await page.clock.runFor(3100);
    await page.waitForFunction(() => Bike.isConnected());
    await page.evaluate(() => { sendBikeData(8500); sendBikeData(9000); });
    await page.locator('#mistral-main-btn').click();
    const last = await page.evaluate(() => JSON.parse(localStorage.getItem('cyclone-typhoon-distances-v1')).at(-1));
    assert.equal(last.km, 1);
    assert.equal(await page.evaluate(() => bikeCalls.chooser), 1);
    await page.locator('#mistral-home-btn').click();
    await page.locator('#open-cyclone').click();
    await page.locator('#cyclone-reset-btn').click();
    await page.locator('#cyclone-home-btn').click();
    await page.locator('#open-mistral').click();
    await page.locator('#mistral-section [data-distance="5"]').click();
    assert.equal(await page.locator('#mistral-stat-alltime').textContent(), '0.00 km');
    console.log('PASS: Back during countdown, no hidden playback, picker reset, reconnect during a ride without another chooser, no distance jump, shared reset.');
    assert.deepEqual(errors, []);
    await page.goBack();
    await page.waitForFunction(() => !document.getElementById('launcher').hidden);
    await page.goForward();
    await page.waitForFunction(() => !document.getElementById('mistral-section').hidden);
    assert.equal(await page.locator('#mistral-distance-setup').isVisible(),true);
    assert.equal(await page.locator('h1:visible').count(),1);
    console.log('PASS: browser Back/Forward and only the active section is visible.');
    await page.screenshot({ path: process.env.TEMP + '/cyclone-mistral-combined.png', fullPage: true });

    // Bookmarks redirect to the one document; remembered devices need no chooser.
    const second = await context.newPage();
    await installBike(second, true);
    await second.goto(base + 'typhoon/');
    await second.waitForFunction(() => typeof Bike !== 'undefined' && Bike.isConnected());
    assert.equal(await second.locator('#typhoon-section').isVisible(), true);
    assert.equal(await second.evaluate(() => bikeCalls.chooser), 0);
    assert.equal(await second.evaluate(() => bikeCalls.connect), 1);
    console.log('PASS: legacy URL and remembered-device automatic connection.');
    await context.close();
    const migrationContext = await browser.newContext();
    const migrationPage = await migrationContext.newPage();
    await installBike(migrationPage);
    await migrationPage.addInitScript(() => {
      if (localStorage.getItem('seeded-migration')) return;
      localStorage.setItem('seeded-migration','1');
      localStorage.setItem('cyclone-sessions',JSON.stringify([{date:new Date().toISOString().slice(0,10),km:2}]));
      localStorage.setItem('typhoon-sessions-v1',JSON.stringify([
        {id:'completed',completed:true,endedAt:new Date().toISOString(),distanceKm:3},
        {id:'incomplete',completed:false,endedAt:new Date().toISOString(),distanceKm:99}
      ]));
    });
    await migrationPage.clock.install();
    await migrationPage.goto(base);
    await migrationPage.locator('#open-cyclone').click();
    assert.equal(await migrationPage.locator('#cyclone-stat-alltime').textContent(),'5.00 km');
    await migrationPage.locator('#cyclone-home-btn').click();
    await migrationPage.locator('#open-mistral').click();
    await migrationPage.locator('#mistral-unit-btn').click();
    await migrationPage.locator('#mistral-section [data-distance="5"]').click();
    assert.equal(await migrationPage.locator('#mistral-stat-alltime').textContent(),'5.00 km');
    assert.equal(await migrationPage.evaluate(() => JSON.parse(localStorage.getItem('cyclone-typhoon-distances-v1')).length),2);
    await migrationPage.locator('#mistral-home-btn').click();
    await migrationPage.locator('#open-typhoon').click();
    await migrationPage.locator('#typhoon-section [data-minutes="3"]').click();
    await migrationPage.locator('#typhoon-main-action').click();
    await migrationPage.waitForFunction(() => document.getElementById('typhoon-main-action').textContent === 'Start');
    await migrationPage.locator('#typhoon-main-action').click();
    for(let i=0;i<8 && !await migrationPage.locator('#typhoon-workout-section').isVisible();i++) await migrationPage.clock.runFor(1000);
    await migrationPage.locator('#typhoon-main-action').click();
    await migrationPage.locator('#typhoon-reset-history').click();
    await migrationPage.locator('#typhoon-reset-history').click();
    assert.equal(await migrationPage.evaluate(() => localStorage.getItem('typhoon-sessions-v1')),null);
    await migrationPage.locator('#typhoon-home-btn').click();
    await migrationPage.locator('#open-cyclone').click();
    assert.equal(await migrationPage.locator('#cyclone-stat-alltime').textContent(),'0.00 km');
    await migrationPage.reload();
    await migrationPage.waitForFunction(() => document.getElementById('cyclone-section')?.hidden === false);
    assert.equal(await migrationPage.locator('#cyclone-stat-alltime').textContent(),'0.00 km');
    console.log('PASS: legacy histories imported once, incomplete Typhoon history excluded, Typhoon reset clears both histories without reimport on reload.');
    await migrationContext.close();
    // Windows Playwright WebKit has no Web Audio implementation. Test journeys
    // there, and use Chromium for the real Web Audio + MP3 playback integration.
    if (process.env.CYCLONE_BROWSER === 'webkit') {
      console.log('SKIP: real Web Audio playback in the Windows WebKit test runtime (AudioContext unavailable).');
      return;
    }
    // Actual browser decoding/playback: no media-element mocks and no fake clock.
    const audioContext = await browser.newContext();
    const audioPage = await audioContext.newPage();
    await installBike(audioPage, false, true);
    const audioErrors = [];
    audioPage.on('pageerror', error => audioErrors.push(error.message));
    await audioPage.goto(base);
    for (const name of ['cyclone', 'mistral']) {
      await audioPage.locator('#open-' + name).click();
      if (name === 'mistral') await audioPage.locator('#mistral-section [data-distance="5"]').click();
      const button = audioPage.locator('#' + name + '-main-btn');
      if (await button.textContent() === 'Connect') await button.click();
      await audioPage.locator('#' + name + '-audio-file').setInputFiles(require('node:path').join(__dirname, '../typhoon/audio/track-28-97-bpm.mp3'));
      await button.click();
      await audioPage.waitForFunction(name => {
        const audio = document.getElementById(name + '-workout-audio');
        const play = document.getElementById(name + '-play-btn');
        return !play.disabled && !audio.paused && !audio.muted && audio.currentTime > 0.2;
      }, name, { timeout: 15000 }).catch(async error => { console.log('Media state', await audioPage.evaluate(name => { const a=document.getElementById(name+'-workout-audio');return {paused:a.paused,muted:a.muted,time:a.currentTime,ready:a.readyState,error:a.error?.message,status:document.getElementById(name+'-audio-status').textContent,button:document.getElementById(name+'-play-btn').outerHTML}; },name));throw error; });
      assert.equal(await audioPage.locator('#' + name + '-audio-status').isVisible(), false);
      await button.click();
      assert.equal(await audioPage.evaluate(name => document.getElementById(name + '-workout-audio').paused, name), true);
      await audioPage.locator('#' + name + '-home-btn').click();
    }
    assert.deepEqual(audioErrors, []);
    console.log('PASS: real MP3 decoding and automatic post-countdown playback, then Stop, in Cyclone and Mistral.');
    await audioContext.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
