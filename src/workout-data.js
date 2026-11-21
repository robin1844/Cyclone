// FTMS packet decoding shared by all engines and the detailed ride summaries.
const BikeData = {
  parse(view) {
    const flags = view.getUint16(0, true);
    let offset = 2;
    const u8 = () => view.getUint8(offset++);
    const u16 = () => { const value = view.getUint16(offset, true); offset += 2; return value; };
    const s16 = () => { const value = view.getInt16(offset, true); offset += 2; return value; };
    const u24 = () => u8() | (u8() << 8) | (u8() << 16);
    const out = {};
    if (!(flags & 1)) out.speedKph = u16() / 100;
    if (flags & 2) out.bikeAverageSpeedKph = u16() / 100;
    if (flags & 4) out.cadenceRpm = u16() / 2;
    if (flags & 8) out.bikeAverageCadenceRpm = u16() / 2;
    if (flags & 16) out.distanceM = u24();
    if (flags & 32) {
      // Current SIG layout uses one byte. Many deployed FTMS bikes use the
      // older two-byte, tenth-level representation; distinguish by packet size.
      const trailing = ((flags & 64) ? 2 : 0) + ((flags & 128) ? 2 : 0) +
        ((flags & 256) ? 5 : 0) + ((flags & 512) ? 1 : 0) +
        ((flags & 1024) ? 1 : 0) + ((flags & 2048) ? 2 : 0) + ((flags & 4096) ? 2 : 0);
      out.resistance = view.byteLength - offset - trailing === 1 ? u8() : s16() / 10;
    }
    if (flags & 64) out.powerW = s16();
    if (flags & 128) out.bikeAveragePowerW = s16();
    if (flags & 256) {
      const energy = u16(), hour = u16(), minute = u8();
      if (energy !== 65535) out.energyKcal = energy;
      if (hour !== 65535) out.energyPerHour = hour;
      if (minute !== 255) out.energyPerMinute = minute;
    }
    if (flags & 512) u8(); // Skip the unsupported heart-rate field without retaining it.
    if (flags & 1024) { const met = u8(); if (met !== 255) out.met = met / 10; }
    if (flags & 2048) { const elapsed = u16(); if (elapsed !== 65535) out.bikeElapsedSeconds = elapsed; }
    if (flags & 4096) { const remaining = u16(); if (remaining !== 65535) out.bikeRemainingSeconds = remaining; }
    // Compatibility names for Cyclone and Mistral's workout engines.
    out.speed_kmh = out.speedKph;
    out.cadence_rpm = out.cadenceRpm;
    out.distance_m = out.distanceM;
    out.power_w = out.powerW;
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
    return out;
  },
  distanceDelta(previous, current, dt, speed = 0) {
    if (previous === null || dt > 15 || dt < 0) return 0;
    let delta = current - previous;
    if (delta < 0 && previous > 0xffff00 && current < 1000) delta += 0x1000000;
    const limit = Math.max(100, Math.max(0, speed) / 3.6 * Math.max(dt, 1) * 3 + 20);
    return delta >= 0 && delta <= limit ? delta : 0;
  }
};

// Remove previously retained unsupported pulse measurements without touching rides.
try {
  const key = 'cyclone-typhoon-distances-v1';
  const entries = JSON.parse(localStorage.getItem(key) || '[]');
  let changed = false;
  if (Array.isArray(entries)) for (const entry of entries) {
    if (entry.metrics?.fields && Object.hasOwn(entry.metrics.fields, 'heartRate')) {
      delete entry.metrics.fields.heartRate; changed = true;
    }
  }
  if (changed) localStorage.setItem(key, JSON.stringify(entries));
} catch (error) {}

const WorkoutData = (() => {
  const key = 'cyclone-typhoon-distances-v1';
  let current = null, lastPacket = null, expiring = false;
  const fields = ['powerW', 'cadenceRpm', 'speedKph', 'resistance', 'met'];
  function weight() {
    const value = Number(localStorage.getItem('typhoon-weight-kg'));
    return value >= 30 && value <= 250 ? value : 75;
  }
  function start(source, capturedWeight = weight()) {
    const now = performance.now();
    current = { source, started: now, startedAt: new Date().toISOString(), distanceKm: 0,
      weightKg: capturedWeight, fields: {}, latest: {}, energyKcal: 0, energySeen: false,
      previousEnergy: null, last: now, lastWall: Date.now() };
    lastPacket = now;
  }
  function integrate(now) {
    if (!current) return;
    const dt = (now - current.last) / 1000;
    if (dt > 0 && dt <= 5) {
      for (const field of fields) {
        const sample = current.latest[field];
        if (!sample || now - sample.at > 5000) continue;
        const metric = current.fields[field];
        metric.integral += sample.value * dt;
        metric.seconds += dt;
      }
    }
    current.last = now;
  }
  function feed(measurement) {
    lastPacket = performance.now();
    if (!current) return;
    integrate(lastPacket);
    current.lastWall = Date.now();
    for (const field of fields) {
      if (!(field in measurement) || !Number.isFinite(measurement[field])) continue;
      const value = field === 'powerW' ? Math.max(0, measurement[field]) : measurement[field];
      current.fields[field] ||= { integral: 0, seconds: 0, peak: value };
      current.fields[field].peak = Math.max(current.fields[field].peak, value);
      current.latest[field] = { value, at: lastPacket };
    }
    if ('energyKcal' in measurement) {
      if (current.previousEnergy !== null) {
        const delta = measurement.energyKcal - current.previousEnergy;
        if (delta >= 0 && delta <= 100) current.energyKcal += delta;
      }
      current.previousEnergy = measurement.energyKcal;
      current.energySeen = true;
    }
  }
  function elapsed() {
    if (!current) return 0;
    return Math.max(0, ((expiring ? lastPacket : performance.now()) - current.started) / 1000);
  }
  function snapshot() {
    if (!current) return null;
    integrate(expiring ? lastPacket : performance.now());
    return { version: 1, durationSeconds: elapsed(), weightKg: current.weightKg,
      fields: JSON.parse(JSON.stringify(current.fields)), energyKcal: current.energyKcal,
      energySeen: current.energySeen, endedAt: new Date(expiring ? current.lastWall : Date.now()).toISOString() };
  }
  function finish(source, km) {
    if (!current || current.source !== source) return null;
    current.distanceKm = km;
    const result = snapshot();
    current = null;
    return result;
  }
  function stale() {
    return Boolean(current && lastPacket !== null && (performance.now() - lastPacket > 10 * 60 * 1000 || Date.now() - current.lastWall > 10 * 60 * 1000));
  }
  function expire(section) {
    if (!stale()) return;
    expiring = true;
    section.expire();
    expiring = false;
  }
  function attach(entry) {
    const metrics = finish(entry.source, entry.km);
    if (metrics) { entry.metrics = metrics; entry.endedAt = metrics.endedAt; }
    return entry;
  }
  function legacy(entry, sessions) {
    if (entry.metrics) return entry.metrics;
    const ride = sessions.find(item => `typhoon-${item.id}` === entry.id);
    if (!ride) return null;
    const seconds = Number(ride.durationSeconds) || Number(ride.durationMinutes) * 60;
    if (!(seconds > 0)) return null;
    const metrics = { durationSeconds: seconds, weightKg: Number(ride.weightKg) || 75, fields: {}, legacy: true };
    for (const [field, average, peak] of [
      ['powerW', 'averagePowerW', 'topPowerW'], ['cadenceRpm', 'averageCadenceRpm', 'topCadenceRpm'],
      ['speedKph', 'averageSpeedKph', 'topSpeedKph']
    ]) {
      if (Number.isFinite(ride[average])) metrics.fields[field] = {
        integral: ride[average] * seconds, seconds, peak: Number(ride[peak]) || ride[average]
      };
    }
    if (Number.isFinite(ride.calories)) metrics.legacyCalories = ride.calories;
    return metrics;
  }
  function entries() {
    let ledger = [], sessions = [];
    try { ledger = JSON.parse(localStorage.getItem(key) || '[]'); } catch (error) {}
    try { sessions = JSON.parse(localStorage.getItem('typhoon-sessions-v1') || '[]'); } catch (error) {}
    if (!Array.isArray(ledger)) ledger = [];
    if (!Array.isArray(sessions)) sessions = [];
    const result = ledger.map(entry => ({ ...entry, metrics: legacy(entry, sessions) }));
    if (current) result.push({ source: current.source, endedAt: new Date().toISOString(), km: current.distanceKm, metrics: snapshot(), live: true });
    return result;
  }
  function distance(metres) { if (current) current.distanceKm = metres / 1000; }
  function disconnected() { if (current) { current.latest = {}; current.previousEnergy = null; } }
  return { start, feed, distance, attach, elapsed, expire, entries, disconnected, weight };
})();
