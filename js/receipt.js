// Receipt scanning via Anthropic Haiku or Google Gemini vision, chosen by
// key prefix (sk-ant-... = Anthropic, AIza... = Gemini free tier). The photo
// is sent for extraction only and never stored anywhere.
import { ANTHROPIC_MODEL, GEMINI_MODEL, CATEGORIES, CURRENCIES } from "./config.js";

export function getApiKey() {
  return localStorage.getItem("ts_anthropic_key") || "";
}

export function setApiKey(key) {
  if (key) localStorage.setItem("ts_anthropic_key", key.trim());
  else localStorage.removeItem("ts_anthropic_key");
}

// Downscale + JPEG-encode so we send ~100-300KB instead of a 5MB photo.
export async function fileToJpegBase64(file, maxDim = 1280, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return dataUrl.split(",")[1];
}

const PROMPT =
`Extract this receipt and reply with ONLY a JSON object, no other text:
{
  "merchant": <short merchant/store name as a string, or null>,
  "category": <exactly one of: ${CATEGORIES.join(", ")}>,
  "currency": <ISO code, one of ${CURRENCIES.join("/")}, or your best guess from the receipt>,
  "items": [ { "name": <short item name>, "price": <line total for that item as a number> } ],
  "subtotal": <pre-tax subtotal as a number, or null>,
  "tax": <tax / service charge / gratuity added on top, as a number, or null>,
  "total": <final total paid, as a number>
}
Rules:
- One entry per distinct line item. "price" is the total for that line (quantity × unit price).
- Do NOT list subtotal, tax, service charge, tip, discount or total as items.
- Use null for any value you cannot read. Numbers have no currency symbols or thousands separators.
- Category: restaurant/cafe/supermarket = "Food", bar = "Drinks", taxi/train/fuel = "Transport", hotel = "Accommodation", tour/ticket = "Activities", other retail = "Shopping".`;

async function scanAnthropic(apiKey, base64) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function scanGemini(apiKey, base64) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: base64 } },
            { text: PROMPT },
          ],
        }],
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

// Returns { amount, currency, merchant, category, items, subtotal, tax }.
//   amount  = final total paid (number|null) — used as the bill total
//   items   = [{ name, price }] line items (may be empty if none could be read)
// Any field may be null/empty. Throws on network/API/parse failure; caller
// falls back to manual entry.
export async function scanReceipt(file) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("NO_KEY");

  const base64 = await fileToJpegBase64(file);
  const text = apiKey.startsWith("AIza")
    ? await scanGemini(apiKey, base64)
    : await scanAnthropic(apiKey, base64);

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("PARSE");
  const parsed = JSON.parse(match[0]);

  const num = (v) => typeof v === "number" && isFinite(v) ? v : null;
  const items = Array.isArray(parsed.items)
    ? parsed.items
        .map((it) => ({
          name: typeof it?.name === "string" ? it.name.slice(0, 60) : "",
          price: num(it?.price),
        }))
        .filter((it) => it.price != null && it.price > 0)
    : [];

  const total = num(parsed.total) ?? num(parsed.amount);
  const subtotal = num(parsed.subtotal);

  return {
    // amount falls back to subtotal, then the items' own sum, so we always
    // have a sensible bill total even on partial reads.
    amount: (total && total > 0 ? total : null)
      ?? (subtotal && subtotal > 0 ? subtotal : null)
      ?? (items.length ? Math.round(items.reduce((a, b) => a + b.price, 0) * 100) / 100 : null),
    currency: typeof parsed.currency === "string" ? parsed.currency.toUpperCase() : null,
    merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
    category: CATEGORIES.includes(parsed.category) ? parsed.category : null,
    items,
    subtotal,
    tax: num(parsed.tax),
  };
}
