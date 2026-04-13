# Qtime Backend

Node.js backend for a Fresha-like booking platform. Book salons, spas, barbers, and beauty services nearby.

## Features

- **Auth**: Register, login (JWT)
- **Businesses**: Create & list salons/spas with services
- **Search**: By city, category, text, or geolocation
- **Bookings**: Create, list, cancel appointments
- **Reviews**: Rate businesses (1–5 stars)
- **Favorites**: Save favorite businesses

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set `DATABASE_URL` (PostgreSQL connection string) and `JWT_SECRET`.

3. **Setup database**
   ```bash
   npm run db:generate
   npm run db:push
   ```
   (Or `npm run db:migrate` for migrations.)

4. **Start the server**
   ```bash
   npm run dev
   ```

## API Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST   | `/api/auth/register` | Register user |
| POST   | `/api/auth/login` | Login |
| GET    | `/api/auth/me` | Current user (auth required) |
| GET    | `/api/businesses` | List businesses (filter: city, category) |
| GET    | `/api/businesses/:id` | Get business details |
| POST   | `/api/businesses` | Create business (auth) |
| PATCH  | `/api/businesses/:id` | Update business (owner) |
| GET    | `/api/search?q=&city=&category=&lat=&lng=` | Search |
| POST   | `/api/bookings` | Create booking (auth) |
| GET    | `/api/bookings/me` | My bookings |
| PATCH  | `/api/bookings/:id/cancel` | Cancel booking |
| POST   | `/api/reviews` | Add review |
| GET/POST/DELETE | `/api/users/favorites/:businessId` | Favorites |

## Tech Stack

- **Node.js** + **Express**
- **PostgreSQL** + **Prisma**
- **JWT** (jsonwebtoken) for auth
- **bcryptjs** for passwords
- **express-validator** for validation

## Similar to Fresha

Inspired by [Fresha](https://www.fresha.com/) — booking salons, spas, barbers, and wellness services. This backend provides the core APIs to build a similar marketplace.
