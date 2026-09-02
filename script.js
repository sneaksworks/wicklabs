/* wicklabs app */

const API_KEY = "8b512483caf04a168b28da4791fedaa4";
const DEFAULT_SYMBOL = "AAPL";
const DEFAULT_TF = "1D";
const BARS = 300;
const CACHE_TTL_MS = 60 * 1000;

const INTERVALS = {
  "1m":  { api: "1min",  seconds: 60,     intraday: true },
  "5m":  { api: "5min",  seconds: 300,    intraday: true },
  "15m": { api: "15min", seconds: 900,    intraday: true },
  "1h":  { api: "1h",    seconds: 3600,   intraday: true },
  "4h":  { api: "4h",    seconds: 14400,  intraday: true },
  "1D":  { api: "1day",  seconds: 86400,  intraday: false },
  "1W":  { api: "1week", seconds: 604800, intraday: false },
};

const C = {
  accent: "#6e56f7",
  up: "#34d399",
  down: "#f87171",
  muted: "#9b94ae",
  border: "#2a2438",
  flow: "#a78bfa",
  ma: "#60a5fa",
  maSlow: "#7dd3fc",
  bands: "#c084fc",
  volume: "#f59e0b",
};

const INDICATORS = {
  flow:       { name: "AI Predictive Flow",  color: C.flow,   desc: "Regression curve plus a forward cone tilted by the model" },
  supertrend: { name: "AI SuperTrend",       color: C.up,     desc: "ATR trailing line with BUY and SELL flips and confidence" },
  ma:         { name: "AI Moving Average",   color: C.ma,     desc: "Fast and slow EMA, fast line colored by model bias" },
  bands:      { name: "AI Volatility Bands", color: C.bands,  desc: "Dashed volatility channel around price" },
  volbreak:   { name: "AI Volume Breakout",  color: C.volume, desc: "Volume spikes that break the recent range" },
};

const $ = (id) => document.getElementById(id);
const els = {
  form: $("search-form"),
  input: $("ticker-input"),
  searchBtn: $("search-btn"),
  status: $("status-message"),
  statusPill: $("status-pill"),
  timeframes: $("timeframes"),
  indicatorToggle: $("indicator-toggle"),
  indicatorPanel: $("indicator-panel"),
  indicatorCount: $("indicator-count"),
  volumeToggle: $("volume-toggle"),
  chartPanel: $("chart-panel"),
  chartHeader: $("chart-header"),
  symbol: $("chart-symbol"),
  price: $("chart-price"),
  change: $("chart-change"),
  bias: $("stat-bias"),
  biasBar: $("bias-bar"),
  trend: $("stat-trend"),
  vol: $("stat-vol"),
  signal: $("stat-signal"),
  skeleton: $("skeleton"),
  emptyState: $("empty-state"),
  chartContainer: $("chart-container"),
  legend: $("legend"),
};

const state = {
  symbol: null,
  tf: DEFAULT_TF,
  candles: [],
  probs: [],
  st: null,
  active: new Set(["flow", "supertrend"]),
  showVolume: true,
  cache: new Map(),
  chart: null,
  candleSeries: null,
  volumeSeries: null,
  indicatorSeries: [],
  markers: [],
  lockRange: null,
  loadId: 0,
  renderId: 0,
  loading: false,
  lastShownPrice: null,
};

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtPrice = (v) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- chart ---------- */

function initChart() {
  state.chart = LightweightCharts.createChart(els.chartContainer, {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "transparent" },
      textColor: C.muted,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "rgba(154, 148, 174, 0.07)" },
      horzLines: { color: "rgba(154, 148, 174, 0.07)" },
    },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.25 } },
    timeScale: { borderColor: C.border, rightOffset: 4, timeVisible: false, secondsVisible: false },
    crosshair: {
      vertLine: { color: "rgba(110, 86, 247, 0.45)", labelBackgroundColor: C.accent },
      horzLine: { color: "rgba(110, 86, 247, 0.45)", labelBackgroundColor: C.accent },
    },
    watermark: {
      visible: true,
      text: "wicklabs",
      color: "rgba(110, 86, 247, 0.09)",
      fontSize: 64,
      fontFamily: "'Space Grotesk', sans-serif",
      horzAlign: "center",
      vertAlign: "center",
    },
  });

  state.candleSeries = state.chart.addCandlestickSeries({
    upColor: C.up,
    downColor: C.down,
    wickUpColor: C.up,
    wickDownColor: C.down,
    borderVisible: false,
    autoscaleInfoProvider: (original) => (state.lockRange ? { priceRange: state.lockRange } : original()),
  });

  state.volumeSeries = state.chart.addHistogramSeries({
    priceFormat: { type: "volume" },
    priceScaleId: "volume",
    lastValueVisible: false,
    priceLineVisible: false,
  });
  state.chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
}

/* ---------- data ---------- */

function toUnix(datetime, intraday) {
  const iso = intraday ? datetime.replace(" ", "T") + "Z" : datetime + "T00:00:00Z";
  return Math.floor(Date.parse(iso) / 1000);
}

async function fetchCandles(symbol, tf) {
  const key = `${symbol}|${tf}`;
  const hit = state.cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const cfg = INTERVALS[tf];
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${cfg.api}&outputsize=${BARS}&apikey=${API_KEY}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.status === "error" || !Array.isArray(data.values)) {
    const err = new Error(data.message || "Ticker not found");
    err.code = data.code;
    err.fromApi = true;
    throw err;
  }

  const seen = new Set();
  const candles = [];
  for (const v of data.values.slice().reverse()) {
    const time = toUnix(v.datetime, cfg.intraday);
    if (!Number.isFinite(time) || seen.has(time)) continue;
    seen.add(time);
    candles.push({
      time,
      open: +v.open,
      high: +v.high,
      low: +v.low,
      close: +v.close,
      volume: v.volume ? +v.volume : 0,
    });
  }
  candles.sort((a, b) => a.time - b.time);
  state.cache.set(key, { at: Date.now(), data: candles });
  return candles;
}

function futureTimes(lastTime, count, tf) {
  const cfg = INTERVALS[tf];
  const out = [];
  let t = lastTime;
  for (let i = 0; i < count; i++) {
    t += cfg.seconds;
    if (cfg.api === "1day") {
      while ([0, 6].includes(new Date(t * 1000).getUTCDay())) t += 86400;
    }
    out.push(t);
  }
  return out;
}

function friendlyError(err, symbol) {
  if (err.code === 429) return "Twelve Data's free plan allows 8 requests a minute. Wait a moment and try again.";
  if (err.code === 401) return "The API key was rejected. Check the key at the top of script.js.";
  if (err.fromApi) {
    if (/not found|invalid|symbol/i.test(err.message)) return `Could not find "${symbol}". Check the ticker and try again.`;
    return err.message;
  }
  if (err instanceof TypeError) return "Network error. Check your connection and try again.";
  return "The data loaded but drawing the chart failed. Open the browser console for details.";
}

/* ---------- loading ---------- */

function setLoading(on, label) {
  state.loading = on;
  els.searchBtn.disabled = on;
  els.chartPanel.classList.toggle("is-loading", on);
  els.skeleton.classList.toggle("hidden", !(on && !state.chart));
  els.emptyState.classList.toggle("hidden", on || !!state.chart);
  els.statusPill.textContent = label;
  els.statusPill.className = "status-pill " + (on ? "loading" : label === "Ready" ? "ready" : "");
}

async function loadSymbol(symbol, tf) {
  const myLoad = ++state.loadId;
  els.status.textContent = "";
  setLoading(true, `Loading ${symbol} ${tf}`);

  let candles;
  try {
    candles = await fetchCandles(symbol, tf);
  } catch (err) {
    if (myLoad !== state.loadId) return;
    setLoading(false, state.chart ? "Ready" : "Idle");
    els.status.textContent = friendlyError(err, symbol);
    console.error(err);
    return;
  }
  if (myLoad !== state.loadId) return;

  try {
    state.symbol = symbol;
    state.tf = tf;
    state.candles = candles;
    state.probs = Indicators.knnProbabilities(candles);
    state.st = Indicators.superTrend(candles);

    els.chartContainer.classList.remove("hidden");
    els.chartHeader.classList.remove("hidden");
    if (!state.chart) initChart();
    state.chart.timeScale().applyOptions({ timeVisible: INTERVALS[tf].intraday });

    setLoading(false, "Ready");
    updateStats();
    await renderAll();
  } catch (err) {
    setLoading(false, "Idle");
    els.status.textContent = friendlyError(err, symbol);
    console.error(err);
  }
}

/* ---------- rendering ---------- */

function reveal(series, data, { duration = 700, delay = 0, renderId } = {}) {
  if (reducedMotion() || data.length < 2) {
    series.setData(data);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const n = data.length;
    const blanks = data.map((d) => ({ time: d.time }));
    let start = null;
    const step = (now) => {
      if (renderId !== state.renderId) return resolve();
      if (start === null) start = now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - t, 3);
      const count = Math.round(eased * n);
      series.setData(data.slice(0, count).concat(blanks.slice(count)));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

function lineData(times, values) {
  return values.map((v, i) => (v === null || v === undefined ? { time: times[i] } : { time: times[i], value: v }));
}

// Split one line into an "up" and a "down" series so it can change color
function splitByFlag(times, values, isUp, connect) {
  const up = [];
  const down = [];
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || isUp[i] === null) {
      up.push({ time: times[i] });
      down.push({ time: times[i] });
      continue;
    }
    const prevUp = i > 0 ? isUp[i - 1] : isUp[i];
    if (isUp[i]) {
      up.push({ time: times[i], value: v });
      down.push(connect && prevUp === false ? { time: times[i], value: v } : { time: times[i] });
    } else {
      down.push({ time: times[i], value: v });
      up.push(connect && prevUp === true ? { time: times[i], value: v } : { time: times[i] });
    }
  }
  return { up, down };
}

function buildVolumeData() {
  const vb = state.active.has("volbreak") ? Indicators.volumeBreakouts(state.candles) : null;
  return state.candles.map((c, i) => {
    const up = c.close >= c.open;
    let color = up ? "rgba(52, 211, 153, 0.28)" : "rgba(248, 113, 113, 0.28)";
    if (vb && vb.spikes.has(i)) color = up ? "rgba(52, 211, 153, 0.9)" : "rgba(248, 113, 113, 0.9)";
    return { time: c.time, value: c.volume, color };
  });
}

function buildIndicatorLayers() {
  const { chart, candles, probs, st } = state;
  const times = candles.map((c) => c.time);
  const closes = candles.map((c) => c.close);
  const layers = [];
  const LS = LightweightCharts.LineStyle;

  const addLine = (opts, data) => {
    const series = chart.addLineSeries({
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      ...opts,
    });
    state.indicatorSeries.push(series);
    layers.push({ series, data });
  };

  let lastProb = 0.5;
  for (let i = probs.length - 1; i >= 0; i--) {
    if (probs[i] !== null) { lastProb = probs[i]; break; }
  }

  if (state.active.has("bands")) {
    const bb = Indicators.bollinger(closes, 20, 2);
    addLine({ color: C.bands, lineWidth: 1, lineStyle: LS.Dashed }, lineData(times, bb.upper));
    addLine({ color: "rgba(192, 132, 252, 0.45)", lineWidth: 1, lineStyle: LS.Dotted }, lineData(times, bb.mid));
    addLine({ color: C.bands, lineWidth: 1, lineStyle: LS.Dashed }, lineData(times, bb.lower));
  }

  if (state.active.has("ma")) {
    const fast = Indicators.ema(closes, 9);
    const slow = Indicators.ema(closes, 21);
    const isUp = fast.map((f, i) => {
      if (f === null || slow[i] === null) return null;
      return probs[i] === null ? f >= slow[i] : probs[i] >= 0.5;
    });
    const split = splitByFlag(times, fast, isUp, true);
    addLine({ color: C.maSlow, lineWidth: 1, lineStyle: LS.Dotted }, lineData(times, slow));
    addLine({ color: C.up, lineWidth: 2 }, split.up);
    addLine({ color: C.down, lineWidth: 2 }, split.down);
    for (let i = 1; i < times.length; i++) {
      if (fast[i] === null || slow[i - 1] === null) continue;
      const crossUp = fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
      const crossDown = fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
      if (crossUp || crossDown) {
        state.markers.push({
          time: times[i],
          position: crossUp ? "belowBar" : "aboveBar",
          color: C.ma,
          shape: "circle",
          size: 0.6,
        });
      }
    }
  }

  if (state.active.has("supertrend")) {
    const isUp = st.trend.map((t) => (t === null ? null : t === 1));
    const split = splitByFlag(times, st.line, isUp, false);
    addLine({ color: C.up, lineWidth: 2 }, split.up);
    addLine({ color: C.down, lineWidth: 2 }, split.down);
    for (const f of st.flips) {
      const p = probs[f.index];
      const conf = p === null ? null : Math.round((f.dir === 1 ? p : 1 - p) * 100);
      state.markers.push({
        time: times[f.index],
        position: f.dir === 1 ? "belowBar" : "aboveBar",
        color: f.dir === 1 ? C.up : C.down,
        shape: f.dir === 1 ? "arrowUp" : "arrowDown",
        text: (f.dir === 1 ? "BUY" : "SELL") + (conf === null ? "" : ` ${conf}%`),
        size: 1,
      });
    }
  }

  if (state.active.has("flow")) {
    const curve = Indicators.lsma(closes, 20);
    addLine({ color: "rgba(167, 139, 250, 0.75)", lineWidth: 1, lineStyle: LS.Dashed }, lineData(times, curve));

    const forward = 12;
    const proj = Indicators.projection(closes, { lookback: 30, forward });
    const tilt = (lastProb - 0.5) * proj.sigma * 0.8;
    const last = candles[candles.length - 1];
    const future = futureTimes(last.time, forward, state.tf);

    const center = [{ time: last.time, value: last.close }];
    const upper = [{ time: last.time, value: last.close }];
    const lower = [{ time: last.time, value: last.close }];
    for (let t = 1; t <= forward; t++) {
      const v = proj.center[t - 1] + tilt * t;
      const w = proj.width[t - 1];
      center.push({ time: future[t - 1], value: v });
      upper.push({ time: future[t - 1], value: v + w });
      lower.push({ time: future[t - 1], value: v - w });
    }
    addLine({ color: "rgba(167, 139, 250, 0.4)", lineWidth: 1, lineStyle: LS.SparseDotted }, upper);
    addLine({ color: "rgba(167, 139, 250, 0.4)", lineWidth: 1, lineStyle: LS.SparseDotted }, lower);
    addLine({ color: C.flow, lineWidth: 2, lineStyle: LS.Dashed }, center);
  }

  if (state.active.has("volbreak")) {
    const vb = Indicators.volumeBreakouts(candles);
    for (const e of vb.events) {
      state.markers.push({
        time: times[e.index],
        position: e.dir === 1 ? "belowBar" : "aboveBar",
        color: C.volume,
        shape: "circle",
        text: e.dir === 1 ? "VOL BREAK" : "VOL DROP",
        size: 0.8,
      });
    }
  }

  return layers;
}

async function renderAll() {
  if (!state.chart || !state.candles.length) return;
  const renderId = ++state.renderId;
  const { chart, candleSeries, volumeSeries, candles } = state;

  for (const s of state.indicatorSeries) chart.removeSeries(s);
  state.indicatorSeries = [];
  state.markers = [];
  candleSeries.setMarkers([]);

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  const pad = (hi - lo) * 0.06;
  state.lockRange = { minValue: lo - pad, maxValue: hi + pad };

  const candleData = candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
  const volumeData = buildVolumeData();
  const volumeOn = state.showVolume || state.active.has("volbreak");

  volumeSeries.applyOptions({ visible: volumeOn });
  chart.priceScale("right").applyOptions({ autoScale: true, scaleMargins: { top: 0.08, bottom: volumeOn ? 0.25 : 0.06 } });

  const layers = buildIndicatorLayers();

  // Whitespace first so the time axis is full width before the reveal starts
  candleSeries.setData(candleData.map((d) => ({ time: d.time })));
  volumeSeries.setData(volumeData.map((d) => ({ time: d.time })));
  for (const l of layers) l.series.setData(l.data.map((d) => ({ time: d.time })));
  chart.timeScale().fitContent();

  await Promise.all([
    reveal(candleSeries, candleData, { duration: 800, renderId }),
    reveal(volumeSeries, volumeData, { duration: 800, renderId }),
    ...layers.map((l, i) => reveal(l.series, l.data, { duration: 650, delay: 260 + i * 110, renderId })),
  ]);

  if (renderId !== state.renderId) return;
  state.lockRange = null;
  chart.priceScale("right").applyOptions({ autoScale: true });
  state.markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(state.markers);
  renderLegend();
}

function renderLegend() {
  const chips = [];
  for (const id of Object.keys(INDICATORS)) {
    if (!state.active.has(id)) continue;
    chips.push(`<span class="chip"><i style="background:${INDICATORS[id].color}"></i>${INDICATORS[id].name}</span>`);
  }
  if (state.showVolume || state.active.has("volbreak")) {
    chips.push(`<span class="chip"><i style="background:${C.muted}"></i>Volume</span>`);
  }
  els.legend.innerHTML = chips.join("");
}

/* ---------- stats ---------- */

function animateNumber(el, from, to, duration = 700) {
  if (reducedMotion()) {
    el.textContent = fmtPrice(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = fmtPrice(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function updateStats() {
  const { candles, probs, st } = state;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const change = last.close - prev.close;
  const pct = (change / prev.close) * 100;
  const up = change >= 0;

  els.symbol.textContent = state.symbol;
  animateNumber(els.price, state.lastShownPrice ?? last.close * 0.97, last.close);
  state.lastShownPrice = last.close;
  els.change.textContent = `${up ? "+" : ""}${change.toFixed(2)} (${up ? "+" : ""}${pct.toFixed(2)}%)`;
  els.change.className = "chart-change " + (up ? "up" : "down");

  let p = null;
  for (let i = probs.length - 1; i >= 0; i--) {
    if (probs[i] !== null) { p = probs[i]; break; }
  }
  if (p === null) {
    els.bias.textContent = "Warming up";
    els.bias.className = "stat-value";
    els.biasBar.style.width = "0%";
    els.biasBar.className = "bias-fill";
  } else {
    const bull = p >= 0.5;
    const conf = Math.round((bull ? p : 1 - p) * 100);
    els.bias.textContent = `${bull ? "Bullish" : "Bearish"} ${conf}%`;
    els.bias.className = "stat-value " + (bull ? "up" : "down");
    els.biasBar.style.width = `${conf}%`;
    els.biasBar.className = "bias-fill " + (bull ? "up" : "down");
  }

  const t = st.trend[st.trend.length - 1];
  els.trend.textContent = t === 1 ? "Uptrend" : t === -1 ? "Downtrend" : "n/a";
  els.trend.className = "stat-value " + (t === 1 ? "up" : t === -1 ? "down" : "");

  const a = st.atr[st.atr.length - 1];
  els.vol.textContent = a ? `${((a / last.close) * 100).toFixed(2)}% ATR` : "n/a";

  const f = st.flips[st.flips.length - 1];
  if (f) {
    els.signal.textContent = `${f.dir === 1 ? "BUY" : "SELL"} at ${fmtPrice(candles[f.index].close)}`;
    els.signal.className = "stat-value " + (f.dir === 1 ? "up" : "down");
  } else {
    els.signal.textContent = "None yet";
    els.signal.className = "stat-value";
  }
}

/* ---------- UI wiring ---------- */

function buildIndicatorPanel() {
  els.indicatorPanel.innerHTML = Object.entries(INDICATORS)
    .map(
      ([id, ind]) => `
      <label class="ind-row">
        <span class="ind-swatch" style="background:${ind.color};color:${ind.color}"></span>
        <span class="ind-text">
          <span class="ind-name">${ind.name}</span>
          <span class="ind-desc">${ind.desc}</span>
        </span>
        <span class="switch">
          <input type="checkbox" data-indicator="${id}" ${state.active.has(id) ? "checked" : ""}>
          <span class="switch-track" aria-hidden="true"></span>
        </span>
      </label>`
    )
    .join("");
  els.indicatorCount.textContent = state.active.size;

  els.indicatorPanel.querySelectorAll("input[data-indicator]").forEach((box) => {
    box.addEventListener("change", () => {
      const id = box.dataset.indicator;
      if (box.checked) state.active.add(id);
      else state.active.delete(id);
      els.indicatorCount.textContent = state.active.size;
      renderAll();
    });
  });
}

function setPanelOpen(open) {
  els.indicatorPanel.hidden = !open;
  els.indicatorToggle.setAttribute("aria-expanded", String(open));
}

els.indicatorToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  setPanelOpen(els.indicatorPanel.hidden);
});
els.indicatorPanel.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => setPanelOpen(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setPanelOpen(false);
});

els.volumeToggle.addEventListener("change", () => {
  state.showVolume = els.volumeToggle.checked;
  renderAll();
});

els.timeframes.querySelectorAll("button[data-tf]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tf = btn.dataset.tf;
    if (tf === state.tf && state.symbol) return;
    els.timeframes.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    state.tf = tf;
    if (state.symbol) loadSymbol(state.symbol, tf);
  });
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const symbol = els.input.value.trim().toUpperCase();
  if (!symbol) return;
  els.input.value = symbol;
  loadSymbol(symbol, state.tf);
});

buildIndicatorPanel();
els.input.value = DEFAULT_SYMBOL;
loadSymbol(DEFAULT_SYMBOL, DEFAULT_TF);
