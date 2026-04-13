# Qtime BE Scripts

## Admin хэрэглэгч үүсгэх

Одоо байгаа хэрэглэгчийг admin болгох:

```bash
cd qtime-be
node scripts/create-admin.js user@example.com
```

Эхлээд Qtime апп эсвэл `/api/auth/register`-аар хэрэглэгч бүртгэсэн байх ёстой.

---

# Notification туршилт – Админ веб байхгүй үед

Админ веб бэлэн болох хүртэл баазаар шууд notification оруулж шалгана.

## 1. userId олох

```sql
SELECT id, email, name FROM "User" LIMIT 10;
```

## 2. SQL query-аар notification оруулах

PostgreSQL (psql эсвэл pgAdmin):

```sql
INSERT INTO "Notification" (id, "userId", title, body, read, "createdAt")
VALUES (
  gen_random_uuid()::text,
  'USER_ID_ЭНД_ОРУУЛНА',  -- SELECT id FROM "User" LIMIT 1; аас userId
  'Захиалга баталгаажлаа',
  'Таны захиалга 2025-03-15 14:00 цагт баталгаажлаа.',
  false,
  NOW()
);
```

**Бүх хэрэглэгчид илгээх:**
```sql
INSERT INTO "Notification" (id, "userId", title, body, read, "createdAt")
SELECT gen_random_uuid()::text, id, 'Системийн мэдэгдэл', 'Шинэ функц нэмэгдлээ.', false, NOW()
FROM "User";
```

## 3. Script ашиглах (зөвлөмжтэй)

```bash
cd qtime-be

# Энгийн туршилт
node scripts/insert-test-notification.js user@example.com

# Гарчиг + мессеж өгөх
node scripts/insert-test-notification.js user@example.com "Захиалга баталгаажлаа" "14:00 цагт"

# npm script
npm run notification:test -- user@example.com
```

## 4. Шалгах

1. App дээр нэвтэрнэ
2. Bell icon → Мэдэгдлүүд дэлгэц нээнэ
3. **Доош чирж сэргээнэ** (pull-to-refresh)
4. Баазаас оруулсан мэдэгдэл харагдана

## Тэмдэглэл

- FCM push **илгээгдэхгүй** – зөвхөн in-app жагсаалт дахь мэдэгдэл
- Админ веб ирэхэд: DB-д бичих + FCM push илгээх хоёуланг хийнэ
