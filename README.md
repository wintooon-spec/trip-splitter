# TripSplit 🧾

Mobile-first PWA for splitting and tracking travel expenses in a small group. Built for a 6-week Europe trip: a core pair plus friends who join for individual legs.

**Setup:** see [SETUP.md](SETUP.md) — Firebase config is required before first use.

## Features

- **Trips & join codes** — create a trip once, others join with a short code. All data syncs live between phones via Firebase Realtime Database.
- **Groups** — a default "Main" group for the core pair, plus temporary groups for legs where friends join. Settle-up is per group; groups are closed (balances frozen) when people leave.
- **Expenses** — amount, currency (EUR/GBP/AUD/USD), category, who paid, equal or custom split. Live AUD conversion via the Frankfurter API, cached for offline entry.
- **Balances & settle up** — per-group net positions and a minimum-transaction settlement plan; mark payments as settled.
- **Receipt scanning** — photograph a receipt and Claude Haiku extracts amount, currency, merchant and category to pre-fill the form. Photos are never stored.
- **Insights** — personal spend across all groups, daily budget tracker, spend by category and by group, exportable trip summary.
- **PWA** — installs to the iPhone home screen from Safari, dark mode, works offline for viewing and entry.

## Stack

Vanilla HTML/CSS/JS (no build step) · Firebase Realtime Database · Anthropic API (`claude-haiku-4-5-20251001`) · Frankfurter exchange rates · GitHub Pages.
