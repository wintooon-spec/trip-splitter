import { CATEGORIES, CURRENCIES, CURRENCY_SYMBOLS } from "./config.js";
import * as DB from "./db.js";
import { getRate, cachedRate, toAUD } from "./currency.js";
import { computeNets, simplifyDebts, equalSplit, computeItemizedSplits, percentToAmounts } from "./settle.js";
import { scanReceipt, getApiKey, setApiKey } from "./receipt.js";

// ---------------- state ----------------
const S = {
  tripId: localStorage.getItem("ts_trip") || null,
  memberId: localStorage.getItem("ts_member") || null,
  groupId: localStorage.getItem("ts_group") || null,
  trip: null,
  screen: "home",
  // join flow
  pendingTripId: null,
  pendingTrip: null,
  // expense form
  editingId: null,
  splitMode: "equal", // "equal" | "amounts" | "percent"
  included: new Set(),
  customSplits: {},    // memberId -> dollar amount (amounts mode)
  pctSplits: {},       // memberId -> percent (percent mode)
  selCategory: CATEGORIES[0],
  selCurrency: "EUR",
  selPaidBy: null,
  // itemize flow (transient — never written to Firebase)
  itemize: null,
  unsubTrip: null,
};

const COLORS = ["#5b9cf5", "#f08c5a", "#5ac88f", "#c98ef0", "#f0d05a", "#f06d8c", "#5ad0d0", "#a8b86a"];

// ---------------- tiny dom helpers ----------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtAUD = (n) => n == null ? "—" : `A$${Number(n).toFixed(2)}`;
const fmtMoney = (n, cur) => `${CURRENCY_SYMBOLS[cur] || cur + " "}${Number(n).toFixed(2)}`;
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------------- trip data accessors ----------------
const members = () => S.trip?.members || {};
const groups = () => S.trip?.groups || {};
const memberName = (id) => members()[id]?.name || "?";
const memberColor = (id) => COLORS[Object.keys(members()).indexOf(id) % COLORS.length] || COLORS[0];
const curGroup = () => groups()[S.groupId];
const groupActive = (g) => g?.meta?.status === "active";

function avatar(id) {
  const n = memberName(id);
  return `<span class="avatar" style="background:${memberColor(id)}">${esc(n[0]?.toUpperCase() || "?")}</span>`;
}

function pickDefaultGroup() {
  const gs = groups();
  if (S.groupId && gs[S.groupId]) return S.groupId;
  const entries = Object.entries(gs);
  const mine = entries.find(([, g]) => groupActive(g) && (g.members || []).includes(S.memberId));
  const anyActive = entries.find(([, g]) => groupActive(g));
  return (mine || anyActive || entries[0] || [null])[0];
}

function setGroup(gid) {
  S.groupId = gid;
  localStorage.setItem("ts_group", gid || "");
  render();
}

// Personal spend in AUD across ALL groups (my share of every expense)
function myTotalSpendAUD() {
  let total = 0;
  for (const g of Object.values(groups())) {
    for (const exp of Object.values(g.expenses || {})) {
      const share = exp.splits?.[S.memberId];
      if (!share) continue;
      const splitTotal = Object.values(exp.splits).reduce((a, b) => a + b, 0) || 1;
      total += (exp.amountAUD ?? exp.amount) * (share / splitTotal);
    }
  }
  return Math.round(total * 100) / 100;
}

function tripDaysElapsed() {
  const start = S.trip?.meta?.createdAt || Date.now();
  return Math.max(1, Math.floor((Date.now() - start) / 86400000) + 1);
}

// ---------------- navigation ----------------
function showScreen(name) {
  S.screen = name;
  for (const sec of document.querySelectorAll(".screen")) sec.classList.add("hidden");
  $(`screen-${name}`).classList.remove("hidden");
  const inTrip = !!S.trip;
  $("bottom-nav").classList.toggle("hidden", !inTrip);
  for (const b of document.querySelectorAll("#bottom-nav button")) {
    b.classList.toggle("active", b.dataset.nav === name);
  }
  window.scrollTo(0, 0);
  render();
}

document.body.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) showScreen(nav.dataset.nav);
});

// ---------------- render dispatch ----------------
function render() {
  if (!S.trip) return;
  if (!S.groupId || !groups()[S.groupId]) S.groupId = pickDefaultGroup();
  ({
    home: renderHome,
    expenses: renderExpenses,
    balances: renderBalances,
    insights: renderInsights,
    settings: renderSettings,
    newgroup: renderNewGroup,
    add: () => {}, // form is set up when opened, live re-render would clobber input
    itemize: () => {}, // built when opened; live re-render would clobber inputs
  }[S.screen] || (() => {}))();
}

// ---------------- onboarding ----------------
function showOnboard(part) {
  showScreen("onboard");
  $("onboard-choice").classList.toggle("hidden", part !== "choice");
  $("form-create").classList.toggle("hidden", part !== "create");
  $("form-join").classList.toggle("hidden", part !== "join");
  $("join-identity").classList.toggle("hidden", part !== "identity");
}

$("btn-show-create").onclick = () => showOnboard("create");
$("btn-show-join").onclick = () => showOnboard("join");
for (const b of document.querySelectorAll("[data-back]")) b.onclick = () => showOnboard("choice");

function addOtherInput(value = "") {
  const wrap = document.createElement("div");
  wrap.className = "row";
  wrap.innerHTML = `<input type="text" placeholder="Name" maxlength="20" autocomplete="off" value="${esc(value)}">
    <button type="button" class="btn btn-ghost btn-small">✕</button>`;
  wrap.querySelector("button").onclick = () => wrap.remove();
  $("create-others").appendChild(wrap);
}
$("btn-add-other").onclick = () => addOtherInput();
addOtherInput(); // start with one partner field

$("form-create").onsubmit = async (e) => {
  e.preventDefault();
  if (!DB.isConfigured()) return toast("Set up Firebase first — see SETUP.md");
  const name = $("create-name").value.trim();
  const me = $("create-me").value.trim();
  const others = [...$("create-others").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  const budget = parseFloat($("create-budget").value) || null;
  if (!name || !me) return;
  const btn = e.submitter; btn.disabled = true;
  try {
    const { tripId, memberIds, mainGroupId } = await DB.createTrip({
      name, memberNames: [me, ...others], dailyBudget: budget,
    });
    S.tripId = tripId;
    S.memberId = memberIds[0];
    S.groupId = mainGroupId;
    persistIdentity();
    startTrip();
  } catch (err) {
    console.error(err);
    toast("Couldn't create trip — check your connection and Firebase config");
  } finally { btn.disabled = false; }
};

$("form-join").onsubmit = async (e) => {
  e.preventDefault();
  if (!DB.isConfigured()) return toast("Set up Firebase first — see SETUP.md");
  const code = $("join-code").value.trim().toUpperCase();
  $("join-error").classList.add("hidden");
  const btn = e.submitter; btn.disabled = true;
  try {
    const tripId = await DB.lookupJoinCode(code);
    if (!tripId) {
      $("join-error").textContent = "No trip found with that code.";
      $("join-error").classList.remove("hidden");
      return;
    }
    const trip = await DB.fetchTrip(tripId);
    if (!trip) throw new Error("trip missing");
    S.pendingTripId = tripId;
    S.pendingTrip = trip;
    $("join-trip-name").textContent = trip.meta.name;
    const list = $("join-member-list");
    list.innerHTML = "";
    for (const [mid, m] of Object.entries(trip.members || {})) {
      const b = document.createElement("button");
      b.className = "btn btn-secondary btn-big";
      b.textContent = `I'm ${m.name}`;
      b.onclick = () => finishJoin(mid);
      list.appendChild(b);
    }
    showOnboard("identity");
  } catch (err) {
    console.error(err);
    toast("Couldn't reach Firebase — check your connection");
  } finally { btn.disabled = false; }
};

$("form-join-new").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("join-new-name").value.trim();
  if (!name) return;
  try {
    const mid = await DB.addMember(S.pendingTripId, name);
    finishJoin(mid);
  } catch (err) {
    console.error(err);
    toast("Couldn't join — check your connection");
  }
};

function finishJoin(memberId) {
  S.tripId = S.pendingTripId;
  S.memberId = memberId;
  S.groupId = null;
  persistIdentity();
  startTrip();
}

function persistIdentity() {
  localStorage.setItem("ts_trip", S.tripId);
  localStorage.setItem("ts_member", S.memberId);
  localStorage.setItem("ts_group", S.groupId || "");
}

// ---------------- live trip subscription ----------------
function startTrip() {
  if (S.unsubTrip) S.unsubTrip();
  // render instantly from cache while Firebase connects
  try {
    const cached = JSON.parse(localStorage.getItem("ts_cache"));
    if (cached && !S.trip) { S.trip = cached; showScreen("home"); }
  } catch { /* no cache */ }

  S.unsubTrip = DB.watchTrip(S.tripId, (trip) => {
    if (!trip) { toast("Trip no longer exists"); leaveTrip(); return; }
    const first = !S.trip;
    S.trip = trip;
    localStorage.setItem("ts_cache", JSON.stringify(trip));
    if (first) showScreen("home"); else render();
  });
}

function leaveTrip() {
  if (S.unsubTrip) S.unsubTrip();
  for (const k of ["ts_trip", "ts_member", "ts_group", "ts_cache"]) localStorage.removeItem(k);
  S.tripId = S.memberId = S.groupId = S.trip = null;
  location.reload();
}

// ---------------- HOME ----------------
function renderHome() {
  $("home-trip-name").textContent = S.trip.meta.name;
  $("home-trip-sub").textContent = `Day ${tripDaysElapsed()} · you are ${memberName(S.memberId)}`;
  $("home-join-code").textContent = S.trip.meta.joinCode;

  const spend = myTotalSpendAUD();
  $("home-my-spend").textContent = fmtAUD(spend);

  const budget = S.trip.meta.dailyBudget;
  if (budget) {
    const allowed = budget * tripDaysElapsed();
    const over = spend > allowed;
    $("home-budget-status").textContent = over ? "Over" : "On track";
    $("home-budget-status").style.color = over ? "var(--red)" : "var(--green)";
    $("home-budget-label").textContent = `Budget A$${budget}/day`;
  } else {
    $("home-budget-status").textContent = "—";
    $("home-budget-label").textContent = "No budget set";
  }

  const active = [], closed = [];
  for (const [gid, g] of Object.entries(groups())) (groupActive(g) ? active : closed).push([gid, g]);

  const card = ([gid, g]) => {
    const nets = computeNets(g);
    const mine = nets[S.memberId];
    const count = Object.keys(g.expenses || {}).length;
    const div = document.createElement("div");
    div.className = "card group-card";
    div.innerHTML = `
      <div class="group-card-top">
        <strong>${esc(g.meta.name)}</strong>
        ${groupActive(g) ? "" : '<span class="badge badge-closed">closed</span>'}
      </div>
      <div class="muted small">${(g.members || []).map(memberName).map(esc).join(", ")}</div>
      <div class="group-card-bottom">
        <span class="muted small">${count} expense${count === 1 ? "" : "s"}</span>
        <span class="${mine > 0.005 ? "pos" : mine < -0.005 ? "neg" : "muted"}">
          ${mine == null ? "" : mine > 0.005 ? `you're owed ${fmtAUD(mine)}` : mine < -0.005 ? `you owe ${fmtAUD(-mine)}` : "settled"}
        </span>
      </div>`;
    div.onclick = () => { setGroup(gid); showScreen("expenses"); };
    return div;
  };

  $("home-groups").replaceChildren(...active.map(card));
  $("home-closed-wrap").classList.toggle("hidden", closed.length === 0);
  $("home-closed-groups").replaceChildren(...closed.map(card));
}

$("btn-new-group").onclick = () => showScreen("newgroup");
$("btn-share-code").onclick = async () => {
  const text = `Join my trip "${S.trip.meta.name}" on TripSplit with code: ${S.trip.meta.joinCode}\n${location.href}`;
  if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } }
  else { await navigator.clipboard.writeText(text); toast("Join code copied"); }
};

// ---------------- NEW GROUP ----------------
function renderNewGroup() {
  const wrap = $("newgroup-members");
  // keep existing checkbox states when re-rendering
  const checked = new Set([...wrap.querySelectorAll("input:checked")].map((i) => i.value));
  const fresh = wrap.childElementCount === 0;
  wrap.innerHTML = "";
  for (const [mid, m] of Object.entries(members())) {
    const lab = document.createElement("label");
    lab.className = "check-row";
    const on = fresh ? mid === S.memberId : checked.has(mid);
    lab.innerHTML = `<input type="checkbox" value="${mid}" ${on ? "checked" : ""}> ${avatar(mid)} <span>${esc(m.name)}</span>`;
    wrap.appendChild(lab);
  }
}

$("btn-newgroup-add").onclick = async () => {
  const name = $("newgroup-newname").value.trim();
  if (!name) return;
  try {
    const mid = await DB.addMember(S.tripId, name);
    $("newgroup-newname").value = "";
    // tick the new member once the live update arrives
    setTimeout(() => {
      const box = $("newgroup-members").querySelector(`input[value="${mid}"]`);
      if (box) box.checked = true;
    }, 400);
  } catch { toast("Couldn't add member — are you online?"); }
};

$("form-newgroup").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("newgroup-name").value.trim();
  const ids = [...$("newgroup-members").querySelectorAll("input:checked")].map((i) => i.value);
  if (!name) return;
  if (ids.length < 2) return toast("Pick at least 2 people");
  try {
    const gid = await DB.createGroup(S.tripId, name, ids);
    $("form-newgroup").reset();
    $("newgroup-members").innerHTML = "";
    setGroup(gid);
    showScreen("expenses");
    toast(`Group "${name}" created`);
  } catch { toast("Couldn't create group — are you online?"); }
};

// ---------------- group tabs (shared by expenses + balances) ----------------
function renderGroupTabs(containerId) {
  const wrap = $(containerId);
  wrap.innerHTML = "";
  for (const [gid, g] of Object.entries(groups())) {
    const b = document.createElement("button");
    b.className = "group-tab" + (gid === S.groupId ? " active" : "") + (groupActive(g) ? "" : " closed");
    b.textContent = g.meta.name + (groupActive(g) ? "" : " 🔒");
    b.onclick = () => setGroup(gid);
    wrap.appendChild(b);
  }
}

// ---------------- EXPENSES ----------------
function renderExpenses() {
  renderGroupTabs("expenses-group-tabs");
  const g = curGroup();
  if (!g) return;
  const active = groupActive(g);
  $("expenses-closed-note").classList.toggle("hidden", active);
  $("btn-add-expense").classList.toggle("hidden", !active);

  const list = Object.entries(g.expenses || {}).sort((a, b) => b[1].createdAt - a[1].createdAt);
  $("expenses-empty").classList.toggle("hidden", list.length > 0);

  const items = list.map(([eid, exp]) => {
    const div = document.createElement("div");
    div.className = "card expense-card";
    div.innerHTML = `
      <div class="expense-main">
        <div class="expense-desc">${esc(exp.description)}</div>
        <div class="muted small">${esc(exp.category)} · ${avatar(exp.paidBy)} ${esc(memberName(exp.paidBy))} paid · ${fmtDate(exp.createdAt)}</div>
      </div>
      <div class="expense-amounts">
        <div class="expense-amount">${fmtMoney(exp.amount, exp.currency)}</div>
        <div class="muted small">${exp.currency === "AUD" ? "" : fmtAUD(exp.amountAUD)}</div>
      </div>`;
    if (active) div.onclick = () => openExpenseForm(eid);
    return div;
  });
  $("expense-list").replaceChildren(...items);
}

$("btn-add-expense").onclick = () => openExpenseForm(null);

// ---------------- ADD / EDIT EXPENSE FORM ----------------
function chipRow(containerId, options, selected, onPick, renderLabel = esc) {
  const wrap = $(containerId);
  wrap.innerHTML = "";
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (opt === selected ? " active" : "");
    b.innerHTML = renderLabel(opt);
    b.onclick = () => onPick(opt);
    wrap.appendChild(b);
  }
}

function openExpenseForm(expenseId) {
  const g = curGroup();
  if (!g || !groupActive(g)) return;
  S.editingId = expenseId;
  const exp = expenseId ? g.expenses[expenseId] : null;

  $("add-title").textContent = exp ? "Edit expense" : "Add expense";
  $("btn-delete-expense").classList.toggle("hidden", !exp);
  $("form-expense").reset();
  $("scan-status").textContent = "";
  $("split-error").classList.add("hidden");

  $("exp-amount").value = exp ? exp.amount : "";
  $("exp-desc").value = exp ? exp.description : "";
  S.selCurrency = exp ? exp.currency : "EUR";
  S.selCategory = exp ? exp.category : CATEGORIES[0];
  S.selPaidBy = exp ? exp.paidBy : (g.members.includes(S.memberId) ? S.memberId : g.members[0]);
  S.included = new Set(exp ? Object.keys(exp.splits) : g.members);
  S.splitMode = "equal";
  if (exp) {
    // detect uneven split → show it as editable amounts (percent isn't stored,
    // so a percent split reopens as the equivalent amounts — math is identical)
    const vals = Object.values(exp.splits);
    if (vals.length > 1 && Math.abs(Math.max(...vals) - Math.min(...vals)) > 0.011) S.splitMode = "amounts";
  }
  S.customSplits = exp && S.splitMode === "amounts" ? { ...exp.splits } : {};
  S.pctSplits = {};

  refreshExpenseForm();
  showScreen("add");
  updateAudPreview();
}

function refreshExpenseForm() {
  const g = curGroup();
  chipRow("exp-currency", CURRENCIES, S.selCurrency, (c) => { S.selCurrency = c; refreshExpenseForm(); updateAudPreview(); });
  chipRow("exp-category", CATEGORIES, S.selCategory, (c) => { S.selCategory = c; refreshExpenseForm(); });
  chipRow("exp-paidby", g.members, S.selPaidBy, (m) => { S.selPaidBy = m; refreshExpenseForm(); },
    (m) => `${avatar(m)} ${esc(memberName(m))}`);

  for (const b of $("split-mode-seg").querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.mode === S.splitMode);
    b.onclick = () => setSplitMode(b.dataset.mode);
  }
  renderSplitRows();
}

function setSplitMode(mode) {
  if (mode === S.splitMode) return;
  const amount = parseFloat($("exp-amount").value) || 0;
  const ids = [...S.included];
  if (mode === "amounts") {
    S.customSplits = ids.length ? equalSplit(amount, ids) : {};
  } else if (mode === "percent") {
    const n = ids.length || 1;
    const base = Math.round((100 / n) * 10) / 10;
    S.pctSplits = {};
    ids.forEach((m, i) => { S.pctSplits[m] = i === n - 1 ? Math.round((100 - base * (n - 1)) * 10) / 10 : base; });
  }
  S.splitMode = mode;
  refreshExpenseForm();
}

function renderSplitRows() {
  const g = curGroup();
  const wrap = $("exp-splits");
  wrap.innerHTML = "";
  const amount = parseFloat($("exp-amount").value) || 0;
  const includedIds = g.members.filter((m) => S.included.has(m));
  const equal = includedIds.length ? equalSplit(amount, includedIds) : {};

  for (const mid of g.members) {
    const on = S.included.has(mid);
    const row = document.createElement("div");
    row.className = "split-row" + (on ? "" : " off");
    const toggle = (e) => {
      e.target.checked ? S.included.add(mid) : S.included.delete(mid);
      if (S.included.size === 0) { S.included.add(mid); e.target.checked = true; toast("At least one person must be in the split"); }
      renderSplitRows();
    };

    if (S.splitMode === "equal") {
      row.innerHTML = `
        <label class="check-row grow">
          <input type="checkbox" ${on ? "checked" : ""}> ${avatar(mid)} <span>${esc(memberName(mid))}</span>
        </label>
        <span class="muted">${on ? fmtMoney(equal[mid] ?? 0, S.selCurrency) : "—"}</span>`;
      row.querySelector("input").onchange = toggle;
    } else if (S.splitMode === "percent") {
      const pct = S.pctSplits[mid];
      const dollarEq = on ? amount * (parseFloat(pct) || 0) / 100 : 0;
      row.innerHTML = `
        <label class="check-row grow">
          <input type="checkbox" ${on ? "checked" : ""}> ${avatar(mid)} <span>${esc(memberName(mid))}</span>
        </label>
        <span class="muted split-pct-eq">${on ? fmtMoney(dollarEq, S.selCurrency) : "—"}</span>
        <input type="number" class="split-pct" step="0.1" min="0" inputmode="decimal"
          value="${on ? (pct ?? "") : ""}" ${on ? "" : "disabled"}>
        <span class="muted">%</span>`;
      row.querySelector('input[type="checkbox"]').onchange = toggle;
      row.querySelector(".split-pct").oninput = (e) => {
        S.pctSplits[mid] = parseFloat(e.target.value) || 0;
        const eq = amount * (S.pctSplits[mid] || 0) / 100;
        row.querySelector(".split-pct-eq").textContent = fmtMoney(eq, S.selCurrency);
        validateSplit();
      };
    } else { // amounts
      row.innerHTML = `
        <label class="check-row grow">
          <input type="checkbox" ${on ? "checked" : ""}> ${avatar(mid)} <span>${esc(memberName(mid))}</span>
        </label>
        <input type="number" class="split-amt" step="0.01" min="0" inputmode="decimal"
          value="${on ? (S.customSplits[mid] ?? equal[mid] ?? "") : ""}" ${on ? "" : "disabled"}>`;
      row.querySelector('input[type="checkbox"]').onchange = toggle;
      row.querySelector(".split-amt").oninput = (e) => {
        S.customSplits[mid] = parseFloat(e.target.value) || 0;
        validateSplit();
      };
    }
    wrap.appendChild(row);
  }
  if (S.splitMode !== "equal") validateSplit();
}

function validateSplit() {
  const err = $("split-error");
  if (S.splitMode === "percent") {
    const sum = [...S.included].reduce((a, m) => a + (parseFloat(S.pctSplits[m]) || 0), 0);
    if (Math.abs(sum - 100) > 0.1) {
      err.textContent = `Percentages add to ${sum.toFixed(1)}% — must total 100%`;
      err.classList.remove("hidden");
      return false;
    }
  } else if (S.splitMode === "amounts") {
    const amount = parseFloat($("exp-amount").value) || 0;
    const sum = [...S.included].reduce((a, m) => a + (S.customSplits[m] || 0), 0);
    if (Math.abs(sum - amount) > 0.011) {
      err.textContent = `Split adds to ${fmtMoney(sum, S.selCurrency)} but total is ${fmtMoney(amount, S.selCurrency)}`;
      err.classList.remove("hidden");
      return false;
    }
  }
  err.classList.add("hidden");
  return true;
}

$("exp-amount").addEventListener("input", () => { renderSplitRows(); updateAudPreview(); });

let audPreviewTimer;
function updateAudPreview() {
  clearTimeout(audPreviewTimer);
  audPreviewTimer = setTimeout(async () => {
    const amount = parseFloat($("exp-amount").value);
    const el = $("exp-aud-preview");
    if (!amount || S.selCurrency === "AUD") { el.textContent = ""; return; }
    const cached = cachedRate(S.selCurrency);
    if (cached) el.textContent = `≈ ${fmtAUD(toAUD(amount, cached))}${cached.stale ? " (cached rate)" : ""}`;
    const live = await getRate(S.selCurrency);
    const nowAmount = parseFloat($("exp-amount").value);
    if (live && nowAmount) el.textContent = `≈ ${fmtAUD(toAUD(nowAmount, live))}${live.stale ? " (cached rate — offline)" : ""}`;
    else if (!live) el.textContent = "No exchange rate available offline — will save without AUD value";
  }, 250);
}

$("form-expense").onsubmit = async (e) => {
  e.preventDefault();
  const g = curGroup();
  const amount = parseFloat($("exp-amount").value);
  const desc = $("exp-desc").value.trim();
  if (!amount || amount <= 0 || !desc) return;
  if (S.included.size === 0) return toast("Pick who to split between");

  let splits;
  if (S.splitMode === "amounts") {
    if (!validateSplit()) return;
    splits = {};
    for (const m of S.included) splits[m] = Math.round((S.customSplits[m] || 0) * 100) / 100;
  } else if (S.splitMode === "percent") {
    if (!validateSplit()) return;
    const pct = {};
    for (const m of S.included) pct[m] = parseFloat(S.pctSplits[m]) || 0;
    splits = percentToAmounts(pct, amount);
  } else {
    splits = equalSplit(amount, [...S.included]);
  }

  const btn = $("btn-save-expense");
  btn.disabled = true;
  try {
    const rate = await getRate(S.selCurrency);
    const expense = {
      amount, currency: S.selCurrency,
      amountAUD: toAUD(amount, rate),
      description: desc,
      category: S.selCategory,
      paidBy: S.selPaidBy,
      splits,
      createdAt: S.editingId ? g.expenses[S.editingId].createdAt : Date.now(),
      createdBy: S.editingId ? g.expenses[S.editingId].createdBy : S.memberId,
    };
    if (S.editingId) await DB.updateExpense(S.tripId, S.groupId, S.editingId, expense);
    else await DB.addExpense(S.tripId, S.groupId, expense);
    showScreen("expenses");
    toast(S.editingId ? "Expense updated" : "Expense added");
  } catch (err) {
    console.error(err);
    toast("Save failed — check your connection");
  } finally { btn.disabled = false; }
};

$("btn-delete-expense").onclick = async () => {
  if (!S.editingId) return;
  if (!confirm("Delete this expense?")) return;
  await DB.deleteExpense(S.tripId, S.groupId, S.editingId);
  showScreen("expenses");
  toast("Expense deleted");
};

// ---------------- receipt scanning ----------------
$("btn-scan").onclick = () => {
  if (!getApiKey()) {
    toast("Add your Anthropic API key in Settings first");
    showScreen("settings");
    return;
  }
  $("receipt-input").click();
};

$("receipt-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("scan-status");
  status.textContent = "Scanning…";
  $("btn-scan").disabled = true;
  try {
    const r = await scanReceipt(file);
    // Two or more line items → itemize so you can tick who had what.
    if (r.items && r.items.length >= 2) {
      status.textContent = "";
      openItemize(r);
      return;
    }
    // Otherwise just prefill the single-total form (old behaviour).
    if (r.amount) { $("exp-amount").value = r.amount; }
    if (r.currency && CURRENCIES.includes(r.currency)) S.selCurrency = r.currency;
    if (r.merchant) $("exp-desc").value = r.merchant;
    if (r.category) S.selCategory = r.category;
    refreshExpenseForm();
    updateAudPreview();
    status.textContent = "✓ Check the values below";
  } catch (err) {
    console.error(err);
    status.textContent = "";
    toast(err.message === "NO_KEY" ? "Add your API key in Settings" : "Couldn't read the receipt — enter manually");
  } finally { $("btn-scan").disabled = false; }
};

// ---------------- ITEMIZE: assign receipt items to people ----------------
// All state here is transient (S.itemize) — nothing is written to Firebase.
// On "Apply" it collapses to an ordinary amounts split on the expense form.
function openItemize(scan) {
  const g = curGroup();
  if (!g || !groupActive(g)) return;
  const cur = scan.currency && CURRENCIES.includes(scan.currency) ? scan.currency : S.selCurrency;
  S.itemize = {
    currency: cur,
    merchant: scan.merchant || "",
    category: CATEGORIES.includes(scan.category) ? scan.category : S.selCategory,
    items: scan.items.map((it) => ({ name: it.name || "Item", price: it.price || 0, who: new Set() })),
  };
  $("itemize-merchant").textContent =
    (scan.merchant ? `${scan.merchant} · ` : "") + `${scan.items.length} items detected`;
  $("itemize-currency").textContent = CURRENCY_SYMBOLS[cur] || cur;
  $("itemize-total").value = scan.amount || "";
  renderItemize();
  showScreen("itemize");
}

function renderItemize() {
  const g = curGroup();
  const wrap = $("itemize-items");
  wrap.innerHTML = "";
  S.itemize.items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "item-card" + (item.who.size === 0 ? " unassigned" : "");
    const people = g.members.map((mid) => {
      const on = item.who.has(mid);
      return `<button type="button" class="who-chip${on ? " on" : ""}" data-mid="${mid}">${avatar(mid)}<span>${esc(memberName(mid))}</span></button>`;
    }).join("");
    card.innerHTML = `
      <div class="item-top">
        <input type="text" value="${esc(item.name)}" maxlength="60" autocomplete="off">
        <input type="number" class="item-price" step="0.01" min="0" inputmode="decimal" value="${item.price || ""}" placeholder="0.00">
        <button type="button" class="item-del" title="Remove item">✕</button>
      </div>
      <div class="item-people">${people}</div>`;
    const nameEl = card.querySelector('input[type="text"]');
    const priceEl = card.querySelector(".item-price");
    nameEl.oninput = (e) => { item.name = e.target.value; };
    priceEl.oninput = (e) => { item.price = parseFloat(e.target.value) || 0; updateItemizePreview(); };
    card.querySelector(".item-del").onclick = () => { S.itemize.items.splice(idx, 1); renderItemize(); };
    for (const chip of card.querySelectorAll(".who-chip")) {
      chip.onclick = () => {
        const mid = chip.dataset.mid;
        item.who.has(mid) ? item.who.delete(mid) : item.who.add(mid);
        renderItemize();
      };
    }
    wrap.appendChild(card);
  });
  updateItemizePreview();
}

// Recompute the tax note, leftover guard and per-person preview. Returns the
// computed split (or null if not ready to apply).
function updateItemizePreview() {
  const g = curGroup();
  const cur = S.itemize.currency;
  const billTotal = parseFloat($("itemize-total").value) || 0;
  const items = S.itemize.items.map((it) => ({ price: it.price, members: [...it.who] }));
  const itemsTotal = items.reduce((a, it) => a + (it.members.length ? (Number(it.price) || 0) : 0), 0);

  const taxEl = $("itemize-tax-note");
  const diff = Math.round((billTotal - itemsTotal) * 100) / 100;
  if (!billTotal) taxEl.textContent = "Enter the bill total above to handle tax.";
  else if (Math.abs(diff) < 0.01) taxEl.textContent = `Items add up to the bill total — tax is already in the prices, nothing extra to split.`;
  else if (diff > 0) taxEl.textContent = `${fmtMoney(diff, cur)} tax/service on top of ${fmtMoney(itemsTotal, cur)} — split in proportion to what each person ordered.`;
  else taxEl.textContent = `${fmtMoney(-diff, cur)} less than the items (discount) — shared in proportion.`;

  const unassigned = S.itemize.items.filter((it) => it.who.size === 0).length;
  const leftover = $("itemize-leftover");
  let blocked = true;
  if (!S.itemize.items.length) leftover.textContent = "No items — add at least one.";
  else if (unassigned > 0) leftover.textContent = `${unassigned} item${unassigned === 1 ? "" : "s"} not assigned to anyone yet — tap a name on each.`;
  else if (itemsTotal <= 0) leftover.textContent = "Enter item prices to work out the split.";
  else if (!billTotal) leftover.textContent = "Enter the bill total.";
  else blocked = false;
  leftover.classList.toggle("hidden", !blocked);
  $("btn-itemize-apply").disabled = blocked;

  const pv = $("itemize-preview");
  if (blocked) {
    pv.innerHTML = `<div class="muted small">Assign every item to see each person's share.</div>`;
    return null;
  }
  const result = computeItemizedSplits(items, billTotal);
  const assigned = new Set();
  for (const it of S.itemize.items) for (const m of it.who) assigned.add(m);
  pv.replaceChildren(...g.members.filter((m) => assigned.has(m)).map((mid) => {
    const div = document.createElement("div");
    div.className = "preview-row";
    div.innerHTML = `<div class="check-row">${avatar(mid)} <span>${esc(memberName(mid))}</span></div><strong>${fmtMoney(result.splits[mid] || 0, cur)}</strong>`;
    return div;
  }));
  return result;
}

$("itemize-total").addEventListener("input", () => { if (S.itemize) updateItemizePreview(); });

$("btn-itemize-additem").onclick = () => {
  if (!S.itemize) return;
  S.itemize.items.push({ name: "Item", price: 0, who: new Set() });
  renderItemize();
};

$("btn-itemize-back").onclick = () => { S.itemize = null; showScreen("add"); };
$("btn-itemize-cancel").onclick = () => { S.itemize = null; showScreen("add"); };

$("btn-itemize-apply").onclick = () => {
  if (!S.itemize) return;
  const result = updateItemizePreview();
  if (!result) return; // still blocked
  const billTotal = parseFloat($("itemize-total").value) || 0;
  const assigned = new Set();
  for (const it of S.itemize.items) for (const m of it.who) assigned.add(m);

  // Collapse the itemization into an ordinary amounts split on the form.
  $("exp-amount").value = billTotal;
  if (S.itemize.merchant) $("exp-desc").value = S.itemize.merchant;
  S.selCurrency = S.itemize.currency;
  S.selCategory = S.itemize.category;
  S.included = new Set([...assigned]);
  S.customSplits = { ...result.splits };
  S.pctSplits = {};
  S.splitMode = "amounts";
  S.itemize = null;

  refreshExpenseForm();
  showScreen("add");
  updateAudPreview();
  toast("Split applied — review and save");
};

// ---------------- BALANCES ----------------
function renderBalances() {
  renderGroupTabs("balances-group-tabs");
  const g = curGroup();
  if (!g) return;
  const active = groupActive(g);
  $("balances-closed-note").classList.toggle("hidden", active);
  $("btn-close-group").classList.toggle("hidden", !active);

  const nets = computeNets(g);
  const rows = Object.entries(nets).map(([mid, v]) => {
    const div = document.createElement("div");
    div.className = "card balance-row";
    div.innerHTML = `
      <div class="check-row">${avatar(mid)} <span>${esc(memberName(mid))}</span></div>
      <span class="${v > 0.005 ? "pos" : v < -0.005 ? "neg" : "muted"}">
        ${v > 0.005 ? `+${fmtAUD(v)}` : v < -0.005 ? `−${fmtAUD(-v)}` : "settled"}
      </span>`;
    return div;
  });
  $("balance-list").replaceChildren(...rows);

  const txns = simplifyDebts(nets);
  $("settle-empty").classList.toggle("hidden", txns.length > 0);
  const settleRows = txns.map((t) => {
    const div = document.createElement("div");
    div.className = "card settle-row";
    div.innerHTML = `
      <div class="settle-who">
        ${avatar(t.from)} <strong>${esc(memberName(t.from))}</strong>
        <span class="muted">pays</span>
        ${avatar(t.to)} <strong>${esc(memberName(t.to))}</strong>
      </div>
      <div class="settle-right">
        <strong>${fmtAUD(t.amount)}</strong>
        ${active ? '<button class="btn btn-secondary btn-small">Mark settled</button>' : ""}
      </div>`;
    const btn = div.querySelector("button");
    if (btn) btn.onclick = async () => {
      if (!confirm(`${memberName(t.from)} paid ${memberName(t.to)} ${fmtAUD(t.amount)}?`)) return;
      try { await DB.addSettlement(S.tripId, S.groupId, t); toast("Settlement recorded"); }
      catch { toast("Couldn't save — are you online?"); }
    };
    return div;
  });
  $("settle-list").replaceChildren(...settleRows);

  const hist = Object.values(g.settlements || {}).sort((a, b) => b.settledAt - a.settledAt);
  $("settlement-history-wrap").classList.toggle("hidden", hist.length === 0);
  $("settlement-history").replaceChildren(...hist.map((s) => {
    const div = document.createElement("div");
    div.className = "card settle-row muted";
    div.innerHTML = `<span>${esc(memberName(s.from))} → ${esc(memberName(s.to))} · ${fmtDate(s.settledAt)}</span><span>${fmtAUD(s.amount)}</span>`;
    return div;
  }));
}

$("btn-close-group").onclick = async () => {
  const g = curGroup();
  const nets = computeNets(g);
  const outstanding = simplifyDebts(nets).length;
  const msg = outstanding
    ? `There are still ${outstanding} unsettled payment(s). Close "${g.meta.name}" anyway? Balances will be frozen.`
    : `Close "${g.meta.name}"? It becomes view-only.`;
  if (!confirm(msg)) return;
  try { await DB.closeGroup(S.tripId, S.groupId); toast("Group closed"); }
  catch { toast("Couldn't close — are you online?"); }
};

// ---------------- INSIGHTS ----------------
function renderInsights() {
  const spend = myTotalSpendAUD();
  const days = tripDaysElapsed();
  $("ins-total").textContent = fmtAUD(spend);
  $("ins-daily-avg").textContent = fmtAUD(spend / days);

  const budget = S.trip.meta.dailyBudget;
  $("ins-budget-card").classList.toggle("hidden", !budget);
  if (budget) {
    const allowed = budget * days;
    const pct = Math.min(100, (spend / allowed) * 100);
    const over = spend > allowed;
    $("ins-budget-fill").style.width = `${pct}%`;
    $("ins-budget-fill").style.background = over ? "var(--red)" : "var(--green)";
    $("ins-budget-badge").textContent = over ? `Over by ${fmtAUD(spend - allowed)}` : `${fmtAUD(allowed - spend)} under`;
    $("ins-budget-badge").style.color = over ? "var(--red)" : "var(--green)";
    $("ins-budget-detail").textContent = `Spent ${fmtAUD(spend)} of ${fmtAUD(allowed)} budgeted for ${days} day${days === 1 ? "" : "s"} (A$${budget}/day)`;
  }

  // my spend by category + by group (AUD)
  const byCat = {}, byGroup = {};
  for (const [, g] of Object.entries(groups())) {
    for (const exp of Object.values(g.expenses || {})) {
      const share = exp.splits?.[S.memberId];
      if (!share) continue;
      const splitTotal = Object.values(exp.splits).reduce((a, b) => a + b, 0) || 1;
      const aud = (exp.amountAUD ?? exp.amount) * (share / splitTotal);
      byCat[exp.category] = (byCat[exp.category] || 0) + aud;
      byGroup[g.meta.name] = (byGroup[g.meta.name] || 0) + aud;
    }
  }
  renderDonut(byCat);
  renderGroupBars(byGroup);
}

const CAT_COLORS = { Food: "#f08c5a", Drinks: "#c98ef0", Transport: "#5b9cf5", Accommodation: "#5ac88f", Activities: "#f0d05a", Shopping: "#f06d8c" };

function renderDonut(byCat) {
  const svg = $("ins-donut");
  const legend = $("ins-donut-legend");
  const total = Object.values(byCat).reduce((a, b) => a + b, 0);
  svg.innerHTML = "";
  legend.innerHTML = "";
  if (!total) {
    svg.innerHTML = `<circle cx="60" cy="60" r="48" fill="none" stroke="var(--surface2)" stroke-width="16"/>`;
    legend.innerHTML = `<span class="muted small">No spending yet</span>`;
    return;
  }
  const C = 2 * Math.PI * 48;
  let offset = 0;
  for (const cat of CATEGORIES) {
    const v = byCat[cat] || 0;
    if (!v) continue;
    const frac = v / total;
    const seg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    seg.setAttribute("cx", 60); seg.setAttribute("cy", 60); seg.setAttribute("r", 48);
    seg.setAttribute("fill", "none");
    seg.setAttribute("stroke", CAT_COLORS[cat]);
    seg.setAttribute("stroke-width", 16);
    seg.setAttribute("stroke-dasharray", `${frac * C} ${C}`);
    seg.setAttribute("stroke-dashoffset", -offset * C);
    seg.setAttribute("transform", "rotate(-90 60 60)");
    svg.appendChild(seg);
    offset += frac;

    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `<span class="dot" style="background:${CAT_COLORS[cat]}"></span>
      <span>${esc(cat)}</span><span class="muted">${fmtAUD(v)}</span>`;
    legend.appendChild(item);
  }
}

function renderGroupBars(byGroup) {
  const wrap = $("ins-groups");
  wrap.innerHTML = "";
  const entries = Object.entries(byGroup).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { wrap.innerHTML = '<span class="muted small">No spending yet</span>'; return; }
  const max = entries[0][1];
  for (const [name, v] of entries) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-label"><span>${esc(name)}</span><span class="muted">${fmtAUD(v)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / max) * 100}%"></div></div>`;
    wrap.appendChild(row);
  }
}

// ---------------- export summary ----------------
$("btn-export").onclick = async () => {
  const lines = [`🧾 ${S.trip.meta.name} — trip summary`, ""];
  let grand = 0;
  for (const [, g] of Object.entries(groups())) {
    const exps = Object.values(g.expenses || {});
    if (!exps.length) continue;
    const total = exps.reduce((a, e) => a + (e.amountAUD ?? e.amount), 0);
    grand += total;
    lines.push(`${g.meta.name}${groupActive(g) ? "" : " (closed)"} — ${fmtAUD(total)} total, ${exps.length} expenses`);
    const nets = computeNets(g);
    for (const [mid, v] of Object.entries(nets)) {
      if (Math.abs(v) > 0.005) lines.push(`  ${memberName(mid)}: ${v > 0 ? "is owed" : "owes"} ${fmtAUD(Math.abs(v))}`);
    }
    lines.push("");
  }
  lines.push(`Group spending total: ${fmtAUD(grand)}`);
  lines.push(`My personal spend: ${fmtAUD(myTotalSpendAUD())} over ${tripDaysElapsed()} days`);
  const text = lines.join("\n");
  if (navigator.share) { try { await navigator.share({ text }); } catch { /* cancelled */ } }
  else { await navigator.clipboard.writeText(text); toast("Summary copied to clipboard"); }
};

// ---------------- SETTINGS ----------------
function renderSettings() {
  $("key-status").textContent = getApiKey() ? "✓ Key saved on this device" : "No key saved";
  $("settings-trip-info").innerHTML =
    `<div><strong>${esc(S.trip.meta.name)}</strong></div>
     <div>Join code: ${esc(S.trip.meta.joinCode)}</div>
     <div>You are: ${esc(memberName(S.memberId))}</div>
     <div>Members: ${Object.values(members()).map((m) => esc(m.name)).join(", ")}</div>`;
}

$("btn-save-key").onclick = () => {
  setApiKey($("setting-api-key").value);
  $("setting-api-key").value = "";
  renderSettings();
  toast(getApiKey() ? "API key saved" : "API key cleared");
};

$("btn-leave-trip").onclick = () => {
  if (confirm("Leave this trip on this device? You can rejoin anytime with the code.")) leaveTrip();
};

// ---------------- connection banner ----------------
let firebaseConnected = true;
function updateOfflineBanner() {
  const offline = !navigator.onLine || !firebaseConnected;
  $("offline-banner").classList.toggle("hidden", !offline);
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);

// ---------------- boot ----------------
function boot() {
  if (!DB.isConfigured()) {
    $("config-banner").classList.remove("hidden");
  } else {
    DB.watchConnection((ok) => { firebaseConnected = ok; updateOfflineBanner(); });
  }
  if (S.tripId && S.memberId) startTrip();
  else showOnboard("choice");
}
boot();
