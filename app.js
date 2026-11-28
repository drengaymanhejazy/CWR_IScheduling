const TIMEZONE = 'Asia/Damascus';
const CROP_DATA_URL = '/data/crops_local_syria_v0.1.json';
const LOCATION_DATA_URL = '/data/locations_syria_v0.1.json';
const FERTILIZER_MAP_URL = '/data/fertilizer_crop_map_v0.1.json';
const FERTILIZER_PROFILES_URL = '/data/fertilizer_profiles_soilfert_v0.1.json';
const DIN_STORAGE_KEY = 'cwr-din-profile-v0.1';
const OPERATIONS_STORAGE_KEY = 'cwr-production-operations-costs-v0.1';
const state = { catalog: null, locations: null, fertilizerMap: null, fertilizerProfiles: null, rows: [], referenceDate: null, loading: false, din: null, operations: [] };

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

function readOpenMeteoPayload(payload, sourceLabel = 'Open-Meteo') {
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
      source: sourceLabel,
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
    return { ...open, state: future ? 'forecast' : 'alternative', stateLabel: future ? 'توقع' : 'بيانات بديلة', sourceLabel: open.source || 'Open-Meteo', quality: future ? 'forecast' : 'alternative' };
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
  return { kc: null, stage: 'post_season' };
}

function cropSeasonInfo(crop, seasonStart) {
  const totalDays = [crop?.L1, crop?.L2, crop?.L3, crop?.L4].map(Number).reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  if (!crop || !seasonStart || totalDays <= 0) return { totalDays: null, endDate: null };
  const lengths = ['L1', 'L2', 'L3', 'L4'].map((key) => Number(crop[key]) || 0);
  let cursor = seasonStart;
  const stages = lengths.map((length, index) => {
    const endDate = length > 0 ? addDays(cursor, length - 1) : cursor;
    const result = { key: `L${index + 1}`, startDate: cursor, endDate, length };
    cursor = addDays(endDate, 1);
    return result;
  });
  return { totalDays, endDate: stages.at(-1).endDate, stages, plantingWindow: crop.planting_window || '' };
}

function parsePlantingWindow(windowText) {
  const match = String(windowText || '').match(/(\d{1,2})\/(\d{1,2})(?:\s*-\s*(\d{1,2})\/(\d{1,2}))?/);
  if (!match) return null;
  const start = { day: Number(match[1]), month: Number(match[2]) };
  const end = match[3] ? { day: Number(match[3]), month: Number(match[4]) } : start;
  return { start, end };
}

function isDateInPlantingWindow(isoDate, windowText) {
  const parsed = parsePlantingWindow(windowText);
  if (!parsed || !isoDate) return null;
  const date = new Date(`${isoDate}T00:00:00Z`);
  const value = date.getUTCMonth() * 31 + date.getUTCDate();
  const start = (parsed.start.month - 1) * 31 + parsed.start.day;
  const end = (parsed.end.month - 1) * 31 + parsed.end.day;
  return start <= end ? value >= start && value <= end : value >= start || value <= end;
}

function formatIsoDate(isoDate) {
  return isoDate ? new Intl.DateTimeFormat('ar-SY', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${isoDate}T12:00:00`)) : '—';
}

function defaultDinProfile() {
  return {
    version: '0.1.0',
    field: { name: '', area: null, areaUnit: 'dunum', code: '' },
    soil: { texture: '', rootDepthCm: null, fieldCapacity: null, wiltingPoint: null, mad: null, initialState: 'field_capacity', initialDeficitMm: null, carryoverStorageMm: null, ph: null, ec: null, organicMatter: null, n: null, p: null, k: null },
    irrigation: { method: '', coverageCoefficient: 1, efficiency: null, weeklyRain: null, dailyRain: {}, actualIrrigation: {}, dischargeLph: null, units: null, spacingM: null, coverageM: null, intensityMmHour: null, intervalDays: null },
    savedAt: null
  };
}

function normaliseDinProfile(raw) {
  const fallback = defaultDinProfile();
  if (!raw || typeof raw !== 'object') return fallback;
  return {
    ...fallback,
    ...raw,
    field: { ...fallback.field, ...(raw.field || {}) },
    soil: { ...fallback.soil, ...(raw.soil || {}) },
    irrigation: { ...fallback.irrigation, ...(raw.irrigation || {}), dailyRain: { ...fallback.irrigation.dailyRain, ...((raw.irrigation || {}).dailyRain || {}) }, actualIrrigation: { ...fallback.irrigation.actualIrrigation, ...((raw.irrigation || {}).actualIrrigation || {}) } }
  };
}

function readDinProfile() {
  try {
    return normaliseDinProfile(JSON.parse(sessionStorage.getItem(DIN_STORAGE_KEY) || 'null'));
  } catch (error) {
    return defaultDinProfile();
  }
}

function writeDinProfile(profile) {
  try {
    sessionStorage.setItem(DIN_STORAGE_KEY, JSON.stringify(profile));
  } catch (error) {
    console.warn('تعذر حفظ ملف DIN في جلسة المتصفح.', error);
  }
}

function operationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readOperations() {
  try {
    const raw = JSON.parse(localStorage.getItem(OPERATIONS_STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((record) => record && typeof record === 'object') : [];
  } catch (error) {
    return [];
  }
}

function writeOperations(records) {
  try { localStorage.setItem(OPERATIONS_STORAGE_KEY, JSON.stringify(records)); }
  catch (error) { console.warn('تعذر حفظ سجل العمليات محليًا.', error); }
}

function operationLabels() { return { land_preparation: 'تجهيز الأرض', planting: 'زراعة', transplanting: 'شتل', irrigation: 'ري', fertilization: 'تسميد', spraying: 'رش', weeding: 'تعشيب', pruning: 'تقليم', harvesting: 'حصاد', sorting: 'فرز', packaging: 'تعبئة', transport: 'نقل', storage: 'تخزين', other: 'أخرى' }; }
function operationInputLabels() { return { water: 'ماء', energy: 'طاقة', fertilizer: 'سماد', pesticide: 'مبيد', seed: 'بذار', seedling: 'شتول', labor: 'عمالة', machinery: 'آلة', packaging: 'عبوة', transport_service: 'خدمة نقل', other: 'أخرى' }; }
function operationStatusLabels() { return { planned: 'مخطط', estimated: 'تقديري', actual: 'فعلي', cancelled: 'ملغى', superseded: 'مستبدل' }; }
function operationSourceLabels() { return { user: 'المستخدم', invoice: 'فاتورة', advisor: 'مرشد', local_table: 'جدول محلي', history: 'سجل سابق', model: 'نموذج', other: 'أخرى' }; }

function currentOperationContext() {
  const crop = state.catalog?.records.find((item) => item.id === $('crop-select').value);
  const fieldName = $('field-code').value.trim() || $('field-name').value.trim() || 'field-unnamed';
  const fieldId = `field:${fieldName}`;
  const cropId = crop?.id || $('crop-select').value || null;
  const seasonStart = $('season-start').value || null;
  return { fieldId, fieldName, cropId, seasonStart, seasonId: `${fieldId}:${cropId || 'crop-unnamed'}:${seasonStart || 'season-unnamed'}` };
}

function currentOperationRecords() {
  const context = currentOperationContext();
  return state.operations.filter((record) => record.field_id === context.fieldId && record.season_id === context.seasonId);
}

function operationMoneyTotals(records, status) {
  const totals = {};
  records.filter((record) => record.record_status === status && record.total_cost != null && record.currency).forEach((record) => { totals[record.currency] = (totals[record.currency] || 0) + Number(record.total_cost); });
  return Object.entries(totals).map(([currency, amount]) => `${formatNumber(amount, 2)} ${currency}`).join(' · ') || '—';
}

function resetOperationForm() {
  $('operation-edit-id').value = '';
  $('operation-date').value = state.referenceDate || damascusToday();
  $('operation-type').value = 'land_preparation'; $('operation-input-type').value = 'other'; $('operation-status').value = 'planned';
  $('operation-quantity').value = ''; $('operation-unit').value = 'kg'; $('operation-unit-price').value = ''; $('operation-currency').value = '';
  $('operation-additional').value = '0'; $('operation-discount').value = '0'; $('operation-cost-basis').value = 'direct'; $('operation-source-type').value = 'user'; $('operation-description').value = '';
  $('operation-submit').textContent = 'إضافة السجل';
}

function renderOperationMetrics(records) {
  $('operations-total-actual').textContent = operationMoneyTotals(records, 'actual');
  $('operations-total-estimated').textContent = operationMoneyTotals(records, 'estimated');
  $('operations-total-planned').textContent = operationMoneyTotals(records, 'planned');
  $('operations-count').textContent = String(records.filter((record) => !['cancelled', 'superseded'].includes(record.record_status)).length);
  const status = $('operations-status'); status.className = `status-pill ${records.length ? 'success' : 'neutral'}`; status.textContent = records.length ? `${records.length} سجل محلي` : 'لا توجد سجلات';
}

function renderOperations() {
  const records = currentOperationRecords().sort((a, b) => String(b.event_date).localeCompare(String(a.event_date)) || String(b.created_at).localeCompare(String(a.created_at)));
  renderOperationMetrics(records);
  const body = $('operations-body');
  if (!records.length) { body.innerHTML = '<tr><td colspan="7" class="table-empty">لا توجد سجلات لهذا الحقل والموسم.</td></tr>'; return; }
  const operationNames = operationLabels(); const inputNames = operationInputLabels(); const statuses = operationStatusLabels(); const sources = operationSourceLabels();
  body.innerHTML = records.map((record) => {
    const cost = record.total_cost != null && record.currency ? `<span class="operation-cost">${formatNumber(record.total_cost, 2)}<small>${escapeHtml(record.currency)}</small></span>` : '—';
    const action = record.record_status === 'cancelled' ? 'ملغى' : `<button type="button" class="table-action operation-edit" data-operation-action="edit" data-operation-id="${escapeHtml(record.operation_id)}">تعديل</button><button type="button" class="table-action" data-operation-action="cancel" data-operation-id="${escapeHtml(record.operation_id)}">إلغاء</button>`;
    return `<tr><td class="table-date">${escapeHtml(formatIsoDate(record.event_date))}</td><td><b>${escapeHtml(operationNames[record.operation_type] || record.operation_type)}</b><small>${escapeHtml(inputNames[record.input_type] || record.input_type)}${record.description ? ` · ${escapeHtml(record.description)}` : ''}</small></td><td><span class="operation-status-chip ${escapeHtml(record.record_status)}">${escapeHtml(statuses[record.record_status] || record.record_status)}</span></td><td class="num">${record.quantity != null ? `${formatNumber(record.quantity, 3)} ${escapeHtml(record.unit || '')}` : '—'}</td><td>${cost}</td><td>${escapeHtml(sources[record.source_type] || record.source_type)}${record.source_ref ? `<small>${escapeHtml(record.source_ref)}</small>` : ''}</td><td>${action}</td></tr>`;
  }).join('');
}

function saveOperation(event) {
  event.preventDefault();
  const quantity = optionalNumber('operation-quantity'); const unitPrice = optionalNumber('operation-unit-price');
  const additionalCost = optionalNumber('operation-additional') ?? 0; const discount = optionalNumber('operation-discount') ?? 0; const currency = $('operation-currency').value.trim();
  if (unitPrice != null && (quantity == null || !currency)) { $('operation-message').className = 'data-message error-message'; $('operation-message').textContent = 'عند إدخال سعر وحدي يجب إدخال الكمية والعملة أيضًا.'; return; }
  if (additionalCost < 0 || discount < 0 || !$('operation-date').value) return;
  const context = currentOperationContext(); const now = new Date().toISOString(); const editId = $('operation-edit-id').value; const previous = state.operations.find((record) => record.operation_id === editId);
  const subtotal = quantity != null && unitPrice != null ? quantity * unitPrice : null; const totalCost = subtotal != null ? subtotal + additionalCost - discount : null;
  const record = { operation_id: editId || operationId(), field_id: context.fieldId, season_id: context.seasonId, crop_id: context.cropId, operation_type: $('operation-type').value, input_type: $('operation-input-type').value, description: $('operation-description').value.trim(), event_date: $('operation-date').value, planned_or_actual: $('operation-status').value, record_status: $('operation-status').value, quantity, unit: $('operation-unit').value, unit_price: unitPrice, currency: currency || null, subtotal: subtotal == null ? null : round(subtotal, 4), additional_cost: round(additionalCost, 4), discount: round(discount, 4), total_cost: totalCost == null ? null : round(totalCost, 4), cost_basis: $('operation-cost-basis').value, allocation_method: $('operation-cost-basis').value === 'allocated' ? 'custom' : 'none', source_type: $('operation-source-type').value, source_ref: $('operation-description').value.trim() || null, linked_record_ids: previous?.linked_record_ids || [], notes: null, created_at: previous?.created_at || now, updated_at: now };
  const index = state.operations.findIndex((item) => item.operation_id === record.operation_id);
  if (index >= 0) state.operations[index] = record; else state.operations.push(record);
  writeOperations(state.operations); resetOperationForm(); renderOperations(); $('operation-message').className = 'data-message neutral-message'; $('operation-message').textContent = 'تم حفظ السجل محليًا. لا يدخل التقديري أو المخطط في مؤشرات التكلفة الفعلية.';
}

function editOperation(record) {
  $('operation-edit-id').value = record.operation_id; $('operation-date').value = record.event_date || ''; $('operation-type').value = record.operation_type || 'other'; $('operation-input-type').value = record.input_type || 'other'; $('operation-status').value = ['planned', 'estimated', 'actual'].includes(record.record_status) ? record.record_status : 'estimated'; $('operation-quantity').value = record.quantity ?? ''; $('operation-unit').value = record.unit || 'kg'; $('operation-unit-price').value = record.unit_price ?? ''; $('operation-currency').value = record.currency || ''; $('operation-additional').value = record.additional_cost ?? 0; $('operation-discount').value = record.discount ?? 0; $('operation-cost-basis').value = record.cost_basis || 'direct'; $('operation-source-type').value = record.source_type || 'user'; $('operation-description').value = record.description || record.source_ref || ''; $('operation-submit').textContent = 'حفظ تعديل السجل'; $('operation-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function handleOperationTable(event) {
  const button = event.target.closest('[data-operation-action]'); if (!button) return;
  const record = state.operations.find((item) => item.operation_id === button.dataset.operationId); if (!record) return;
  if (button.dataset.operationAction === 'edit') editOperation(record);
  if (button.dataset.operationAction === 'cancel') { record.record_status = 'cancelled'; record.planned_or_actual = 'actual'; record.updated_at = new Date().toISOString(); writeOperations(state.operations); renderOperations(); }
}

function exportOperations() {
  const context = currentOperationContext(); const payload = { schema_version: 'production_operations_costs_v0.1', record_type: 'production_operations_costs', exported_at: new Date().toISOString(), identity: context, records: currentOperationRecords() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `production_operations_${context.seasonId.replace(/[^a-z0-9_-]+/gi, '_')}.json`; link.click(); URL.revokeObjectURL(url);
}

function importOperations(event) {
  const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result); const records = Array.isArray(parsed) ? parsed : parsed.records; if (!Array.isArray(records)) throw new Error('لا توجد قائمة records صالحة.');
      const context = currentOperationContext(); const valid = records.filter((record) => record && record.operation_id && record.field_id === context.fieldId && record.season_id === context.seasonId && record.event_date); const existingIds = new Set(state.operations.map((record) => record.operation_id));
      valid.forEach((record) => { if (existingIds.has(record.operation_id)) { const index = state.operations.findIndex((item) => item.operation_id === record.operation_id); state.operations[index] = record; } else state.operations.push(record); });
      writeOperations(state.operations); renderOperations(); $('operation-message').className = 'data-message neutral-message'; $('operation-message').textContent = `تم استيراد ${valid.length} سجلًا مطابقًا للحقل والموسم الحاليين.`;
    } catch (error) { $('operation-message').className = 'data-message error-message'; $('operation-message').textContent = `تعذر استيراد الملف: ${error.message}`; }
    event.target.value = '';
  }; reader.readAsText(file);
}

function optionalNumber(id) {
  const raw = $(id).value.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readDinForm() {
  return normaliseDinProfile({
    version: '0.1.0',
    field: {
      name: $('field-name').value.trim(),
      area: optionalNumber('field-area'),
      areaUnit: $('field-area-unit').value,
      code: $('field-code').value.trim()
    },
    soil: {
      texture: $('soil-texture').value,
      rootDepthCm: optionalNumber('soil-root-depth'),
      fieldCapacity: optionalNumber('soil-field-capacity'),
      wiltingPoint: optionalNumber('soil-wilting-point'),
      mad: optionalNumber('soil-mad'),
      initialState: $('soil-initial-state').value,
      initialDeficitMm: optionalNumber('soil-initial-deficit'),
      carryoverStorageMm: state.din?.soil?.carryoverStorageMm ?? null,
      ph: optionalNumber('soil-ph'),
      ec: optionalNumber('soil-ec'),
      organicMatter: optionalNumber('soil-organic-matter'),
      n: optionalNumber('soil-n'),
      p: optionalNumber('soil-p'),
      k: optionalNumber('soil-k')
    },
    irrigation: {
      method: $('irrigation-method').value,
      coverageCoefficient: optionalNumber('coverage-coefficient'),
      efficiency: optionalNumber('irrigation-efficiency'),
      weeklyRain: optionalNumber('weekly-rain'),
      dailyRain: { ...(state.din?.irrigation?.dailyRain || {}) },
      actualIrrigation: { ...(state.din?.irrigation?.actualIrrigation || {}) },
      dischargeLph: optionalNumber('irrigation-discharge'),
      units: optionalNumber('irrigation-units'),
      spacingM: optionalNumber('irrigation-spacing'),
      coverageM: optionalNumber('irrigation-coverage'),
      intensityMmHour: optionalNumber('irrigation-intensity'),
      intervalDays: optionalNumber('irrigation-interval')
    }
  });
}

function assignInput(id, value) {
  $(id).value = value == null ? '' : value;
}

function populateDinForm(profile) {
  const data = normaliseDinProfile(profile);
  assignInput('field-name', data.field.name);
  assignInput('field-area', data.field.area);
  assignInput('field-area-unit', data.field.areaUnit);
  assignInput('field-code', data.field.code);
  assignInput('soil-texture', data.soil.texture);
  assignInput('soil-root-depth', data.soil.rootDepthCm);
  assignInput('soil-field-capacity', data.soil.fieldCapacity);
  assignInput('soil-wilting-point', data.soil.wiltingPoint);
  assignInput('soil-mad', data.soil.mad);
  assignInput('soil-initial-state', data.soil.initialState || 'field_capacity');
  assignInput('soil-initial-deficit', data.soil.initialDeficitMm);
  assignInput('soil-ph', data.soil.ph);
  assignInput('soil-ec', data.soil.ec);
  assignInput('soil-organic-matter', data.soil.organicMatter);
  assignInput('soil-n', data.soil.n);
  assignInput('soil-p', data.soil.p);
  assignInput('soil-k', data.soil.k);
  assignInput('irrigation-method', data.irrigation.method);
  assignInput('coverage-coefficient', data.irrigation.coverageCoefficient == null ? 1 : data.irrigation.coverageCoefficient);
  assignInput('irrigation-efficiency', data.irrigation.efficiency == null ? defaultIrrigationEfficiency(data.irrigation.method) : data.irrigation.efficiency);
  assignInput('weekly-rain', data.irrigation.weeklyRain);
  assignInput('irrigation-discharge', data.irrigation.dischargeLph);
  assignInput('irrigation-units', data.irrigation.units);
  assignInput('irrigation-spacing', data.irrigation.spacingM);
  assignInput('irrigation-coverage', data.irrigation.coverageM);
  assignInput('irrigation-intensity', data.irrigation.intensityMmHour);
  assignInput('irrigation-interval', data.irrigation.intervalDays);
}

const dinAreaLabels = { dunum: 'دونم', hectare: 'هكتار', m2: 'م²' };
const dinTextureLabels = { sandy: 'رملية', loamy: 'طميية', clay_loam: 'طينية مزيجة', clayey: 'طينية' };
const dinIrrigationLabels = { surface: 'سطحي / أخاديد', sprinkler: 'رذاذ / مرش', drip_gr: 'تنقيط GR', external_emitters: 'نقاطات خارجية', other: 'أخرى' };
const dinEfficiencyDefaults = { surface: 0.65, sprinkler: 0.75, drip_gr: 0.85, external_emitters: 0.85, other: 0.75 };
const DIN_KR_DEFAULT = 1;

function defaultIrrigationEfficiency(method) {
  return dinEfficiencyDefaults[method] ?? null;
}

function updateEfficiencyHint(applyDefault = false) {
  const method = $('irrigation-method').value;
  const defaultValue = defaultIrrigationEfficiency(method);
  if (applyDefault && defaultValue != null) assignInput('irrigation-efficiency', defaultValue);
  $('efficiency-hint').textContent = defaultValue == null
    ? 'اختر طريقة الري لإظهار قيمة ابتدائية قابلة للتعديل'
    : `الافتراضي المقترح لهذه الطريقة: ${formatNumber(defaultValue, 2)} · قابل للتعديل`;
}

function calculateSoilWater(profile) {
  const soil = profile.soil;
  const depth = Number(soil.rootDepthCm);
  const fc = Number(soil.fieldCapacity);
  const wp = Number(soil.wiltingPoint);
  const mad = Number(soil.mad);
  if (![depth, fc, wp, mad].every(Number.isFinite) || depth <= 0 || fc < wp || mad < 0 || mad > 1) {
    return { taw: null, raw: null };
  }
  const taw = (fc - wp) * depth * 0.1;
  return { taw, raw: taw * mad };
}

function areaToHectares(area, unit) {
  if (!Number.isFinite(area) || area <= 0) return null;
  if (unit === 'hectare') return area;
  if (unit === 'm2') return area / 10000;
  return area * 0.1;
}

function simulateDailySoilWater(profile, rows, referenceDate) {
  const water = calculateSoilWater(profile);
  if (water.taw == null) return { rows: [], taw: null, raw: null, reason: 'أكمل FC وWP وعمق الجذور وMAD' };
  const coverage = Number(profile.irrigation.coverageCoefficient);
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1) return { rows: [], taw: water.taw, raw: water.raw, reason: 'أدخل معامل التغطية C بين 0 و1' };
  const dailyRain = profile.irrigation.dailyRain || {};
  const actualIrrigation = profile.irrigation.actualIrrigation || {};
  const irrigationEfficiency = Number(profile.irrigation.efficiency);
  const efficiency = Number.isFinite(irrigationEfficiency) && irrigationEfficiency > 0 && irrigationEfficiency <= 1 ? irrigationEfficiency : 1;
  const initialState = profile.soil.initialState || 'field_capacity';
  const initialDeficit = Number(profile.soil.initialDeficitMm);
  const carryoverStorage = Number(profile.soil.carryoverStorageMm);
  let storage = water.taw;
  if (initialState === 'manual_deficit' && Number.isFinite(initialDeficit)) storage = Math.max(0, Math.min(water.taw, water.taw - initialDeficit));
  if (initialState === 'carryover' && Number.isFinite(carryoverStorage)) storage = Math.max(0, Math.min(water.taw, carryoverStorage));
  const initialStorage = storage;
  const simulated = (rows || [])
    .filter((row) => row.date <= (referenceDate || '9999-12-31') && row.etc != null)
    .map((row) => {
      const etcAdjusted = row.etc * DIN_KR_DEFAULT * coverage;
      const hasManualRain = Object.prototype.hasOwnProperty.call(dailyRain, row.date);
      const storedRain = hasManualRain ? Number(dailyRain[row.date]) : Number(row.rain || 0);
      const rain = Number.isFinite(storedRain) && storedRain >= 0 ? storedRain : 0;
      const effectiveRain = Math.min(rain, Math.max(0, water.taw - storage));
      const irrigationEntry = actualIrrigation[row.date] || {};
      const enteredAmount = Number(irrigationEntry.amountMm);
      const enteredHours = Number(irrigationEntry.hours);
      const intensity = Number(profile.irrigation.intensityMmHour);
      const irrigationGross = Number.isFinite(enteredAmount) && enteredAmount >= 0
        ? enteredAmount
        : Number.isFinite(enteredHours) && enteredHours >= 0 && Number.isFinite(intensity) && intensity > 0 ? enteredHours * intensity : 0;
      const irrigationEffective = Math.min(irrigationGross * efficiency, Math.max(0, water.taw - storage - effectiveRain));
      storage = Math.max(0, Math.min(water.taw, storage + effectiveRain + irrigationEffective - etcAdjusted));
      const moisturePct = Math.max(0, Math.min(100, (storage / water.taw) * 100));
      const depletion = water.taw - storage;
      return {
        ...row,
        rainInput: rain,
        rainSource: hasManualRain ? 'manual' : 'weather',
        etcAdjusted,
        effectiveRain,
        irrigationGross,
        irrigationEffective,
        soilWaterMm: storage,
        soilMoisturePct: moisturePct,
        depletion,
        madReached: water.raw != null && depletion >= water.raw
      };
    });
  return { rows: simulated, taw: water.taw, raw: water.raw, initialStorage, finalStorage: simulated.at(-1)?.soilWaterMm ?? initialStorage, reason: null };
}

function calculateWeeklyDinBalance(profile, rows, referenceDate) {
  const simulation = simulateDailySoilWater(profile, rows, referenceDate);
  const eligible = simulation.rows.length ? simulation.rows.slice(-7) : (rows || []).filter((row) => row.date <= (referenceDate || '9999-12-31') && row.etc != null).slice(-7);
  const weeklyEtc = eligible.length ? eligible.reduce((sum, row) => sum + row.etc, 0) : null;
  const asNumber = (value) => value == null || value === '' ? null : Number(value);
  const coverage = asNumber(profile.irrigation.coverageCoefficient);
  const weeklyRain = asNumber(profile.irrigation.weeklyRain);
  const efficiency = asNumber(profile.irrigation.efficiency);
  const intensity = asNumber(profile.irrigation.intensityMmHour);
  const coveredDemand = eligible.length && simulation.rows.length ? eligible.reduce((sum, row) => sum + row.etcAdjusted, 0) : weeklyEtc != null && Number.isFinite(coverage) ? weeklyEtc * DIN_KR_DEFAULT * coverage : null;
  const effectiveRain = eligible.length && simulation.rows.length ? eligible.reduce((sum, row) => sum + row.effectiveRain, 0) : coveredDemand != null && Number.isFinite(weeklyRain) ? Math.min(Math.max(0, weeklyRain), coveredDemand) : null;
  const netNeed = coveredDemand != null && effectiveRain != null ? Math.max(0, coveredDemand - effectiveRain) : null;
  const grossNeed = netNeed != null && Number.isFinite(efficiency) && efficiency > 0 && efficiency <= 1 ? netNeed / efficiency : null;
  const areaHa = areaToHectares(asNumber(profile.field.area), profile.field.areaUnit);
  const volume = grossNeed != null && areaHa != null ? grossNeed * areaHa * 10 : null;
  const hours = grossNeed != null && Number.isFinite(intensity) && intensity > 0 ? grossNeed / intensity : null;
  return { weeklyEtc, effectiveRain, netNeed, grossNeed, volume, hours, eligibleDays: eligible.length, usedForecast: eligible.some((row) => row.state === 'forecast'), dailySimulation: simulation };
}

function updateRootDepthHint() {
  const crop = state.catalog?.records.find((item) => item.id === $('crop-select').value);
  if (!crop) return;
  const range = crop.root_depth_cm_min === crop.root_depth_cm_max
    ? `${crop.root_depth_cm_min} سم`
    : `${crop.root_depth_cm_min}–${crop.root_depth_cm_max} سم`;
  $('root-depth-hint').textContent = `المرجع المحلي لـ${crop.name_ar}: ${range} · يمكن تعديله من تحليل الحقل`;
}

function renderDinBalance(profile, rows = state.rows, referenceDate = state.referenceDate) {
  const result = calculateWeeklyDinBalance(profile, rows, referenceDate);
  $('din-weekly-etc').textContent = result.weeklyEtc != null ? `${formatNumber(result.weeklyEtc, 2)} ملم` : '—';
  $('din-effective-rain').textContent = result.effectiveRain != null ? `${formatNumber(result.effectiveRain, 2)} ملم` : '—';
  $('din-net-need').textContent = result.netNeed != null ? `${formatNumber(result.netNeed, 2)} ملم` : '—';
  $('din-gross-need').textContent = result.grossNeed != null ? `${formatNumber(result.grossNeed, 2)} ملم` : '—';
  $('din-water-volume').textContent = result.volume != null ? `${formatNumber(result.volume, 2)} م³` : '—';
  $('din-irrigation-hours').textContent = result.hours != null ? `${formatNumber(result.hours, 2)} سا` : '—';
  const status = $('din-balance-status');
  if (result.weeklyEtc == null) {
    status.className = 'status-pill neutral';
    status.textContent = 'بانتظار ETc';
  } else if (profile.irrigation.coverageCoefficient == null) {
    status.className = 'status-pill neutral';
    status.textContent = 'أدخل معامل C';
  } else if (profile.irrigation.weeklyRain == null) {
    status.className = 'status-pill neutral';
    status.textContent = 'أدخل المطر الأسبوعي';
  } else if (profile.irrigation.efficiency == null) {
    status.className = 'status-pill neutral';
    status.textContent = 'أدخل كفاءة الري';
  } else if (result.netNeed == null) {
    status.className = 'status-pill neutral';
    status.textContent = 'راجع مدخلات الميزان';
  } else if (result.volume == null) {
    status.className = 'status-pill neutral';
    status.textContent = 'أدخل مساحة الحقل';
  } else if (result.hours == null) {
    status.className = 'status-pill neutral';
    status.textContent = 'أدخل كثافة التطبيق';
  } else if (result.usedForecast) {
    status.className = 'status-pill loading';
    status.textContent = 'حساب يتضمن توقعًا';
  } else {
    status.className = 'status-pill success';
    status.textContent = 'حساب أولي';
  }
}

function renderDailySoilSimulation(profile, rows = state.rows, referenceDate = state.referenceDate) {
  const result = simulateDailySoilWater(profile, rows, referenceDate);
  const body = $('din-daily-body');
  const status = $('din-daily-status');
  if (!result.rows.length) {
    status.className = 'status-pill neutral';
    status.textContent = result.reason || 'بانتظار بيانات الطقس';
    body.innerHTML = `<tr><td colspan="8" class="table-empty">${escapeHtml(result.reason || 'لا توجد أيام قابلة للمحاكاة بعد.')}</td></tr>`;
    $('din-soil-chart').innerHTML = '<div class="empty-state">سيظهر الرسم بعد اكتمال خصائص التربة والطقس.</div>';
    return;
  }
  const madReached = result.rows.some((row) => row.madReached);
  status.className = madReached ? 'status-pill loading' : 'status-pill success';
  status.textContent = madReached ? 'تجاوز RAW في يوم أو أكثر' : 'الرصيد ضمن RAW';
  body.innerHTML = result.rows.map((row) => `<tr>
    <td class="table-date">${escapeHtml(dateLabel(row.date))}</td>
    <td class="num">${formatNumber(row.etcAdjusted, 2)}</td>
    <td class="num"><span class="rain-cell ${row.rainSource === 'manual' ? 'manual-rain' : ''}">${formatNumber(row.rainInput, 2)}<small>${row.rainSource === 'manual' ? 'يدوي' : 'طقس'}</small></span></td>
    <td class="num">${formatNumber(row.effectiveRain, 2)}</td>
    <td class="num"><span class="rain-cell ${row.irrigationGross > 0 ? 'manual-rain' : ''}">${formatNumber(row.irrigationGross, 2)}<small>${row.irrigationGross > 0 ? 'فعلي' : '—'}</small></span></td>
    <td class="num"><b>${formatNumber(row.soilWaterMm, 2)}</b></td>
    <td class="num">${formatNumber(row.soilMoisturePct, 1)}%</td>
    <td><span class="stage-chip ${row.madReached ? 'soil-alert' : ''}">${row.madReached ? 'بلغ RAW' : 'ضمن الحد'}</span></td>
  </tr>`).join('');
  renderSoilChart(result.rows, result.taw, result.raw);
  $('soil-carryover-note').textContent = `بداية المحاكاة: ${formatNumber(result.initialStorage, 2)} ملم · نهاية الفترة: ${formatNumber(result.finalStorage, 2)} ملم`;
}

function renderSoilChart(rows, taw, raw) {
  const chart = $('din-soil-chart');
  if (!rows.length || taw == null) { chart.innerHTML = '<div class="empty-state">سيظهر الرسم بعد اكتمال خصائص التربة والطقس.</div>'; return; }
  const width = 860, height = 230, left = 45, right = 18, top = 24, bottom = 34;
  const max = Math.max(1, taw) * 1.08;
  const x = (index) => left + index * ((width - left - right) / Math.max(1, rows.length - 1));
  const y = (value) => height - bottom - (value / max) * (height - top - bottom);
  const path = rows.map((row, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(row.soilWaterMm).toFixed(1)}`).join(' ');
  const rawLine = raw != null ? `<line class="soil-raw-line" x1="${left}" x2="${width - right}" y1="${y(taw - raw)}" y2="${y(taw - raw)}" /><text class="soil-chart-note" x="${width - right}" y="${y(taw - raw) - 5}" text-anchor="end">حد RAW</text>` : '';
  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="تغير ماء التربة مع TAW وRAW"><line class="soil-taw-line" x1="${left}" x2="${width - right}" y1="${y(taw)}" y2="${y(taw)}" /><text class="soil-chart-note" x="${width - right}" y="${y(taw) - 5}" text-anchor="end">TAW</text>${rawLine}<path class="soil-water-path" d="${path}" />${rows.map((row, index) => `<circle class="soil-water-point" cx="${x(index)}" cy="${y(row.soilWaterMm)}" r="3"><title>${escapeHtml(row.date)}: ${formatNumber(row.soilWaterMm, 2)} ملم</title></circle>`).join('')}</svg>`;
}

function renderRainEntries(profile) {
  const entries = Object.entries(profile.irrigation.dailyRain || {}).sort(([a], [b]) => a.localeCompare(b));
  $('rain-entry-count').textContent = entries.length ? `${entries.length} إدخال` : 'لا توجد إدخالات';
  $('rain-entry-body').innerHTML = entries.length ? entries.map(([date, amount]) => `<tr><td class="table-date">${escapeHtml(date)}</td><td class="num">${formatNumber(amount, 2)}</td><td><button class="table-action rain-delete" type="button" data-date="${escapeHtml(date)}">حذف</button></td></tr>`).join('') : '<tr><td colspan="3" class="table-empty">لا توجد إدخالات يدوية بعد.</td></tr>';
}

function renderIrrigationEntries(profile) {
  const entries = Object.entries(profile.irrigation.actualIrrigation || {}).sort(([a], [b]) => a.localeCompare(b));
  $('irrigation-entry-count').textContent = entries.length ? `${entries.length} إدخال` : 'لا توجد إدخالات';
  $('irrigation-entry-body').innerHTML = entries.length ? entries.map(([date, entry]) => `<tr><td class="table-date">${escapeHtml(date)}</td><td class="num">${formatNumber(entry.amountMm, 2)}</td><td class="num">${entry.hours != null ? formatNumber(entry.hours, 1) : '—'}</td><td><button class="table-action irrigation-delete" type="button" data-date="${escapeHtml(date)}">حذف</button></td></tr>`).join('') : '<tr><td colspan="4" class="table-empty">لا توجد إدخالات فعلية بعد.</td></tr>';
}

function refreshDinDisplays() {
  renderDinSummary(state.din, state.rows, state.referenceDate);
  renderDailySoilSimulation(state.din, state.rows, state.referenceDate);
  renderRainEntries(state.din);
  renderIrrigationEntries(state.din);
  renderFertilizerRecommendation(state.din);
}

function addDailyRain(event) {
  event.preventDefault();
  const date = $('rain-entry-date').value;
  const amount = optionalNumber('rain-entry-amount');
  if (!date || amount == null || amount < 0) return;
  const profile = normaliseDinProfile(state.din);
  profile.irrigation.dailyRain[date] = amount;
  state.din = profile;
  writeDinProfile(profile);
  refreshDinDisplays();
}

function deleteDailyRain(event) {
  const button = event.target.closest('.rain-delete');
  if (!button) return;
  const profile = normaliseDinProfile(state.din);
  delete profile.irrigation.dailyRain[button.dataset.date];
  state.din = profile;
  writeDinProfile(profile);
  refreshDinDisplays();
}

function openRainModal() {
  const modal = $('rain-modal');
  $('rain-entry-date').value = state.referenceDate || damascusToday();
  renderRainEntries(state.din);
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
}

function addActualIrrigation(event) {
  event.preventDefault();
  const date = $('irrigation-entry-date').value;
  const amount = optionalNumber('irrigation-entry-amount');
  const hours = optionalNumber('irrigation-entry-hours');
  if (!date || amount == null || amount < 0 || (hours != null && hours < 0)) return;
  const profile = normaliseDinProfile(state.din);
  profile.irrigation.actualIrrigation[date] = { amountMm: amount, hours };
  state.din = profile;
  writeDinProfile(profile);
  refreshDinDisplays();
}

function deleteActualIrrigation(event) {
  const button = event.target.closest('.irrigation-delete');
  if (!button) return;
  const profile = normaliseDinProfile(state.din);
  delete profile.irrigation.actualIrrigation[button.dataset.date];
  state.din = profile;
  writeDinProfile(profile);
  refreshDinDisplays();
}

function openIrrigationModal() {
  const modal = $('irrigation-modal');
  $('irrigation-entry-date').value = state.referenceDate || damascusToday();
  renderIrrigationEntries(state.din);
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
}

function fertilizerCategory(crop) { return crop?.group_ar === 'الأشجار المثمرة' ? 'tree' : 'crop'; }

function fertilizerClassify(value, type, category, levels) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  let index = 0;
  if (type === 'nitrogen') index = number < 5 ? 0 : number <= 9 ? 1 : number <= 15 ? 2 : number <= 19 ? 3 : 4;
  if (type === 'phosphorus') index = category === 'tree' ? (number < 3 ? 0 : number <= 6 ? 1 : number <= 9 ? 2 : number <= 12 ? 3 : number <= 15 ? 4 : number <= 18 ? 5 : 6) : (number < 3 ? 0 : number <= 5 ? 1 : number <= 7 ? 2 : number <= 9 ? 3 : number <= 12 ? 4 : 5);
  if (type === 'potassium') index = category === 'tree' ? (number < 60 ? 0 : number <= 120 ? 1 : number <= 180 ? 2 : number <= 240 ? 3 : number <= 300 ? 4 : number <= 360 ? 5 : number <= 420 ? 6 : 7) : (number < 60 ? 0 : number <= 120 ? 1 : number <= 160 ? 2 : number <= 240 ? 3 : number <= 250 ? 4 : number <= 260 ? 5 : number <= 420 ? 6 : 7);
  const level = levels?.[type]?.[index];
  return level ? { index, ...level } : null;
}

function fertilizerOrganicFactor(value) { return value < 1 ? 1.2 : value <= 2 ? 1 : value <= 3 ? 0.9 : 0.7; }

function fertilizerUnit(profile) {
  const areaUnit = profile.field.areaUnit;
  if (areaUnit === 'hectare') return { label: 'كغ/هكتار', divisor: 1 };
  if (areaUnit === 'm2') return { label: 'كغ/م²', divisor: 10000 };
  return { label: 'كغ/دونم', divisor: 10 };
}

function fertilizerRecommendation(profile = state.din) {
  const crop = state.catalog?.records.find((item) => item.id === $('crop-select').value);
  const mapping = state.fertilizerMap?.entries.find((item) => item.crop_id === crop?.id);
  if (!crop || !mapping || !state.fertilizerProfiles) return { status: 'missing', reason: 'لم تُحمّل قاعدة التسميد أو لا يوجد ربط للمحصول.' };
  if (mapping.mapping_status === 'no_direct_profile') return { status: 'blocked', crop, mapping, reason: mapping.notes_ar };
  const category = fertilizerCategory(crop);
  const mode = $('fertilizer-water-mode')?.value || 'irrigated';
  const profileKey = mapping.soilfert_profiles[mode] ? mode : (mapping.default_profile || Object.keys(mapping.soilfert_profiles)[0]);
  const profileName = mapping.soilfert_profiles[profileKey];
  const list = category === 'tree' ? state.fertilizerProfiles.trees : state.fertilizerProfiles.crops;
  const item = list.find((candidate) => candidate.name === profileName);
  if (!item) return { status: 'blocked', crop, mapping, reason: `ملف SoilFert «${profileName}» غير موجود في القاعدة المحلية.` };
  const values = { nitrogen: optionalNumber('soil-n'), phosphorus: optionalNumber('soil-p'), potassium: optionalNumber('soil-k'), organic: optionalNumber('soil-organic-matter') };
  if (Object.values(values).some((value) => value == null)) return { status: 'incomplete', crop, mapping, item, profileName, values, reason: 'أدخل N وP وK والمادة العضوية لإظهار التوصية.' };
  const levels = state.fertilizerProfiles.levels;
  const categoryLevels = levels[category];
  const diagnosis = { nitrogen: fertilizerClassify(values.nitrogen, 'nitrogen', category, categoryLevels), phosphorus: fertilizerClassify(values.phosphorus, 'phosphorus', category, categoryLevels), potassium: fertilizerClassify(values.potassium, 'potassium', category, categoryLevels), organic: values.organic < 1 ? levels.organic[0] : values.organic <= 2 ? levels.organic[1] : values.organic <= 3 ? levels.organic[2] : levels.organic[3] };
  const indexes = { nitrogen: diagnosis.nitrogen.index, phosphorus: diagnosis.phosphorus.index, potassium: diagnosis.potassium.index };
  const base = { nitrogen: item.n[indexes.nitrogen] || 0, phosphorus: item.p[indexes.phosphorus] || 0, potassium: item.k[indexes.potassium] || 0 };
  const treeAge = category === 'tree' ? ($('fertilizer-tree-age')?.value || 'mature') : 'mature';
  const treeFactor = category === 'tree' ? (state.fertilizerProfiles.irrigationFactors[mode === 'rainfed' ? 'rainfed' : 'irrigated'] || 1) * (state.fertilizerProfiles.ageFactors[treeAge] || 1) : 1;
  const adjusted = { nitrogen: base.nitrogen * fertilizerOrganicFactor(values.organic) * treeFactor, phosphorus: base.phosphorus * treeFactor, potassium: base.potassium * treeFactor };
  const unit = fertilizerUnit(profile);
  const amounts = { nitrogen: adjusted.nitrogen / unit.divisor, phosphorus: adjusted.phosphorus / unit.divisor, potassium: adjusted.potassium / unit.divisor };
  const fertilizer = { urea: amounts.nitrogen / state.fertilizerProfiles.fertilizerRates.urea.factor, superPhosphate: amounts.phosphorus / state.fertilizerProfiles.fertilizerRates.superPhosphate.factor, potassiumSulfate: amounts.potassium / state.fertilizerProfiles.fertilizerRates.potassiumSulfate.factor };
  return { status: mapping.mapping_status === 'fallback_group' ? 'fallback' : 'ready', crop, mapping, item, profileName, values, diagnosis, base, adjusted: amounts, fertilizer, unit, category, mode, treeAge, treeFactor, omFactor: fertilizerOrganicFactor(values.organic) };
}

function renderFertilizerRecommendation(profile = state.din) {
  const status = $('fertilizer-status');
  const note = $('fertilizer-note');
  const profileName = $('fertilizer-profile-name');
  const diagnosisNode = $('fertilizer-diagnosis');
  const recommendationNode = $('fertilizer-recommendation');
  if (!status || !state.fertilizerProfiles) return;
  const result = fertilizerRecommendation(profile);
  profileName.textContent = result.profileName || 'لا يوجد ملف مباشر';
  if (result.status === 'incomplete' || result.status === 'missing') {
    status.className = 'status-pill neutral'; status.textContent = 'بيانات ناقصة'; note.textContent = result.reason; diagnosisNode.innerHTML = ''; recommendationNode.innerHTML = ''; return;
  }
  if (result.status === 'blocked') {
    status.className = 'status-pill error'; status.textContent = 'التوصية متوقفة'; note.textContent = `${result.reason} لا يصدر المحرك جرعة تلقائية.`; diagnosisNode.innerHTML = ''; recommendationNode.innerHTML = ''; return;
  }
  const warning = result.status === 'fallback';
  status.className = `status-pill ${warning ? 'loading' : 'success'}`; status.textContent = warning ? 'ربط بديل · مراجعة مطلوبة' : 'توصية إرشادية';
  note.textContent = `${result.mapping.notes_ar} القيم إرشادية، وتفترض توافق وحدات التحليل مع SoilFert؛ راجع المختص قبل التنفيذ.`;
  const labels = { nitrogen: 'N', phosphorus: 'P₂O₅', potassium: 'K₂O', organic: 'OM' };
  diagnosisNode.innerHTML = Object.entries(result.diagnosis).map(([key, value]) => `<div class="fert-diagnosis-card"><span>${labels[key]}</span><strong>${escapeHtml(value.label)}</strong><small>${formatNumber(result.values[key], 1)} · ${escapeHtml(value.range)}</small></div>`).join('');
  recommendationNode.innerHTML = [['N','النيتروجين',result.adjusted.nitrogen],['P₂O₅','الفوسفور',result.adjusted.phosphorus],['K₂O','البوتاسيوم',result.adjusted.potassium],['يوريا 46%','يوريا',result.fertilizer.urea],['سوبر فوسفات 18%','سوبر فوسفات',result.fertilizer.superPhosphate],['سلفات بوتاسيوم 50%','سلفات بوتاسيوم',result.fertilizer.potassiumSulfate]].map(([symbol,name,amount]) => `<div class="fert-recommendation-card"><span>${symbol}</span><strong>${formatNumber(amount, 1)}</strong><small>${name} · ${result.unit.label}</small></div>`).join('');
}

function saveSoilCarryover() {
  const result = simulateDailySoilWater(state.din, state.rows, state.referenceDate);
  if (!result.rows.length || result.finalStorage == null) return;
  const profile = normaliseDinProfile(state.din);
  profile.soil.carryoverStorageMm = result.finalStorage;
  profile.soil.initialState = 'carryover';
  state.din = profile;
  writeDinProfile(profile);
  populateDinForm(profile);
  refreshDinDisplays();
}

function renderDinSummary(profile, rows = state.rows, referenceDate = state.referenceDate) {
  const data = normaliseDinProfile(profile);
  const area = data.field.area != null ? `${formatNumber(data.field.area, 2)} ${dinAreaLabels[data.field.areaUnit] || ''}` : '—';
  const soilParts = [];
  if (data.soil.texture) soilParts.push(dinTextureLabels[data.soil.texture] || data.soil.texture);
  if (data.soil.rootDepthCm != null) soilParts.push(`${formatNumber(data.soil.rootDepthCm, 0)} سم جذور`);
  if (data.soil.ph != null) soilParts.push(`pH ${formatNumber(data.soil.ph, 2)}`);
  const irrigation = dinIrrigationLabels[data.irrigation.method] || 'غير محددة';
  const water = calculateSoilWater(data);
  $('din-summary-field').textContent = data.field.name || '—';
  $('din-summary-area').textContent = area;
  $('din-summary-soil').textContent = soilParts.length ? soilParts.join(' · ') : 'لم يُدخل بعد';
  $('din-summary-irrigation').textContent = data.irrigation.method
    ? `${irrigation} · C=${formatNumber(data.irrigation.coverageCoefficient, 2)}`
    : 'غير محددة';
  $('din-summary-interval').textContent = data.irrigation.intervalDays != null ? `${formatNumber(data.irrigation.intervalDays, 0)} يوم` : '—';
  $('din-taw').textContent = water.taw != null ? `${formatNumber(water.taw, 2)} ملم` : '—';
  $('din-raw').textContent = water.raw != null ? `${formatNumber(water.raw, 2)} ملم` : '—';
  $('din-rain-input').textContent = data.irrigation.weeklyRain != null ? `${formatNumber(data.irrigation.weeklyRain, 1)} ملم` : '—';
  renderDinBalance(data, rows, referenceDate);
  renderDailySoilSimulation(data, rows, referenceDate);
  renderFertilizerRecommendation(data);
  const message = $('din-message');
  if (data.savedAt) {
    const saved = new Intl.DateTimeFormat('ar-SY', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date(data.savedAt));
    message.className = 'data-message neutral-message';
    message.textContent = `تم حفظ ملف DIN في جلسة المتصفح عند ${saved}. المدخلات لا تغيّر ET0 أو Kc أو ETc؛ وTAW/RAW مؤشرات تقديرية عند اكتمال خصائص التربة.`;
  } else {
    message.className = 'data-message neutral-message';
    message.textContent = 'لم يُحفظ ملف DIN بعد.';
  }
}

function saveDinProfile(event) {
  event.preventDefault();
  const profile = readDinForm();
  const coverage = profile.irrigation.coverageCoefficient;
  const efficiency = profile.irrigation.efficiency;
  const fc = profile.soil.fieldCapacity;
  const wp = profile.soil.wiltingPoint;
  const mad = profile.soil.mad;
  if (!profile.field.name || profile.field.area == null || profile.field.area <= 0) {
    $('din-message').className = 'data-message error-message';
    $('din-message').textContent = 'أدخل اسم الحقل ومساحة أكبر من صفر قبل الحفظ.';
    return;
  }
  if (coverage == null || coverage < 0 || coverage > 1) {
    $('din-message').className = 'data-message error-message';
    $('din-message').textContent = 'معامل التغطية يجب أن يكون بين 0 و1.';
    return;
  }
  if (profile.irrigation.method && (efficiency == null || efficiency <= 0 || efficiency > 1)) {
    $('din-message').className = 'data-message error-message';
    $('din-message').textContent = 'أدخل كفاءة ري أكبر من صفر ولا تتجاوز 1.';
    return;
  }
  if (fc != null && wp != null && fc < wp) {
    $('din-message').className = 'data-message error-message';
    $('din-message').textContent = 'السعة الحقلية FC يجب أن تكون أكبر من أو تساوي نقطة الذبول WP.';
    return;
  }
  if (mad != null && (mad < 0 || mad > 1)) {
    $('din-message').className = 'data-message error-message';
    $('din-message').textContent = 'نسبة الاستنزاف المسموح MAD يجب أن تكون بين 0 و1.';
    return;
  }
  profile.savedAt = new Date().toISOString();
  state.din = profile;
  writeDinProfile(profile);
  renderDinSummary(profile, state.rows, state.referenceDate);
}

function clearDinProfile() {
  const profile = defaultDinProfile();
  state.din = profile;
  try { sessionStorage.removeItem(DIN_STORAGE_KEY); } catch (error) { console.warn('تعذر مسح ملف DIN.', error); }
  populateDinForm(profile);
  updateEfficiencyHint();
  renderDinSummary(profile, state.rows, state.referenceDate);
}

async function loadWeather() {
  const actualToday = damascusToday();
  const referenceDate = $('weather-date').value || actualToday;
  const start = addDays(referenceDate, -7);
  const end = addDays(referenceDate, 6);
  const latitude = Number($('latitude').value);
  const longitude = Number($('longitude').value);
  const elevation = Number($('elevation').value);
  const nasaEnd = end < actualToday ? end : addDays(actualToday, -1);
  const nasaUrl = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,T2MDEW,RH2M,ALLSKY_SFC_SW_DWN,WS2M,PS,PRECTOTCORR&community=AG&longitude=${longitude}&latitude=${latitude}&start=${apiDate(start)}&end=${apiDate(nasaEnd)}&format=JSON&time-standard=LST`;
  const historical = referenceDate < actualToday;
  const openBase = historical ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const openPeriod = historical ? `start_date=${start}&end_date=${end}` : 'past_days=7&forecast_days=7';
  const openMeteoUrl = `${openBase}?latitude=${latitude}&longitude=${longitude}&elevation=${elevation}&timezone=${encodeURIComponent(TIMEZONE)}&wind_speed_unit=ms&${openPeriod}&daily=temperature_2m_max,temperature_2m_min,dew_point_2m_mean,wind_speed_10m_mean,shortwave_radiation_sum,precipitation_sum,surface_pressure_mean`;
  const nasaRequest = nasaEnd >= start ? fetchJson(nasaUrl) : Promise.resolve(null);
  const results = await Promise.allSettled([nasaRequest, fetchJson(openMeteoUrl)]);
  const nasaPayload = results[0].status === 'fulfilled' ? results[0].value : null;
  const openPayload = results[1].status === 'fulfilled' ? results[1].value : null;
  if (!nasaPayload && !openPayload) throw new Error('تعذر الاتصال بمصدري الطقس.');
  const nasaByDate = nasaPayload ? readNasaPayload(nasaPayload) : {};
  const openMeteoByDate = openPayload ? readOpenMeteoPayload(openPayload, historical ? 'Open-Meteo Archive' : 'Open-Meteo') : {};
  const crop = state.catalog.records.find((item) => item.id === $('crop-select').value) || state.catalog.records[0];
  const seasonStart = $('season-start').value;
  const rows = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const weather = chooseWeather(date, actualToday, nasaByDate, openMeteoByDate);
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
  return { rows, today: referenceDate, referenceDate, start, end, sourceAvailability: { nasa: Boolean(nasaPayload), openMeteo: Boolean(openPayload) } };
}

function stageLabel(stage) {
  return ({ L1: 'L1 · التأسيس', L2: 'L2 · النمو', L3: 'L3 · منتصف الموسم', L4: 'L4 · النضج', post_season: 'بعد الموسم', before_season: 'قبل الموسم' })[stage] || stage;
}

function renderSeasonStatus() {
  const crop = state.catalog?.records.find((item) => item.id === $('crop-select').value);
  const start = $('season-start').value;
  const status = $('season-status');
  const title = $('season-status-title');
  const detail = $('season-status-detail');
  const info = cropSeasonInfo(crop, start);
  const calendar = $('season-calendar');
  const setStageDate = (key, value) => { $(`season-${key.toLowerCase()}-date`).textContent = value ? formatIsoDate(value) : '—'; };
  if (info.stages) info.stages.forEach((stage) => setStageDate(stage.key, stage.endDate));
  $('season-end-date').textContent = info.endDate ? formatIsoDate(info.endDate) : '—';
  if (!info.endDate) {
    status.className = 'season-status neutral-season';
    title.textContent = 'حالة الموسم';
    detail.textContent = 'اختر المحصول وأدخل بداية الموسم لعرض تاريخ النهاية.';
    calendar.classList.add('calendar-empty');
    return;
  }
  calendar.classList.remove('calendar-empty');
  const weatherDate = $('weather-date').value;
  const ended = weatherDate > info.endDate;
  const before = weatherDate < start;
  const inWindow = isDateInPlantingWindow(start, info.plantingWindow);
  const currentStage = weatherDate ? kcForDay(crop, daysBetween(start, weatherDate)).stage : null;
  const windowNote = inWindow === false ? ` تحذير: تاريخ الزراعة خارج النافذة المحلية المقترحة (${info.plantingWindow}).` : ` النافذة المحلية المقترحة: ${info.plantingWindow || 'غير محددة'}.`;
  status.className = `season-status ${ended ? 'ended-season' : before ? 'before-season' : 'active-season'}`;
  title.textContent = ended ? 'الموسم منتهٍ' : before ? 'الموسم لم يبدأ بعد' : 'الموسم قائم';
  detail.textContent = `${crop.name_ar} · من ${formatIsoDate(start)} إلى ${formatIsoDate(info.endDate)} (${info.totalDays} يومًا). الطور الحالي: ${stageLabel(currentStage)}. ${ended ? 'لن يُحسب ETc محصولي بعد تاريخ النهاية.' : before ? 'لن يُحسب ETc قبل تاريخ البداية.' : 'يُحسب Kc وETc وفق الطور اليومي.'}${windowNote}`;
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
  state.referenceDate = metadata.referenceDate;
  const crop = state.catalog.records.find((item) => item.id === $('crop-select').value) || state.catalog.records[0];
  $('location-summary').textContent = selectedLocation()?.name_ar || 'الموقع المحدد';
  $('crop-summary').textContent = crop.name_ar;
  $('updated-at').textContent = new Intl.DateTimeFormat('ar-SY', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }).format(new Date());
  renderSummary(rows, metadata.today);
  renderSeasonStatus();
  renderDinSummary(state.din, rows, metadata.referenceDate);
  renderOperations();
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
    $('weather-date').value = damascusToday();
    const [catalog, locations, fertilizerMap, fertilizerProfiles] = await Promise.all([fetchJson(CROP_DATA_URL), fetchJson(LOCATION_DATA_URL), fetchJson(FERTILIZER_MAP_URL), fetchJson(FERTILIZER_PROFILES_URL)]);
    state.catalog = catalog;
    state.locations = locations;
    state.fertilizerMap = fertilizerMap;
    state.fertilizerProfiles = fertilizerProfiles;
    state.operations = readOperations();
    populateCrops(state.catalog);
    populateLocations(state.locations);
    state.din = readDinProfile();
    populateDinForm(state.din);
    updateRootDepthHint();
    updateEfficiencyHint();
    renderSeasonStatus();
    renderDinSummary(state.din);
    resetOperationForm();
    renderOperations();
    renderRainEntries(state.din);
    renderIrrigationEntries(state.din);
    $('controls-form').addEventListener('submit', (event) => { event.preventDefault(); refresh(); });
    $('din-form').addEventListener('submit', saveDinProfile);
    $('din-clear').addEventListener('click', clearDinProfile);
    $('rain-entry-open').addEventListener('click', openRainModal);
    $('rain-entry-form').addEventListener('submit', addDailyRain);
    $('rain-entry-body').addEventListener('click', deleteDailyRain);
    $('rain-modal-close').addEventListener('click', () => $('rain-modal').close());
    $('rain-modal').addEventListener('click', (event) => { if (event.target === $('rain-modal')) $('rain-modal').close(); });
    $('irrigation-entry-open').addEventListener('click', openIrrigationModal);
    $('irrigation-entry-form').addEventListener('submit', addActualIrrigation);
    $('irrigation-entry-body').addEventListener('click', deleteActualIrrigation);
    $('irrigation-modal-close').addEventListener('click', () => $('irrigation-modal').close());
    $('irrigation-modal').addEventListener('click', (event) => { if (event.target === $('irrigation-modal')) $('irrigation-modal').close(); });
    $('soil-carryover-save').addEventListener('click', saveSoilCarryover);
    $('operation-form').addEventListener('submit', saveOperation);
    $('operation-reset').addEventListener('click', resetOperationForm);
    $('operations-export').addEventListener('click', exportOperations);
    $('operations-import-open').addEventListener('click', () => $('operations-import-file').click());
    $('operations-import-file').addEventListener('change', importOperations);
    $('operations-body').addEventListener('click', handleOperationTable);
    $('irrigation-method').addEventListener('change', () => updateEfficiencyHint(true));
    $('fertilizer-water-mode').addEventListener('change', () => renderFertilizerRecommendation(state.din));
    $('fertilizer-tree-age').addEventListener('change', () => renderFertilizerRecommendation(state.din));
    $('crop-select').addEventListener('change', () => {
      $('crop-summary').textContent = state.catalog.records.find((crop) => crop.id === $('crop-select').value)?.name_ar || '—';
      updateRootDepthHint();
      renderSeasonStatus();
      renderOperations();
    });
    $('season-start').addEventListener('change', () => { renderSeasonStatus(); renderOperations(); });
    $('field-name').addEventListener('input', renderOperations);
    $('field-code').addEventListener('input', renderOperations);
    $('weather-date').addEventListener('change', renderSeasonStatus);
    $('location-name').addEventListener('change', () => applyLocation(selectedLocation()));
    await refresh();
  } catch (error) {
    setStatus('تعذر تحميل القواعد المحلية', 'error');
    $('data-message').className = 'data-message error-message';
    $('data-message').textContent = `تعذر قراءة قاعدة المحاصيل أو المواقع: ${error.message}`;
  }
}

document.addEventListener('DOMContentLoaded', init);
