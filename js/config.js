// ============================================================
// FIREBASE CONFIG — REPLACE THIS BLOCK WITH YOUR OWN
// See SETUP.md for step-by-step instructions (takes ~5 min).
// Get this object from: Firebase Console → Project settings →
// Your apps → Web app → SDK setup and configuration
// ============================================================
export const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY_HERE",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000",
};

// App-wide constants
export const CATEGORIES = ["Food", "Drinks", "Transport", "Accommodation", "Activities", "Shopping"];
export const CURRENCIES = ["EUR", "GBP", "AUD", "USD"];
export const CURRENCY_SYMBOLS = { EUR: "€", GBP: "£", AUD: "A$", USD: "US$" };
export const HOME_CURRENCY = "AUD";
export const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
