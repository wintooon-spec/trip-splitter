// Live AUD conversion via Frankfurter (ECB rates, no key needed).
// Rates are cached in localStorage so offline entry falls back to the
// last known rate (flagged as stale in the UI preview).
import { HOME_CURRENCY } from "./config.js";

const CACHE_KEY = "ts_rates";

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
  catch { return {}; }
}

function saveCache(cache) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

export function cachedRate(currency) {
  if (currency === HOME_CURRENCY) return { rate: 1, date: null, stale: false };
  const entry = loadCache()[currency];
  if (!entry) return null;
  const today = new Date().toISOString().slice(0, 10);
  return { ...entry, stale: entry.fetchedOn !== today };
}

// Returns { rate, date, stale } or null if offline with no cache.
export async function getRate(currency) {
  if (currency === HOME_CURRENCY) return { rate: 1, date: null, stale: false };
  const today = new Date().toISOString().slice(0, 10);
  const cache = loadCache();
  if (cache[currency]?.fetchedOn === today) return { ...cache[currency], stale: false };
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=${HOME_CURRENCY}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const entry = { rate: data.rates[HOME_CURRENCY], date: data.date, fetchedOn: today };
    cache[currency] = entry;
    saveCache(cache);
    return { ...entry, stale: false };
  } catch {
    return cache[currency] ? { ...cache[currency], stale: true } : null;
  }
}

export function toAUD(amount, rateInfo) {
  if (!rateInfo) return null;
  return Math.round(amount * rateInfo.rate * 100) / 100;
}
