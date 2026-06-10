// ============================================================
// FIREBASE CONFIG — REPLACE THIS BLOCK WITH YOUR OWN
// See SETUP.md for step-by-step instructions (takes ~5 min).
// Get this object from: Firebase Console → Project settings →
// Your apps → Web app → SDK setup and configuration
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyBXaPKLTXnSrw7jfi6btjGbvCJXLbRyU18",
  authDomain: "tripsplit-1e110.firebaseapp.com",
  databaseURL: "https://tripsplit-1e110-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "tripsplit-1e110",
  storageBucket: "tripsplit-1e110.firebasestorage.app",
  messagingSenderId: "1077603830059",
  appId: "1:1077603830059:web:fac97f5257e80c2ecbdd6e",
};

// App-wide constants
export const CATEGORIES = ["Food", "Drinks", "Transport", "Accommodation", "Activities", "Shopping"];
export const CURRENCIES = ["EUR", "GBP", "AUD", "USD"];
export const CURRENCY_SYMBOLS = { EUR: "€", GBP: "£", AUD: "A$", USD: "US$" };
export const HOME_CURRENCY = "AUD";
export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const GEMINI_MODEL = "gemini-2.5-flash";
