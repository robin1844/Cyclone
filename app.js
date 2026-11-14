"use strict";
// One document owns the native GATT connection for all workout sections.
const sections = {};
let activeSection = null;
const Bike = (() => {
  let device = null, characteristic = null, pending = null, retryTimer = null;
  const FTMS = 0x1826, IBD = 0x2ad2;
  const isConnected = () => Boolean(device?.gatt?.connected && characteristic);
  function notify() {
    for (const section of Object.values(sections)) section.connection(device);
  }
  function onData(event) {
    if (activeSection) sections[activeSection].data(event);
  }
  function retry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (device && !isConnected()) ensure(device).catch(retry);
    }, 3000);
  }
  function onDisconnected() {
    if (characteristic) characteristic.removeEventListener("characteristicvaluechanged", onData);
    characteristic = null;
    for (const section of Object.values(sections)) section.disconnected();
    retry();
  }
  async function ensure(chosen) {
    if (isConnected()) return device;
    if (pending) return pending;
    clearTimeout(retryTimer);
    pending = (async () => {
      if (device && device !== chosen) device.removeEventListener("gattserverdisconnected", onDisconnected);
      device = chosen;
      device.removeEventListener("gattserverdisconnected", onDisconnected);
      device.addEventListener("gattserverdisconnected", onDisconnected);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(FTMS);
      const next = await service.getCharacteristic(IBD);
      // Listen before notifications start so the initial packet is not missed.
      next.removeEventListener("characteristicvaluechanged", onData);
      next.addEventListener("characteristicvaluechanged", onData);
      try { await next.startNotifications(); }
      catch (error) { next.removeEventListener("characteristicvaluechanged", onData); throw error; }
      if (!device.gatt.connected) {
        next.removeEventListener("characteristicvaluechanged", onData);
        throw new Error("Bike disconnected while connecting.");
      }
      characteristic = next;
      try {
        localStorage.setItem("cyclone-device-name", device.name || "");
        localStorage.setItem("typhoon-device-name", device.name || "");
      } catch (error) {}
      notify();
      return device;
    })();
    try { return await pending; }
    finally { pending = null; }
  }
  async function connect() {
    if (isConnected()) return device;
    if (!navigator.bluetooth) throw new Error("Web Bluetooth is unavailable in this browser.");
    if (pending) return pending;
    if (device) {
      try { return await ensure(device); } catch (error) {}
    }
    const name = localStorage.getItem("cyclone-device-name") || localStorage.getItem("typhoon-device-name");
    const filters = [{ services: [FTMS] }, { namePrefix: "Sport01" }];
    if (name) filters.unshift({ name });
    return ensure(await navigator.bluetooth.requestDevice({ filters, optionalServices: [FTMS] }));
  }
  async function autoConnect() {
    if (!navigator.bluetooth?.getDevices) return;
    try {
      const devices = await navigator.bluetooth.getDevices();
      const name = localStorage.getItem("cyclone-device-name") || localStorage.getItem("typhoon-device-name");
      const chosen = devices.find(item => item.name === name) || devices[0];
      if (chosen) await ensure(chosen);
    } catch (error) { if (device) retry(); }
  }
  return { connect, ensure, autoConnect, isConnected, get device() { return device; } };
})();

// Engines keep their own DOM, metrics, histories and audio without duplicate IDs.
function sectionDocument(name) {
  const root = document.getElementById(`${name}-section`);
  const selector = value => value.replace(/#([\w-]+)/g, `#${name}-$1`);
  return {
    getElementById: id => document.getElementById(`${name}-${id}`),
    querySelector: value => root.querySelector(selector(value)),
    querySelectorAll: value => root.querySelectorAll(selector(value)),
    createElement: tag => document.createElement(tag),
    addEventListener: (...args) => document.addEventListener(...args),
    get visibilityState() { return document.visibilityState; }
  };
}

let navigation = Promise.resolve();
function showSection(name, updateHistory = true) {
  navigation = navigation.then(async () => {
    if (!Object.hasOwn(sections, name)) name = null;
    if (name === activeSection) return;
    const previous = activeSection;
    if (previous) await sections[previous].leave();
    activeSection = name;
    for (const key of Object.keys(sections)) document.getElementById(`${key}-section`).hidden = key !== name;
    document.getElementById("launcher").hidden = Boolean(name);
    document.title = name ? name[0].toUpperCase() + name.slice(1) : "Cyclone";
    if (updateHistory) history.pushState(null, "", name ? `#${name}` : location.pathname + location.search);
    if (navigator.mediaSession) {
      try { navigator.mediaSession.setActionHandler("nexttrack", null); } catch (error) {}
    }
    if (name) sections[name].enter();
    else {
      document.getElementById(`open-${previous || "cyclone"}`).focus();
      document.body.style.background = "";
    }
    window.scrollTo(0, 0);
  });
  return navigation;
}


// Cyclone workout engine
(() => {
const document = sectionDocument("cyclone");

const FTMS = 0x1826, IBD = 0x2ad2;
const DISTANCE_KEY = "cyclone-typhoon-distances-v1";
const DISTANCE_MIGRATION_KEY = "cyclone-typhoon-distances-migrated-v1";
const $ = id => document.getElementById(id);

let device = null, char = null;
let connected = false;
let sessionActive = false;
let sessionDistanceM = 0;
let lastT = null;
let lastRawDistanceM = null;
let latestSpeed_kmh = 0;
let speakTimer = null;
let wakeLock = null;
let audioUrl = null;

async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
// Re-acquire if the page becomes visible again (lock is dropped on page hide)
document.addEventListener("visibilitychange", () => {
  if (sessionActive && document.visibilityState === "visible") acquireWakeLock();
});

function speak(text) {
  if (!text) return;
  const r = $("spoken");
  r.textContent = "";
  requestAnimationFrame(() => {
    r.textContent = text;
    // Clear after VoiceOver has had time to read it so it doesn't repeat on swipe
    clearTimeout(speakTimer);
    speakTimer = setTimeout(() => { r.textContent = ""; }, 6000);
  });
}

let lastBand = null;
function updateRpm(cadenceRpm) {
  const band = Math.round(cadenceRpm / 5) * 5;
  $("rpm-value").textContent = band;
  if (band !== lastBand) {
    lastBand = band;
    speak(`${band}`);
  }
}

function todayStr(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (e) { return []; }
}

function migrateDistanceHistory() {
  try {
    if (localStorage.getItem(DISTANCE_MIGRATION_KEY) === "1") return;
    const ledger = [];
    for (const [index, session] of parseStoredArray("cyclone-sessions").entries()) {
      const km = Number(session.km);
      if (km > 0 && /^\d{4}-\d{2}-\d{2}$/.test(session.date || "")) {
        ledger.push({ id: `cyclone-legacy-${index}`, source: "cyclone", endedAt: `${session.date}T12:00:00.000Z`, km });
      }
    }
    for (const [index, session] of parseStoredArray("typhoon-sessions-v1").entries()) {
      const km = Number(session.distanceKm);
      const endedAt = session.endedAt || "";
      if (session.completed && km > 0 && Number.isFinite(Date.parse(endedAt))) {
        ledger.push({ id: `typhoon-${session.id || index}`, source: "typhoon", endedAt, km });
      }
    }
    localStorage.setItem(DISTANCE_KEY, JSON.stringify(ledger));
    localStorage.setItem(DISTANCE_MIGRATION_KEY, "1");
  } catch (e) {}
}

function loadDistanceLedger() {
  migrateDistanceHistory();
  return parseStoredArray(DISTANCE_KEY);
}

function saveDistanceLedger(ledger) {
  try { localStorage.setItem(DISTANCE_KEY, JSON.stringify(ledger)); } catch (e) {}
}

function recordDistance(km) {
  if (!(km > 0)) return;
  const ledger = loadDistanceLedger();
  ledger.push({ id: `cyclone-${Date.now()}-${Math.random().toString(16).slice(2)}`, source: "cyclone", endedAt: new Date().toISOString(), km: Number(km.toFixed(3)) });
  saveDistanceLedger(ledger);
}

function recordSession(km) {
  recordDistance(km);
}

function computeStats() {
  const sessions = loadDistanceLedger();
  const now = Date.now();
  const today = todayStr();
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;
  const monthStart = now - 30 * 24 * 60 * 60 * 1000;
  let todayKm = 0, weekKm = 0, monthKm = 0, allKm = 0;
  for (const s of sessions) {
    const km = Number(s.km) || 0;
    const time = Date.parse(s.endedAt);
    allKm += km;
    if (Number.isFinite(time) && todayStr(new Date(time)) === today) todayKm += km;
    if (Number.isFinite(time) && time >= weekStart) weekKm += km;
    if (Number.isFinite(time) && time >= monthStart) monthKm += km;
  }
  return { todayKm, weekKm, monthKm, allKm };
}

function renderStats() {
  const { todayKm, weekKm, monthKm, allKm } = computeStats();
  $("stat-today").textContent   = `${todayKm.toFixed(2)} km`;
  $("stat-week").textContent    = `${weekKm.toFixed(2)} km`;
  $("stat-month").textContent   = `${monthKm.toFixed(2)} km`;
  $("stat-alltime").textContent = `${allKm.toFixed(2)} km`;
}

function parseBike(dv) {
  const flags = dv.getUint16(0, true); let o = 2; const out = {};
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const s16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const u24 = () => { const a = dv.getUint8(o), b = dv.getUint8(o+1), c = dv.getUint8(o+2); o += 3; return a|(b<<8)|(c<<16); };
  const u8  = () => { const v = dv.getUint8(o); o += 1; return v; };
  if (!(flags & 1))  out.speed_kmh   = u16() / 100;
  if (flags & 2)     u16();
  if (flags & 4)     out.cadence_rpm = u16() / 2;
  if (flags & 8)     u16();
  if (flags & 16)    out.distance_m  = u24();
  if (flags & 32)    s16();
  if (flags & 64)    out.power_w     = s16();
  if (flags & 128)   s16();
  if (flags & 256)   u16();
  if (flags & 512)   u8();
  return out;
}

function onData(e) {
  const m = parseBike(e.target.value);
  const now = performance.now() / 1000;
  if ("speed_kmh" in m) latestSpeed_kmh = m.speed_kmh;
  if (sessionActive && "cadence_rpm" in m) updateRpm(m.cadence_rpm);
  if ("distance_m" in m) {
    if (sessionActive && lastRawDistanceM !== null) {
      const delta = m.distance_m - lastRawDistanceM;
      if (delta >= 0) sessionDistanceM += delta;
    }
    lastRawDistanceM = m.distance_m;
  } else if (sessionActive) {
    const dt = lastT === null ? 0 : (now - lastT);
    if (dt > 0 && dt < 5) sessionDistanceM += (latestSpeed_kmh * 1000 / 3600) * dt;
  }
  lastT = now;
}

function setSessionUI() {
  sessionActive = true;
  acquireWakeLock();
  const btn = $("main-btn");
  btn.textContent = "Stop";
  btn.classList.add("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = false;
  lastBand = null;
  $("rpm-value").textContent = "0";
}

function setReadyUI() {
  sessionActive = false;
  releaseWakeLock();
  const btn = $("main-btn");
  btn.textContent = "Start";
  btn.classList.remove("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = true;
}

function setDisconnectedUI() {
  connected = false;
  sessionActive = false;
  releaseWakeLock();
  const btn = $("main-btn");
  btn.textContent = "Connect";
  btn.classList.remove("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = true;
}

function setInterruptedUI() {
  connected = false;
  const btn = $("main-btn");
  btn.textContent = "Stop";
  btn.classList.add("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = false;
}

function endSession() {
  const km = sessionDistanceM / 1000;
  recordSession(km);
  renderStats();
  speak(`Today: ${km.toFixed(2)} kilometres`);
}

let audioContext = null;
let startGeneration = 0;
let startingAudio = false;
let workoutMediaSource = null;
let workoutMediaGain = null;
const signalOscillators = new Set();
function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return true;
}
function cancelSignals() {
  for (const oscillator of signalOscillators) {
    try { oscillator.stop(); } catch (error) {}
  }
  signalOscillators.clear();
}
function setStartingAudio(value) {
  startingAudio = value;
  $("choose-audio-btn").disabled = value;
  $("play-btn").disabled = value;
}
function beep(frequency, durationSeconds, delaySeconds = 0) {
  if (!ensureAudioContext()) return;
  const oscillator = audioContext.createOscillator();
  const master = audioContext.createGain();
  const start = audioContext.currentTime + delaySeconds;
  const end = start + durationSeconds;
  oscillator.frequency.value = frequency;
  oscillator.type = "sine";
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(0.68, start + 0.03);
  master.gain.setValueAtTime(0.68, Math.max(start + 0.04, end - 0.08));
  master.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(master);
  master.connect(audioContext.destination);
  signalOscillators.add(oscillator);
  oscillator.onended = () => signalOscillators.delete(oscillator);
  oscillator.start(start);
  oscillator.stop(end + 0.02);
}

function finishSignal() {
  beep(330, 0.3);
  beep(660, 0.65, 0.36);
}


async function startWorkoutAudio() {
  const generation = ++startGeneration;
  const audio = $("workout-audio");
  setStartingAudio(true);
  $("audio-status").hidden = true;
  audio.pause();
  cancelSignals();
  // Start the media while the Start tap still grants playback permission.
  // Silence its Web Audio output rather than muting and restarting the element.
  let playbackFailed = false;
  if (audio.src) {
    if (ensureAudioContext() && !workoutMediaSource) {
      workoutMediaSource = audioContext.createMediaElementSource(audio);
      workoutMediaGain = audioContext.createGain();
      workoutMediaSource.connect(workoutMediaGain);
      workoutMediaGain.connect(audioContext.destination);
    }
    if (workoutMediaGain) workoutMediaGain.gain.setValueAtTime(0, audioContext.currentTime);
    audio.muted = !workoutMediaGain;
    audio.currentTime = 0;
    try {
      Promise.resolve(audio.play()).catch(() => { playbackFailed = true; });
    } catch (error) { playbackFailed = true; }
  }
  for (const delay of [0, 0.9, 1.8]) beep(500, 0.32, delay);
  beep(1000, 0.65, 2.7);
  await new Promise(resolve => setTimeout(resolve, 4400));
  if (generation !== startGeneration || !sessionActive) return;
  if (audio.src) audio.currentTime = 0;
  audio.muted = false;
  if (workoutMediaGain) workoutMediaGain.gain.setValueAtTime(1, audioContext.currentTime);
  setStartingAudio(false);
  // Usually already playing: do not require another delayed play permission.
  if (audio.src && (audio.paused || playbackFailed)) {
    try {
      await audio.play();
    } catch (error) {
      if (generation === startGeneration && sessionActive) {
        const message = "Workout audio could not start automatically. Tap Play to start it.";
        $("audio-status").textContent = message;
        $("audio-status").hidden = false;
        speak(message);
      }
    }
  }
}
function stopWorkoutAudio() {
  ++startGeneration;
  const audio = $("workout-audio");
  audio.pause();
  if (audio.src) audio.currentTime = 0;
  audio.muted = false;
  if (workoutMediaGain) workoutMediaGain.gain.setValueAtTime(1, audioContext.currentTime);
  setStartingAudio(false);
  cancelSignals();
  finishSignal();
}

async function startSession() {
  if (!connected || !device || !device.gatt || !device.gatt.connected) {
    setDisconnectedUI();
    return;
  }
  sessionDistanceM = 0;
  lastT = null;
  lastRawDistanceM = null;
  latestSpeed_kmh = 0;
  setSessionUI();
  await startWorkoutAudio();
}

async function connect() {
  $("main-btn").disabled = true;
  try { await Bike.connect(); }
  catch (error) {
    setDisconnectedUI();
    speak(navigator.bluetooth ? "Could not connect. Keep pedalling and tap Connect to try again." : "Web Bluetooth is unavailable in this browser.");
  }
}

function stop() {
  if (!sessionActive) return;
  stopWorkoutAudio();
  endSession();
  if (device && device.gatt && device.gatt.connected) setReadyUI();
  else setDisconnectedUI();
}

function onUnexpectedDisconnect() {
  char = null;
  connected = false;
  if (sessionActive) {
    setInterruptedUI();
    speak("Bike disconnected. Trying to reconnect.");
    // The shared connection owner retries without restarting this workout.
  } else {
    device = null;
    setDisconnectedUI();
  }
}

function leaveCyclone() { showSection(null); }

function resetData() {
  localStorage.removeItem("cyclone-sessions");
  saveDistanceLedger([]);
  localStorage.setItem(DISTANCE_MIGRATION_KEY, "1");
  renderStats();
  speak("All distance data cleared.");
}

function chooseWorkout() {
  if (startingAudio) return;
  $("audio-file").click();
}

function loadWorkout(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const audio = $("workout-audio");
  audio.pause();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(file);
  audio.src = audioUrl;
  audio.load();

  const playBtn = $("play-btn");
  playBtn.textContent = "Play";
  playBtn.hidden = false;
  playBtn.setAttribute("aria-label", `Play ${workoutName(file)}`);
}

function workoutName(file) {
  return file.name.replace(/\.mp3$/i, "");
}

async function togglePlayback() {
  if (startingAudio) return;
  const audio = $("workout-audio");
  const playBtn = $("play-btn");
  if (audio.paused) {
    try { await audio.play(); } catch (e) {}
  } else {
    audio.pause();
  }
}

function updatePlaybackButton() {
  const audio = $("workout-audio");
  const playBtn = $("play-btn");
  const file = $("audio-file").files && $("audio-file").files[0];
  const action = audio.paused ? "Play" : "Pause";
  if (!audio.paused) $("audio-status").hidden = true;
  playBtn.textContent = action;
  playBtn.setAttribute("aria-label", file ? `${action} ${workoutName(file)}` : action);
}

$("main-btn").addEventListener("click", () => {
  if (sessionActive) stop();
  else if (connected) startSession();
  else connect();
});
$("home-btn").addEventListener("click", leaveCyclone);
$("reset-btn").addEventListener("click", resetData);
$("choose-audio-btn").addEventListener("click", chooseWorkout);
$("audio-file").addEventListener("change", loadWorkout);
$("play-btn").addEventListener("click", togglePlayback);
$("workout-audio").addEventListener("play", updatePlaybackButton);
$("workout-audio").addEventListener("pause", updatePlaybackButton);
$("workout-audio").addEventListener("ended", updatePlaybackButton);
renderStats();


sections["cyclone"] = {
  data: onData,
  connection(chosen) {
    device = chosen;
    connected = true;
    lastT = null;
    lastRawDistanceM = null;
    if (sessionActive) setSessionUI(); else setReadyUI();
  },
  disconnected: onUnexpectedDisconnect,
  enter() {
    renderStats();
    if (Bike.isConnected()) this.connection(Bike.device); else setDisconnectedUI();
    $("main-btn").focus();
  },
  leave() {
    if (sessionActive) stop();
    ++startGeneration;
    $("workout-audio").pause();
    cancelSignals();
    clearTimeout(speakTimer);
    $("spoken").textContent = "";
    releaseWakeLock();
  }
};


})();

// Typhoon workout engine
(() => {
const document = sectionDocument("typhoon");


const FTMS = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const SESSION_KEY = "typhoon-sessions-v1";
const DISTANCE_KEY = "cyclone-typhoon-distances-v1";
const DISTANCE_MIGRATION_KEY = "cyclone-typhoon-distances-migrated-v1";
const DEVICE_KEY = "typhoon-device-name";
const LAST_START_KEY = "typhoon-last-start-track";
const LAST_WORKOUT_TRACKS_KEY = "typhoon-last-workout-tracks";
const WEIGHT_KEY = "typhoon-weight-kg";
const DEFAULT_WEIGHT_KG = 75;
const $ = id => document.getElementById(id);

const TRACKS = [
  { id: 28, bpm: 97, seconds: 124.907, file: "typhoon/audio/track-28-97-bpm.mp3?v=5" },
  { id: 1013, bpm: 97, seconds: 160.009, file: "typhoon/audio/track-more-13-97-bpm.mp3?v=5" },
  { id: 1,  bpm: 96, seconds: 176.965, file: "typhoon/audio/track-01-96-bpm.mp3?v=5" },
  { id: 2001, bpm: 96, seconds: 439.175, file: "typhoon/audio/track-even-01-96-bpm.mp3?v=5" },
  { id: 27, bpm: 95, seconds: 181.127, file: "typhoon/audio/track-27-95-bpm.mp3?v=5" },
  { id: 3,  bpm: 94, seconds: 277.321, file: "typhoon/audio/track-03-94-bpm.mp3?v=5" },
  { id: 3001, bpm: 94, seconds: 226.606, file: "typhoon/audio/track-yet-01-94-bpm.mp3?v=5" },
  { id: 3006, bpm: 94, seconds: 270.032, file: "typhoon/audio/track-yet-06-94-bpm.mp3?v=5" },
  { id: 13, bpm: 93, seconds: 213.917, file: "typhoon/audio/track-13-93-bpm.mp3?v=5" },
  { id: 1014, bpm: 93, seconds: 225.540, file: "typhoon/audio/track-more-14-93-bpm.mp3?v=5" },
  { id: 3004, bpm: 93, seconds: 258.210, file: "typhoon/audio/track-yet-04-93-bpm.mp3?v=5" },
  { id: 14, bpm: 92, seconds: 208.798, file: "typhoon/audio/track-14-92-bpm.mp3?v=5" },
  { id: 2003, bpm: 92, seconds: 168.385, file: "typhoon/audio/track-even-03-92-bpm.mp3?v=5" },
  { id: 3005, bpm: 92, seconds: 266.739, file: "typhoon/audio/track-yet-05-92-bpm.mp3?v=5" },
  { id: 16, bpm: 90, seconds: 242.776, file: "typhoon/audio/track-16-90-bpm.mp3?v=5" },
  { id: 26, bpm: 90, seconds: 185.949, file: "typhoon/audio/track-26-90-bpm.mp3?v=5" },
  { id: 3008, bpm: 90, seconds: 187.292, file: "typhoon/audio/track-yet-08-90-bpm.mp3?v=5" }
];

const RESULT_METRICS = [
  { key: "averagePowerW", label: "Average power", unit: "Watts", decimals: 0 },
  { key: "topPowerW", label: "Top power", unit: "Watts", decimals: 0 },
  { key: "averageWattsPerKg", label: "Average Watts per kilo", unit: "Watts per kilo", decimals: 2 },
  { key: "maximumWattsPerKg", label: "Maximum Watts per kilo", unit: "Watts per kilo", decimals: 2 },
  { key: "calories", label: "Calories", unit: "calories", decimals: 0 }
];

let device = null;
let dataCharacteristic = null;
let connected = false;
let wakeLock = null;
let audioContext = null;
let spokenTimer = null;
let lastCadenceBand = null;
let cadenceSpeechBlockedUntil = 0;
let previousTimerRemaining = 0;
let announcedTimeMilestones = new Set();
let lastDataTime = null;
let lastRawDistanceM = null;
let latest = { speedKph: 0, cadenceRpm: 0, powerW: 0, heartRate: 0 };

let workoutActive = false;
let startingWorkout = false;
let workoutGeneration = 0;
const signalOscillators = new Set();
function cancelSignals() {
  for (const oscillator of signalOscillators) { try { oscillator.stop(); } catch (error) {} }
  signalOscillators.clear();
}
let selectedDurationSeconds = 0;
let workoutStartPerformance = 0;
let workoutTimer = null;
let playbackPlan = [];
let playbackIndex = 0;
let heardTrackIds = [];
let activeMusicElement = null;
let standbyMusicElement = null;
let musicAdvancePending = false;
let currentWorkoutWeightKg = DEFAULT_WEIGHT_KG;
let resetConfirmationPending = false;
let resetConfirmationTimer = null;
let workoutMetrics = freshWorkoutMetrics();
let chosenMinutes = null;

function freshWorkoutMetrics() {
  return {
    distanceM: 0,
    sampleSeconds: 0,
    powerWeighted: 0,
    cadenceWeighted: 0,
    speedWeighted: 0,
    topPowerW: 0,
    topCadenceRpm: 0,
    topSpeedKph: 0,
    calories: 0,
    lastMetricTime: null
  };
}

function safeGet(key, fallback = null) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value; }
  catch (error) { return fallback; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch (error) {}
}
function loadWeightKg() {
  const weight = Number(safeGet(WEIGHT_KEY, String(DEFAULT_WEIGHT_KG)));
  return Number.isFinite(weight) && weight >= 30 && weight <= 250 ? weight : DEFAULT_WEIGHT_KG;
}
function loadSessions() {
  try {
    const parsed = JSON.parse(safeGet(SESSION_KEY, "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) { return []; }
}
function saveSessions(sessions) { safeSet(SESSION_KEY, JSON.stringify(sessions)); }

function parseStoredArray(key) {
  try {
    const value = JSON.parse(safeGet(key, "[]"));
    return Array.isArray(value) ? value : [];
  } catch (error) { return []; }
}

function migrateDistanceHistory() {
  if (safeGet(DISTANCE_MIGRATION_KEY, "") === "1") return;
  const ledger = [];
  for (const [index, session] of parseStoredArray("cyclone-sessions").entries()) {
    const km = Number(session.km);
    if (km > 0 && /^\d{4}-\d{2}-\d{2}$/.test(session.date || "")) {
      ledger.push({ id: `cyclone-legacy-${index}`, source: "cyclone", endedAt: `${session.date}T12:00:00.000Z`, km });
    }
  }
  for (const [index, session] of loadSessions().entries()) {
    const km = Number(session.distanceKm);
    const endedAt = session.endedAt || "";
    if (session.completed && km > 0 && Number.isFinite(Date.parse(endedAt))) {
      ledger.push({ id: `typhoon-${session.id || index}`, source: "typhoon", endedAt, km });
    }
  }
  safeSet(DISTANCE_KEY, JSON.stringify(ledger));
  safeSet(DISTANCE_MIGRATION_KEY, "1");
}

function loadDistanceLedger() {
  migrateDistanceHistory();
  return parseStoredArray(DISTANCE_KEY);
}

function saveDistanceLedger(ledger) { safeSet(DISTANCE_KEY, JSON.stringify(ledger)); }

function recordCombinedDistance(result) {
  const km = Number(result.distanceKm);
  if (!(km > 0)) return;
  const id = `typhoon-${result.id}`;
  const ledger = loadDistanceLedger();
  if (ledger.some(entry => entry.id === id)) return;
  ledger.push({ id, source: "typhoon", endedAt: result.endedAt, km });
  saveDistanceLedger(ledger);
}

function resetCombinedDistances() {
  saveDistanceLedger([]);
  safeSet(DISTANCE_MIGRATION_KEY, "1");
  try { localStorage.removeItem("cyclone-sessions"); } catch (error) {}
}

function speak(text) {
  if (!text) return;
  const region = $("spoken");
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = text;
    clearTimeout(spokenTimer);
    spokenTimer = setTimeout(() => { region.textContent = ""; }, 10000);
  });
}

function setConnectionStatus() {}

function selectedMinutes() {
  return chosenMinutes;
}

function setSetupEnabled(enabled) {
  for (const button of document.querySelectorAll(".duration-choice")) button.disabled = !enabled;
  $("main-action").disabled = !enabled;
}

function updateMainAction() {
  const button = $("main-action");
  button.hidden = chosenMinutes === null || !$("results-section").hidden;
  if (button.hidden) return;
  button.textContent = workoutActive ? "Stop" : connected ? "Start" : "Connect";
  button.removeAttribute("aria-label");
}

function chooseDuration(event) {
  // Warm the audio route on this early user gesture so Start is immediate.
  warmAudioOutput();
  chosenMinutes = Number(event.currentTarget.dataset.minutes);
  $("duration-grid").hidden = true;
  updateMainAction();
  $("main-action").focus();
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const random = globalThis.crypto && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296
      : Math.random();
    const other = Math.floor(random * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function loadLastWorkoutTrackIds() {
  try {
    const ids = JSON.parse(safeGet(LAST_WORKOUT_TRACKS_KEY, "[]"));
    return Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
  } catch (error) { return []; }
}

function selectStartingIndex(workoutSeconds, candidates) {
  const minutes = Math.round(workoutSeconds / 60);
  const candidateIds = candidates.map(index => TRACKS[index].id).join("-");
  const key = `typhoon-start-bag-v2-${minutes}-${candidateIds}`;
  let bag;
  try { bag = JSON.parse(safeGet(key, "[]")); } catch (error) { bag = []; }
  if (!Array.isArray(bag)) bag = [];
  bag = bag.filter(index => candidates.includes(index));
  if (!bag.length) bag = shuffle(candidates);

  const lastTrackId = Number(safeGet(LAST_START_KEY, "-1"));
  if (bag.length > 1 && TRACKS[bag[0]].id === lastTrackId) [bag[0], bag[1]] = [bag[1], bag[0]];

  const startingIndex = bag.shift();
  safeSet(key, JSON.stringify(bag));
  safeSet(LAST_START_KEY, String(TRACKS[startingIndex].id));
  return startingIndex;
}

function createPlaybackPlan(workoutSeconds) {
  const previousTrackIds = new Set(loadLastWorkoutTrackIds());
  let candidates = TRACKS.map((track, index) => ({ track, index }))
    .filter(({ track }) => !previousTrackIds.has(track.id))
    .map(({ index }) => index);
  if (!candidates.length) candidates = TRACKS.map((track, index) => index);

  const startingIndex = selectStartingIndex(workoutSeconds, candidates);
  let candidatePosition = candidates.indexOf(startingIndex);
  const plan = [];
  let remaining = workoutSeconds;
  while (remaining > 0.1) {
    const index = candidates[candidatePosition];
    const track = TRACKS[index];
    const playFor = Math.min(track.seconds, remaining);
    plan.push({ ...track, playFor });
    remaining -= playFor;
    candidatePosition = (candidatePosition + 1) % candidates.length;
  }
  return plan;
}

function durationText(seconds) {
  const rounded = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function kilometresText(km) { return `${km.toFixed(2)} kilometres`; }

async function acquireWakeLock() {
  if (!navigator.wakeLock || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (error) {}
}
async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch (error) {}
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (workoutActive && document.visibilityState === "visible") acquireWakeLock();
});

function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return true;
}

function warmAudioOutput() {
  if (!ensureAudioContext()) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  oscillator.frequency.value = 220;
  oscillator.type = "sine";
  gain.gain.setValueAtTime(0.0008, now);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.7);
}

function beep(frequency, durationSeconds, delaySeconds = 0) {
  if (!ensureAudioContext()) return;
  const oscillator = audioContext.createOscillator();
  const master = audioContext.createGain();
  const start = audioContext.currentTime + delaySeconds;
  const end = start + durationSeconds;
  oscillator.frequency.value = frequency;
  oscillator.type = "sine";
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(0.68, start + 0.03);
  master.gain.setValueAtTime(0.68, Math.max(start + 0.04, end - 0.08));
  master.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(master);
  master.connect(audioContext.destination);
  signalOscillators.add(oscillator);
  oscillator.onended = () => signalOscillators.delete(oscillator);
  oscillator.start(start);
  oscillator.stop(end + 0.02);
}

function finishSignal() {
  beep(330, 0.3);
  beep(660, 0.65, 0.36);
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function runCountdown(generation) {
  $("setup-section").hidden = true;
  $("results-section").hidden = true;
  $("countdown-section").hidden = false;
  for (const number of [3, 2, 1]) {
    $("countdown").textContent = String(number);
    beep(500, 0.32);
    await wait(900);
    if (generation !== workoutGeneration) return;
  }
  $("countdown").textContent = "Go";
  beep(1000, 0.65);
  // Leave a full second of silence after the final tone before music begins.
  await wait(1700);
}

async function unlockMusic(firstTrack, generation) {
  activeMusicElement = $("music");
  standbyMusicElement = $("music-preload");
  activeMusicElement.pause();
  activeMusicElement.src = firstTrack.file;
  activeMusicElement.load();
  activeMusicElement.muted = true;
  try {
    await activeMusicElement.play();
    if (generation !== workoutGeneration) return;
    activeMusicElement.pause();
    activeMusicElement.currentTime = 0;
  } catch (error) {}

  // This element warms the browser cache only. It must never create a second media session.
  standbyMusicElement.pause();
  standbyMusicElement.muted = true;
  const next = playbackPlan[1];
  if (next) {
    standbyMusicElement.src = next.file;
    standbyMusicElement.load();
  }
}

function unmuteMusic() {
  if (standbyMusicElement) {
    standbyMusicElement.pause();
    standbyMusicElement.muted = true;
  }
  if (activeMusicElement) activeMusicElement.muted = false;
}

function preloadFollowingTrack() {
  const next = playbackPlan[playbackIndex + 1];
  if (!standbyMusicElement) return;
  if (!next) { standbyMusicElement.removeAttribute("src"); return; }
  if (!standbyMusicElement.src.endsWith(next.file)) {
    standbyMusicElement.src = next.file;
    standbyMusicElement.load();
  }
}

async function playCurrentTrack() {
  if (!workoutActive) return;
  const track = playbackPlan[playbackIndex];
  if (!track) return;
  const music = activeMusicElement || $("music");
  if (!music.src.endsWith(track.file)) {
    music.src = track.file;
    music.load();
  } else if (music.ended) {
    music.currentTime = 0;
  }
  preloadFollowingTrack();
  try {
    await music.play();
    if (!heardTrackIds.includes(track.id)) heardTrackIds.push(track.id);
  }
  catch (error) { speak("Music could not start. The workout timer is still running."); }
}

function nextEligibleTrackAfter(trackId) {
  const previousTrackIds = new Set(loadLastWorkoutTrackIds());
  let candidates = TRACKS.filter(track => !previousTrackIds.has(track.id));
  if (!candidates.length) candidates = TRACKS;
  const currentPosition = candidates.findIndex(track => track.id === trackId);
  return candidates[(currentPosition + 1 + candidates.length) % candidates.length];
}

function nextUnheardTrackAfter(trackId) {
  const currentPosition = TRACKS.findIndex(track => track.id === trackId);
  const ordered = [
    ...TRACKS.slice(currentPosition + 1),
    ...TRACKS.slice(0, currentPosition + 1)
  ];
  return ordered.find(track => !heardTrackIds.includes(track.id)) || ordered[0];
}

async function advanceMusic(includeAllTracks = false) {
  if (!workoutActive || !activeMusicElement || musicAdvancePending) return;
  musicAdvancePending = true;
  $("next-song").disabled = true;
  try {
    activeMusicElement.pause();
    let nextIndex = playbackIndex + 1;
    if (includeAllTracks) {
      while (nextIndex < playbackPlan.length && heardTrackIds.includes(playbackPlan[nextIndex].id)) nextIndex++;
    }
    if (nextIndex >= playbackPlan.length) {
      const currentTrackId = playbackPlan[playbackIndex].id;
      const next = includeAllTracks ? nextUnheardTrackAfter(currentTrackId) : nextEligibleTrackAfter(currentTrackId);
      playbackPlan.push({ ...next, playFor: next.seconds });
      nextIndex = playbackPlan.length - 1;
    }
    playbackIndex = nextIndex;
    await playCurrentTrack();
  } finally {
    musicAdvancePending = false;
    $("next-song").disabled = false;
  }
}

function onMusicEnded(event) {
  if (!workoutActive || event.currentTarget !== activeMusicElement) return;
  advanceMusic();
}

function configureMediaControls() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler("nexttrack", () => advanceMusic(true));
  } catch (error) {}
}

async function startWorkout() {
  if (!connected || workoutActive || startingWorkout) return;
  const generation = ++workoutGeneration;
  startingWorkout = true;
  currentWorkoutWeightKg = loadWeightKg();
  selectedDurationSeconds = selectedMinutes() * 60;
  playbackPlan = createPlaybackPlan(selectedDurationSeconds);
  playbackIndex = 0;
  heardTrackIds = [];
  ensureAudioContext();
  await unlockMusic(playbackPlan[0], generation);
  if (generation !== workoutGeneration) return;
  setSetupEnabled(false);
  await acquireWakeLock();
  if (generation !== workoutGeneration) { await releaseWakeLock(); return; }
  await runCountdown(generation);
  if (generation !== workoutGeneration) return;
  startingWorkout = false;
  unmuteMusic();

  workoutMetrics = freshWorkoutMetrics();
  workoutMetrics.lastMetricTime = performance.now() / 1000;
  lastCadenceBand = null;
  cadenceSpeechBlockedUntil = 0;
  selectedDurationSeconds = selectedMinutes() * 60;
  previousTimerRemaining = selectedDurationSeconds;
  announcedTimeMilestones = new Set();
  workoutStartPerformance = performance.now();
  workoutActive = true;
  updateMainAction();
  $("main-action").disabled = false;
  $("countdown-section").hidden = true;
  $("workout-section").hidden = false;
  $("workout-clock").textContent = durationText(selectedDurationSeconds);
  $("countdown-message").textContent = "";
  $("countdown-message").hidden = true;
  updateLiveDisplay();
  await playCurrentTrack();
  if (generation !== workoutGeneration || !workoutActive) return;
  setConnectionStatus("Workout running. Keep pedalling.");
  speak("Go.");
  workoutTimer = setInterval(updateWorkoutTimer, 100);
}

function updateWorkoutTimer() {
  if (!workoutActive) return;
  const elapsed = (performance.now() - workoutStartPerformance) / 1000;
  const remaining = selectedDurationSeconds - elapsed;
  $("workout-clock").textContent = durationText(remaining);
  $("workout-clock").setAttribute("aria-label", `${Math.max(0, Math.ceil(remaining))} seconds remaining`);
  if (remaining <= 0) {
    finishWorkout(true, "Workout completed.");
    return;
  }
  const crossed = timeMilestones().filter(milestone =>
    !announcedTimeMilestones.has(milestone.seconds) &&
    previousTimerRemaining > milestone.seconds &&
    remaining <= milestone.seconds
  );
  if (crossed.length) {
    const milestone = crossed[crossed.length - 1];
    announcedTimeMilestones.add(milestone.seconds);
    announceTimeMilestone(milestone.text);
  }
  previousTimerRemaining = remaining;
}

function timeMilestones() {
  const milestones = [];
  for (let minutes = selectedDurationSeconds / 60 - 1; minutes >= 1; minutes--) {
    milestones.push({
      seconds: minutes * 60,
      text: `${minutes} minute${minutes === 1 ? "" : "s"} remaining.`
    });
  }
  milestones.push(
    { seconds: 30, text: "30 seconds left." },
    { seconds: 20, text: "20 seconds." },
    { seconds: 10, text: "10 seconds." },
    { seconds: 5, text: "5" },
    { seconds: 4, text: "4" },
    { seconds: 3, text: "3" },
    { seconds: 2, text: "2" },
    { seconds: 1, text: "1" }
  );
  return milestones.sort((first, second) => second.seconds - first.seconds);
}

function announceTimeMilestone(text) {
  const message = $("countdown-message");
  message.textContent = text;
  message.hidden = false;
  cadenceSpeechBlockedUntil = performance.now() + 3500;
  speak(text);
}

function resultFromMetrics(completed) {
  const sampleSeconds = workoutMetrics.sampleSeconds || 1;
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    completed,
    durationMinutes: selectedDurationSeconds / 60,
    durationSeconds: completed ? selectedDurationSeconds : Math.max(0, (performance.now() - workoutStartPerformance) / 1000),
    endedAt: new Date().toISOString(),
    distanceKm: workoutMetrics.distanceM / 1000,
    averagePowerW: workoutMetrics.powerWeighted / sampleSeconds,
    topPowerW: workoutMetrics.topPowerW,
    weightKg: currentWorkoutWeightKg,
    averageWattsPerKg: (workoutMetrics.powerWeighted / sampleSeconds) / currentWorkoutWeightKg,
    maximumWattsPerKg: workoutMetrics.topPowerW / currentWorkoutWeightKg,
    averageCadenceRpm: workoutMetrics.cadenceWeighted / sampleSeconds,
    topCadenceRpm: workoutMetrics.topCadenceRpm,
    averageSpeedKph: workoutMetrics.speedWeighted / sampleSeconds,
    topSpeedKph: workoutMetrics.topSpeedKph,
    calories: workoutMetrics.calories,
    startingTrackId: playbackPlan[0] ? playbackPlan[0].id : null,
    startingBpm: playbackPlan[0] ? playbackPlan[0].bpm : null,
    tracksHeard: [...heardTrackIds]
  };
}

function roundedMetric(metric, value) { return Number(value).toFixed(metric.decimals); }
function metricValueText(metric, value) { return `${roundedMetric(metric, value)} ${metric.unit}`; }

function differenceText(metric, amount) {
  const absolute = Math.abs(amount);
  const number = roundedMetric(metric, absolute);
  return `${number} ${metric.unit}`;
}

function metricNumber(metric, session) {
  const stored = Number(session[metric.key]);
  if (Number.isFinite(stored)) return stored;
  const weight = Number(session.weightKg) > 0 ? Number(session.weightKg) : DEFAULT_WEIGHT_KG;
  if (metric.key === "averageWattsPerKg") return (Number(session.averagePowerW) || 0) / weight;
  if (metric.key === "maximumWattsPerKg") return (Number(session.topPowerW) || 0) / weight;
  return 0;
}

function comparisonFor(metric, result, earlier) {
  const value = metricNumber(metric, result);
  if (!earlier.length) {
    return `${metric.label}: ${metricValueText(metric, value)}. First recorded result for this workout. Personal best for ${result.durationMinutes} minutes.`;
  }

  const average = earlier.reduce((sum, session) => sum + metricNumber(metric, session), 0) / earlier.length;
  const best = Math.max(...earlier.map(session => metricNumber(metric, session)));
  const tolerance = 0.5 * Math.pow(10, -metric.decimals);
  const versusAverage = value - average;
  let averageClause;
  if (Math.abs(versusAverage) <= tolerance) averageClause = "the same as your average";
  else if (versusAverage > 0) averageClause = `${differenceText(metric, versusAverage)} above your average`;
  else averageClause = `${differenceText(metric, versusAverage)} below your average`;

  const pb = value > best + tolerance;
  return `${metric.label}: ${metricValueText(metric, value)}, ${averageClause}.${pb ? ` New personal best for ${result.durationMinutes} minutes.` : ""}`;
}

function renderResults(result, earlier) {
  $("results-section").hidden = false;
  const list = $("comparison-list");
  list.innerHTML = "";
  const comparisons = [];
  if (result.completed) {
    for (const metric of RESULT_METRICS) {
      const text = comparisonFor(metric, result, earlier);
      comparisons.push(text);
      const item = document.createElement("li");
      item.textContent = text;
      if (/personal best/i.test(text)) item.classList.add("pb");
      list.append(item);
    }
  } else {
    const item = document.createElement("li");
    item.textContent = "Complete the selected duration to receive comparisons and personal-best results.";
    list.append(item);
  }

  const stats = computeDistanceStats();
  const distanceSpeech = `Distance travelled: ${kilometresText(result.distanceKm)}. Last 7 days: ${kilometresText(stats.weekKm)}. Last 30 days: ${kilometresText(stats.monthKm)}. All time: ${kilometresText(stats.allKm)}.`;
  const intro = result.completed ? `${result.durationMinutes} minute workout completed.` : "Workout ended early.";
  speak([intro, ...comparisons, distanceSpeech].join(" "));
  $("results-heading").focus();
}

async function finishWorkout(completed, statusText) {
  if (!workoutActive) return;
  const generation = ++workoutGeneration;
  workoutActive = false;
  updateMainAction();
  $("main-action").disabled = true;
  clearInterval(workoutTimer);
  workoutTimer = null;
  $("music").pause();
  $("music-preload").pause();
  safeSet(LAST_WORKOUT_TRACKS_KEY, JSON.stringify(heardTrackIds));
  $("workout-section").hidden = true;
  const result = resultFromMetrics(completed);
  const sessions = loadSessions();
  const earlier = sessions.filter(session => session.completed && session.durationMinutes === result.durationMinutes);
  if (completed) {
    sessions.push(result);
    saveSessions(sessions);
    recordCombinedDistance(result);
  }
  if (completed) { finishSignal(); await wait(1100); }
  await releaseWakeLock();
  if (generation !== workoutGeneration) return;
  renderDistanceStats(result.distanceKm);
  renderResults(result, earlier);
  $("distance-section").hidden = false;
  $("post-workout-actions").hidden = false;
  setConnectionStatus(statusText);
  updateMainAction();
}

function updateLiveDisplay() {
  $("live-cadence-value").textContent = String(Math.round(latest.cadenceRpm));
  $("distance-workout").textContent = kilometresText(workoutMetrics.distanceM / 1000);
}

function updateCadenceSpeech(cadenceRpm) {
  if (!workoutActive) return;
  const now = performance.now();
  const remaining = selectedDurationSeconds - (now - workoutStartPerformance) / 1000;
  if (remaining <= 32.5 || now < cadenceSpeechBlockedUntil) return;
  const approachingMinute = timeMilestones().some(milestone =>
    milestone.seconds >= 60 && remaining > milestone.seconds && remaining <= milestone.seconds + 2.5
  );
  if (approachingMinute) return;
  const band = Math.round(cadenceRpm / 5) * 5;
  if (band !== lastCadenceBand) {
    lastCadenceBand = band;
    speak(String(band));
  }
}

function parseBike(dataView) {
  const flags = dataView.getUint16(0, true);
  let offset = 2;
  const output = {};
  const u8 = () => { const value = dataView.getUint8(offset); offset += 1; return value; };
  const u16 = () => { const value = dataView.getUint16(offset, true); offset += 2; return value; };
  const s16 = () => { const value = dataView.getInt16(offset, true); offset += 2; return value; };
  const u24 = () => { const value = dataView.getUint8(offset) | (dataView.getUint8(offset + 1) << 8) | (dataView.getUint8(offset + 2) << 16); offset += 3; return value; };
  if (!(flags & 1)) output.speedKph = u16() / 100;
  if (flags & 2) u16();
  if (flags & 4) output.cadenceRpm = u16() / 2;
  if (flags & 8) u16();
  if (flags & 16) output.distanceM = u24();
  if (flags & 32) s16();
  if (flags & 64) output.powerW = s16();
  if (flags & 128) s16();
  if (flags & 256) {
    output.energyKcal = u16();
    u16();
    u8();
  }
  if (flags & 512) output.heartRate = u8();
  return output;
}

function onBikeData(event) {
  let measurement;
  try { measurement = parseBike(event.target.value); }
  catch (error) { return; }
  const now = performance.now() / 1000;
  const dataDelta = lastDataTime === null ? 0 : now - lastDataTime;
  lastDataTime = now;

  if ("speedKph" in measurement) latest.speedKph = measurement.speedKph;
  if ("cadenceRpm" in measurement) {
    latest.cadenceRpm = measurement.cadenceRpm;
    updateCadenceSpeech(latest.cadenceRpm);
  }
  if ("powerW" in measurement) latest.powerW = Math.max(0, measurement.powerW);
  if ("heartRate" in measurement) latest.heartRate = measurement.heartRate;

  if ("distanceM" in measurement) {
    if (workoutActive && lastRawDistanceM !== null) {
      let delta = measurement.distanceM - lastRawDistanceM;
      if (delta < 0) delta = measurement.distanceM;
      if (delta >= 0 && delta < 100) workoutMetrics.distanceM += delta;
    }
    lastRawDistanceM = measurement.distanceM;
  } else if (workoutActive && dataDelta > 0 && dataDelta < 3) {
    workoutMetrics.distanceM += latest.speedKph * 1000 / 3600 * dataDelta;
  }

  if (workoutActive) {
    const metricDelta = workoutMetrics.lastMetricTime === null ? 0 : now - workoutMetrics.lastMetricTime;
    workoutMetrics.lastMetricTime = now;
    if (metricDelta > 0 && metricDelta < 3) {
      workoutMetrics.sampleSeconds += metricDelta;
      workoutMetrics.powerWeighted += latest.powerW * metricDelta;
      workoutMetrics.cadenceWeighted += latest.cadenceRpm * metricDelta;
      workoutMetrics.speedWeighted += latest.speedKph * metricDelta;
      workoutMetrics.calories += latest.powerW * metricDelta / 4184 / 0.24;
    }
    workoutMetrics.topPowerW = Math.max(workoutMetrics.topPowerW, latest.powerW);
    workoutMetrics.topCadenceRpm = Math.max(workoutMetrics.topCadenceRpm, latest.cadenceRpm);
    workoutMetrics.topSpeedKph = Math.max(workoutMetrics.topSpeedKph, latest.speedKph);
    updateLiveDisplay();
  }
}

function reportConnectionError(error) {
  const name = error && error.name ? error.name : "Error";
  const message = error && error.message ? error.message : String(error);
  if (name === "NotFoundError") setConnectionStatus("No bike was selected. Keep pedalling and try again.");
  else if (name === "SecurityError") setConnectionStatus("Bluetooth was blocked. Open Typhoon over HTTPS in a Web Bluetooth browser.");
  else setConnectionStatus(`Could not connect: ${message}`);
}

async function connect() {
  $("main-action").disabled = true;
  try { await Bike.connect(); }
  catch (error) {
    connected = false;
    if (!navigator.bluetooth) $("unsupported").hidden = false;
    reportConnectionError(error);
    setSetupEnabled(true);
    updateMainAction();
  }
}

function onDisconnected() {
  connected = false;
  device = null;
  dataCharacteristic = null;
  ++workoutGeneration;
  startingWorkout = false;
  cancelSignals();
  if (workoutActive) finishWorkout(false, "The bike disconnected. The incomplete workout was not saved.");
  else { setSetupEnabled(true); updateMainAction(); }
}

function computeDistanceStats() {
  const sessions = loadDistanceLedger();
  const now = Date.now();
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;
  const monthStart = now - 30 * 24 * 60 * 60 * 1000;
  let weekKm = 0;
  let monthKm = 0;
  let allKm = 0;
  for (const session of sessions) {
    const km = Number(session.km) || 0;
    const time = Date.parse(session.endedAt);
    allKm += km;
    if (Number.isFinite(time) && time >= weekStart) weekKm += km;
    if (Number.isFinite(time) && time >= monthStart) monthKm += km;
  }
  return { weekKm, monthKm, allKm };
}

function renderDistanceStats(currentWorkoutKm = 0) {
  const stats = computeDistanceStats();
  $("distance-workout").textContent = kilometresText(currentWorkoutKm);
  $("distance-week").textContent = kilometresText(stats.weekKm);
  $("distance-month").textContent = kilometresText(stats.monthKm);
  $("distance-all").textContent = kilometresText(stats.allKm);
}

function anotherWorkout() {
  cancelResetConfirmation();
  closeWeightEditor(false);
  chosenMinutes = null;
  $("duration-grid").hidden = false;
  $("results-section").hidden = true;
  $("distance-section").hidden = true;
  $("post-workout-actions").hidden = true;
  $("setup-section").hidden = false;
  setSetupEnabled(true);
  updateMainAction();
  document.querySelector(".duration-choice").focus();
}

function resetHistory() {
  if (!resetConfirmationPending) {
    resetConfirmationPending = true;
    $("reset-history").textContent = "Confirm reset all data";
    speak("Tap again to confirm reset all data.");
    clearTimeout(resetConfirmationTimer);
    resetConfirmationTimer = setTimeout(cancelResetConfirmation, 7000);
    return;
  }
  cancelResetConfirmation();
  try { localStorage.removeItem(SESSION_KEY); } catch (error) {}
  for (const minutes of [3, 5, 8, 10]) {
    try { localStorage.removeItem(`typhoon-start-bag-${minutes}`); } catch (error) {}
  }
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && key.startsWith("typhoon-start-bag-v2-")) localStorage.removeItem(key);
    }
  } catch (error) {}
  try { localStorage.removeItem(LAST_START_KEY); } catch (error) {}
  try { localStorage.removeItem(LAST_WORKOUT_TRACKS_KEY); } catch (error) {}
  resetCombinedDistances();
  renderDistanceStats(0);
  speak("All Typhoon workout history and combined distance data have been cleared.");
}

function cancelResetConfirmation() {
  resetConfirmationPending = false;
  clearTimeout(resetConfirmationTimer);
  resetConfirmationTimer = null;
  $("reset-history").textContent = "Reset all data";
}

function openWeightEditor() {
  cancelResetConfirmation();
  const input = $("weight-kg-input");
  input.value = String(loadWeightKg());
  input.setCustomValidity("");
  $("update-weight").hidden = true;
  $("weight-editor").hidden = false;
  input.focus();
}

function closeWeightEditor(restoreFocus = true) {
  $("weight-editor").hidden = true;
  $("update-weight").hidden = false;
  if (restoreFocus) $("update-weight").focus();
}

function saveWeight(event) {
  event.preventDefault();
  const input = $("weight-kg-input");
  const weight = Number(String(input.value).trim().replace(",", "."));
  if (!Number.isFinite(weight) || weight < 30 || weight > 250) {
    input.setCustomValidity("Enter a weight between 30 and 250 kilograms.");
    input.reportValidity();
    input.focus();
    return;
  }
  input.setCustomValidity("");
  safeSet(WEIGHT_KEY, String(weight));
  closeWeightEditor();
  speak(`Weight updated to ${weight} kilograms. It will be used for future workouts.`);
}

function init() {
  $("home-btn").addEventListener("click", () => { showSection(null); });
  for (const button of document.querySelectorAll(".duration-choice")) button.addEventListener("click", chooseDuration);
  $("main-action").addEventListener("click", () => {
    if (workoutActive) finishWorkout(false, "Workout ended early. The incomplete result was not saved.");
    else if (connected) startWorkout();
    else connect();
  });
  $("next-song").addEventListener("click", () => advanceMusic(true));
  $("another-workout").addEventListener("click", anotherWorkout);
  $("reset-history").addEventListener("click", resetHistory);
  $("update-weight").addEventListener("click", openWeightEditor);
  $("weight-editor").addEventListener("submit", saveWeight);
  $("cancel-weight").addEventListener("click", () => closeWeightEditor());
  for (const element of [$("music"), $("music-preload")]) {
    element.addEventListener("ended", onMusicEnded);
    element.addEventListener("error", () => {
      if (workoutActive) speak("The next music track could not be loaded. The workout timer will continue.");
    });
  }

  if (!navigator.bluetooth) $("unsupported").hidden = false;
  renderDistanceStats(0);
  updateMainAction();

}

init();

sections.typhoon = {
  data: onBikeData,
  connection(chosen) {
    device = chosen;
    connected = true;
    lastDataTime = null;
    lastRawDistanceM = null;
    lastCadenceBand = null;
    if (!startingWorkout && !workoutActive) setSetupEnabled(true);
    updateMainAction();
  },
  disconnected: onDisconnected,
  enter() {
    renderDistanceStats(0);
    if (Bike.isConnected()) this.connection(Bike.device);
    configureMediaControls();
    document.querySelector(".duration-choice").focus();
  },
  async leave() {
    ++workoutGeneration;
    startingWorkout = false;
    cancelSignals();
    if (workoutActive) await finishWorkout(false, "Workout ended early.");
    ++workoutGeneration;
    $("music").pause();
    $("music-preload").pause();
    clearInterval(workoutTimer);
    clearTimeout(spokenTimer);
    $("spoken").textContent = "";
    await releaseWakeLock();
    $("countdown-section").hidden = true;
    $("workout-section").hidden = true;
    anotherWorkout();
  }
};

})();

// Mistral workout engine
(() => {
const document = sectionDocument("mistral");

const FTMS = 0x1826, IBD = 0x2ad2;
const DISTANCE_KEY = "cyclone-typhoon-distances-v1";
const DISTANCE_MIGRATION_KEY = "cyclone-typhoon-distances-migrated-v1";
const $ = id => document.getElementById(id);

let unit = "miles";
let targetDistance = null;
let nextMilestone = 0.5;
let announcedFinishDistances = new Set();
let sessionStartedAt = null;
let resultAnnouncementTimer = null;
let cadenceTimer = null;
const metresPerUnit = () => unit === "miles" ? 1609.344 : 1000;
const unitLabel = () => unit === "miles" ? "miles" : "km";
const spokenUnit = () => unit === "miles" ? "miles" : "kilometres";
const distanceText = km => `${(km * 1000 / metresPerUnit()).toFixed(2)} ${unitLabel()}`;

function renderProgress() {
  const travelled = (sessionDistanceM / metresPerUnit()).toFixed(1).replace(/\.0$/, "");
  const suffix = unit === "miles" ? " miles" : "K";
  $("distance-progress").textContent = `Distance: ${travelled}${suffix} of ${targetDistance}${suffix}`;
}
function chooseDistance(value) {
  clearTimeout(resultAnnouncementTimer);
  $("results-section").hidden = true;
  targetDistance = value;
  sessionDistanceM = 0;
  $("distance-setup").hidden = true;
  $("workout-screen").hidden = false;
  renderProgress();
  renderStats();
  $("main-btn").focus();
}
function updateDistance() {
  const travelled = sessionDistanceM / metresPerUnit();
  renderProgress();
  if (travelled >= targetDistance) {
    stop();
    return;
  }
  let announcement = null;
  while (travelled >= nextMilestone) {
    const remaining = targetDistance - nextMilestone;
    const down = unit === "miles" ? `${nextMilestone} miles` : `${nextMilestone}K`;
    const toGo = unit === "miles" && remaining === 0.5 ? "half a mile" : `${remaining}`;
    announcement = `${down} down, ${toGo} to go.`;
    nextMilestone += 0.5;
  }
  const remainingMetres = targetDistance * metresPerUnit() - sessionDistanceM;
  for (const distance of [200, 100, 50]) {
    const thresholdMetres = unit === "miles" ? distance * 0.9144 : distance;
    if (remainingMetres <= thresholdMetres + 1e-6 && !announcedFinishDistances.has(distance)) {
      announcedFinishDistances.add(distance);
      announcement = `${distance} ${unit === "miles" ? "yards" : "metres"} to go.`;
    }
  }
  // If a packet crosses more than one threshold, announce the closest current
  // marker once, rather than interrupting it with outdated messages.
  if (announcement) speak(announcement);
}

let device = null, char = null;
let connected = false;
let sessionActive = false;
let sessionDistanceM = 0;
let lastT = null;
let lastRawDistanceM = null;
let latestSpeed_kmh = 0;
let speakTimer = null;
let speakUpdateTimer = null;
let cadenceBlockedUntil = 0;
let wakeLock = null;
let audioUrl = null;

async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
// Re-acquire if the page becomes visible again (lock is dropped on page hide)
document.addEventListener("visibilitychange", () => {
  if (sessionActive && document.visibilityState === "visible") acquireWakeLock();
});

function speak(text) {
  if (!text) return;
  // Keep cadence quiet while VoiceOver receives and reads a priority message.
  cadenceBlockedUntil = performance.now() + 8000;
  clearTimeout(cadenceTimer);
  $("cadence-spoken").textContent = "";
  const r = $("spoken");
  clearTimeout(speakTimer);
  clearTimeout(speakUpdateTimer);
  r.textContent = "";
  // A separate task gives the accessibility tree time to register the empty
  // region, including before the very first distance announcement.
  speakUpdateTimer = setTimeout(() => {
    r.textContent = text;
    speakTimer = setTimeout(() => { r.textContent = ""; }, 8000);
  }, 100);
}

let lastBand = null;
function updateRpm(cadenceRpm) {
  const band = Math.round(cadenceRpm / 5) * 5;
  $("rpm-value").textContent = band;
  if (band !== lastBand) {
    lastBand = band;
    if (performance.now() < cadenceBlockedUntil) return;
    const region = $("cadence-spoken");
    region.textContent = "";
    clearTimeout(cadenceTimer);
    cadenceTimer = setTimeout(() => { if (sessionActive && performance.now() >= cadenceBlockedUntil) region.textContent = `${band}`; }, 150);
  }
}

function todayStr(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseStoredArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (e) { return []; }
}

function migrateDistanceHistory() {
  try {
    if (localStorage.getItem(DISTANCE_MIGRATION_KEY) === "1") return;
    const ledger = [];
    for (const [index, session] of parseStoredArray("cyclone-sessions").entries()) {
      const km = Number(session.km);
      if (km > 0 && /^\d{4}-\d{2}-\d{2}$/.test(session.date || "")) {
        ledger.push({ id: `cyclone-legacy-${index}`, source: "cyclone", endedAt: `${session.date}T12:00:00.000Z`, km });
      }
    }
    for (const [index, session] of parseStoredArray("typhoon-sessions-v1").entries()) {
      const km = Number(session.distanceKm);
      const endedAt = session.endedAt || "";
      if (session.completed && km > 0 && Number.isFinite(Date.parse(endedAt))) {
        ledger.push({ id: `typhoon-${session.id || index}`, source: "typhoon", endedAt, km });
      }
    }
    localStorage.setItem(DISTANCE_KEY, JSON.stringify(ledger));
    localStorage.setItem(DISTANCE_MIGRATION_KEY, "1");
  } catch (e) {}
}

function loadDistanceLedger() {
  migrateDistanceHistory();
  return parseStoredArray(DISTANCE_KEY);
}

function saveDistanceLedger(ledger) {
  try { localStorage.setItem(DISTANCE_KEY, JSON.stringify(ledger)); } catch (e) {}
}

function recordDistance(km) {
  if (!(km > 0)) return;
  const ledger = loadDistanceLedger();
  ledger.push({ id: `mistral-${Date.now()}-${Math.random().toString(16).slice(2)}`, source: "mistral", endedAt: new Date().toISOString(), km: Number(km.toFixed(3)) });
  saveDistanceLedger(ledger);
}

function recordSession(km) {
  recordDistance(km);
}

function computeStats() {
  const sessions = loadDistanceLedger();
  const now = Date.now();
  const today = todayStr();
  const weekStart = now - 7 * 24 * 60 * 60 * 1000;
  const monthStart = now - 30 * 24 * 60 * 60 * 1000;
  let todayKm = 0, weekKm = 0, monthKm = 0, allKm = 0;
  for (const s of sessions) {
    const km = Number(s.km) || 0;
    const time = Date.parse(s.endedAt);
    allKm += km;
    if (Number.isFinite(time) && todayStr(new Date(time)) === today) todayKm += km;
    if (Number.isFinite(time) && time >= weekStart) weekKm += km;
    if (Number.isFinite(time) && time >= monthStart) monthKm += km;
  }
  return { todayKm, weekKm, monthKm, allKm };
}

function renderStats() {
  const { todayKm, weekKm, monthKm, allKm } = computeStats();
  $("stat-today").textContent   = `${distanceText(todayKm)}`;
  $("stat-week").textContent    = `${distanceText(weekKm)}`;
  $("stat-month").textContent   = `${distanceText(monthKm)}`;
  $("stat-alltime").textContent = `${distanceText(allKm)}`;
}

function parseBike(dv) {
  const flags = dv.getUint16(0, true); let o = 2; const out = {};
  const u16 = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const s16 = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const u24 = () => { const a = dv.getUint8(o), b = dv.getUint8(o+1), c = dv.getUint8(o+2); o += 3; return a|(b<<8)|(c<<16); };
  const u8  = () => { const v = dv.getUint8(o); o += 1; return v; };
  if (!(flags & 1))  out.speed_kmh   = u16() / 100;
  if (flags & 2)     u16();
  if (flags & 4)     out.cadence_rpm = u16() / 2;
  if (flags & 8)     u16();
  if (flags & 16)    out.distance_m  = u24();
  if (flags & 32)    s16();
  if (flags & 64)    out.power_w     = s16();
  if (flags & 128)   s16();
  if (flags & 256)   u16();
  if (flags & 512)   u8();
  return out;
}

function onData(e) {
  const m = parseBike(e.target.value);
  const now = performance.now() / 1000;
  if ("speed_kmh" in m) latestSpeed_kmh = m.speed_kmh;
  if (sessionActive && "cadence_rpm" in m) updateRpm(m.cadence_rpm);
  if ("distance_m" in m) {
    if (sessionActive && lastRawDistanceM !== null) {
      const delta = m.distance_m - lastRawDistanceM;
      if (delta >= 0) sessionDistanceM += delta;
    }
    lastRawDistanceM = m.distance_m;
  } else if (sessionActive) {
    const dt = lastT === null ? 0 : (now - lastT);
    if (dt > 0 && dt < 5) sessionDistanceM += (latestSpeed_kmh * 1000 / 3600) * dt;
  }
  lastT = now;
  if (sessionActive) updateDistance();
}

function setSessionUI() {
  sessionActive = true;
  acquireWakeLock();
  const btn = $("main-btn");
  btn.textContent = "Stop";
  btn.classList.add("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = false;
  lastBand = null;
  $("rpm-value").textContent = "0";
}

function setReadyUI() {
  sessionActive = false;
  releaseWakeLock();
  const btn = $("main-btn");
  btn.textContent = "Start";
  btn.classList.remove("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = true;
}

function setDisconnectedUI() {
  connected = false;
  sessionActive = false;
  releaseWakeLock();
  const btn = $("main-btn");
  btn.textContent = "Connect";
  btn.classList.remove("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = true;
}

function setInterruptedUI() {
  connected = false;
  const btn = $("main-btn");
  btn.textContent = "Stop";
  btn.classList.add("stop-mode");
  btn.disabled = false;
  $("rpm-display").hidden = false;
}

function timeText(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const remainder = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
}
function spokenTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const values = [
    [Math.floor(total / 3600), "hour"],
    [Math.floor(total / 60) % 60, "minute"],
    [total % 60, "second"]
  ];
  return values.filter(([value]) => value > 0).map(([value, label]) => `${value} ${label}${value === 1 ? "" : "s"}`).join(", ") || "0 seconds";
}
function endSession() {
  const km = sessionDistanceM / 1000;
  const elapsedSeconds = sessionStartedAt === null ? 0 : Math.max(0, (performance.now() - sessionStartedAt) / 1000);
  const averageSpeed = elapsedSeconds > 0 ? sessionDistanceM / metresPerUnit() / (elapsedSeconds / 3600) : 0;
  recordSession(km);
  renderStats();
  $("result-time").textContent = timeText(elapsedSeconds);
  $("result-speed").textContent = `${averageSpeed.toFixed(1)} ${unit === "miles" ? "mph" : "km/h"}`;
  $("results-section").hidden = false;
  $("results-heading").focus();
  const completed = sessionDistanceM >= targetDistance * metresPerUnit();
  const intro = completed ? "Workout complete." : "Workout stopped.";
  const speedUnit = unit === "miles" ? "miles per hour" : "kilometres per hour";
  // Let the finish tones end before reading the two simple workout results.
  clearTimeout(resultAnnouncementTimer);
  resultAnnouncementTimer = setTimeout(() => {
    speak(`${intro} Time: ${spokenTime(elapsedSeconds)}. Average speed: ${averageSpeed.toFixed(1)} ${speedUnit}.`);
  }, 1100);
}

let audioContext = null;
let startGeneration = 0;
let startingAudio = false;
let workoutMediaSource = null;
let workoutMediaGain = null;
const signalOscillators = new Set();
function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  return true;
}
function cancelSignals() {
  for (const oscillator of signalOscillators) {
    try { oscillator.stop(); } catch (error) {}
  }
  signalOscillators.clear();
}
function setStartingAudio(value) {
  startingAudio = value;
  $("choose-audio-btn").disabled = value;
  $("play-btn").disabled = value;
}
function beep(frequency, durationSeconds, delaySeconds = 0) {
  if (!ensureAudioContext()) return;
  const oscillator = audioContext.createOscillator();
  const master = audioContext.createGain();
  const start = audioContext.currentTime + delaySeconds;
  const end = start + durationSeconds;
  oscillator.frequency.value = frequency;
  oscillator.type = "sine";
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(0.68, start + 0.03);
  master.gain.setValueAtTime(0.68, Math.max(start + 0.04, end - 0.08));
  master.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(master);
  master.connect(audioContext.destination);
  signalOscillators.add(oscillator);
  oscillator.onended = () => signalOscillators.delete(oscillator);
  oscillator.start(start);
  oscillator.stop(end + 0.02);
}

function finishSignal() {
  beep(330, 0.3);
  beep(660, 0.65, 0.36);
}


async function startWorkoutAudio() {
  const generation = ++startGeneration;
  const audio = $("workout-audio");
  setStartingAudio(true);
  $("audio-status").hidden = true;
  audio.pause();
  cancelSignals();
  // Start the media while the Start tap still grants playback permission.
  // Silence its Web Audio output rather than muting and restarting the element.
  let playbackFailed = false;
  if (audio.src) {
    if (ensureAudioContext() && !workoutMediaSource) {
      workoutMediaSource = audioContext.createMediaElementSource(audio);
      workoutMediaGain = audioContext.createGain();
      workoutMediaSource.connect(workoutMediaGain);
      workoutMediaGain.connect(audioContext.destination);
    }
    if (workoutMediaGain) workoutMediaGain.gain.setValueAtTime(0, audioContext.currentTime);
    audio.muted = !workoutMediaGain;
    audio.currentTime = 0;
    try {
      Promise.resolve(audio.play()).catch(() => { playbackFailed = true; });
    } catch (error) { playbackFailed = true; }
  }
  for (const delay of [0, 0.9, 1.8]) beep(500, 0.32, delay);
  beep(1000, 0.65, 2.7);
  await new Promise(resolve => setTimeout(resolve, 4400));
  if (generation !== startGeneration || !sessionActive) return;
  if (audio.src) audio.currentTime = 0;
  audio.muted = false;
  if (workoutMediaGain) workoutMediaGain.gain.setValueAtTime(1, audioContext.currentTime);
  setStartingAudio(false);
  // Usually already playing: do not require another delayed play permission.
  if (audio.src && (audio.paused || playbackFailed)) {
    try {
      await audio.play();
    } catch (error) {
      if (generation === startGeneration && sessionActive) {
        const message = "Workout audio could not start automatically. Tap Play to start it.";
        $("audio-status").textContent = message;
        $("audio-status").hidden = false;
        speak(message);
      }
    }
  }
}
function stopWorkoutAudio() {
  ++startGeneration;
  const audio = $("workout-audio");
  audio.pause();
  if (audio.src) audio.currentTime = 0;
  audio.muted = false;
  if (workoutMediaGain) workoutMediaGain.gain.setValueAtTime(1, audioContext.currentTime);
  setStartingAudio(false);
  cancelSignals();
  finishSignal();
}

async function startSession() {
  if (targetDistance === null) return;
  if (!connected || !device || !device.gatt || !device.gatt.connected) {
    setDisconnectedUI();
    return;
  }
  clearTimeout(resultAnnouncementTimer);
  $("results-section").hidden = true;
  sessionStartedAt = performance.now();
  sessionDistanceM = 0;
  nextMilestone = 0.5;
  announcedFinishDistances = new Set();
  cadenceBlockedUntil = 0;
  renderProgress();
  $("change-distance-btn").hidden = true;
  lastT = null;
  lastRawDistanceM = null;
  latestSpeed_kmh = 0;
  setSessionUI();
  await startWorkoutAudio();
}

async function connect() {
  $("main-btn").disabled = true;
  try { await Bike.connect(); }
  catch (error) {
    setDisconnectedUI();
    speak(navigator.bluetooth ? "Could not connect. Keep pedalling and tap Connect to try again." : "Web Bluetooth is unavailable in this browser.");
  }
}

function stop() {
  if (!sessionActive) return;
  clearTimeout(cadenceTimer);
  $("cadence-spoken").textContent = "";
  $("change-distance-btn").hidden = false;
  stopWorkoutAudio();
  endSession();
  if (device && device.gatt && device.gatt.connected) setReadyUI();
  else setDisconnectedUI();
}

function onUnexpectedDisconnect() {
  char = null;
  connected = false;
  if (sessionActive) {
    setInterruptedUI();
    speak("Bike disconnected. Trying to reconnect.");
    // The shared connection owner retries without restarting this workout.
  } else {
    device = null;
    setDisconnectedUI();
  }
}

function leaveCyclone() { showSection(null); }

function resetData() {
  localStorage.removeItem("cyclone-sessions");
  saveDistanceLedger([]);
  localStorage.setItem(DISTANCE_MIGRATION_KEY, "1");
  renderStats();
  speak("All distance data cleared.");
}

function chooseWorkout() {
  if (startingAudio) return;
  $("audio-file").click();
}

function loadWorkout(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  const audio = $("workout-audio");
  audio.pause();
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(file);
  audio.src = audioUrl;
  audio.load();

  const playBtn = $("play-btn");
  playBtn.textContent = "Play";
  playBtn.hidden = false;
  playBtn.setAttribute("aria-label", `Play ${workoutName(file)}`);
}

function workoutName(file) {
  return file.name.replace(/\.mp3$/i, "");
}

async function togglePlayback() {
  if (startingAudio) return;
  const audio = $("workout-audio");
  const playBtn = $("play-btn");
  if (audio.paused) {
    try { await audio.play(); } catch (e) {}
  } else {
    audio.pause();
  }
}

function updatePlaybackButton() {
  const audio = $("workout-audio");
  const playBtn = $("play-btn");
  const file = $("audio-file").files && $("audio-file").files[0];
  const action = audio.paused ? "Play" : "Pause";
  if (!audio.paused) $("audio-status").hidden = true;
  playBtn.textContent = action;
  playBtn.setAttribute("aria-label", file ? `${action} ${workoutName(file)}` : action);
}

$("main-btn").addEventListener("click", () => {
  if (sessionActive) stop();
  else if (connected) startSession();
  else connect();
});
$("home-btn").addEventListener("click", leaveCyclone);
$("reset-btn").addEventListener("click", resetData);
$("choose-audio-btn").addEventListener("click", chooseWorkout);
$("audio-file").addEventListener("change", loadWorkout);
$("play-btn").addEventListener("click", togglePlayback);
$("workout-audio").addEventListener("play", updatePlaybackButton);
$("workout-audio").addEventListener("pause", updatePlaybackButton);
$("workout-audio").addEventListener("ended", updatePlaybackButton);
document.querySelectorAll(".distance-choice").forEach(button => {
  button.addEventListener("click", () => chooseDistance(Number(button.dataset.distance)));
});
$("unit-btn").addEventListener("click", () => {
  unit = unit === "miles" ? "km" : "miles";
  document.querySelectorAll(".distance-choice").forEach(button => {
    button.textContent = `${button.dataset.distance} ${unitLabel()}`;
  });
  $("unit-btn").textContent = unit === "miles" ? "Switch to KM" : "Switch to miles";
  renderStats();
});
$("change-distance-btn").addEventListener("click", () => {
  if (sessionActive) return;
  $("workout-screen").hidden = true;
  $("distance-setup").hidden = false;
  document.querySelector(".distance-choice").focus();
});
window.addEventListener("storage", event => {
  if (event.key === DISTANCE_KEY || event.key === null) renderStats();
});
renderStats();


sections["mistral"] = {
  data: onData,
  connection(chosen) {
    device = chosen;
    connected = true;
    lastT = null;
    lastRawDistanceM = null;
    if (sessionActive) setSessionUI(); else setReadyUI();
  },
  disconnected: onUnexpectedDisconnect,
  enter() {
    renderStats();
    if (Bike.isConnected()) this.connection(Bike.device); else setDisconnectedUI();
    document.querySelector(".distance-choice").focus();
  },
  leave() {
    if (sessionActive) stop();
    clearTimeout(resultAnnouncementTimer);
    $("results-section").hidden = true;
    ++startGeneration;
    $("workout-audio").pause();
    cancelSignals();
    clearTimeout(speakTimer);
    clearTimeout(cadenceTimer);
    clearTimeout(speakUpdateTimer); $("cadence-spoken").textContent = ""; $("spoken").textContent = "";
    releaseWakeLock();
    $("distance-setup").hidden = false; $("workout-screen").hidden = true;
  }
};


})();

document.querySelectorAll("[data-section]").forEach(button => {
  button.addEventListener("click", () => showSection(button.dataset.section));
});
window.addEventListener("popstate", () => showSection(location.hash.slice(1), false));
showSection(location.hash.slice(1), false);
Bike.autoConnect();
