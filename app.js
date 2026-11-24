const TIMEZONE = 'Asia/Damascus';
const CROP_DATA_URL = '/data/crops_local_syria_v0.1.json';
const LOCATION_DATA_URL = '/data/locations_syria_v0.1.json';
const state = { catalog: null, locations: null, rows: [], loading: false };

const $ = (id) => document.getElementById(id);
const numberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > -900 ? n : null;
};
const round = (value, digits = 3) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const formatNumber = (value, digits = 2) => value == null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

function selectedLocation() {
  return state.locations?.records.find((location) => location.id === $('location-name').value) || state.locations?.records[0];
}

function applyLocation(location) {
  if (!location) return;
  $('latitude').value = location.latitude;
  $('longitude').value = location.longitude;
  $('elevation').value = location.elevation_m;
  $('location-reference').textContent = `${location.reference_ar} · إحداثيات مرجعية قابلة للتعديل`;
  $('location-summary').textContent = location.name_ar;
}

function damascusToday() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDays(isoDate, amount) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayOfYear(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  return Math.floor((date - yearStart) / 86400000);
}

function daysBetween(startIso, endIso) {
  return Math.round((new Date(`${endIso}T00:00:00Z`) - new Date(`${startIso}T00:00:00Z`)) / 86400000);
}

function apiDate(isoDate) { return isoDate.replaceAll('-', ''); }

function setStatus(text, tone = 'neutral') {
  const node = $('data-status');
  node.textContent = text;
  node.className = `status-pill ${tone}`;
}

function fetchJson(url) {
  return fetch(url, { headers: { Accept: 'application/json' } }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
}

function readNasaPayload(payload) {
  const parameters = payload?.properties?.parameter || {};
  const dates = new Set(Object.keys(parameters.T2M_MAX || {}));
  return [...dates].reduce((result, yyyymmdd) => {
    const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
    result[date] = {
      date,
      tmax: numberOrNull(parameters.T2M_MAX?.[yyyymmdd]),
      tmin: numberOrNull(parameters.T2M_MIN?.[yyyymmdd]),
      dew: numberOrNull(parameters.T2MDEW?.[yyyymmdd]),
      rh: numberOrNull(parameters.RH2M?.[yyyymmdd]),
      solar: numberOrNull(parameters.ALLSKY_SFC_SW_DWN?.[yyyymmdd]),
      wind10: null,
      wind2: numberOrNull(parameters.WS2M?.[yyyymmdd]),
      pressure: numberOrNull(parameters.PS?.[yyyymmdd]),
      rain: numberOrNull(parameters.PRECTOTCORR?.[yyyymmdd]) ?? 0,
      source: 'NASA POWER',
      solarUnit: 'MJ/m²/day'
    };
    return result;
  }, {});
}

function readOpenMeteoPayload(payload) {
  const daily = payload?.daily || {};
  return (daily.time || []).reduce((result, date, index) => {
    result[date] = {
      date,
      tmax: numberOrNull(daily.temperature_2m_max?.[index]),
      tmin: numberOrNull(daily.temperature_2m_min?.[index]),
      dew: numberOrNull(daily.dew_point_2m_mean?.[index]),
      rh: null,
      solar: numberOrNull(daily.shortwave_radiation_sum?.[index]),
      wind10: numberOrNull(daily.wind_speed_10m_mean?.[index]),
      wind2: null,
      pressure: numberOrNull(daily.surface_pressure_mean?.[index]),
      rain: numberOrNull(daily.precipitation_sum?.[index]) ?? 0,
      source: 'Open-Meteo',
      solarUnit: 'MJ/m²/day'
    };
    return result;
  }, {});
}

function hasCoreWeather(row) {
  return Boolean(row && row.tmax != null && row.tmin != null && (row.dew != null || row.rh != null) && (row.wind2 != null || row.wind10 != null));
}

function chooseWeather(date, today, nasaByDate, openMeteoByDate) {
  const nasa = nasaByDate[date];
  const open = openMeteoByDate[date];
  const future = date > today;
  const nasaCore = hasCoreWeather(nasa);
  const openCore = hasCoreWeather(open);

  if (!future && nasaCore && nasa.solar != null) {
    return { ...nasa, state: 'actual', stateLabel: 'فعلي', sourceLabel: 'NASA POWER', quality: 'nasa' };
  }
  if (!future && nasaCore && nasa.solar == null && open?.solar != null) {
    return { ...nasa, solar: open.solar, rain: nasa.rain ?? open.rain, state: 'alternative', stateLabel: 'بديل للإشعاع', sourceLabel: 'NASA + Open-Meteo', quality: 'solar-fallback' };
  }
  if (openCore) {
    return { ...open, state: future ? 'forecast' : 'alternative', stateLabel: future ? 'توقع' : 'بيانات بديلة', sourceLabel: 'Open-Meteo', quality: future ? 'forecast' : 'alternative' };
  }
  if (nasaCore) {
    return { ...nasa, state: 'actual', stateLabel: 'فعلي ناقص', sourceLabel: 'NASA POWER', quality: 'incomplete' };
  }
  return { date, state: 'missing', stateLabel: 'غير مكتمل', sourceLabel: 'لا توجد بيانات كافية', quality: 'missing', rain: 0 };
}

function saturationVaporPressure(temperature) {
  return 0.6108 * Math.exp((17.27 * temperature) / (temperature + 237.3));
}

function extraterrestrialRadiation(date, latitude) {
  const gsc = 0.0820;
  const phi = latitude * Math.PI / 180;
  const j = dayOfYear(date);
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * j) / 365);
  const solarDeclination = 0.409 * Math.sin((2 * Math.PI * j) / 365 - 1.39);
  const sunsetAngle = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(solarDeclination))));
  return (24 * 60 / Math.PI) * gsc * dr * (sunsetAngle * Math.sin(phi) * Math.sin(solarDeclination) + Math.cos(phi) * Math.cos(solarDeclination) * Math.sin(sunsetAngle));
}

function pressureFromElevation(elevation) {
  return 101.3 * Math.pow((293 - 0.0065 * elevation) / 293, 5.26);
}

function windAtTwoMeters(weather) {
  if (weather.wind2 != null) return weather.wind2;
  if (weather.wind10 == null) return null;
  return weather.wind10 * 4.87 / Math.log(67.8 * 10 - 5.42);
}

function pressureInKpa(weather, elevation) {
  if (weather.pressure == null) return pressureFromElevation(elevation);
  return weather.pressure > 200 ? weather.pressure / 10 : weather.pressure;
}

function calculateEt0(weather, date, latitude, elevation) {
  if (weather.tmax == null || weather.tmin == null || weather.solar == null) return { et0: null, reason: 'الإشعاع الشمسي أو درجات الحرارة غير متوفرة' };
  const tmean = (weather.tmax + weather.tmin) / 2;
  const esTmax = saturationVaporPressure(weather.tmax);
  const esTmin = saturationVaporPressure(weather.tmin);
  const es = (esTmax + esTmin) / 2;
  const ea = weather.dew != null ? saturationVaporPressure(weather.dew) : es * ((weather.rh ?? 70) / 100);
  const delta = 4098 * saturationVaporPressure(tmean) / Math.pow(tmean + 237.3, 2);
  const pressure = pressureInKpa(weather, elevation);
  const gamma = 0.000665 * pressure;
  const ra = extraterrestrialRadiation(date, latitude);
  const rso = (0.75 + 0.00002 * elevation) * ra;
  const rs = Math.max(0, weather.solar);
  const rns = (1 - 0.23) * rs;
  const ratio = rso > 0 ? Math.max(0, Math.min(1, rs / rso)) : 0.5;
  const sigma = 4.903e-9;
  const rnl = sigma * (((weather.tmax + 273.16) ** 4 + (weather.tmin + 273.16) ** 4) / 2) * (0.34 - 0.14 * Math.sqrt(Math.max(ea, 0))) * (1.35 * ratio - 0.35);
  const rn = rns - rnl;
  const u2 = windAtTwoMeters(weather);
  if (u2 == null || !Number.isFinite(u2)) return { et0: null, reason: 'سرعة الرياح غير متوفرة' };
  const numerator = 0.408 * delta * rn + gamma * (900 / (tmean + 273)) * u2 * Math.max(es - ea, 0);
  const denominator = delta + gamma * (1 + 0.34 * u2);
  return { et0: Math.max(0, numerator / denominator), reason: null, u2, rn };
}

function kcForDay(crop, dayFromStart) {
  if (dayFromStart < 0) return { kc: null, stage: 'before_season' };
  const l1 = Number(crop.L1), l2 = Number(crop.L2), l3 = Number(crop.L3), l4 = Number(crop.L4);
  const ini = Number(crop.kc_ini), mid = Number(crop.kc_mid), end = Number(crop.kc_end);
  let d = dayFromStart;
  if (d < l1) return { kc: ini, stage: 'L1' };
  d -= l1;
  if (d < l2) return { kc: ini + ((d + 1) / l2) * (mid - ini), stage: 'L2' };
  d -= l2;
  if (d < l3) return { kc: mid, stage: 'L3' };
  d -= l3;
  if (d < l4) return { kc: mid + ((d + 1) / l4) * (end - mid), stage: 'L4' };
  return { kc: end, stage: 'post_season' };
}

async function loadWeather() {
  const today = damascusToday();
  const start = addDays(today, -7);
  const end = addDays(today, 6);
  const latitude = Number($('latitude').value);
  const longitude = Number($('longitude').value);
  const elevation = Number($('elevation').value);
  const nasaEnd = addDays(today, -1);
  const nasaUrl = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,T2MDEW,RH2M,ALLSKY_SFC_SW_DWN,WS2M,PS,PRECTOTCORR&community=AG&longitude=${longitude}&latitude=${latitude}&start=${apiDate(start)}&end=${apiDate(nasaEnd)}&format=JSON&time-standard=LST`;
  const openMeteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&elevation=${elevation}&timezone=${encodeURIComponent(TIMEZONE)}&wind_speed_unit=ms&past_days=7&forecast_days=7&daily=temperature_2m_max,temperature_2m_min,dew_point_2m_mean,wind_speed_10m_mean,shortwave_radiation_sum,precipitation_sum,surface_pressure_mean`;
  const results = await Promise.allSettled([fetchJson(nasaUrl), fetchJson(openMeteoUrl)]);
  const nasaPayload = results[0].status === 'fulfilled' ? results[0].value : null;
  const openPayload = results[1].status === 'fulfilled' ? results[1].value : null;
  if (!nasaPayload && !openPayload) throw new Error('تعذر الاتصال بمصدري الطقس.');
  const nasaByDate = nasaPayload ? readNasaPayload(nasaPayload) : {};
  const openMeteoByDate = openPayload ? readOpenMeteoPayload(openPayload) : {};
  const crop = state.catalog.records.find((item) => item.id === $('crop-select').value) || state.catalog.records[0];
  const seasonStart = $('season-start').value;
  const rows = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const weather = chooseWeather(date, today, nasaByDate, openMeteoByDate);
    const et0Result = calculateEt0(weather, date, latitude, elevation);
    const kcResult = kcForDay(crop, daysBetween(seasonStart, date));
    const etc = et0Result.et0 != null && kcResult.kc != null ? et0Result.et0 * kcResult.kc : null;
    rows.push({
      ...weather,
      tmean: weather.tmax != null && weather.tmin != null ? (weather.tmax + weather.tmin) / 2 : null,
      et0: et0Result.et0,
      etc,
      kc: kcResult.kc,
      stage: kcResult.stage,
      dayFromStart: daysBetween(seasonStart, date),
      u2: et0Result.u2 ?? windAtTwoMeters(weather),
      reason: et0Result.reason
    });
  }
  return { rows, today, start, end, sourceAvailability: { nasa: Boolean(nasaPayload), openMeteo: Boolean(openPayload) } };
}

function stageLabel(stage) {
  return ({ L1: 'L1 · التأسيس', L2: 'L2 · النمو', L3: 'L3 · منتصف الموسم', L4: 'L4 · النضج', post_season: 'بعد الموسم', before_season: 'قبل الموسم' })[stage] || stage;
}

function dateLabel(date) {
  return new Intl.DateTimeFormat('ar-SY', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(new Date(`${date}T12:00:00`));
}

function renderTable(rows) {
  const body = $('results-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="table-empty">لا توجد سجلات للعرض.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => {
    const stateClass = row.state;
    const temperature = row.tmin != null && row.tmax != null ? `${formatNumber(row.tmin, 1)} / ${formatNumber(row.tmax, 1)}` : '—';
    const rowNote = row.quality === 'solar-fallback' ? 'الإشعاع من Open-Meteo' : row.sourceLabel;
    return `<tr>
      <td class="table-date" title="${escapeHtml(row.date)}">${escapeHtml(dateLabel(row.date))}</td>
      <td><div class="source-cell"><span class="state-dot ${stateClass}"></span><span><b>${escapeHtml(row.stateLabel)}</b><small>${escapeHtml(rowNote)}</small></span></div></td>
      <td class="num">${temperature}</td>
      <td class="num">${formatNumber(row.solar, 2)}</td>
      <td class="num">${formatNumber(row.u2, 2)}</td>
      <td class="num">${formatNumber(row.rain, 1)}</td>
      <td class="num"><b>${formatNumber(row.et0, 3)}</b></td>
      <td class="num">${formatNumber(row.kc, 3)}</td>
      <td><span class="stage-chip">${escapeHtml(stageLabel(row.stage))}</span></td>
      <td class="num"><b>${formatNumber(row.etc, 3)}</b></td>
    </tr>`;
  }).join('');
}

function linePath(points) { return points.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' '); }

function renderChart(rows) {
  const chart = $('chart-wrap');
  const usable = rows.filter((row) => row.et0 != null || row.etc != null);
  if (!usable.length) { chart.innerHTML = '<div class="empty-state">لا تتوفر قيم كافية للرسم.</div>'; return; }
  const width = 760, height = 250, left = 42, right = 18, top = 20, bottom = 38;
  const max = Math.max(1, ...usable.flatMap((row) => [row.et0 || 0, row.etc || 0])) * 1.15;
  const x = (index) => left + index * ((width - left - right) / Math.max(1, rows.length - 1));
  const y = (value) => height - bottom - (value / max) * (height - top - bottom);
  const et0Points = rows.map((row, index) => [x(index), y(row.et0 || 0)]);
  const etcPoints = rows.map((row, index) => [x(index), y(row.etc || 0)]);
  const grids = [0, .25, .5, .75, 1].map((ratio) => {
    const yy = y(max * ratio);
    return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${yy}" y2="${yy}" /><text class="chart-axis-label" x="${left - 8}" y="${yy + 3}" text-anchor="end">${formatNumber(max * ratio, 1)}</text>`;
  }).join('');
  const labels = rows.map((row, index) => index % 2 === 0 || rows.length < 10 ? `<text class="chart-label" x="${x(index)}" y="${height - 12}" text-anchor="middle">${escapeHtml(row.date.slice(5))}</text>` : '').join('');
  const points = (values, color) => values.map((point, index) => `<circle class="chart-point" cx="${point[0]}" cy="${point[1]}" r="4" fill="${color}"${rows[index].state === 'forecast' ? ' opacity=".58"' : ''}><title>${escapeHtml(rows[index].date)}: ${formatNumber(index === 0 ? values[index] : (color === '#136f63' ? rows[index].et0 : rows[index].etc), 3)} ملم</title></circle>`).join('');
  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="مقارنة ET0 وETc"><g>${grids}</g><path d="${linePath(et0Points)}" fill="none" stroke="#136f63" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /><path d="${linePath(etcPoints)}" fill="none" stroke="#d78b3a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />${points(et0Points, '#136f63')}${points(etcPoints, '#d78b3a')}<g>${labels}</g></svg>`;
}

function renderSummary(rows, today) {
  const valid = rows.filter((row) => row.et0 != null);
  const totalEt0 = valid.reduce((sum, row) => sum + row.et0, 0);
  const totalEtc = valid.reduce((sum, row) => sum + (row.etc || 0), 0);
  const totalRain = rows.reduce((sum, row) => sum + (row.rain || 0), 0);
  const avgKc = valid.length ? valid.reduce((sum, row) => sum + (row.kc || 0), 0) / valid.length : null;
  $('metric-et0').textContent = formatNumber(totalEt0, 2);
  $('metric-etc').textContent = formatNumber(totalEtc, 2);
  $('metric-rain').textContent = formatNumber(totalRain, 2);
  $('metric-kc').textContent = formatNumber(avgKc, 3);
  const todayRow = rows.find((row) => row.date === today) || rows[rows.length - 1];
  $('stage-summary').textContent = todayRow ? stageLabel(todayRow.stage) : '—';
  const sourceNames = [...new Set(rows.map((row) => row.sourceLabel).filter(Boolean))];
  $('source-summary').textContent = sourceNames.length ? sourceNames.join(' · ') : '—';
}

function renderDataMessage(rows, sourceAvailability) {
  const message = $('data-message');
  const hasMissing = rows.some((row) => row.state === 'missing' || row.et0 == null);
  const hasAlternative = rows.some((row) => row.state === 'alternative');
  if (hasMissing) {
    message.className = 'data-message error-message';
    message.textContent = 'يوجد يوم أو أكثر بلا متغيرات كافية لحساب ET0؛ عُرضت الخانة كغير مكتملة بدل إنتاج قيمة مصطنعة.';
  } else if (hasAlternative) {
    message.className = 'data-message warning-message';
    message.textContent = `تم الدمج مع مصدر بديل لبعض السجلات. NASA POWER: ${sourceAvailability.nasa ? 'متاح' : 'غير متاح'} · Open-Meteo: ${sourceAvailability.openMeteo ? 'متاح' : 'غير متاح'}. التوقعات موسومة بوضوح.`;
  } else {
    message.className = 'data-message neutral-message';
    message.textContent = 'المصدر والحالة يظهران لكل سجل حتى لا تختلط التوقعات بالقياسات الفعلية.';
  }
}

function render(rows, metadata) {
  state.rows = rows;
  const crop = state.catalog.records.find((item) => item.id === $('crop-select').value) || state.catalog.records[0];
  $('location-summary').textContent = selectedLocation()?.name_ar || 'الموقع المحدد';
  $('crop-summary').textContent = crop.name_ar;
  $('updated-at').textContent = new Intl.DateTimeFormat('ar-SY', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date());
  renderSummary(rows, metadata.today);
  renderChart(rows);
  renderTable(rows);
  renderDataMessage(rows, metadata.sourceAvailability);
}

async function refresh() {
  if (state.loading || !state.catalog) return;
  state.loading = true;
  $('controls-form').querySelector('button').disabled = true;
  setStatus('جاري تحميل الطقس…', 'loading');
  try {
    const result = await loadWeather();
    render(result.rows, result);
    setStatus('تم التحديث', 'success');
  } catch (error) {
    console.error(error);
    setStatus('تعذر التحميل', 'error');
    $('data-message').className = 'data-message error-message';
    $('data-message').textContent = `تعذر جلب بيانات الطقس: ${error.message}. راجع الاتصال أو الإحداثيات ثم أعد المحاولة.`;
  } finally {
    state.loading = false;
    $('controls-form').querySelector('button').disabled = false;
  }
}

function populateCrops(catalog) {
  const select = $('crop-select');
  const groups = new Map();
  catalog.records.forEach((crop) => {
    if (!groups.has(crop.group_ar)) groups.set(crop.group_ar, []);
    groups.get(crop.group_ar).push(crop);
  });
  select.innerHTML = [...groups.entries()].map(([group, crops]) => `<optgroup label="${escapeHtml(group)}">${crops.map((crop) => `<option value="${escapeHtml(crop.id)}">${escapeHtml(crop.name_ar)}</option>`).join('')}</optgroup>`).join('');
  select.value = 'wheat';
}

function populateLocations(locationCatalog) {
  const select = $('location-name');
  select.innerHTML = locationCatalog.records.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name_ar)}</option>`).join('');
  select.value = 'damascus';
  applyLocation(selectedLocation());
}

async function init() {
  try {
    const [catalog, locations] = await Promise.all([fetchJson(CROP_DATA_URL), fetchJson(LOCATION_DATA_URL)]);
    state.catalog = catalog;
    state.locations = locations;
    populateCrops(state.catalog);
    populateLocations(state.locations);
    $('controls-form').addEventListener('submit', (event) => { event.preventDefault(); refresh(); });
    $('crop-select').addEventListener('change', () => { $('crop-summary').textContent = state.catalog.records.find((crop) => crop.id === $('crop-select').value)?.name_ar || '—'; });
    $('location-name').addEventListener('change', () => applyLocation(selectedLocation()));
    await refresh();
  } catch (error) {
    setStatus('تعذر تحميل القواعد المحلية', 'error');
    $('data-message').className = 'data-message error-message';
    $('data-message').textContent = `تعذر قراءة قاعدة المحاصيل أو المواقع: ${error.message}`;
  }
}

document.addEventListener('DOMContentLoaded', init);
