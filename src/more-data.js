const MoreData = (() => {
  const $ = id => document.getElementById(id);
  const dialog = $('more-data-dialog');
  let period = 'today', unit = 'km', timer = null, returnFocus = null;
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
      ['Cadence and body measurements', [
        ['Average cadence', average('cadenceRpm', 'RPM')], ['Peak cadence', peak('cadenceRpm', 'RPM')],
        ['Average heart rate', average('heartRate', 'bpm')], ['Peak heart rate', peak('heartRate', 'bpm')],
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
        list = document.createElement('dl'); list.dataset.group = groupIndex; content.append(list);
        for (let i = 0; i < rows.length; i++) {
          const row = document.createElement('div'); row.className = 'data-row';
          row.append(document.createElement('dt'), document.createElement('dd')); list.append(row);
        }
      }
      rows.forEach(([label, value], index) => {
        const row = list.children[index];
        if (row.children[0].textContent !== label) row.children[0].textContent = label;
        if (row.children[1].textContent !== value) row.children[1].textContent = value;
      });
    }
    const missing = entries.length - detailed.length;
    $('data-coverage').textContent = missing ? `${missing} older ride${missing === 1 ? ' has' : 's have'} distance only. Other totals and averages use the rides with recorded detail.` : (entries.some(entry => entry.live) ? 'Includes the current workout so far.' : 'Totals use the measurements recorded during your rides.');
  }
  function select(value) {
    period = value;
    $('data-today').setAttribute('aria-pressed', String(value === 'today'));
    $('data-all-time').setAttribute('aria-pressed', String(value === 'all'));
    render();
  }
  function open(selectedUnit = 'km', opener = document.activeElement) {
    returnFocus = opener;
    unit = selectedUnit;
    $('data-weight').value = String(WorkoutData.weight());
    $('data-weight-status').textContent = '';
    select('today');
    dialog.showModal();
    $('data-today').focus();
    clearInterval(timer); timer = setInterval(render, 1000);
  }
  $('data-today').addEventListener('click', () => select('today'));
  $('data-all-time').addEventListener('click', () => select('all'));
  $('close-more-data').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearInterval(timer); timer = null; returnFocus?.focus(); });
  $('data-weight-form').addEventListener('submit', event => {
    event.preventDefault();
    const weight = Number($('data-weight').value);
    if (!Number.isFinite(weight) || weight < 30 || weight > 250) return;
    localStorage.setItem('typhoon-weight-kg', String(weight));
    $('data-weight-status').textContent = `Weight saved: ${weight} kg. It will be used for future rides.`;
  });
  return { open, close: () => { if (dialog.open) dialog.close(); } };
})();
