/* app.js — views and wiring. Renders four spans for one place:
   now, the next 16 days (real forecast), the next 2 years (climate projection),
   and the past 2 years (ERA5 reanalysis). */

import {
  geocode, loadPlace, describeCode, units, fmt, fmtTemp, iso, parseISO, addDays, addYears,
  monthlySeries, stdev,
} from './api.js';
import { lineChart, barChart, h } from './charts.js';

const state = {
  place: null,
  data: null,
  imperial: false,
  grain: 'monthly',
  loading: false,
};

const dom = {
  form: document.getElementById('search-form'),
  input: document.getElementById('place-input'),
  list: document.getElementById('place-list'),
  geo: document.getElementById('geo-btn'),
  theme: document.getElementById('theme-btn'),
  themeGlyph: document.getElementById('theme-glyph'),
  status: document.getElementById('status'),
  placeHead: document.getElementById('place-head'),
  placeName: document.getElementById('place-name'),
  placeMeta: document.getElementById('place-meta'),
  filterbar: document.getElementById('filterbar'),
  app: document.getElementById('app'),
};

/* ---------- small helpers ---------- */

const U = () => units.labels(state.imperial);
const T = (c, digits = 0) => fmtTemp(c, state.imperial, digits);
const P = (mm) => (mm === null || mm === undefined ? '—'
  : `${fmt(units.precip(mm, state.imperial), state.imperial ? 2 : 1)} ${U().precip}`);
const S = (kmh) => (kmh === null || kmh === undefined ? '—' : `${fmt(units.speed(kmh, state.imperial), 0)} ${U().speed}`);

const tempVals = (arr) => arr.map((v) => (v === null || v === undefined ? null : units.temp(v, state.imperial)));
const precipVals = (arr) => arr.map((v) => (v === null || v === undefined ? null : units.precip(v, state.imperial)));

const fmtTempAxis = (v) => (v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(v % 1 ? 1 : 0)}°`);
const fmtPrecipAxis = (v) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(state.imperial ? 2 : (v >= 10 ? 0 : 1)));

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const longFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

const labelDay = (isoStr) => dayFmt.format(parseISO(isoStr));
const labelMonth = (key) => monthFmt.format(parseISO(`${key}-01`));

function section(id, title, sub) {
  const s = h('section', null);
  s.id = id;
  const header = document.createElement('header');
  header.append(h('h2', null, title));
  if (sub) header.append(h('p', 'sub', sub));
  s.append(header);
  return s;
}

function tile(label, value, sub, dir) {
  const t = h('div', 'tile');
  t.append(h('div', 'tile-label', label), h('div', 'tile-value', value));
  if (sub) {
    const d = h('div', 'tile-delta', sub);
    if (dir) d.dataset.dir = dir;
    t.append(d);
  }
  return t;
}

function notice(text, tone) {
  const n = h('div', 'notice');
  if (tone) n.dataset.tone = tone;
  n.append(h('span', 'n-icon', tone === 'warning' ? '⚠' : 'ℹ'), h('div', null, text));
  return n;
}

function noticeRich(strongText, rest, tone) {
  const n = h('div', 'notice');
  if (tone) n.dataset.tone = tone;
  const body = h('div');
  body.append(h('strong', null, strongText), document.createTextNode(` ${rest}`));
  n.append(h('span', 'n-icon', tone === 'warning' ? '⚠' : 'ℹ'), body);
  return n;
}

function setStatus(text, kind) {
  dom.status.replaceChildren();
  if (!text) { delete dom.status.dataset.kind; return; }
  if (kind === 'loading') dom.status.append(h('span', 'spinner'));
  dom.status.append(document.createTextNode(text));
  if (kind) dom.status.dataset.kind = kind; else delete dom.status.dataset.kind;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => (deg === null || deg === undefined ? '—' : COMPASS[Math.round((deg % 360) / 22.5) % 16]);
const clock = (isoStr) => (isoStr ? new Date(isoStr).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');

function renderNow(data) {
  const s = section('now', 'Right now', null);
  const cur = data.forecast?.current;
  if (!cur) {
    s.append(notice('Live conditions are unavailable for this place right now.', 'warning'));
    return s;
  }
  const cond = describeCode(cur.weather_code);
  const today = data.forecast.days[0];
  const normal = data.baseline?.daily.get(today?.date.slice(5));

  const grid = h('div', 'now-grid');
  const heroCard = h('div', 'card hero');
  heroCard.append(
    h('div', 'hero-label', `As of ${clock(cur.time)} local time`),
    h('div', 'hero-figure', T(cur.temperature_2m, 0)),
  );
  const condRow = h('div', 'hero-cond');
  condRow.append(h('span', 'glyph', cond.glyph), h('span', null, cond.label));
  heroCard.append(condRow);
  heroCard.append(h('div', 'hero-sub',
    `Today ${T(today?.tmax)} / ${T(today?.tmin)} · feels like ${T(cur.apparent_temperature)}`));

  const tiles = h('div', 'tiles');
  let anomalySub = null;
  let anomalyDir = null;
  if (normal?.tmax !== null && normal?.tmax !== undefined && today?.tmax !== null) {
    const delta = today.tmax - normal.tmax;
    anomalySub = `${delta >= 0 ? '+' : '−'}${fmt(Math.abs(units.tempDelta(delta, state.imperial)), 1)}${U().temp} vs the ${data.baseline.rows.length > 3000 ? '10-year' : 'recent'} normal for this date`;
    anomalyDir = delta >= 0 ? 'up' : 'down';
  }
  tiles.append(
    tile("Today's high", T(today?.tmax), anomalySub, anomalyDir),
    tile('Feels like', T(cur.apparent_temperature)),
    tile('Humidity', cur.relative_humidity_2m === null ? '—' : `${Math.round(cur.relative_humidity_2m)}%`),
    tile('Wind', S(cur.wind_speed_10m), `${compass(cur.wind_direction_10m)} · gusts ${S(cur.wind_gusts_10m)}`),
    tile('Precipitation', P(cur.precipitation), `chance today ${today?.pop === null ? '—' : `${Math.round(today?.pop ?? 0)}%`}`),
    tile('Cloud cover', cur.cloud_cover === null ? '—' : `${Math.round(cur.cloud_cover)}%`),
    tile('Pressure', cur.surface_pressure === null ? '—' : `${Math.round(cur.surface_pressure)} hPa`),
    tile('UV index (max)', today?.uv === null ? '—' : fmt(today?.uv, 1)),
    tile('Daylight', `${clock(today?.sunrise)} → ${clock(today?.sunset)}`),
  );

  grid.append(heroCard, tiles);
  s.append(grid);
  return s;
}

function renderShortTerm(data) {
  const s = section('short', 'Next 16 days', 'A real forecast: numerical weather models, refreshed hourly. This is the only span where day-by-day detail is meaningful.');
  if (!data.forecast) {
    s.append(notice('The live forecast could not be loaded for this place.', 'warning'));
    return s;
  }
  const { hourly, days } = data.forecast;

  const strip = h('div', 'daystrip');
  for (const d of days) {
    const cond = describeCode(d.code);
    const card = h('div', 'day');
    card.append(h('div', 'day-name', labelDay(d.date)), h('div', 'day-glyph', cond.glyph));
    const temps = h('div', 'day-temps');
    temps.append(h('span', 'hi', T(d.tmax)), document.createTextNode(' / '), h('span', 'lo', T(d.tmin)));
    card.append(temps, h('div', 'day-pop', `${d.pop === null ? '—' : `${Math.round(d.pop)}%`} · ${P(d.prcp)}`));
    card.title = `${labelDay(d.date)}: ${cond.label}`;
    strip.append(card);
  }
  const stripCard = h('div', 'card');
  stripCard.append(h('h3', 'chart-title', 'Day by day'), strip);
  s.append(stripCard);

  /* 48 hours from the current hour */
  const nowHour = (data.forecast.current?.time || hourly.time[0]).slice(0, 13);
  let start = hourly.time.findIndex((t) => t.slice(0, 13) >= nowHour);
  if (start < 0) start = 0;
  const idx = [...Array(Math.min(48, hourly.time.length - start)).keys()].map((i) => i + start);
  const hLabels = idx.map((i) => `${labelDay(hourly.time[i].slice(0, 10))}, ${hourFmt.format(new Date(hourly.time[i]))}`);
  const hTicks = idx.map((i) => hourFmt.format(new Date(hourly.time[i])));

  const pair = h('div', 'grid-2');
  pair.append(lineChart({
    title: 'Temperature, next 48 hours',
    subtitle: `Air temperature and apparent (“feels like”) temperature, ${U().temp}`,
    xLabels: hLabels,
    xTickLabels: hTicks,
    xHeader: 'Hour',
    yLabel: U().temp,
    format: fmtTempAxis,
    series: [
      { name: 'Air temperature', color: 'var(--series-1)', values: tempVals(idx.map((i) => hourly.temperature_2m[i])) },
      { name: 'Feels like', color: 'var(--series-2)', values: tempVals(idx.map((i) => hourly.apparent_temperature[i])) },
    ],
    height: 250,
  }));
  pair.append(barChart({
    title: 'Precipitation, next 48 hours',
    subtitle: `Hourly total, ${U().precip}`,
    xLabels: hLabels,
    xTickLabels: hTicks,
    xHeader: 'Hour',
    yLabel: U().precip,
    format: fmtPrecipAxis,
    bars: { name: `Precipitation (${U().precip})`, color: 'var(--series-1)', values: precipVals(idx.map((i) => hourly.precipitation[i])) },
    height: 250,
  }));
  s.append(pair);

  const dLabels = days.map((d) => labelDay(d.date));
  const pair2 = h('div', 'grid-2');
  pair2.append(lineChart({
    title: 'Daily temperature range, 16 days',
    subtitle: `Midpoint line inside the day's high–low band, ${U().temp}`,
    xLabels: dLabels,
    xHeader: 'Day',
    yLabel: U().temp,
    format: fmtTempAxis,
    series: [{
      name: 'Daily midpoint',
      color: 'var(--series-1)',
      values: tempVals(days.map((d) => (d.tmax !== null && d.tmin !== null ? (d.tmax + d.tmin) / 2 : null))),
    }],
    band: { name: 'Daily high–low', color: 'var(--series-1)', lo: tempVals(days.map((d) => d.tmin)), hi: tempVals(days.map((d) => d.tmax)) },
    height: 250,
  }));
  pair2.append(barChart({
    title: 'Daily precipitation, 16 days',
    subtitle: `Total per day, ${U().precip}`,
    xLabels: dLabels,
    xHeader: 'Day',
    yLabel: U().precip,
    format: fmtPrecipAxis,
    bars: { name: `Precipitation (${U().precip})`, color: 'var(--series-1)', values: precipVals(days.map((d) => d.prcp)) },
    height: 250,
  }));
  s.append(pair2);
  return s;
}

function outlookSeries(data) {
  const { outlook, baseline } = data;
  if (state.grain === 'monthly') {
    const months = outlook.monthly;
    const lo = monthlySeries(outlook.rows.map((r) => ({ ...r, tmean: r.tmeanLo, prcp: r.prcpLo })));
    const hi = monthlySeries(outlook.rows.map((r) => ({ ...r, tmean: r.tmeanHi, prcp: r.prcpHi })));
    const normalFor = (key) => baseline?.monthly[Number(key.slice(5, 7))] || {};
    return {
      xLabels: months.map((m) => labelMonth(m.key)),
      xTickLabels: months.map((m) => monthShort.format(parseISO(`${m.key}-01`))),
      xHeader: 'Month',
      temp: months.map((m) => m.tmean),
      tempLo: lo.map((m) => m.tmean),
      tempHi: hi.map((m) => m.tmean),
      normalTemp: months.map((m) => normalFor(m.key).tmean ?? null),
      prcp: months.map((m) => m.prcp),
      normalPrcp: months.map((m) => normalFor(m.key).prcp ?? null),
      tempTitle: 'Projected monthly mean temperature vs. the local normal',
      prcpTitle: 'Projected monthly precipitation vs. the local normal',
    };
  }
  const rows = outlook.rows;
  const normalFor = (date) => baseline?.daily.get(date.slice(5)) || {};
  return {
    xLabels: rows.map((r) => labelDay(r.date)),
    xTickLabels: rows.map((r) => monthFmt.format(parseISO(r.date))),
    xHeader: 'Date',
    temp: rows.map((r) => r.tmeanSmooth),
    tempLo: rows.map((r) => r.tmeanLoSmooth),
    tempHi: rows.map((r) => r.tmeanHiSmooth),
    normalTemp: rows.map((r) => normalFor(r.date).tmean ?? null),
    prcp: rows.map((r) => r.prcp),
    normalPrcp: rows.map((r) => normalFor(r.date).prcp ?? null),
    tempTitle: 'Projected daily mean temperature (15-day smoothing) vs. the local normal',
    prcpTitle: 'Projected daily precipitation vs. the local normal',
  };
}

function renderOutlook(data) {
  const s = section('outlook', 'Next 2 years — climate outlook',
    'Beyond about two weeks the atmosphere is unpredictable, so this span is not a forecast. It is a seven-model CMIP6 ensemble, bias-corrected to this location, shown against the observed normals for the same calendar dates.');
  if (!data.outlook) {
    s.append(notice('The climate projection service did not return data for this place.', 'warning'));
    return s;
  }
  s.append(noticeRich('Read this as climate, not weather.',
    'Individual days carry no skill — no method can say whether it will rain on a given date next year. What the ensemble does carry is the seasonal shape and the warming trend, so compare the blue line to the orange normal, not one day to the next.', 'warning'));

  const ser = outlookSeries(data);
  const next12 = data.outlook.monthly.slice(0, 12);
  const projMean = next12.reduce((a, m) => a + (m.tmean ?? 0), 0) / (next12.length || 1);
  const normMean = next12.reduce((a, m) => a + (data.baseline?.monthly[Number(m.key.slice(5, 7))]?.tmean ?? 0), 0) / (next12.length || 1);
  const projPrcp = next12.reduce((a, m) => a + (m.prcp ?? 0), 0);
  const normPrcp = next12.reduce((a, m) => a + (data.baseline?.monthly[Number(m.key.slice(5, 7))]?.prcp ?? 0), 0);
  const hottest = next12.reduce((a, m) => (a === null || (m.tmean ?? -99) > (a.tmean ?? -99) ? m : a), null);
  const wettest = next12.reduce((a, m) => (a === null || (m.prcp ?? -1) > (a.prcp ?? -1) ? m : a), null);
  const dTemp = projMean - normMean;

  const tiles = h('div', 'tiles');
  tiles.append(
    tile('Projected mean, next 12 months', T(projMean, 1),
      `${dTemp >= 0 ? '+' : '−'}${fmt(Math.abs(units.tempDelta(dTemp, state.imperial)), 1)}${U().temp} vs the 10-year normal`, dTemp >= 0 ? 'up' : 'down'),
    tile('Projected precipitation, next 12 months', P(projPrcp),
      normPrcp ? `${Math.round((projPrcp / normPrcp - 1) * 100)}% vs normal` : null),
    tile('Warmest projected month', hottest ? labelMonth(hottest.key) : '—', hottest ? `mean ${T(hottest.tmean, 1)}` : null),
    tile('Wettest projected month', wettest ? labelMonth(wettest.key) : '—', wettest ? P(wettest.prcp) : null),
  );
  const tilesCard = h('div', 'card');
  tilesCard.append(h('h3', 'chart-title', 'The next 12 months in four numbers'), tiles);
  s.append(tilesCard);

  s.append(lineChart({
    title: ser.tempTitle,
    subtitle: `Ensemble mean of 7 downscaled CMIP6 models; the band spans the coolest to the warmest model at each point, ${U().temp}`,
    xLabels: ser.xLabels,
    xTickLabels: ser.xTickLabels,
    xHeader: ser.xHeader,
    yLabel: U().temp,
    format: fmtTempAxis,
    series: [
      { name: 'Model ensemble mean', color: 'var(--series-1)', values: tempVals(ser.temp) },
      { name: 'Observed normal (last 10 years)', color: 'var(--series-2)', values: tempVals(ser.normalTemp) },
    ],
    band: { name: 'Model spread (min–max)', color: 'var(--series-1)', lo: tempVals(ser.tempLo), hi: tempVals(ser.tempHi) },
    height: 300,
  }));

  s.append(barChart({
    title: ser.prcpTitle,
    subtitle: `Ensemble mean total against the observed normal for the same period, ${U().precip}`,
    xLabels: ser.xLabels,
    xTickLabels: ser.xTickLabels,
    xHeader: ser.xHeader,
    yLabel: U().precip,
    format: fmtPrecipAxis,
    bars: { name: `Projected precipitation (${U().precip})`, color: 'var(--series-1)', values: precipVals(ser.prcp) },
    overlay: { name: 'Observed normal', color: 'var(--series-2)', values: precipVals(ser.normalPrcp) },
    height: 280,
  }));

  s.append(futureLookup(data));
  return s;
}

function futureLookup(data) {
  const card = h('div', 'card');
  card.append(h('h3', 'chart-title', 'Look up any date in the next 2 years'),
    h('p', 'chart-sub', 'Returns the ensemble projection for that date plus what that date has actually looked like over the past decade — the statistics, not a prediction of the day.'));

  const wrap = h('div', 'lookup');
  const field = h('div');
  const input = document.createElement('input');
  input.type = 'date';
  input.id = 'future-date';
  input.min = iso(addDays(new Date(), 1));
  input.max = data.outlook.to;
  input.value = iso(addDays(new Date(), 30));
  const label = h('label', null, 'Date');
  label.htmlFor = input.id;
  field.append(label, input);
  wrap.append(field);
  card.append(wrap);

  const out = h('div', 'lookup-out');
  card.append(out);

  const run = () => {
    out.replaceChildren();
    const date = input.value;
    if (!date) return;
    const row = data.outlook.rows.find((r) => r.date === date);
    const norm = data.baseline?.daily.get(date.slice(5));
    const sameDay = data.baseline?.rows.filter((r) => r.date.slice(5) === date.slice(5)) || [];
    const recMax = sameDay.reduce((a, r) => (r.tmax !== null && (a === null || r.tmax > a) ? r.tmax : a), null);
    const recMin = sameDay.reduce((a, r) => (r.tmin !== null && (a === null || r.tmin < a) ? r.tmin : a), null);
    const forecastDay = data.forecast?.days.find((d) => d.date === date);

    if (forecastDay) {
      out.append(tile('This date is inside the forecast window', `${T(forecastDay.tmax)} / ${T(forecastDay.tmin)}`,
        `${describeCode(forecastDay.code).label} — use this, not the projection`));
    }
    if (!row) {
      out.append(tile('Projection', '—', 'Outside the projected range'));
      return;
    }
    const spread = row.tmeanHi !== null && row.tmeanLo !== null
      ? `models span ${T(row.tmeanLo, 1)}–${T(row.tmeanHi, 1)}` : null;
    out.append(
      tile('Projected mean temperature', T(row.tmean, 1), spread),
      tile('Projected high / low', `${T(row.tmax)} / ${T(row.tmin)}`, 'ensemble mean of daily extremes'),
      tile('Normal for this date', norm?.tmean === null || norm?.tmean === undefined ? '—' : T(norm.tmean, 1),
        norm?.tmax !== undefined ? `typical high ${T(norm.tmax)} · low ${T(norm.tmin)}` : null),
      tile('Chance of a wet day', norm?.wetChance === null || norm?.wetChance === undefined ? '—' : `${Math.round(norm.wetChance * 100)}%`,
        'days with 1 mm or more, past 10 years'),
      tile('Observed range on this date', recMax === null ? '—' : `${T(recMin)} … ${T(recMax)}`,
        'coldest low to warmest high, past 10 years'),
    );
  };

  input.addEventListener('change', run);
  run();
  return card;
}

function historySeries(data) {
  const { history, baseline } = data;
  if (state.grain === 'monthly') {
    const months = history.monthly;
    const normalFor = (key) => baseline?.monthly[Number(key.slice(5, 7))] || {};
    return {
      xLabels: months.map((m) => labelMonth(m.key)),
      xTickLabels: months.map((m) => monthShort.format(parseISO(`${m.key}-01`))),
      xHeader: 'Month',
      temp: months.map((m) => m.tmean),
      bandLo: months.map((m) => m.tmin),
      bandHi: months.map((m) => m.tmax),
      bandName: 'Average daily low–high',
      normalTemp: months.map((m) => normalFor(m.key).tmean ?? null),
      prcp: months.map((m) => m.prcp),
      normalPrcp: months.map((m) => normalFor(m.key).prcp ?? null),
      tempTitle: 'Observed monthly mean temperature vs. the 10-year normal',
      prcpTitle: 'Observed monthly precipitation vs. the 10-year normal',
    };
  }
  const rows = history.rows;
  const normalFor = (date) => baseline?.daily.get(date.slice(5)) || {};
  return {
    xLabels: rows.map((r) => labelDay(r.date)),
    xTickLabels: rows.map((r) => monthFmt.format(parseISO(r.date))),
    xHeader: 'Date',
    temp: rows.map((r) => r.tmean),
    bandLo: rows.map((r) => r.tmin),
    bandHi: rows.map((r) => r.tmax),
    bandName: "That day's low–high",
    normalTemp: rows.map((r) => normalFor(r.date).tmean ?? null),
    prcp: rows.map((r) => r.prcp),
    normalPrcp: rows.map((r) => normalFor(r.date).prcp ?? null),
    tempTitle: 'Observed daily mean temperature vs. the 10-year normal',
    prcpTitle: 'Observed daily precipitation vs. the 10-year normal',
  };
}

function renderHistory(data) {
  const s = section('history', 'Past 2 years — what actually happened',
    'ERA5 reanalysis: observations blended into a physical model on a 9 km grid. These are measured conditions, not estimates of the future.');
  if (!data.history || !data.history.rows.length) {
    s.append(notice('Historical reanalysis is unavailable for this place.', 'warning'));
    return s;
  }
  const ser = historySeries(data);
  const rows = data.history.rows;
  const last12 = rows.filter((r) => r.date >= iso(addYears(parseISO(data.history.to), -1)));
  const obsMean = last12.reduce((a, r) => a + (r.tmean ?? 0), 0) / (last12.length || 1);
  const normMean = last12.reduce((a, r) => a + (data.baseline?.daily.get(r.date.slice(5))?.tmean ?? 0), 0) / (last12.length || 1);
  const dTemp = obsMean - normMean;
  const obsPrcp = last12.reduce((a, r) => a + (r.prcp ?? 0), 0);
  const normPrcpYear = Object.values(data.baseline?.monthly || {}).reduce((a, m) => a + (m.prcp ?? 0), 0);
  const hottest = rows.reduce((a, r) => (a === null || (r.tmax ?? -99) > (a.tmax ?? -99) ? r : a), null);
  const wettest = rows.reduce((a, r) => (a === null || (r.prcp ?? -1) > (a.prcp ?? -1) ? r : a), null);
  const variability = stdev(last12.map((r) => r.tmean));

  const tiles = h('div', 'tiles');
  tiles.append(
    tile('Mean temperature, last 12 months', T(obsMean, 1),
      `${dTemp >= 0 ? '+' : '−'}${fmt(Math.abs(units.tempDelta(dTemp, state.imperial)), 1)}${U().temp} vs the 10-year normal`, dTemp >= 0 ? 'up' : 'down'),
    tile('Precipitation, last 12 months', P(obsPrcp),
      normPrcpYear ? `${Math.round((obsPrcp / normPrcpYear - 1) * 100)}% vs normal` : null),
    tile('Hottest day', hottest ? T(hottest.tmax) : '—', hottest ? longFmt.format(parseISO(hottest.date)) : null),
    tile('Wettest day', wettest ? P(wettest.prcp) : '—', wettest ? longFmt.format(parseISO(wettest.date)) : null),
    tile('Day-to-day variability', variability === null ? '—' : `±${fmt(units.tempDelta(variability, state.imperial), 1)}${U().temp}`,
      'standard deviation of daily means'),
  );
  const tilesCard = h('div', 'card');
  tilesCard.append(h('h3', 'chart-title', 'The last 12 months in five numbers'), tiles);
  s.append(tilesCard);

  s.append(lineChart({
    title: ser.tempTitle,
    subtitle: `Observed means against the average for the same calendar period, ${U().temp}`,
    xLabels: ser.xLabels,
    xTickLabels: ser.xTickLabels,
    xHeader: ser.xHeader,
    yLabel: U().temp,
    format: fmtTempAxis,
    series: [
      { name: 'Observed mean', color: 'var(--series-1)', values: tempVals(ser.temp) },
      { name: 'Normal (last 10 years)', color: 'var(--series-2)', values: tempVals(ser.normalTemp) },
    ],
    band: { name: ser.bandName, color: 'var(--series-1)', lo: tempVals(ser.bandLo), hi: tempVals(ser.bandHi) },
    height: 300,
  }));

  s.append(barChart({
    title: ser.prcpTitle,
    subtitle: `Measured totals against the normal for the same period, ${U().precip}`,
    xLabels: ser.xLabels,
    xTickLabels: ser.xTickLabels,
    xHeader: ser.xHeader,
    yLabel: U().precip,
    format: fmtPrecipAxis,
    bars: { name: `Observed precipitation (${U().precip})`, color: 'var(--series-1)', values: precipVals(ser.prcp) },
    overlay: { name: 'Normal', color: 'var(--series-2)', values: precipVals(ser.normalPrcp) },
    height: 280,
  }));

  s.append(pastLookup(data));
  return s;
}

function pastLookup(data) {
  const card = h('div', 'card');
  card.append(h('h3', 'chart-title', 'Look up any date in the past 2 years'),
    h('p', 'chart-sub', 'Observed conditions for that day, with the anomaly against the normal for the same date.'));

  const wrap = h('div', 'lookup');
  const field = h('div');
  const input = document.createElement('input');
  input.type = 'date';
  input.id = 'past-date';
  input.min = data.history.from;
  input.max = data.history.to;
  input.value = data.history.to;
  const label = h('label', null, 'Date');
  label.htmlFor = input.id;
  field.append(label, input);
  wrap.append(field);
  card.append(wrap);

  const out = h('div', 'lookup-out');
  card.append(out);

  const run = () => {
    out.replaceChildren();
    const row = data.history.rows.find((r) => r.date === input.value);
    if (!row) { out.append(tile('No observation', '—', 'Try another date in range')); return; }
    const norm = data.baseline?.daily.get(row.date.slice(5));
    const anomaly = norm?.tmean !== undefined && norm?.tmean !== null && row.tmean !== null ? row.tmean - norm.tmean : null;
    const cond = describeCode(row.code);
    out.append(
      tile('Mean temperature', T(row.tmean, 1),
        anomaly === null ? null : `${anomaly >= 0 ? '+' : '−'}${fmt(Math.abs(units.tempDelta(anomaly, state.imperial)), 1)}${U().temp} vs normal`,
        anomaly === null ? null : (anomaly >= 0 ? 'up' : 'down')),
      tile('High / low', `${T(row.tmax)} / ${T(row.tmin)}`, `${cond.glyph} ${cond.label}`),
      tile('Precipitation', P(row.prcp), norm?.prcp === undefined ? null : `normal ${P(norm.prcp)}`),
      tile('Peak wind', S(row.wind)),
      tile('Date', longFmt.format(parseISO(row.date))),
    );
  };

  input.addEventListener('change', run);
  run();
  return card;
}

function renderMethod(data) {
  const s = section('method', 'How each span is produced', null);
  const card = h('div', 'card');
  const list = document.createElement('dl');
  const rows = [
    ['Now and the next 16 days', 'Open-Meteo’s blend of national weather-service models (ICON, GFS, ECMWF IFS among them), on a 1–11 km grid, refreshed hourly. Skill is high for 1–3 days, useful to about a week, and fades to little by day 14.'],
    ['Past 2 years', 'ERA5 / ERA5-Land reanalysis — observations from stations, satellites, radiosondes and buoys assimilated into a physical model at 9 km. Lands about one day behind real time.'],
    ['The 10-year normal', 'The same reanalysis over the previous decade for this exact point, averaged per calendar day with a ±7-day window so one storm cannot spike a “normal”. This is the reference the anomalies compare against.'],
    ['Next 2 years', 'Seven high-resolution downscaled CMIP6 models (CMCC-CM2-VHR4, FGOALS-f3-H, HiRAM-SIT-HR, MRI-AGCM3-2-S, EC-Earth3P-HR, MPI-ESM1-2-XR, NICAM16-8S), bias-corrected against ERA5 for this point, averaged into an ensemble mean with the model spread shown as a band. Climate models reproduce seasonal cycles and trends; they cannot and do not predict the weather on a named future day.'],
    ['What no site can do', 'Deterministic weather prediction has a horizon of roughly two weeks — beyond it, tiny differences in the starting state dominate. Anything presenting a specific temperature for a date 18 months out as a “forecast” is presenting a climatology or a model average, whether or not it says so.'],
  ];
  for (const [term, def] of rows) {
    list.append(h('dt', null, term), h('dd', null, def));
  }
  card.append(list);
  if (data.errors.length) {
    card.append(notice(`Some spans failed to load: ${data.errors.join('; ')}. Everything else on this page is unaffected.`, 'warning'));
  }
  s.append(card);
  return s;
}

/* ---------- rendering ---------- */

function render() {
  if (!state.data) return;
  const d = state.data;
  dom.app.replaceChildren(renderNow(d), renderShortTerm(d), renderOutlook(d), renderHistory(d), renderMethod(d));
}

function renderWelcome() {
  const s = section('welcome', 'Pick a place to begin',
    'Weatherspan puts four spans of weather side by side for anywhere on earth: right now, the next 16 days as a real forecast, the next 2 years as a climate projection, and the past 2 years as measured reanalysis.');
  const card = h('div', 'card');
  card.append(h('p', 'chart-sub', 'Try one of these, or search above:'));
  const row = h('div', 'lookup');
  const examples = [
    { name: 'London', country: 'United Kingdom', latitude: 51.5072, longitude: -0.1276, admin1: 'England' },
    { name: 'New York', country: 'United States', latitude: 40.7143, longitude: -74.006, admin1: 'New York' },
    { name: 'Kolkata', country: 'India', latitude: 22.5626, longitude: 88.363, admin1: 'West Bengal' },
    { name: 'Nairobi', country: 'Kenya', latitude: -1.2833, longitude: 36.8167, admin1: 'Nairobi' },
    { name: 'Reykjavík', country: 'Iceland', latitude: 64.1355, longitude: -21.8954, admin1: '' },
    { name: 'Sydney', country: 'Australia', latitude: -33.8678, longitude: 151.2073, admin1: 'New South Wales' },
  ];
  for (const p of examples) {
    const b = h('button', 'btn', p.name);
    b.type = 'button';
    b.addEventListener('click', () => selectPlace(p));
    row.append(b);
  }
  card.append(row);
  s.append(card);
  dom.app.replaceChildren(s);
}

function showPlaceHead(place) {
  dom.placeHead.hidden = false;
  dom.placeName.textContent = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  const bits = [
    `${Math.abs(place.latitude).toFixed(3)}° ${place.latitude >= 0 ? 'N' : 'S'}, ${Math.abs(place.longitude).toFixed(3)}° ${place.longitude >= 0 ? 'E' : 'W'}`,
  ];
  if (place.elevation !== undefined && place.elevation !== null) bits.push(`${Math.round(place.elevation)} m elevation`);
  if (place.timezone) bits.push(place.timezone);
  if (place.population) bits.push(`population ${place.population.toLocaleString()}`);
  dom.placeMeta.textContent = bits.join(' · ');
}

/* ---------- place selection & routing ---------- */

const STORE_PLACE = 'ws:place';
const STORE_THEME = 'ws:theme';
const STORE_UNIT = 'ws:unit';

/* localStorage throws in some privacy modes — never let that break a render. */
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
};

function writeHash(place) {
  const params = new URLSearchParams({
    name: place.name, lat: String(place.latitude), lon: String(place.longitude),
  });
  if (place.country) params.set('country', place.country);
  if (place.admin1) params.set('admin1', place.admin1);
  history.replaceState(null, '', `#${params}`);
}

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !params.get('name')) return null;
  return {
    name: params.get('name'), latitude: lat, longitude: lon,
    country: params.get('country') || '', admin1: params.get('admin1') || '',
  };
}

async function selectPlace(place) {
  state.place = place;
  hideSuggestions();
  showPlaceHead(place);
  dom.filterbar.hidden = false;
  writeHash(place);
  store.set(STORE_PLACE, JSON.stringify(place));

  state.loading = true;
  setStatus(`Loading four spans for ${place.name}…`, 'loading');
  dom.app.classList.add('loading');
  try {
    const data = await loadPlace(place);
    if (state.place !== place) return;           // a newer selection won
    state.data = data;
    render();
    const parts = [];
    if (data.forecast) parts.push(`forecast to ${labelDay(data.forecast.days[data.forecast.days.length - 1].date)}`);
    if (data.history) parts.push(`observations ${labelDay(data.history.from)} → ${labelDay(data.history.to)}`);
    if (data.outlook) parts.push(`projection to ${labelDay(data.outlook.to)}`);
    setStatus(parts.join(' · ') + (data.errors.length ? ` · gaps: ${data.errors.join('; ')}` : ''),
      data.errors.length ? 'error' : null);
  } catch (err) {
    setStatus(`Could not load data: ${err.message}`, 'error');
  } finally {
    state.loading = false;
    dom.app.classList.remove('loading');
  }
}

/* ---------- search box ---------- */

let suggestions = [];
let activeIndex = -1;
let searchTimer = null;

function hideSuggestions() {
  dom.list.hidden = true;
  dom.list.replaceChildren();
  dom.input.setAttribute('aria-expanded', 'false');
  dom.input.removeAttribute('aria-activedescendant');
  suggestions = [];
  activeIndex = -1;
}

function paintSuggestions() {
  dom.list.replaceChildren();
  suggestions.forEach((p, i) => {
    const li = h('li');
    li.id = `sug-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === activeIndex));
    li.append(h('span', null, p.name),
      h('span', 'sug-sub', [p.admin1, p.country].filter(Boolean).join(', ')));
    li.addEventListener('mousedown', (ev) => { ev.preventDefault(); selectPlace(p); dom.input.value = p.name; });
    dom.list.append(li);
  });
  dom.list.hidden = suggestions.length === 0;
  dom.input.setAttribute('aria-expanded', String(suggestions.length > 0));
  if (activeIndex >= 0) dom.input.setAttribute('aria-activedescendant', `sug-${activeIndex}`);
  else dom.input.removeAttribute('aria-activedescendant');
}

async function runSearch(query) {
  try {
    suggestions = await geocode(query);
    activeIndex = -1;
    paintSuggestions();
    if (!suggestions.length && query.trim().length >= 2) setStatus(`No place matched “${query.trim()}”.`, 'error');
    else if (!state.loading) setStatus(state.data ? dom.status.textContent : '');
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, 'error');
  }
}

dom.input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = dom.input.value;
  if (q.trim().length < 2) { hideSuggestions(); return; }
  searchTimer = setTimeout(() => runSearch(q), 250);
});

dom.input.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (!suggestions.length) return;
    ev.preventDefault();
    activeIndex = ev.key === 'ArrowDown'
      ? (activeIndex + 1) % suggestions.length
      : (activeIndex - 1 + suggestions.length) % suggestions.length;
    paintSuggestions();
  } else if (ev.key === 'Enter') {
    if (activeIndex >= 0 && suggestions[activeIndex]) {
      ev.preventDefault();
      const picked = suggestions[activeIndex];
      dom.input.value = picked.name;
      selectPlace(picked);
    }
  } else if (ev.key === 'Escape') {
    hideSuggestions();
  }
});

dom.input.addEventListener('blur', () => setTimeout(hideSuggestions, 120));

dom.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = dom.input.value.trim();
  if (!q) return;
  if (suggestions.length) { selectPlace(suggestions[Math.max(0, activeIndex)]); return; }
  setStatus(`Searching for “${q}”…`, 'loading');
  const found = await geocode(q, 1);
  if (found.length) selectPlace(found[0]);
  else setStatus(`No place matched “${q}”.`, 'error');
});

/* ---------- geolocation, theme, unit & grain toggles ---------- */

dom.geo.addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('This browser has no location service — search for a place instead.', 'error'); return; }
  setStatus('Asking your browser for your location…', 'loading');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const near = await geocode(`${latitude.toFixed(2)},${longitude.toFixed(2)}`, 1).catch(() => []);
      selectPlace({
        name: near[0]?.name || 'My location',
        admin1: near[0]?.admin1 || '',
        country: near[0]?.country || '',
        latitude, longitude,
      });
    },
    (err) => setStatus(`Location unavailable (${err.message}). Search for a place instead.`, 'error'),
    { timeout: 10000, maximumAge: 6e5 },
  );
});

function applyTheme(mode) {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  dom.themeGlyph.textContent = mode === 'light' ? '☀' : mode === 'dark' ? '☾' : '◐';
  dom.theme.title = `Colour theme: ${mode}`;
  store.set(STORE_THEME, mode);
}

dom.theme.addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const current = store.get(STORE_THEME) || 'auto';
  applyTheme(order[(order.indexOf(current) + 1) % order.length]);
});

for (const btn of dom.filterbar.querySelectorAll('[data-unit]')) {
  btn.addEventListener('click', () => {
    state.imperial = btn.dataset.unit === 'imperial';
    for (const b of dom.filterbar.querySelectorAll('[data-unit]')) b.setAttribute('aria-checked', String(b === btn));
    store.set(STORE_UNIT, btn.dataset.unit);
    render();
  });
}

for (const btn of dom.filterbar.querySelectorAll('[data-grain]')) {
  btn.addEventListener('click', () => {
    state.grain = btn.dataset.grain;
    for (const b of dom.filterbar.querySelectorAll('[data-grain]')) b.setAttribute('aria-checked', String(b === btn));
    render();
  });
}

/* ---------- boot ---------- */

(function boot() {
  applyTheme(store.get(STORE_THEME) || 'auto');

  const savedUnit = store.get(STORE_UNIT);
  if (savedUnit === 'imperial') {
    state.imperial = true;
    for (const b of dom.filterbar.querySelectorAll('[data-unit]')) b.setAttribute('aria-checked', String(b.dataset.unit === 'imperial'));
  }

  let place = readHash();
  if (!place) {
    try { place = JSON.parse(store.get(STORE_PLACE) || 'null'); } catch { place = null; }
  }
  if (place && Number.isFinite(place.latitude) && Number.isFinite(place.longitude)) {
    dom.input.value = place.name || '';
    selectPlace(place);
  } else {
    renderWelcome();
  }
}());

