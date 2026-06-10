// Receipt scanning via Anthropic Haiku vision. The photo is sent for
// extraction only and never stored anywhere.
import { ANTHROPIC_MODEL, CATEGORIES, CURRENCIES } from "./config.js";

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

// Returns { amount, currency, merchant, category } — any field may be null.
// Throws on network/API/parse failure; caller falls back to manual entry.
export async function scanReceipt(file) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("NO_KEY");

  const base64 = await fileToJpegBase64(file);

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
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          {
            type: "text",
            text:
`Extract the following from this receipt and reply with ONLY a JSON object, no other text:
{
  "amount": <final total paid, as a number, no thousands separators>,
  "currency": <ISO code, one of ${CURRENCIES.join("/")}, or your best guess from the receipt>,
  "merchant": <short merchant/store name as a string>,
  "category": <exactly one of: ${CATEGORIES.join(", ")}>
}
Use null for any field you cannot determine. A restaurant/cafe/supermarket is "Food", a bar is "Drinks", taxis/trains/fuel are "Transport", hotels are "Accommodation", tours/tickets are "Activities", everything else retail is "Shopping".`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("PARSE");
  const parsed = JSON.parse(match[0]);

  return {
    amount: typeof parsed.amount === "number" && parsed.amount > 0 ? parsed.amount : null,
    currency: typeof parsed.currency === "string" ? parsed.currency.toUpperCase() : null,
    merchant: typeof parsed.merchant === "string" ? parsed.merchant : null,
    category: CATEGORIES.includes(parsed.category) ? parsed.category : null,
  };
}
