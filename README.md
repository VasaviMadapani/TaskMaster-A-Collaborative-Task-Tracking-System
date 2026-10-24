# TaskMaster API

TaskMaster is a REST API for team task tracking, built with Node.js, TypeScript, Express 5, PostgreSQL, and Prisma. It provides account and session management, project membership and invitations, task assignment and search, comments, and private task attachments.

## Features

- Email/password registration and login with bcrypt password hashes.
- Short-lived, signed JWT access tokens and rotating, revocable refresh sessions in secure, HTTP-only cookies.
- User profile and project membership endpoints.
- Projects with owner, administrator, and member roles; one-time invitation tokens expire after seven days.
- Task CRUD with assignees, due dates, status, priority, pagination, filtering, sorting, and title/description search.
- Task comments and private, authorized attachment upload/download/deletion.
- PostgreSQL migrations, request validation, consistent JSON errors, CORS, security headers, rate limits, structured logs, liveness/readiness checks, and graceful shutdown.
- Docker image and Docker Compose configuration.

## Requirements

- Node.js 20.11 or later and npm.
- PostgreSQL 15 or later, or Docker Compose.

## Local development

1. Copy `.env.example` to `.env`. Set `DATABASE_URL` for a local PostgreSQL database and replace `JWT_ACCESS_SECRET` with a random secret of at least 32 characters. For example, generate one with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`.
2. Install dependencies. This generates `package-lock.json`; commit that lockfile so installs and deployment builds can be reproduced.

   ```sh
   npm install
   ```

3. Generate the Prisma client, apply migrations, and start the development server:

   ```sh
   npm run db:generate
   npm run db:migrate
   npm run dev
   ```

The API listens on `http://localhost:3000`. Readiness and liveness are available at `/health/ready` and `/health/live`.

## Docker deployment

Use a `.env` file with at least `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, and `WEB_ORIGINS`. Use a URL-safe PostgreSQL password (base64url is suitable) because Compose constructs `DATABASE_URL` from the password. Set `WEB_ORIGINS` to the exact browser origin(s), without a trailing slash. Keep `.env` out of source control.

Build and apply the database migration once before starting the API:

```sh
docker compose build api
docker compose up -d db
docker compose run --rm api npm run db:migrate
docker compose up -d api
```

The API is bound to `127.0.0.1:3000` by default; set `API_PORT` and, only when necessary, `API_BIND_ADDRESS` to change the host binding. PostgreSQL data and uploaded attachments use named volumes. Put the service behind a TLS-terminating reverse proxy, expose only HTTPS to clients, and set `TRUST_PROXY_HOPS` to the exact number of trusted proxies in front of Express (leave it at `0` when there is no proxy). Do not trust arbitrary forwarded headers.

For deployments outside Compose, build the image and use this release sequence:

1. Provide all required environment variables through the deployment platform's secret/configuration manager.
2. Run `npm run db:migrate` once as a release job against the target database.
3. Start `node dist/server.js` (or the image default) and wait for `/health/ready`.

Do not run migrations independently in every API replica. Use managed PostgreSQL with TLS, restricted network access, automated backups, and a tested restore procedure. The supplied attachment store is a private local filesystem volume: retain and back it up with the database, and use object storage plus a shared rate-limit store before running multiple API replicas. The in-memory rate limiter is intentionally suitable for a single instance only.

## Environment variables

| Variable | Required | Default | Description |
|---|---:|---|---|
| `NODE_ENV` | No | `development` | `development`, `test`, or `production`. Production always enables secure refresh cookies. |
| `PORT` | No | `3000` | HTTP listen port. |
| `TRUST_PROXY_HOPS` | No | `0` | Exact trusted reverse-proxy hop count; configure only behind a known proxy. |
| `DATABASE_URL` | Yes | — | PostgreSQL connection string. Use TLS for remote databases. |
| `JWT_ACCESS_SECRET` | Yes | — | Random signing secret, at least 32 characters. Store in a secret manager. |
| `ACCESS_TOKEN_TTL_SECONDS` | No | `900` | JWT lifetime in seconds (60–3600). |
| `REFRESH_TOKEN_TTL_DAYS` | No | `30` | Refresh-session lifetime in days (1–90). |
| `WEB_ORIGINS` | No | `http://localhost:5173` | Comma-separated exact frontend origins allowed by CORS. |
| `COOKIE_SECURE` | No | `false` | Secure cookie flag; always enabled in production. |
| `UPLOAD_DIR` | No | `./uploads` | Private directory for attachment files. Persist it in deployment. |
| `MAX_UPLOAD_BYTES` | No | `10485760` | Maximum attachment size in bytes (up to 100 MiB). |
| `LOG_LEVEL` | No | `info` | Pino log level. |

Refresh cookies are HTTP-only, scoped to `/api/v1/auth`, and use `SameSite=Lax`. Deploy the browser application and API on the same site. A cross-site frontend requires a deliberate cookie/CSRF design change; do not simply loosen cookie settings.

## API overview

All API routes are prefixed with `/api/v1`. Authenticated routes use `Authorization: Bearer <accessToken>`. JSON responses use `{ "data": ... }`; paginated task lists also include `{ "pagination": { "page", "limit", "total" } }`. Errors use `{ "error": { "code", "message", "details?" } }`. Dates are ISO-8601 values.

### Authentication and profile

| Method | Endpoint | Auth | Purpose |
|---|---|---:|---|
| `POST` | `/auth/register` | No | Register with `name`, `email`, and a password of at least 12 characters and no more than 72 UTF-8 bytes. |
| `POST` | `/auth/login` | No | Login; returns an access token and sets the refresh cookie. |
| `POST` | `/auth/refresh` | Refresh cookie | Rotate refresh session and return a new access token. Send cookies with browser requests (`credentials: "include"`). |
| `POST` | `/auth/logout` | Access token | Revoke the refresh session and clear its cookie. Discard the current access token on the client; access tokens otherwise remain valid until expiry. |
| `GET` | `/users/me` | Yes | Read the current profile. |
| `PATCH` | `/users/me` | Yes | Update `name`. |
| `GET` | `/users/me/projects` | Yes | List projects the user belongs to. |

### Projects and collaboration

| Method | Endpoint | Auth | Purpose |
|---|---|---:|---|
| `POST` | `/projects` | Yes | Create a project; caller becomes owner. |
| `GET` | `/projects/{projectId}` | Member | Read project and member list. |
| `PATCH` | `/projects/{projectId}` | Owner/admin | Update project name or description. |
| `DELETE` | `/projects/{projectId}` | Owner | Delete a project and its tasks. |
| `GET` | `/projects/{projectId}/members` | Member | List project members. |
| `PATCH` | `/projects/{projectId}/members/{memberId}` | Owner | Set a member's role to `ADMIN` or `MEMBER`. |
| `POST` | `/projects/{projectId}/invites` | Owner/admin | Create a seven-day invite for an email address. The response includes a one-time `inviteToken`; deliver it to the invitee over a trusted channel. |
| `POST` | `/projects/invites/accept` | Yes | Accept an invitation using `{ "token": "..." }`; the signed-in email must match the invitation. |
| `DELETE` | `/projects/{projectId}/members/{memberId}` | Owner/admin | Remove a member. Only the owner can remove an administrator; the owner cannot be removed. |

The API does not send invitation email. Integrate a trusted email provider and deliver the one-time token rather than exposing it in a public UI or logs.

### Tasks, comments, and attachments

| Method | Endpoint | Auth | Purpose |
|---|---|---:|---|
| `GET` | `/tasks/assigned` | Yes | List tasks assigned to the caller within projects they still belong to. |
| `POST` | `/projects/{projectId}/tasks` | Member | Create a task. |
| `GET` | `/projects/{projectId}/tasks` | Member | List/filter/search/sort project tasks. |
| `GET`, `PATCH`, `DELETE` | `/projects/{projectId}/tasks/{taskId}` | Member | Read/update a task; creator or project admin may delete it. |
| `GET`, `POST` | `/projects/{projectId}/tasks/{taskId}/comments` | Member | List or add task comments. |
| `GET`, `POST` | `/projects/{projectId}/tasks/{taskId}/attachments` | Member | List attachments or upload multipart field `file`. |
| `GET`, `DELETE` | `/projects/{projectId}/tasks/{taskId}/attachments/{attachmentId}` | Member | Download a private attachment or delete it (uploader, task creator, or project admin). |

Task creation accepts `title` (required), `description`, `dueDate`, `priority` (`LOW`, `MEDIUM`, `HIGH`, `URGENT`), and `assigneeId`. Updates also accept `status` (`OPEN`, `IN_PROGRESS`, `COMPLETED`). Assignments must be to current project members.

Task list query parameters:

- `status`, `priority`, `assigneeId`
- `search` (case-insensitive title and description substring)
- `sortBy`: `createdAt`, `updatedAt`, `dueDate`, or `title`; `order`: `asc` or `desc`
- `page` (starts at 1), `limit` (1–100; default 20)

Attachments are limited by `MAX_UPLOAD_BYTES` and accepted MIME types are PDF, JPEG, PNG, WebP, plain text, and CSV. Files are private and downloads require project membership. MIME type is client-supplied and is not a malware/content scan; production deployments should scan uploads and apply retention/backup policies.

## Operational and security notes

- Apply schema changes only with reviewed Prisma migrations (`npm run db:migrate`); do not use `prisma db push` in production.
- Register/login/auth endpoints are rate limited, as are all API requests. The in-memory limiter does not coordinate across replicas.
- Access tokens are short-lived HS256 JWTs. Refresh tokens are random opaque values; only SHA-256 hashes are stored and refresh is single-use/rotating.
- Account registration does not verify email, and there is no password-reset workflow. Add verified email and a secure reset process before enabling broad public self-registration.
- Configure database TLS, backups, secret rotation, HTTPS, monitoring, and upload scanning at the deployment boundary. No credentials or production secrets belong in Git.
- Optional WebSocket/SSE notifications and generative-AI task descriptions are not included.

## Public GitHub submission

This workspace has not been connected to or published as a GitHub repository. To submit publicly, create a public repository under your GitHub account, generate and commit `package-lock.json` with `npm install`, review the source and secrets, then push this project and provide that repository URL.
