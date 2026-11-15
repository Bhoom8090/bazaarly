'use strict';
// Money math in integer paise. A product is either GST-inclusive of its tax price
// (prices stored inclusive), or excluded — we treat stored price as GST-inclusive,
// matching the Indian "MRP inclusive of all taxes" convention.

const FREE_SHIPPING_THRESHOLD = 49900; // Rs 499.00 in paise
const SHIPPING_FEE = 4000;             // Rs 40.00 in paise
const GST_RATE = 0.18;                 // 18% inclusive

function priceLines(lines, productsBySku) {
  // lines: [{ sku, quantity }]; productsBySku: Map/object sku -> product { price (paise, GST-inclusive), title, ... }
  const get = (sku) => (productsBySku instanceof Map ? productsBySku.get(sku) : productsBySku[sku]);
  const priced = [];
  let subtotal = 0;
  for (const line of lines) {
    const p = get(line.sku);
    if (!p) {
      const err = new Error(`Unknown SKU ${line.sku}`);
      err.code = 'UNKNOWN_SKU';
      err.sku = line.sku;
      throw err;
    }
    const qty = Math.max(0, Math.min(line.quantity | 0, 10));
    const lineTotal = p.price * qty;
    subtotal += lineTotal;
    priced.push({ sku: line.sku, productId: p.productId || p._id || null, title: p.title, emoji: p.emoji || null, unitPrice: p.price, quantity: qty, lineTotal });
  }
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD || subtotal === 0 ? 0 : SHIPPING_FEE;
  // 18% GST extracted from inclusive amounts (subtotal + shipping are tax-inclusive).
  const gross = subtotal + shipping;
  const tax = Math.round((gross * GST_RATE) / (1 + GST_RATE));
  const total = gross;
  return {
    items: priced,
    pricing: {
      subtotal,                       // paise, GST-inclusive
      shipping,                       // paise
      tax,                            // paise, portion of gross attributable to GST
      total,                          // paise
      currency: 'INR',
      freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
    },
  };
}

function formatINR(paise) {
  return '₹' + ((paise || 0) / 100).toFixed(2);
}

module.exports = { priceLines, formatINR, FREE_SHIPPING_THRESHOLD, SHIPPING_FEE, GST_RATE };
