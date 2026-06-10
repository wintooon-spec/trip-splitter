// Firebase Realtime Database layer
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, get, set, update, push, onValue, remove, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export function isConfigured() {
  return !firebaseConfig.apiKey.startsWith("PASTE_");
}

// ---- join codes ----
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L

export function makeJoinCode(tripName) {
  const prefix = (tripName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "TRIP");
  let suffix = "";
  for (let i = 0; i < 3; i++) suffix += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return `${prefix}-${suffix}`;
}

export async function lookupJoinCode(code) {
  const snap = await get(ref(db, `joinCodes/${code.trim().toUpperCase()}`));
  return snap.exists() ? snap.val() : null; // tripId or null
}

// ---- trip lifecycle ----
export async function createTrip({ name, memberNames, dailyBudget }) {
  const tripRef = push(ref(db, "trips"));
  const tripId = tripRef.key;
  const joinCode = makeJoinCode(name);

  const members = {};
  const memberIds = [];
  for (const n of memberNames) {
    const id = push(ref(db, `trips/${tripId}/members`)).key;
    members[id] = { name: n, joinedAt: Date.now() };
    memberIds.push(id);
  }

  const mainGroupId = push(ref(db, `trips/${tripId}/groups`)).key;

  await set(tripRef, {
    meta: { name, createdAt: Date.now(), joinCode, dailyBudget: dailyBudget || null },
    members,
    groups: {
      [mainGroupId]: {
        meta: { name: "Main", createdAt: Date.now(), status: "active" },
        members: memberIds,
      },
    },
  });
  await set(ref(db, `joinCodes/${joinCode}`), tripId);
  return { tripId, joinCode, memberIds, mainGroupId };
}

export async function fetchTrip(tripId) {
  const snap = await get(ref(db, `trips/${tripId}`));
  return snap.exists() ? snap.val() : null;
}

export function watchTrip(tripId, cb) {
  return onValue(ref(db, `trips/${tripId}`), (snap) => cb(snap.val()));
}

export function watchConnection(cb) {
  return onValue(ref(db, ".info/connected"), (snap) => cb(!!snap.val()));
}

// ---- members ----
export async function addMember(tripId, name) {
  const r = push(ref(db, `trips/${tripId}/members`));
  await set(r, { name, joinedAt: Date.now() });
  return r.key;
}

// ---- groups ----
export async function createGroup(tripId, name, memberIds) {
  const r = push(ref(db, `trips/${tripId}/groups`));
  await set(r, {
    meta: { name, createdAt: Date.now(), status: "active" },
    members: memberIds,
  });
  return r.key;
}

export async function closeGroup(tripId, groupId) {
  await update(ref(db, `trips/${tripId}/groups/${groupId}/meta`), {
    status: "closed", closedAt: Date.now(),
  });
}

// ---- expenses ----
export async function addExpense(tripId, groupId, expense) {
  const r = push(ref(db, `trips/${tripId}/groups/${groupId}/expenses`));
  await set(r, expense);
  return r.key;
}

export async function updateExpense(tripId, groupId, expenseId, expense) {
  await set(ref(db, `trips/${tripId}/groups/${groupId}/expenses/${expenseId}`), expense);
}

export async function deleteExpense(tripId, groupId, expenseId) {
  await remove(ref(db, `trips/${tripId}/groups/${groupId}/expenses/${expenseId}`));
}

// ---- settlements ----
export async function addSettlement(tripId, groupId, { from, to, amount }) {
  const r = push(ref(db, `trips/${tripId}/groups/${groupId}/settlements`));
  await set(r, { from, to, amount, settledAt: Date.now() });
  return r.key;
}
