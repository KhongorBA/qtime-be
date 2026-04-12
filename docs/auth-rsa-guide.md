# RSA Encryption on Login — Дэлгэрэнгүй заавар

## Яагаад RSA?

Login хийх үед нууц үгийг network-ээр plain text-ээр явуулахгүйн тулд:
```
Flutter → [RSA encrypt password] → HTTP → [RSA decrypt] → bcrypt compare
```
HTTPS дээр ч гэсэн нэмэлт давхар хамгаалалт болно.

---

## Сервер дээр хэрхэн ажилладаг вэ

### 1. `GET /api/auth/public-key`
```json
{ "publicKey": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq...\n-----END PUBLIC KEY-----\n" }
```
Flutter энэ public key-г авна → нууц үгийг шифрлэнэ.

### 2. `POST /api/auth/login`
```json
{
  "loginName": "user@email.com",
  "credentials": "<RSA-OAEP-base64-encrypted-password>"
}
```
Сервер `AUTH_USE_CIPHER=true` байвал `decryptCredentials()` дуудаж тайлна, bcrypt-тэй харьцуулна.

### 3. Алгоритм
- **RSA-OAEP** (SHA-1 padding) — `crypto.constants.RSA_PKCS1_OAEP_PADDING`
- **Key size**: 2048 bit
- **Output**: base64 encoded (~344 chars)

---

## Flutter дээр нууц үг шифрлэх

### pubspec.yaml
```yaml
dependencies:
  pointycastle: ^3.7.4   # RSA encryption
  http: ^1.2.0
```

### auth_service.dart
```dart
import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:pointycastle/export.dart';

class AuthService {
  final String baseUrl;
  AuthService(this.baseUrl);

  // ── Нийтийн түлхүүр авах ──────────────────────────────────────────
  Future<String> fetchPublicKey() async {
    final res = await http.get(Uri.parse('$baseUrl/auth/public-key'));
    if (res.statusCode != 200) throw Exception('Public key авч чадсангүй');
    final json = jsonDecode(res.body) as Map<String, dynamic>;
    return json['publicKey'] as String;
  }

  // ── RSA-OAEP шифрлэх ─────────────────────────────────────────────
  String encryptPassword(String password, String publicKeyPem) {
    // PEM → DER bytes
    final pemClean = publicKeyPem
        .replaceAll('-----BEGIN PUBLIC KEY-----', '')
        .replaceAll('-----END PUBLIC KEY-----', '')
        .replaceAll('\n', '')
        .trim();
    final derBytes = base64Decode(pemClean);

    // Parse SubjectPublicKeyInfo (SPKI) → RSA public key
    final asn1Parser = ASN1Parser(derBytes);
    final topLevelSeq = asn1Parser.nextObject() as ASN1Sequence;
    final publicKeyBitString = topLevelSeq.elements![1] as ASN1BitString;
    final pkParser = ASN1Parser(publicKeyBitString.valueBytes!);
    final pkSeq = pkParser.nextObject() as ASN1Sequence;
    final modulus    = (pkSeq.elements![0] as ASN1Integer).integer!;
    final exponent   = (pkSeq.elements![1] as ASN1Integer).integer!;

    final rsaPublicKey = RSAPublicKey(modulus, exponent);
    final cipher = OAEPEncoding(RSAEngine())
      ..init(true, PublicKeyParameter<RSAPublicKey>(rsaPublicKey));

    final input = Uint8List.fromList(utf8.encode(password));
    final encrypted = cipher.process(input);
    return base64Encode(encrypted);
  }

  // ── Login ─────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> login(String loginName, String password) async {
    // 1. Public key авах
    final publicKey = await fetchPublicKey();

    // 2. Нууц үг шифрлэх
    final encryptedPassword = encryptPassword(password, publicKey);

    // 3. Login request
    final res = await http.post(
      Uri.parse('$baseUrl/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'loginName': loginName,
        'credentials': encryptedPassword,   // RSA шифрлэсэн
      }),
    );

    if (res.statusCode != 200) {
      final body = jsonDecode(res.body);
      throw Exception(body['message'] ?? 'Login алдаа');
    }

    return jsonDecode(res.body) as Map<String, dynamic>;
    // Returns: { id, name, email, phone, role, token }
  }
}
```

### Хэрэглэх жишээ
```dart
final authService = AuthService('http://192.168.1.100:5000/api');

try {
  final result = await authService.login('user@email.com', 'mypassword123');
  final token = result['token'] as String;
  // SharedPreferences-д хадгалах...
} catch (e) {
  print('Login алдаа: $e');
}
```

---

## Register дээр RSA ашиглах

Login-тэй яг ижилхэн — `credentials` field-д шифрлэсэн нууц үг явуулна:
```dart
final res = await http.post(
  Uri.parse('$baseUrl/auth/register-business'),
  headers: {'Content-Type': 'application/json'},
  body: jsonEncode({
    'verificationToken': verifToken,
    'name': name,
    'phone': phone,
    'email': email,
    'credentials': encryptedPassword,   // ← мөн адил
  }),
);
```

---

## Тест хийх (.env тохиргоо)

```bash
# RSA-г идэвхгүй болгож plain text password ашиглах (dev only):
AUTH_USE_CIPHER=false

# RSA-г идэвхтэй байлгах (default):
AUTH_USE_CIPHER=true
```

`AUTH_USE_CIPHER=false` үед `credentials`-д plain нууц үг явуулж болно — curl эсвэл Postman-аас тестлэхэд хялбар.

---

## curl-аар тест хийх

```bash
# 1. Public key авах
curl http://localhost:5000/api/auth/public-key

# 2. AUTH_USE_CIPHER=false байвал plain password-р login
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"loginName":"test@email.com","credentials":"mypassword"}'
```
