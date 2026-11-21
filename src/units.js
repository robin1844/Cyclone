const DistanceUnits = (() => {
  const listeners = new Map();
  const values = new Map();
  function get(section) {
    if (values.has(section)) return values.get(section);
    try {
      const value = localStorage.getItem(`cyclone-units-${section}`);
      if (value === 'km' || value === 'miles') return value;
    } catch (error) {}
    return section === 'mistral' ? 'miles' : 'km';
  }
  function set(section, value) {
    if (!['km', 'miles'].includes(value)) return;
    values.set(section, value);
    try { localStorage.setItem(`cyclone-units-${section}`, value); } catch (error) {}
    for (const listener of listeners.get(section) || []) listener(value);
  }
  function subscribe(section, listener) {
    if (!listeners.has(section)) listeners.set(section, []);
    listeners.get(section).push(listener);
    listener(get(section));
  }
  return { get, set, subscribe, toggle: section => set(section, get(section) === 'km' ? 'miles' : 'km') };
})();
