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
