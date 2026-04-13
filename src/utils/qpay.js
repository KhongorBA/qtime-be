/**
 * QPay v2 API utility
 *
 * MOCK MODE: Set QPAY_MOCK=true in .env to skip real API calls.
 *   - All functions log their inputs and return realistic fake data.
 *   - Use this to test the full payment flow without a real merchant account.
 *
 * ENV vars:
 *   QPAY_BASE_URL      = https://sandbox.qpay.mn/v2   (sandbox)
 *                      = https://merchant.qpay.mn/v2  (production)
 *   QPAY_USERNAME      = merchant username from QPay dashboard
 *   QPAY_PASSWORD      = merchant password from QPay dashboard
 *   QPAY_INVOICE_CODE  = invoice code from QPay dashboard (e.g. QTIME_INVOICE)
 *   QPAY_MOCK          = true  (dev/test mode — no real API calls)
 */

const BASE = process.env.QPAY_BASE_URL || 'https://sandbox.qpay.mn/v2';
const INVOICE_CODE = process.env.QPAY_INVOICE_CODE || 'QTIME_INVOICE';

// ── Token cache ──────────────────────────────────────────────────────────────
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const username = process.env.QPAY_USERNAME;
  const password = process.env.QPAY_PASSWORD;
  if (!username || !password) throw new Error('QPAY_USERNAME / QPAY_PASSWORD тохируулаагүй байна');

  const res = await fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QPay auth алдаа ${res.status}: ${text}`);
  }

  const data = await res.json();
  _token = data.access_token;
  // Expire 60s early to avoid edge-case rejections
  _tokenExpiry = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
  return _token;
}

// ── Mock helpers ──────────────────────────────────────────────────────────────
const isMock = () => process.env.QPAY_MOCK === 'true';

// Tiny 1x1 transparent PNG as placeholder QR image (base64)
const MOCK_QR_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function mockInvoiceId(prefix = 'mock') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a QPay invoice (QR payment request).
 *
 * @param {object} opts
 * @param {number}  opts.amount            - Amount in MNT (integer)
 * @param {string}  opts.description       - Human-readable description (shown in bank app)
 * @param {string}  opts.senderInvoiceNo   - Your internal reference (bookingId etc.)
 * @param {string}  [opts.callbackUrl]     - Webhook URL QPay calls on payment
 * @returns {object} QPay invoice response
 *   { invoice_id, qr_text, qr_image (base64 PNG), urls [{name, description, logo, link}] }
 */
export async function createQPayInvoice({ amount, description, senderInvoiceNo, callbackUrl }) {
  if (isMock()) {
    const id = mockInvoiceId('inv');
    console.log('[QPay MOCK] createInvoice', { amount, description, senderInvoiceNo, callbackUrl });
    return {
      invoice_id: id,
      qr_text: `https://qpay.mn/q/${id}`,
      qr_image: MOCK_QR_IMAGE,
      urls: [
        { name: 'Khan Bank',      description: 'Хаан банк',        logo: '', link: `khanbank://q/${id}` },
        { name: 'Golomt Bank',    description: 'Голомт банк',      logo: '', link: `golomtbank://q/${id}` },
        { name: 'TDB',            description: 'Худалдаа хөгжлийн банк', logo: '', link: `tdbbank://q/${id}` },
        { name: 'State Bank',     description: 'Хадгаламжийн банк',logo: '', link: `statebank://q/${id}` },
      ],
      _mock: true,
    };
  }

  const token = await getToken();
  const body = {
    invoice_code: INVOICE_CODE,
    sender_invoice_no: String(senderInvoiceNo),
    invoice_receiver_code: 'terminal',
    invoice_description: description,
    amount: Math.round(amount),
    callback_url: callbackUrl || '',
  };

  const res = await fetch(`${BASE}/invoice`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QPay invoice үүсгэх алдаа ${res.status}: ${text}`);
  }

  return res.json();
}

/**
 * Check if an invoice has been paid.
 *
 * @param {string} invoiceId - QPay invoice_id from createQPayInvoice
 * @returns {{ paid: boolean, paidAmount: number, paymentId: string|null, raw: object }}
 */
export async function checkQPayPayment(invoiceId) {
  if (isMock()) {
    // In mock mode auto-pay after 10 seconds so you can test the flow quickly
    const createdTs = parseInt(invoiceId.split('_')[1] || '0', 10);
    const elapsedMs = Date.now() - createdTs;
    const paid = elapsedMs > 10_000;
    console.log('[QPay MOCK] checkPayment', { invoiceId, paid, elapsedMs });
    return {
      paid,
      paidAmount: paid ? undefined : 0, // caller gets paidAmount from Payment record
      paymentId: paid ? `mock_pay_${invoiceId}` : null,
      raw: { count: paid ? 1 : 0, payment_status: paid ? 'PAID' : 'PENDING' },
    };
  }

  const token = await getToken();
  const res = await fetch(`${BASE}/payment/check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ object_type: 'INVOICE', object_id: invoiceId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QPay payment check алдаа ${res.status}: ${text}`);
  }

  const data = await res.json();
  const paidRow = data.rows?.find((r) => r.payment_status === 'PAID');
  return {
    paid: !!paidRow,
    paidAmount: data.paid_amount ?? 0,
    paymentId: paidRow?.payment_id ?? null,
    raw: data,
  };
}

/**
 * Refund / cancel a QPay payment.
 *
 * @param {string} paymentId - QPay payment_id (from checkQPayPayment)
 * @returns {{ success: boolean }}
 */
export async function refundQPayPayment(paymentId) {
  if (isMock()) {
    console.log('[QPay MOCK] refundPayment', { paymentId });
    return { success: true, _mock: true };
  }

  const token = await getToken();
  const res = await fetch(`${BASE}/payment/cancel/${encodeURIComponent(paymentId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`QPay refund алдаа ${res.status}: ${text}`);
  }

  return { success: true };
}
