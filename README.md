# Blood Donation Backend API

A single-file Express 5 REST API powering a blood-donation web app. Handles blood-request listings, user auth/roles, volunteer requests, and Stripe-powered donations.

## Tech Stack

| Piece | Choice |
| --- | --- |
| Runtime | Node.js (CommonJS) |
| Framework | Express 5 |
| Database | MongoDB (native `mongodb` driver, no Mongoose) |
| Auth | Firebase ID tokens (`firebase-admin` JWT verification) |
| Payments | Stripe checkout sessions |
| Deployment | Vercel (serverless, `@vercel/node`) |

## Features

- **Blood requests** — anyone can browse; logged-in users can post and view their own.
- **Users & roles** — Firebase-verified identity; roles are `donor` (default) or `admin`, set server-side only.
- **Volunteer program** — users apply to become volunteers; admins approve and can change roles.
- **Donations** — Stripe checkout sessions; payment verification records donations shown publicly.

## Getting Started

### Prerequisites

- Node.js (16+)
- MongoDB Atlas (or any `MONGODB_URI` with `admin.ping` access)
- Firebase project with a service-account key
- Stripe account (test keys fine)

### Environment variables

Create a `.env` file at the project root:

```
MONGODB_URI=mongodb+srv://...
FB_SERVICE_KEY=<base64-encoded Firebase service-account JSON>
STRIPE_SECRET_KEY=sk_test_...
CLIENT_DOMAIN=https://your-client.web.app
```

> `FB_SERVICE_KEY` must be the service-account JSON **base64-encoded** as a single string. Run `node serviceKeyConverter.js` to produce it (note: that script reads `./blood-donation-serviceKey.j` — the filename is intentionally a known typo, see below). If the key is missing or invalid the server still starts, but every protected route returns `500 Firebase not initialized`.

### Install & run

```bash
npm install
npm run dev      # nodemon, auto-reload
# or
npm start        # plain node index.js
```

Server runs on `http://localhost:5000` (override with `PORT`).

## API Endpoints

| Method | Route | Auth | Description |
| --- | --- | --- | --- |
| GET | `/` | public | Health check |
| GET | `/request` | public | List all blood requests |
| POST | `/request` | JWT | Create a blood request (`user` forced from token) |
| GET | `/my-request/:email` | JWT | List current user's requests (must match token email) |
| POST | `/user` | public | Upsert user on login/register (role defaults to `donor`) |
| GET | `/user/role` | JWT | Get logged-in user's role |
| PATCH | `/user/profile` | JWT | Update own profile (email/role are stripped) |
| GET | `/users` | JWT + admin | List all users except self |
| PATCH | `/update-role` | JWT + admin | Change a user's role (also deletes their volunteer request) |
| POST | `/become-volunteer` | JWT | Apply for volunteer status (409 if already applied) |
| GET | `/volunteer-request` | JWT + admin | List volunteer applications |
| POST | `/create-checkout-session` | JWT | Create Stripe checkout, returns `{ url }` |
| POST | `/payment-success` | public | Verify payment, record donation (idempotent) |
| GET | `/donation` | public | List public donation records |

**Auth header:** `Authorization: Bearer <firebase-id-token>`

## Auth & Security Model

- **JWT** (`verifyJWT`) decodes the Firebase ID token and sets `req.tokenEmail`. Protected routes must always use `req.tokenEmail`, never a body/param email.
- **Ownership** — `POST /request` overwrites the `user` field with the verified token email; `GET /my-request/:email` rejects URL emails that don't match the token.
- **Profile safety** — `PATCH /user/profile` deletes `email` and `role` from the body before updating, preventing email change and role escalation.
- **Roles** — only the server sets roles; new users default to `donor`. Admin routes use `verifyADMIN`.

## Database

Database `blood-donation` with four collections:

| Collection | Purpose | Key fields |
| --- | --- | --- |
| `requests` | Blood requests | `user` (email), request details, `created_at` |
| `users` | User profiles & roles | `email`, `role`, `created_at`, `last_logIn` |
| `volunteerRequest` | Volunteer applications | `email` |
| `donation` | Donation records | `transactionId`, `name`, `email`, `donationAmount`, `status` |

## Deployment (Vercel)

- `vercel.json` routes all requests to `index.js` via `@vercel/node`.
- `app.listen` is guarded by `require.main === module`, so the app exports cleanly as a serverless function.
- Set the four environment variables in your Vercel project settings.

## Project Structure

```
index.js                  # entire backend (routes, middleware, DB, auth)
serviceKeyConverter.js    # converts Firebase service JSON to base64 for FB_SERVICE_KEY
vercel.json               # Vercel serverless config
package.json              # deps & scripts (commonjs, no build step)
.env                      # secrets — gitignored, never commit
```

## Known Gotchas

- **CORS allowlist** is hard-coded in `index.js` (Firebase web app URLs + `localhost:5173`/`localhost:3000`). New client origins must be added there.
- **`serviceKeyConverter.js` typo** — it reads `./blood-donation-serviceKey.j` (missing trailing `n`); rename your file to match or fix the script.
- **No test infrastructure** — verify changes by running the server and hitting endpoints.
