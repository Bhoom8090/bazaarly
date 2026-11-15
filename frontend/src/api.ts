// Thin API client. All calls go through the nginx /api prefix to the gateway.
// Cookies are HttpOnly; mutating requests echo X-CSRF-Token from the session.
export interface Session {
  authenticated: boolean;
  user?: { id: string; email: string; name: string; role: 'customer' | 'admin'; addresses: Address[] };
  csrfToken?: string;
}

export interface Address {
  _id: string; name: string; phone: string; line1: string; line2?: string; city: string; state: string; pincode: string;
}

export interface Product {
  productId: string; sku: string; title: string; brand: string; category: string; description?: string;
  price: number; currency: string; emoji: string; color: string; status?: string; version?: number;
}

export interface CartItem { sku: string; productId: string; title: string; emoji: string; unitPrice: number; quantity: number; lineTotal: number }
export interface Pricing { subtotal: number; shipping: number; tax: number; total: number; currency: string; freeShippingThreshold: number }

export interface Order {
  _id: string; state: string; items: CartItem[]; pricing: Pricing; address: Address;
  history: { from: string | null; to: string; at: string; note?: string }[];
  paymentScenario?: string; cancelReason?: string; reservationExpiresAt?: string;
  createdAt: string; updatedAt: string;
}

export interface Notification { _id: string; subject: string; body: string; readAt: string | null; orderId?: string; createdAt: string }

export class ApiError extends Error {
  code: string; status: number; details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message); this.status = status; this.code = code; this.details = details;
  }
}

let csrfToken = '';
export function setCsrfToken(t?: string) { csrfToken = t || ''; }

async function request<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const method = options.method || 'GET';
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method)) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(`/api${path}`, { method, credentials: 'include', headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || `HTTP_${res.status}`, err.message || res.statusText, err.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>(path, { method: 'POST', body, headers }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function formatPrice(paise: number): string {
  return '₹' + ((paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
