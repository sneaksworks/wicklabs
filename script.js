// TODO: replace this with your own free key from twelvedata.com
// Sign up, copy the key from your dashboard, and paste it below.
const API_KEY = "YOUR_TWELVE_DATA_API_KEY";

const form = document.getElementById("search-form");
const input = document.getElementById("ticker-input");
const statusEl = document.getElementById("status-message");
const chartHeader = document.getElementById("chart-header");
const symbolEl = document.getElementById("chart-symbol");
const priceEl = document.getElementById("chart-price");
const changeEl = document.getElementById("chart-change");
const emptyState = document.getElementById("empty-state");
const chartContainer = document.getElementById("chart-container");

let chart = null;
let candleSeries = null;
let projectionSeries = null;

function initChart() {
  chart = LightweightCharts.createChart(chartContainer, {
    layout: {
      background: { color: "transparent" },
      textColor: "#9b94ae",
      fontFamily: "JetBrains Mono, monospace",
    },
    grid: {
      vertLines: { color: "rgba(154, 148, 174, 0.08)" },
      horzLines: { color: "rgba(154, 148, 174, 0.08)" },
    },
    rightPriceScale: { borderColor: "#2a2438" },
    timeScale: { borderColor: "#2a2438" },
    autoSize: true,
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#34d399",
    downColor: "#f87171",
    wickUpColor: "#34d399",
    wickDownColor: "#f87171",
    borderVisible: false,
  });

  projectionSeries = chart.addLineSeries({
    color: "#6e56f7",
    lineWidth: 2,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    lastValueVisible: false,
    priceLineVisible: false,
  });
}

// Basic least squares fit: y = slope * x + intercept
function linearRegression(points) {
  const n = points.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;

  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumXX += p.x * p.x;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function nextBusinessDays(startDate, count) {
  const days = [];
  const current = new Date(startDate);

  while (days.length < count) {
    current.setDate(current.getDate() + 1);
    const weekday = current.getDay();
    if (weekday !== 0 && weekday !== 6) {
      days.push(new Date(current));
    }
  }

  return days;
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

async function fetchCandles(symbol) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=120&apikey=${API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.status === "error" || !data.values) {
    throw new Error(data.message || "Ticker not found");
  }

  return data.values
    .slice()
    .reverse()
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }));
}

function buildProjection(candles, lookback = 30, forwardDays = 10) {
  const recent = candles.slice(-lookback);
  const points = recent.map((c, i) => ({ x: i, y: c.close }));
  const { slope, intercept } = linearRegression(points);

  const lastCandle = candles[candles.length - 1];
  const lastDate = new Date(lastCandle.time);
  const futureDates = nextBusinessDays(lastDate, forwardDays);

  const line = [{ time: lastCandle.time, value: lastCandle.close }];

  futureDates.forEach((date, i) => {
    const x = lookback + i;
    const y = slope * x + intercept;
    line.push({ time: formatDate(date), value: y });
  });

  return line;
}

async function handleSearch(symbol) {
  statusEl.textContent = "";

  try {
    const candles = await fetchCandles(symbol);

    emptyState.classList.add("hidden");
    chartContainer.classList.remove("hidden");
    chartHeader.classList.remove("hidden");

    if (!chart) initChart();

    candleSeries.setData(candles);
    const projection = buildProjection(candles);
    projectionSeries.setData(projection);
    chart.timeScale().fitContent();

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2] || last;
    const change = last.close - prev.close;
    const changePct = (change / prev.close) * 100;
    const isUp = change >= 0;

    symbolEl.textContent = symbol.toUpperCase();
    priceEl.textContent = last.close.toFixed(2);
    changeEl.textContent = `${isUp ? "+" : ""}${change.toFixed(2)} (${changePct.toFixed(2)}%)`;
    changeEl.className = `chart-change ${isUp ? "up" : "down"}`;
  } catch (err) {
    statusEl.textContent = `Could not load "${symbol.toUpperCase()}". Check the ticker and try again.`;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const symbol = input.value.trim();
  if (!symbol) return;
  handleSearch(symbol);
});
