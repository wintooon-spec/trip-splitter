# TripSplit — One-time Setup

Three things to do before the app works: **Firebase** (required, ~5 min), **Anthropic API key** (optional, for receipt scanning), and **installing on your iPhones**.

---

## 1. Firebase (required)

All trip data lives in a free Firebase Realtime Database so both phones sync live.

1. Go to <https://console.firebase.google.com> and sign in with any Google account.
2. Click **Create a Firebase project** (or "Add project"). Name it anything, e.g. `tripsplit`. You can **disable Google Analytics** when asked — not needed.
3. Once the project opens, in the left sidebar go to **Build → Realtime Database** and click **Create database**.
   - Location: pick **europe-west1 (Belgium)** — you'll be in Europe, lower latency.
   - Security rules: choose **Start in locked mode** (we'll replace the rules next).
4. In the Realtime Database page, open the **Rules** tab, replace everything with the contents of [`firebase-rules.json`](firebase-rules.json) in this repo, and click **Publish**:

   ```json
   {
     "rules": {
       "trips": { ".read": true, ".write": true },
       "joinCodes": { ".read": true, ".write": true }
     }
   }
   ```

5. Now register the web app: click the **gear icon → Project settings**, scroll to **Your apps**, click the **`</>` (Web)** icon.
   - Nickname: `tripsplit` — do **not** tick Firebase Hosting.
   - Click **Register app**. It shows a `firebaseConfig` code block.
6. Copy the values from that block into [`js/config.js`](js/config.js) in this repo, replacing the placeholder block. Make sure `databaseURL` is included — if it's missing from what Firebase shows you, copy the URL shown at the top of the Realtime Database **Data** tab (looks like `https://tripsplit-xxxxx-default-rtdb.europe-west1.firebasedatabase.app`).
7. Commit and push — GitHub Pages redeploys automatically in ~1 minute:

   ```
   git add js/config.js
   git commit -m "Add Firebase config"
   git push
   ```

> **Security note:** the Firebase web config is not a secret (it's public in every Firebase web app). The open read/write rules mean anyone who discovers your database URL could read/write trip data — acceptable for a personal trip app with no sensitive data, and the trade-off for not needing logins. Don't put anything private in expense descriptions.

---

## 2. Anthropic API key (optional — receipt scanning)

1. Go to <https://console.anthropic.com>, create an account, and add a small amount of credit (US$5 lasts a long time — each receipt scan with Haiku costs a fraction of a cent).
2. Go to **API keys → Create key**, copy the `sk-ant-...` key.
3. In the app: **Settings → Anthropic API key → paste → Save key**.

The key is stored only in your phone's localStorage. Each phone that wants to scan receipts enters the key once. Photos are sent to Anthropic for extraction and are **not stored** anywhere.

---

## 3. Install on iPhone

1. Open the GitHub Pages URL in **Safari** (not Chrome).
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Open it from the home screen icon — it runs full-screen like a native app.

First launch needs internet (caches the app). After that it opens offline; expenses added offline sync when you reconnect, as long as the app stays open until then.

---

## Daily use

- **You** create the trip once (trip name, your names, optional daily budget) → get a join code like `EU2026-4X9`.
- **Your partner** installs the app, taps **Join with a code**, enters the code, and taps their own name.
- When friends join for a leg: create a **New group** (e.g. "Croatia"), add their names. They can install the app and join with the same trip code, claiming their name. When they leave: **Balances → Close this group** after settling.
