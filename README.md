# Weatherspan

Four spans of weather for any place on earth, side by side:

- **Right now** — current conditions from Open-Meteo's blend of national weather-service models.
- **Next 16 days** — a genuine numerical forecast (the only span where day-by-day detail is meaningful).
- **Next 2 years** — a *climate outlook*, not a forecast: a seven-model, bias-corrected CMIP6 ensemble
  shown against the observed 10-year normals for the same calendar dates, with the model spread as a band.
- **Past 2 years** — ERA5 reanalysis (measured conditions), with anomalies against the 10-year normal.

Deterministic weather prediction has a horizon of roughly two weeks. Beyond it this site shows a climate
projection and climatological normals — explicitly labelled as such — never a "forecast" of a named day.

## Running locally

It's a static site with no build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## How it's built

- Vanilla ES modules, no framework, no third-party JavaScript, no API key.
- Data: [Open-Meteo](https://open-meteo.com/) — Geocoding, Forecast, Archive (ERA5), and Climate (CMIP6) APIs.
- Charts are hand-rolled SVG: one y-axis per plot, keyboard-reachable, each with a table-view twin.
- Accessible: ARIA combobox search, live status region, light/dark themes, metric/imperial units.

Data © [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). ERA5 © Copernicus Climate Change Service.
