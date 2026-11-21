const MoreData = (() => {
  const $ = id => document.getElementById(id);
  const dialog = $('more-data-dialog');
  let period = 'today', unit = 'km', timer = null, returnFocus = null, workoutRoot = null, previousTitle = '', savedScroll = 0, pushedRoute = false;
  const dateKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  function time(seconds) {
    const total = Math.round(seconds);
    return `${Math.floor(total / 3600)}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  function render() {
    const entries = WorkoutData.entries().filter(entry => period === 'all' || dateKey(new Date(entry.endedAt)) === dateKey(new Date()));
    const detailed = entries.filter(entry => entry.metrics);
    const factor = unit === 'miles' ? 1 / 1.609344 : 1;
    const distanceUnit = unit === 'miles' ? 'miles' : 'km';
    const speedUnit = unit === 'miles' ? 'mph' : 'km/h';
    const totalDistance = entries.reduce((sum, entry) => sum + (Number(entry.km) || 0), 0);
    const totalSeconds = detailed.reduce((sum, entry) => sum + entry.metrics.durationSeconds, 0);
    const knownDistance = detailed.reduce((sum, entry) => sum + (Number(entry.km) || 0), 0);
    const metric = field => {
      const present = detailed.map(entry => entry.metrics.fields[field]).filter(Boolean);
      return present.length ? {
        integral: present.reduce((sum, item) => sum + item.integral, 0),
        seconds: present.reduce((sum, item) => sum + item.seconds, 0),
        peak: Math.max(...present.map(item => item.peak))
      } : null;
    };
    const average = (field, suffix, scale = 1) => {
      const item = metric(field);
      return item?.seconds > 0 ? `${(item.integral / item.seconds * scale).toFixed(1)} ${suffix}` : 'Not recorded';
    };
    const peak = (field, suffix, scale = 1) => {
      const item = metric(field);
      return item ? `${(item.peak * scale).toFixed(1)} ${suffix}` : 'Not recorded';
    };
    const power = metric('powerW');
    let kgIntegral = 0, kgSeconds = 0, kgPeak = null, calories = 0, calorieCount = 0, estimated = false, reported = false;
    for (const { metrics: m } of detailed) {
      const p = m.fields.powerW;
      if (p && m.weightKg > 0) {
        kgIntegral += p.integral / m.weightKg; kgSeconds += p.seconds;
        kgPeak = Math.max(kgPeak ?? 0, p.peak / m.weightKg);
      }
      if (m.energySeen) { calories += m.energyKcal; calorieCount++; reported = true; }
      else if (Number.isFinite(m.legacyCalories)) { calories += m.legacyCalories; calorieCount++; estimated = true; }
      else if (p?.seconds > 0) { calories += p.integral / 4184 / 0.24; calorieCount++; estimated = true; }
    }
    const groups = [
      ['Activity', [
        ['Workouts', String(entries.length)],
        ['Distance', `${(totalDistance * factor).toFixed(2)} ${distanceUnit}`],
        ['Total time', detailed.length || !entries.length ? time(totalSeconds) : 'Not recorded'],
        ['Average speed', totalSeconds > 0 ? `${(knownDistance / (totalSeconds / 3600) * factor).toFixed(1)} ${speedUnit}` : 'Not recorded'],
        ['Peak speed', peak('speedKph', speedUnit, factor)]
      ]],
      ['Energy and power', [
        [`Calories${estimated ? (reported ? ' (bike + estimated)' : ' (estimated)') : (reported ? ' (bike)' : '')}`, calorieCount ? `${calories.toFixed(0)} kcal` : 'Not recorded'],
        ['Total work', power?.seconds > 0 ? `${(power.integral / 1000).toFixed(1)} kJ` : 'Not recorded'],
        ['Average power', average('powerW', 'W')], ['Peak power', peak('powerW', 'W')],
        ['Average Watts per kilo', kgSeconds > 0 ? `${(kgIntegral / kgSeconds).toFixed(2)} W/kg` : 'Not recorded'],
        ['Peak Watts per kilo', kgPeak !== null ? `${kgPeak.toFixed(2)} W/kg` : 'Not recorded']
      ]],
      ['Cadence and resistance', [
        ['Average cadence', average('cadenceRpm', 'RPM')], ['Peak cadence', peak('cadenceRpm', 'RPM')],
        ['Average resistance level', average('resistance', '')], ['Peak resistance level', peak('resistance', '')],
        ['Average metabolic equivalent', average('met', 'MET')]
      ]]
    ];
    const content = $('more-data-content');
    // Preserve the DOM while reading it with a screen reader; update text only.
    for (const [groupIndex, [title, rows]] of groups.entries()) {
      let list = content.querySelector(`[data-group="${groupIndex}"]`);
      if (!list) {
        const heading = document.createElement('h3'); heading.textContent = title; content.append(heading);
        list = document.createElement('div'); list.dataset.group = groupIndex; content.append(list);
        for (let i = 0; i < rows.length; i++) {
          const row = document.createElement('p'); row.className = 'data-row';
          list.append(row);
        }
      }
      rows.forEach(([label, value], index) => {
        const row = list.children[index];
        row.dataset.label = label;
        const text = `${label}: ${value}`;
        if (row.textContent !== text) row.textContent = text;
      });
    }
    const missing = entries.length - detailed.length;
    $('data-coverage').textContent = missing ? `${missing} older ride${missing === 1 ? ' has' : 's have'} distance only. Other totals and averages use the rides with recorded detail.` : (entries.some(entry => entry.live) ? 'Includes the current workout so far.' : 'Totals use the measurements recorded during your rides.');
  }
  function select(value) {
    period = value;
    $('data-today').classList.toggle('selected', value === 'today');
    $('data-all-time').classList.toggle('selected', value === 'all');
    $('data-today').textContent = value === 'today' ? 'Today (selected)' : 'Today';
    $('data-all-time').textContent = value === 'all' ? 'All time (selected)' : 'All time';
    render();
  }
  function open(selectedUnit = 'km', opener = document.activeElement, updateHistory = true) {
    if (!dialog.hidden) return;
    returnFocus = opener;
    workoutRoot = document.getElementById(`${activeSection}-section`);
    previousTitle = document.title;
    savedScroll = window.scrollY;
    pushedRoute = updateHistory;
    unit = selectedUnit;
    $('data-unit-btn').textContent = unit === 'miles' ? 'Switch to KM' : 'Switch to miles';
    $('data-weight').value = String(WorkoutData.weight());
    $('data-weight-status').textContent = '';
    select('today');
    if (workoutRoot) workoutRoot.hidden = true;
    dialog.hidden = false;
    document.title = 'More data';
    if (updateHistory) history.pushState(null, '', `#${activeSection}/data`);
    $('close-more-data').focus();
    window.scrollTo(0, 0);
    clearInterval(timer); timer = setInterval(render, 1000);
  }
  function close(updateHistory = true) {
    if (dialog.hidden) return;
    if (updateHistory && pushedRoute) { history.back(); return; }
    dialog.hidden = true;
    if (workoutRoot) workoutRoot.hidden = false;
    clearInterval(timer); timer = null;
    document.title = previousTitle;
    if (updateHistory) history.replaceState(null, '', `#${activeSection}`);
    window.scrollTo(0, savedScroll);
    returnFocus?.focus();
  }
  $('data-today').addEventListener('click', () => select('today'));
  $('data-all-time').addEventListener('click', () => select('all'));
  $('data-unit-btn').addEventListener('click', () => {
    DistanceUnits.toggle(activeSection);
    unit = DistanceUnits.get(activeSection);
    $('data-unit-btn').textContent = unit === 'miles' ? 'Switch to KM' : 'Switch to miles';
    render();
  });
  $('close-more-data').addEventListener('click', () => close());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !dialog.hidden) { event.preventDefault(); close(); }
  });
  function saveWeight() {
    if (!$('data-weight').reportValidity()) return;
    const weight = Number($('data-weight').value);
    if (!Number.isFinite(weight) || weight < 30 || weight > 250) return;
    localStorage.setItem('typhoon-weight-kg', String(weight));
    $('data-weight-status').textContent = `Weight saved: ${weight} kg. It will be used for future rides.`;
  }
  $('save-data-weight').addEventListener('click', saveWeight);
  $('data-weight').addEventListener('keydown', event => { if (event.key === 'Enter') saveWeight(); });
  return { open, close };
})();
