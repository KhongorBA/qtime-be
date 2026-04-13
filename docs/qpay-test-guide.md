# QPay Mock тест — алхам алхмаар заавар

## Mock горим яаж ажилладаг вэ

`QPAY_MOCK=true` тохируулбал:
- Real QPay API дуудалт **огт хийхгүй**
- Бүх functions-ийн input-ийг `console.log`-д хэвлэнэ
- Fake `invoice_id`, fake QR image буцаана
- **10 секундын дараа** `/qpay-status` endpoint `paid: true` буцаана (auto-pay simulation)

---

## 1. .env тохиргоо

```bash
# .env файлд нэмэх
QPAY_MOCK=true
API_BASE_URL=http://localhost:5000
```

---

## 2. Тест хийх алхамууд (curl)

### А. Booking үүсгэх
```bash
# Эхлээд login хийж token авах
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"loginName":"customer@test.com","credentials":"password123"}' \
  | jq -r '.token')

echo "Token: $TOKEN"

# Booking үүсгэх
BOOKING=$(curl -s -X POST http://localhost:5000/api/bookings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "businessId": "<your-business-id>",
    "serviceIndex": 0,
    "startTime": "2026-04-01T10:00:00.000Z"
  }')

echo "Booking: $BOOKING"
BOOKING_ID=$(echo $BOOKING | jq -r '.id')
```

### Б. QPay deposit intent үүсгэх
```bash
INTENT=$(curl -s -X POST http://localhost:5000/api/payments/booking/$BOOKING_ID/qpay-intent \
  -H "Authorization: Bearer $TOKEN")

echo "QPay intent response:"
echo $INTENT | jq .

INVOICE_ID=$(echo $INTENT | jq -r '.invoiceId')
echo "Invoice ID: $INVOICE_ID"
```

**Console-д харагдах log:**
```
[QPay MOCK] createInvoice {
  amount: 20000,
  description: 'Salon X — Үс засах',
  senderInvoiceNo: 'dep_cm1abc...',
  callbackUrl: 'http://localhost:5000/api/payments/webhook/qpay'
}
[payment] qpay-intent created { bookingId: '...', depositAmount: 20000, invoiceId: 'inv_1743...', mock: true }
```

### В. Payment status шалгах (10 секунд хүлээх)
```bash
# Шууд шалгах — paid: false байна
curl -s http://localhost:5000/api/payments/booking/$BOOKING_ID/qpay-status \
  -H "Authorization: Bearer $TOKEN" | jq .

# 10+ секундын дараа — paid: true болно
sleep 11
curl -s http://localhost:5000/api/payments/booking/$BOOKING_ID/qpay-status \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Хүлээгдэж буй хариу (10с-ийн дараа):**
```json
{
  "paid": true,
  "paidAmount": undefined,
  "paymentId": "mock_pay_inv_1743...",
  "status": "pending"
}
```

**Console log:**
```
[QPay MOCK] checkPayment { invoiceId: 'inv_1743...', paid: true, elapsedMs: 11234 }
```

### Г. Webhook-р test хийх (QPay-с callback дуусгах)
```bash
# QPay webhook-г simulate хийх
curl -s -X POST http://localhost:5000/api/payments/webhook/qpay \
  -H "Content-Type: application/json" \
  -d "{
    \"invoice_id\": \"$INVOICE_ID\",
    \"payment_id\": \"qpay_pay_123\",
    \"payment_status\": \"PAID\"
  }"
```

**Console log:**
```
[webhook] QPay callback received: {"invoice_id":"inv_1743...","payment_id":"qpay_pay_123","payment_status":"PAID"}
[webhook] QPay: deposit captured { bookingId: '...', paymentId: 'qpay_pay_123' }
```

### Д. Үйлчилгээ дуусгах (remainder invoice)
```bash
# Business token ашиглах
BIZ_TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"loginName":"owner@test.com","credentials":"password123"}' \
  | jq -r '.token')

REMAINDER=$(curl -s -X POST http://localhost:5000/api/payments/booking/$BOOKING_ID/complete \
  -H "Authorization: Bearer $BIZ_TOKEN")

echo "Remainder invoice:"
echo $REMAINDER | jq .
```

**Console log:**
```
[QPay MOCK] createInvoice { amount: 80000, description: 'Үлдэгдэл: Salon X — Үс засах', ... }
[payment] remainder invoice created { bookingId: '...', remainderAmount: 80000, mock: true }
```

### Е. Буцаалт (refund)
```bash
curl -s -X POST http://localhost:5000/api/payments/booking/$BOOKING_ID/refund \
  -H "Authorization: Bearer $TOKEN" | jq .
```

**Console log:**
```
[QPay MOCK] refundPayment { paymentId: 'qpay_pay_123' }
[payment] refund processed { bookingId: '...', refunds: [{type:'deposit',success:true,_mock:true}] }
```

---

## 3. Postman collection

```json
{
  "info": { "name": "Qtime QPay Test" },
  "variable": [
    { "key": "base", "value": "http://localhost:5000/api" },
    { "key": "token", "value": "" },
    { "key": "bookingId", "value": "" }
  ],
  "item": [
    {
      "name": "Login",
      "request": {
        "method": "POST",
        "url": "{{base}}/auth/login",
        "body": { "mode": "raw", "raw": "{\"loginName\":\"test@email.com\",\"credentials\":\"password\"}", "options": { "raw": { "language": "json" } } }
      }
    },
    {
      "name": "QPay Intent",
      "request": {
        "method": "POST",
        "url": "{{base}}/payments/booking/{{bookingId}}/qpay-intent",
        "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }]
      }
    },
    {
      "name": "QPay Status",
      "request": {
        "method": "GET",
        "url": "{{base}}/payments/booking/{{bookingId}}/qpay-status",
        "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }]
      }
    },
    {
      "name": "QPay Webhook (simulate)",
      "request": {
        "method": "POST",
        "url": "{{base}}/payments/webhook/qpay",
        "body": { "mode": "raw", "raw": "{\"invoice_id\":\"INVOICE_ID_HERE\",\"payment_id\":\"pay_123\",\"payment_status\":\"PAID\"}", "options": { "raw": { "language": "json" } } }
      }
    },
    {
      "name": "Complete (remainder)",
      "request": {
        "method": "POST",
        "url": "{{base}}/payments/booking/{{bookingId}}/complete",
        "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }]
      }
    },
    {
      "name": "Refund",
      "request": {
        "method": "POST",
        "url": "{{base}}/payments/booking/{{bookingId}}/refund",
        "header": [{ "key": "Authorization", "value": "Bearer {{token}}" }]
      }
    }
  ]
}
```

---

## 4. Production руу шилжих

```bash
# .env-д өөрчлөх
QPAY_MOCK=false   # эсвэл устгах
QPAY_BASE_URL=https://sandbox.qpay.mn/v2   # эхлээд sandbox
QPAY_USERNAME=your_actual_username
QPAY_PASSWORD=your_actual_password
QPAY_INVOICE_CODE=YOUR_INVOICE_CODE
API_BASE_URL=https://your-server.com       # webhook-д хэрэгтэй
```

**QPay merchant account авах:**
1. [merchant.qpay.mn](https://merchant.qpay.mn) → Бүртгэл
2. Бизнесийн регистр, банкны данс оруулах
3. Sandbox credentials шууд авна
4. Production-д шилжихэд QPay баг баталгаажуулна (1-3 ажлын өдөр)
