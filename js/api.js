/* api.js — Open-Meteo data layer: geocoding, live forecast, ERA5 archive,
   CMIP6 climate projections, plus the aggregation helpers the views need.
   No API key, no third-party scripts. */

const ENDPOINTS = {
  geo: 'https://geocoding-api.open-meteo.com/v1/search',
  forecast: 'https://api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
  climate: 'https://climate-api.open-meteo.com/v1/climate',
};

/* Seven downscaled CMIP6 models (bias-corrected against ERA5 by Open-Meteo).
   The outlook uses their mean; their spread is the honest uncertainty band. */
export const CLIMATE_MODELS = [
  'CMCC_CM2_VHR4', 'FGOALS_f3_H', 'HiRAM_SIT_HR', 'MRI_AGCM3_2_S',
  'EC_Earth3P_HR', 'MPI_ESM1_2_XR', 'NICAM16_8S',
];

const TTL = { geo: 864e5, forecast: 9e5, archive: 864e5, climate: 6048e5 };
const memory = new Map();

function cacheGet(key, ttl) {
  const hit = memory.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.d;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.t >= ttl) return null;
    memory.set(key, parsed);
    return parsed.d;
  } catch { return null; }
}

function cacheSet(key, data) {
  const entry = { t: Date.now(), d: data };
  memory.set(key, entry);
  try { sessionStorage.setItem(key, JSON.stringify(entry)); } catch { /* quota — memory is enough */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(base, params, ttl, attempt = 0) {
  const url = `${base}?${new URLSearchParams(params)}`;
  const cached = cacheGet(url, ttl);
  if (cached) return cached;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    const reason = body?.reason || `Request failed (${res.status})`;
    /* Open-Meteo throttles per minute; one polite retry clears a burst. */
    if (attempt < 2 && (res.status === 429 || /limit exceeded/i.test(reason))) {
      await sleep(1500 * (attempt + 1));
      return getJSON(base, params, ttl, attempt + 1);
    }
    throw new Error(reason);
  }
  cacheSet(url, body);
  return body;
}

/* ---------- date helpers (all calendar maths in local wall-clock terms) ---------- */

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
export const addYears = (d, n) => { const c = new Date(d); c.setFullYear(c.getFullYear() + n); return c; };
export const monthKey = (s) => s.slice(0, 7);

/* ---------- requests ---------- */

export async function geocode(query, count = 6) {
  if (!query || query.trim().length < 2) return [];
  const body = await getJSON(ENDPOINTS.geo, {
    name: query.trim(), count, language: 'en', format: 'json',
  }, TTL.geo);
  return (body.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    countryCode: r.country_code || '',
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
    elevation: r.elevation,
    population: r.population,
  }));
}

export function fetchForecast(lat, lon) {
  return getJSON(ENDPOINTS.forecast, {
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: 16,
    current: ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'is_day',
      'precipitation', 'weather_code', 'cloud_cover', 'surface_pressure',
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'].join(','),
    hourly: ['temperature_2m', 'apparent_temperature', 'precipitation',
      'precipitation_probability', 'weather_code', 'wind_speed_10m'].join(','),
    daily: ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'sunrise', 'sunset',
      'uv_index_max', 'precipitation_sum', 'precipitation_probability_max',
      'wind_speed_10m_max'].join(','),
  }, TTL.forecast);
}

export function fetchArchive(lat, lon, startDate, endDate) {
  return getJSON(ENDPOINTS.archive, {
    latitude: lat, longitude: lon, timezone: 'auto',
    start_date: startDate, end_date: endDate,
    daily: ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean',
      'precipitation_sum', 'wind_speed_10m_max'].join(','),
  }, TTL.archive);
}

export function fetchClimate(lat, lon, startDate, endDate, models = CLIMATE_MODELS) {
  return getJSON(ENDPOINTS.climate, {
    latitude: lat, longitude: lon, models: models.join(','),
    start_date: startDate, end_date: endDate,
    daily: ['temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean',
      'precipitation_sum'].join(','),
  }, TTL.climate);
}

/* ---------- shaping ---------- */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mean = (xs) => {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const sum = (xs) => {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

/** Archive/forecast daily block -> array of plain day rows. */
export function dailyRows(daily) {
  if (!daily?.time) return [];
  return daily.time.map((date, i) => ({
    date,
    code: num(daily.weather_code?.[i]),
    tmax: num(daily.temperature_2m_max?.[i]),
    tmin: num(daily.temperature_2m_min?.[i]),
    tmean: num(daily.temperature_2m_mean?.[i]) ??
      mean([num(daily.temperature_2m_max?.[i]), num(daily.temperature_2m_min?.[i])]),
    prcp: num(daily.precipitation_sum?.[i]),
    wind: num(daily.wind_speed_10m_max?.[i]),
    pop: num(daily.precipitation_probability_max?.[i]),
    uv: num(daily.uv_index_max?.[i]),
    sunrise: daily.sunrise?.[i] ?? null,
    sunset: daily.sunset?.[i] ?? null,
  }));
}

/** Climate multi-model block -> day rows carrying the ensemble mean and its spread. */
export function ensembleRows(daily, models = CLIMATE_MODELS) {
  if (!daily?.time) return [];
  const pick = (v, m, i) => num(daily[`${v}_${m}`]?.[i]);
  return daily.time.map((date, i) => {
    const tmeans = models.map((m) => pick('temperature_2m_mean', m, i)).filter((x) => x !== null);
    const prcps = models.map((m) => pick('precipitation_sum', m, i)).filter((x) => x !== null);
    return {
      date,
      tmax: mean(models.map((m) => pick('temperature_2m_max', m, i))),
      tmin: mean(models.map((m) => pick('temperature_2m_min', m, i))),
      tmean: mean(tmeans),
      tmeanLo: tmeans.length ? Math.min(...tmeans) : null,
      tmeanHi: tmeans.length ? Math.max(...tmeans) : null,
      prcp: mean(prcps),
      prcpLo: prcps.length ? Math.min(...prcps) : null,
      prcpHi: prcps.length ? Math.max(...prcps) : null,
      models: tmeans.length,
    };
  });
}

/** Group day rows by calendar month: temperatures average, precipitation totals. */
export function monthlySeries(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = monthKey(r.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, days]) => ({
    key,
    date: `${key}-01`,
    days: days.length,
    tmean: mean(days.map((d) => d.tmean)),
    tmax: mean(days.map((d) => d.tmax)),
    tmin: mean(days.map((d) => d.tmin)),
    tmaxAbs: days.reduce((a, d) => (d.tmax !== null && (a === null || d.tmax > a) ? d.tmax : a), null),
    tminAbs: days.reduce((a, d) => (d.tmin !== null && (a === null || d.tmin < a) ? d.tmin : a), null),
    prcp: sum(days.map((d) => d.prcp)),
    wetDays: days.filter((d) => (d.prcp ?? 0) >= 1).length,
  })).sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Long-run monthly normals from a multi-year archive: index 1..12. */
export function monthlyNormals(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const m = Number(r.date.slice(5, 7));
    const year = r.date.slice(0, 4);
    if (!byMonth.has(m)) byMonth.set(m, { temps: [], maxes: [], mins: [], yearTotals: new Map() });
    const g = byMonth.get(m);
    if (r.tmean !== null) g.temps.push(r.tmean);
    if (r.tmax !== null) g.maxes.push(r.tmax);
    if (r.tmin !== null) g.mins.push(r.tmin);
    if (r.prcp !== null) g.yearTotals.set(year, (g.yearTotals.get(year) || 0) + r.prcp);
  }
  const out = {};
  for (const [m, g] of byMonth) {
    out[m] = {
      tmean: mean(g.temps), tmax: mean(g.maxes), tmin: mean(g.mins),
      prcp: mean([...g.yearTotals.values()]),
      years: g.yearTotals.size,
    };
  }
  return out;
}

/** Day-of-year normals, smoothed over a +/- window so single storms don't spike them. */
export function dailyNormals(rows, window = 7) {
  const buckets = new Map(); // 'MM-DD' -> {temps, maxes, mins, prcps}
  for (const r of rows) {
    const key = r.date.slice(5);
    if (!buckets.has(key)) buckets.set(key, { temps: [], maxes: [], mins: [], prcps: [] });
    const b = buckets.get(key);
    if (r.tmean !== null) b.temps.push(r.tmean);
    if (r.tmax !== null) b.maxes.push(r.tmax);
    if (r.tmin !== null) b.mins.push(r.tmin);
    if (r.prcp !== null) b.prcps.push(r.prcp);
  }
  const keys = [...buckets.keys()].sort();
  const raw = keys.map((k) => ({ key: k, ...buckets.get(k) }));
  const out = new Map();
  raw.forEach((entry, i) => {
    const slice = [];
    for (let o = -window; o <= window; o += 1) slice.push(raw[(i + o + raw.length) % raw.length]);
    out.set(entry.key, {
      tmean: mean(slice.flatMap((s) => s.temps)),
      tmax: mean(slice.flatMap((s) => s.maxes)),
      tmin: mean(slice.flatMap((s) => s.mins)),
      prcp: mean(slice.flatMap((s) => s.prcps)),
      wetChance: (() => {
        const all = slice.flatMap((s) => s.prcps);
        return all.length ? all.filter((p) => p >= 1).length / all.length : null;
      })(),
      samples: slice.reduce((a, s) => a + s.temps.length, 0),
    });
  });
  return out;
}

/** Centred rolling mean — used to make chaotic model days readable. */
export function smooth(values, k = 15) {
  const half = Math.floor(k / 2);
  return values.map((_, i) => {
    const win = [];
    for (let o = -half; o <= half; o += 1) {
      const v = values[i + o];
      if (v !== null && v !== undefined && Number.isFinite(v)) win.push(v);
    }
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
}

export function stdev(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x));
  if (v.length < 2) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

/* ---------- WMO weather codes ---------- */

const WMO = {
  0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌦️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm with hail', '⛈️'], 99: ['Severe thunderstorm', '⛈️'],
};

export function describeCode(code) {
  const hit = WMO[code];
  return { label: hit ? hit[0] : '—', glyph: hit ? hit[1] : '·' };
}

/* ---------- units & formatting ---------- */

export const units = {
  temp: (c, imperial) => (c === null || c === undefined ? null : (imperial ? c * 9 / 5 + 32 : c)),
  tempDelta: (c, imperial) => (c === null || c === undefined ? null : (imperial ? c * 9 / 5 : c)),
  precip: (mm, imperial) => (mm === null || mm === undefined ? null : (imperial ? mm / 25.4 : mm)),
  speed: (kmh, imperial) => (kmh === null || kmh === undefined ? null : (imperial ? kmh / 1.609344 : kmh)),
  labels: (imperial) => ({
    temp: imperial ? '°F' : '°C',
    precip: imperial ? 'in' : 'mm',
    speed: imperial ? 'mph' : 'km/h',
  }),
};

export function fmt(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const fmtTemp = (c, imperial, digits = 0) => (c === null || c === undefined
  ? '—' : `${fmt(units.temp(c, imperial), digits)}${units.labels(imperial).temp}`);

/* ---------- the one call the app makes ---------- */

/**
 * Loads every span for a place in parallel and shapes it for the views.
 * A failing span degrades to `null` with its reason attached rather than
 * taking the whole page down.
 */
export async function loadPlace(place) {
  const { latitude: lat, longitude: lon } = place;
  const today = new Date();
  const lastObserved = addDays(today, -1);            // ERA5 lands about a day behind
  const historyStart = addDays(addYears(lastObserved, -2), 1);
  const baselineStart = addDays(addYears(lastObserved, -10), 1);
  const outlookStart = addDays(today, 1);
  const outlookEnd = addYears(today, 2);

  const settle = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }));
  const [fc, arch, clim] = await Promise.all([
    settle(fetchForecast(lat, lon)),
    settle(fetchArchive(lat, lon, iso(baselineStart), iso(lastObserved))),
    settle(fetchClimate(lat, lon, iso(outlookStart), iso(outlookEnd))),
  ]);

  const errors = [];
  if (!fc.ok) errors.push(`live forecast (${fc.e.message})`);
  if (!arch.ok) errors.push(`observed history (${arch.e.message})`);
  if (!clim.ok) errors.push(`climate outlook (${clim.e.message})`);

  const forecast = fc.ok ? {
    meta: fc.v,
    current: fc.v.current,
    hourly: fc.v.hourly,
    days: dailyRows(fc.v.daily),
  } : null;

  let baseline = null;
  let history = null;
  if (arch.ok) {
    const all = dailyRows(arch.v.daily).filter((r) => r.tmean !== null || r.prcp !== null);
    const histFrom = iso(historyStart);
    baseline = {
      rows: all,
      monthly: monthlyNormals(all),
      daily: dailyNormals(all),
      from: all[0]?.date ?? null,
      to: all[all.length - 1]?.date ?? null,
    };
    const rows = all.filter((r) => r.date >= histFrom);
    history = { rows, monthly: monthlySeries(rows), from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null };
  }

  const outlook = clim.ok ? (() => {
    const rows = ensembleRows(clim.v.daily);
    const sm = smooth(rows.map((r) => r.tmean), 15);
    const smLo = smooth(rows.map((r) => r.tmeanLo), 15);
    const smHi = smooth(rows.map((r) => r.tmeanHi), 15);
    rows.forEach((r, i) => { r.tmeanSmooth = sm[i]; r.tmeanLoSmooth = smLo[i]; r.tmeanHiSmooth = smHi[i]; });
    return { rows, monthly: monthlySeries(rows), from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null };
  })() : null;

  return { place, forecast, history, baseline, outlook, errors, generated: new Date() };
}

