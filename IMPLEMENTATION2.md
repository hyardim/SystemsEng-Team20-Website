# Ambience AI — Implementation Documentation

> Ambience AI is a clinical consultation platform that connects GPs and Specialists via AI-assisted triage. This document explains how each key feature is implemented — which libraries and frameworks are used, how they are wired together, and relevant code snippets to help readers understand the codebase.

---

## Table of Contents

1. [Authentication, Session Management & Security](#1-authentication-session-management--security)
   - 1.1 Password Hashing · 1.2 JWT Token Creation · 1.3 Token Decoding & Verification · 1.4 FastAPI Dependency Injection · 1.5 Auth Cookies · 1.6 Login Flow · 1.7 Email Verification & Password Reset · 1.8 Auth Rate Limiting · 1.9 Profile Management · 1.10 Nginx · 1.11 HTTP Security Headers · 1.12 File Upload Validation · 1.13 Startup Maintenance · 1.14 CORS
2. [Database Connection & ORM Models](#2-database-connection--orm-models)
   - 2.1–2.7 Models & Migrations · **2.8 SQL Indexes, Unique Constraints & Normalisation**
3. [GP Workflow](#3-gp-workflow)
   - 3.1 Creating a Consultation · 3.2 Status Lifecycle · **3.3 Auto-Submit & Async Background Generation**
4. [AI Response Generation & RAG Pipeline](#4-ai-response-generation--rag-pipeline)
   - 4.1 Overview · 4.2 Ingestion Pipeline (NLTK chunking) · 4.3 Retrieval Pipeline · 4.4 Hybrid Search (OR-fallback) · 4.5 RRF · 4.6 LLM Routing · 4.7 Prompt (unified 12-rule) · 4.8 Conversation History (self-anchoring prevention) · 4.9 Retry Worker · 4.10 API Key · 4.11 Query Expansion · 4.12 FilterConfig · 4.13 Canonical Query Rewriting · **4.14 rag_chunks Table & Indexes** · **4.15 RAG Logging & Telemetry**
5. [Real-Time Streaming (SSE)](#5-real-time-streaming-sse)
   - 5.1–5.7 Event bus, endpoint, generation, frontend · **5.8 Replay Buffer & Memory Management**
6. [File Attachment System](#6-file-attachment-system)
   - 6.1–6.3 Upload, storage, file context · **6.4 File Context Truncation & Propagation**
7. [Specialist Review Workflow](#7-specialist-review-workflow)
8. [Notification System](#8-notification-system)
   - 8.1–8.2 Repository, badge · **8.3 Notification Caching Pattern**
9. [Caching Layer](#9-caching-layer)
   - 9.1–9.3 Architecture, cache-aside, invalidation · **9.4 Async-to-Sync Redis Bridge** · **9.5 CacheKeys Namespace**
10. [Audit Logging](#10-audit-logging)
11. [Admin Panel](#11-admin-panel)
12. [Frontend Architecture](#12-frontend-architecture)
    - 12.1 Routing · 12.2 Secure Storage · 12.3 AuthContext · **12.4 API Client & Token Refresh Singleton** · 12.5 Component Structure · 12.6 useChatStream (5-phase) · **12.7 Input Validation & Error Messages** · **12.8 Form, Data & Error State Management**

---

## 1. Authentication, Session Management & Security

### Libraries Used

| Library | Purpose |
|---|---|
| `python-jose` / `PyJWT` | JWT encoding, decoding, and verification |
| `passlib[bcrypt]` | Password hashing and verification using bcrypt |
| `fastapi.security.OAuth2PasswordBearer` | Extracts Bearer token from `Authorization` header |
| `python-multipart` | Parses OAuth2 form data |

### 1.1 Password Hashing

Passwords are never stored in plain text. `passlib` uses bcrypt with an automatically managed cost factor:

```python
# backend/src/core/security.py
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)
```

Password strength is validated before hashing — minimum 8 characters, must contain uppercase, lowercase, digit, and special character.

### 1.2 JWT Token Creation

The system issues two tokens:
- **Access token** — short-lived (minutes), used on every API call
- **Refresh token** — long-lived (days), stored in an HttpOnly cookie, used to issue new access tokens

Both tokens embed `sub` (user email), `role`, `sv` (session version), and `exp` (expiry):

```python
# backend/src/core/security.py
def _encode_token(
    data: dict[str, Any],
    *,
    token_type: str,
    expires_delta: timedelta,
) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode.update({"exp": expire, "type": token_type})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

def create_access_token_for_user(user: User) -> str:
    return create_access_token({
        "sub": user.email,
        "role": user.role.value,
        "sv": user.session_version,    # session version for forced logout
    })

def create_refresh_token_for_user(user: User) -> str:
    return create_refresh_token({
        "sub": user.email,
        "role": user.role.value,
        "sv": user.session_version,
    })
```

Each claim in the token has a distinct purpose:

| Claim | Value | Role |
|---|---|---|
| `sub` | user's email address | **Authentication** — proves who the caller is; used as the DB lookup key on every request |
| `role` | `"gp"` / `"specialist"` / `"admin"` | **Authorization** — read by role-guard dependencies to allow or reject access to protected endpoints without an extra DB query |
| `sv` | integer session version | **Revocation** — on password change or admin deactivation, the DB row's `session_version` is incremented; any token carrying an old `sv` is immediately rejected |
| `type` | `"access"` / `"refresh"` | **Token-type enforcement** — prevents a refresh token from being used in place of an access token (and vice versa) |
| `exp` | UTC timestamp | **Expiry** — access tokens expire after `ACCESS_TOKEN_EXPIRE_MINUTES` (default 30 min); refresh tokens after `REFRESH_TOKEN_EXPIRE_DAYS` (default 7 days) |

The `role` claim means authorization is stateless — the server does not need to re-query the database to check the user's role on every request. The `sv` claim enables instant revocation without a token blocklist: incrementing the counter in the DB is sufficient to invalidate all outstanding tokens for that user.

### 1.3 Token Decoding & Verification

```python
# backend/src/core/security.py
def _decode_token_payload(token: str) -> dict[str, Any]:
    # Raises jwt.JWTError if signature invalid or token expired
    return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])

def _resolve_user_from_token(db: Session, token: str, *, expected_type: str) -> User:
    """Decode JWT, look up user, verify active status and session version."""
    try:
        payload = _decode_token_payload(token)
        email, session_version = _validate_payload(payload, expected_type=expected_type)
    except JWTError as exc:
        raise _credentials_exception() from exc

    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise _credentials_exception()
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")
    # Reject token if session version has been incremented (forced logout)
    if session_version is not None and user.session_version != session_version:
        raise _credentials_exception()
    return user
```

### 1.4 FastAPI Dependency Injection

FastAPI's `Depends` mechanism injects the authenticated user into any protected route:

```python
# backend/src/core/security.py
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

def get_current_user_from_cookie_or_header(
    request: Request,
    db: Session = Depends(get_db),
    bearer_token: str | None = Depends(oauth2_scheme),
) -> User:
    # Enforce Bearer header for mutation requests (CSRF mitigation)
    _enforce_bearer_header_for_unsafe_cookie_auth(request, bearer_token)
    # Token may come from Authorization header OR access cookie
    token = bearer_token or request.cookies.get(settings.ACCESS_COOKIE_NAME)
    if not token:
        raise _credentials_exception()
    return _resolve_user_from_token(db, token, expected_type="access")
```

Role guards are built on top:

```python
# Usage in endpoint files
@router.post("/chats/{id}/review")
def review_chat(
    id: int,
    body: ReviewRequest,
    specialist: User = Depends(get_current_specialist),  # ← role-checked dependency
    db: Session = Depends(get_db),
):
    ...
```

### 1.5 Auth Cookies

On login, both tokens are sent — access token in the JSON body (for API clients) and refresh token as an HttpOnly cookie:

```python
def set_auth_cookies(response: Response, *, access_token: str, refresh_token: str) -> None:
    cookie_common: dict[str, Any] = {
        "httponly": True,
        "secure": settings.COOKIE_SECURE,
        "samesite": settings.COOKIE_SAMESITE,
        "domain": settings.COOKIE_DOMAIN,
        "path": "/",
    }
    response.set_cookie(
        key=settings.ACCESS_COOKIE_NAME,
        value=access_token,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        **cookie_common,
    )
    response.set_cookie(
        key=settings.REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        **cookie_common,
    )
```

### 1.6 Sequence Diagram — Login Flow

```
Browser                  Backend API                  Database
   │                          │                           │
   │  POST /auth/login         │                           │
   │  {email, password}        │                           │
   ├─────────────────────────▶│                           │
   │                          │  SELECT * FROM users      │
   │                          │  WHERE email = ?          │
   │                          ├──────────────────────────▶│
   │                          │◀──────────────────────────┤
   │                          │  bcrypt.verify(password)  │
   │                          │  create_access_token()    │
   │                          │  create_refresh_token()   │
   │                          │  INSERT INTO audit_logs   │
   │                          ├──────────────────────────▶│
   │  200 OK                  │                           │
   │  Body: {access_token}    │                           │
   │  Cookie: refresh_token   │                           │
   │◀─────────────────────────┤                           │
```

### 1.7 Email Verification & Password Reset Flows

**Email verification.** When a new user registers, the backend creates an account in `is_active=True` state but sets `is_email_verified=False`. An email verification token is generated and emailed to the user. Until the user clicks the verification link, the frontend shows a prompt to check their inbox and a "Resend verification email" link. On `POST /auth/verify-email/confirm` with the token, the backend marks `is_email_verified=True` and logs the action. The account is fully functional without verification in the current configuration (the check can be made mandatory via a Pydantic validator on login), but the verification state is recorded for audit purposes and future policy enforcement.

**Password reset.** The forgot-password flow is carefully designed to avoid user enumeration — if the submitted email is not registered, the endpoint still returns the same generic success message ("If that email is registered, a password reset link will be sent shortly") and the same HTTP 200 status. This prevents an attacker from confirming which email addresses have accounts by watching for different responses. The reset token is single-use: after it is consumed on `POST /auth/reset-password/confirm`, the `used_at` timestamp is set and subsequent attempts with the same token are rejected.

**Token security design.** Both token types are one-time secure random values, stored as SHA-256 hashes in the database (not as JWTs):



```python
def generate_secure_token() -> str:
    return secrets.token_urlsafe(32)   # 256 bits of randomness

def _hash_token(token: str, pepper: str) -> str:
    payload = f"{pepper}:{token}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()

def verify_password_reset_token(token: str, token_hash: str) -> bool:
    # Uses hmac.compare_digest to prevent timing attacks
    return hmac.compare_digest(
        _hash_token(token, settings.PASSWORD_RESET_TOKEN_PEPPER),
        token_hash,
    )
```

### 1.8 Auth Endpoint Rate Limiting

The forgot-password and resend-verification endpoints are rate-limited to prevent abuse and enumeration attacks. The implementation uses a **dual-layer** approach — Redis as primary, with an in-process Python `defaultdict` as fallback when Redis is unavailable:

```python
# backend/src/services/auth_service.py
_forgot_password_attempts:      dict[str, list[datetime]] = defaultdict(list)
_resend_verification_attempts:  dict[str, list[datetime]] = defaultdict(list)

def _is_rate_limited(redis_key, attempts_store, *, window_seconds, max_attempts) -> bool:
    # Try Redis first — atomic, survives across process restarts
    redis_limited = _redis_rate_limited(redis_key, window_seconds, max_attempts)
    if redis_limited:
        return True
    # Fall back to in-process store if Redis unavailable
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=window_seconds)
    attempts_store[redis_key] = [t for t in attempts_store[redis_key] if t > cutoff]
    if len(attempts_store[redis_key]) >= max_attempts:
        return True
    attempts_store[redis_key].append(now)
    return False
```

Rate limit configuration (from `settings`):

| Endpoint | Window | Max Attempts |
|---|---|---|
| `POST /auth/forgot-password` | 900 s (15 min) | 5 |
| `POST /auth/resend-verification` | 900 s (15 min) | 5 |

When the limit is exceeded the endpoint returns `429 Too Many Requests` with a message telling the user how long to wait, without revealing whether the email address is registered.

**General API rate limiting — per-scope, per-session buckets.** All other API routes are protected by a sliding-window rate limiter registered as a FastAPI dependency. The important design decision is that the rate limit bucket key is composed of three parts: the endpoint *scope* (e.g. `auth:login`, `auth:refresh`, `chats`), the *subject* (a hash of the bearer token or cookie, or `"anon"` for unauthenticated requests), and the *client IP address*. This means login attempts and chat requests have completely independent counters — hitting the login rate limit does not block a user who is already logged in from using the rest of the application. Without endpoint scoping, a flood of login attempts from a shared IP (e.g. behind a university NAT) could inadvertently throttle all legitimate users on that network. The email hash (not the raw email) is used as part of auth rate limit keys to avoid storing PII in Redis.

### 1.9 Profile Management

Users can update their own profile via `PATCH /auth/profile`:

```python
class ProfileUpdate(BaseModel):
    full_name:    str | None = None
    specialty:    str | None = None    # specialists only
    new_password: str | None = None
    current_password: str | None = None   # required when changing password
```

Password changes require the current password for verification. The new password must pass the same strength requirements enforced on registration. After a successful update the response includes a fresh access token so the frontend does not need to re-authenticate.

### 1.10 Nginx Reverse Proxy

Nginx sits in front of all services and handles TLS termination, HTTP→HTTPS redirection, and request proxying. It is the only container with a public-facing port.

Key configuration decisions:

```nginx
# nginx/nginx.conf

# SSE requires buffering disabled — otherwise Nginx holds chunks until the buffer fills
location /api/chats/ {
    proxy_pass         http://backend:8000;
    proxy_buffering    off;
    proxy_read_timeout 300s;   # keep SSE connections alive for up to 5 minutes
    proxy_set_header   X-Real-IP $remote_addr;
}

# All other API traffic
location /api/ {
    proxy_pass http://backend:8000;
}

# Frontend SPA — serve index.html for all unmatched routes (client-side routing)
location / {
    proxy_pass http://frontend:3000;
    try_files $uri $uri/ /index.html;
}
```

TLS is configured with self-signed certificates generated at container startup via `nginx/docker-entrypoint.d/40-ensure-certs.sh`. Minimum TLS 1.2 is enforced. The HTTP server (port 80) issues a 301 redirect to HTTPS for all requests.

### 1.11 HTTP Security Headers Middleware

The backend applies a set of HTTP security headers to every response via a custom Starlette middleware class. This runs before any route handler and cannot be bypassed by individual endpoints:

```python
# backend/src/middleware/security.py
class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "connect-src 'self'"
        )
        return response
```

The middleware is registered in `main.py` via `app.add_middleware(SecurityHeadersMiddleware)`.

### 1.12 File Upload Validation

File uploads go through a multi-layer validation pipeline before any bytes are written to disk. The purpose of each layer is to catch a different class of attack or misconfiguration.

**Extension allow-list.** The filename extension is checked against a configured set of permitted extensions (e.g. `.pdf`, `.docx`, `.txt`). This rejects obviously wrong file types before reading any content. However, extension alone is not trustworthy — an attacker can rename a file.

**Magic-byte / file signature check.** The first 4 KB of the uploaded content is read and compared against the known binary signatures for each format: PDF files must start with `%PDF-`, DOCX files with the PK ZIP header (`PK\x03\x04`), DOC files with the compound document header (`\xD0\xCF\x11\xE0`), and so on. If the declared extension does not match the actual bytes, the upload is rejected with HTTP 415 (Unsupported Media Type). This prevents content-type confusion attacks where a script is uploaded with a `.pdf` extension.

**Text content heuristic.** For text-based formats (`.txt`, `.md`, `.csv`, `.json`), the first 4 KB is scanned for the proportion of binary control characters. If more than 2% of the sample contains non-text bytes, the file is rejected. A client also cannot declare `application/octet-stream` as the MIME type for a text-format upload.

**Filename sanitisation.** The raw filename from the upload is stripped of any path components (`PurePosixPath(raw).name`) and all characters outside `[A-Za-z0-9._-]` are replaced with underscores. This prevents path traversal attacks and ensures the stored filename is safe to use in filesystem paths.

**Size limit.** The file is streamed in 64 KB chunks to the destination path. If the total bytes written exceeds `MAX_FILE_SIZE_BYTES` (default 3 MB) during the stream, the write is aborted and the partially written file is deleted. The client-side React code also checks file size before uploading and shows an error immediately — but the backend check exists because the frontend can be bypassed.

### 1.13 Application Startup Maintenance

On every backend startup, two maintenance tasks run before the server begins accepting requests. These are registered as part of the FastAPI `lifespan` context manager.

**Purge expired tokens.** Password reset tokens and email verification tokens that are more than 7 days old are deleted from their respective tables. These tokens are single-use and time-limited; leaving them in the database indefinitely wastes space and marginally increases the attack surface. The purge runs inside a `try/except` so a failure does not prevent the server from starting.

**Reset stale generating messages.** If the server shuts down uncleanly (OOM kill, container restart, deployment) while an AI response is being streamed, some `messages` rows may be left with `is_generating=True`. These rows would appear to the frontend as permanently loading, and the specialist would be blocked from reviewing them. On startup, all such rows are updated to `is_generating=False` with the content "Generation interrupted. Please try again." The GP sees a clear message and can ask again; the consultation is not stuck.

### 1.14 CORS Configuration

Cross-Origin Resource Sharing is configured via FastAPI's built-in `CORSMiddleware`, registered in `main.py` before the route router:

```python
# backend/src/app/main.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,     # list of permitted origins
    allow_credentials=True,                      # required for cookie-based auth
    allow_methods=settings.CORS_ALLOW_METHODS,
    allow_headers=settings.CORS_ALLOW_HEADERS,
)
```

The configuration values come from environment variables with safe defaults:

```python
# backend/src/core/config.py
ALLOWED_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:3000"]
CORS_ALLOW_METHODS: list[str] = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
CORS_ALLOW_HEADERS: list[str] = ["Authorization", "Content-Type", "Idempotency-Key"]
```

`allow_credentials=True` is required because the browser sends the HttpOnly refresh-token cookie with cross-origin requests. This setting has a critical constraint: the browser specification prohibits `Access-Control-Allow-Origin: *` when `withCredentials` is true. Wildcard origins would silently break cookie auth in browsers, so `ALLOWED_ORIGINS` must always list explicit origins in production.

The `Idempotency-Key` header is whitelisted because it is sent on generation requests to enable safe retry logic in the RQ worker (see §4.9).

---

## 2. Database Connection & ORM Models

### Libraries Used

| Library | Purpose |
|---|---|
| `SQLAlchemy 2.0` | ORM with declarative typed mapping |
| `alembic` | Schema migration management |
| `psycopg2-binary` | Synchronous PostgreSQL driver |
| `asyncpg` | Asynchronous PostgreSQL driver (used for the AI generation path) |
| `PostgreSQL JSONB` | Native JSON column type for flexible structured data |

### 2.1 Dual-Mode Session Configuration

The application uses **two database sessions** — synchronous for regular API routes, and asynchronous for the AI generation background task (which must not block the event loop):

```python
# backend/src/db/session.py
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

# ── Synchronous engine — all standard API endpoints ──────────────────────────
engine = create_engine(
    DATABASE_URL,
    pool_size=20,        # keep 20 connections warm
    max_overflow=30,     # allow up to 30 extra connections under load
    pool_timeout=30,
    pool_recycle=1800,   # recycle connections every 30 min to avoid stale TCP
    pool_pre_ping=True,  # check liveness before handing connection to a request
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)

def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db          # FastAPI injects this via Depends(get_db)
    except Exception:
        db.rollback()     # auto-rollback on unhandled exception
        raise
    finally:
        db.close()

# ── Async engine — AI generation background task ──────────────────────────────
ASYNC_DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://")

async_engine = create_async_engine(ASYNC_DATABASE_URL, pool_size=20, max_overflow=30,
                                    pool_pre_ping=True)
AsyncSessionLocal = async_sessionmaker(bind=async_engine, expire_on_commit=False)

async def get_async_db() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
```

### 2.2 Declarative Base

All models share a single `Base` class so Alembic can auto-detect schema changes:

```python
# backend/src/db/base.py
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass
```

### 2.3 User Model

```python
# backend/src/db/models/user.py
class UserRole(str, enum.Enum):
    GP         = "gp"
    SPECIALIST = "specialist"
    ADMIN      = "admin"

class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        Index("ix_users_email",    "email"),
        Index("ix_users_role",     "role"),
        Index("ix_users_specialty","specialty"),
    )

    id:                  Mapped[int]             = mapped_column(Integer, primary_key=True)
    email:               Mapped[str]             = mapped_column(String, unique=True, nullable=False)
    hashed_password:     Mapped[str]             = mapped_column(String, nullable=False)
    full_name:           Mapped[str | None]      = mapped_column(String, nullable=True)
    role:                Mapped[UserRole]        = mapped_column(SQLEnum(UserRole), default=UserRole.GP)
    specialty:           Mapped[str | None]      = mapped_column(String, nullable=True)
    is_active:           Mapped[bool]            = mapped_column(Boolean, default=True)
    email_verified:      Mapped[bool]            = mapped_column(Boolean, default=False)
    email_verified_at:   Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    session_version:     Mapped[int]             = mapped_column(Integer, default=0)
    created_at:          Mapped[datetime]        = mapped_column(DateTime, default=utc_now)

    chats:          Mapped[list["Chat"]]         = relationship("Chat", foreign_keys="Chat.user_id")
    assigned_chats: Mapped[list["Chat"]]         = relationship("Chat", foreign_keys="Chat.specialist_id")
    notifications:  Mapped[list["Notification"]] = relationship("Notification", back_populates="user")
```

### 2.4 Chat Model

The `Chat` model drives the entire consultation lifecycle. Key design decisions:

- `status` is a PostgreSQL `ENUM` — prevents invalid values at the database level
- `patient_context` uses `JSONB` — allows flexible patient metadata (age, gender, clinical notes) without additional columns or migrations
- Multiple composite indexes support the most common query patterns (e.g. listing a specialist's assigned chats ordered by `assigned_at`)

```python
# backend/src/db/models/chat.py
class ChatStatus(str, enum.Enum):
    OPEN      = "open"
    SUBMITTED = "submitted"
    ASSIGNED  = "assigned"
    REVIEWING = "reviewing"
    APPROVED  = "approved"
    REJECTED  = "rejected"
    CLOSED    = "closed"
    FLAGGED   = "flagged"
    ARCHIVED  = "archived"

class Chat(Base):
    __tablename__ = "chats"
    __table_args__ = (
        Index("ix_chats_user_id",               "user_id"),
        Index("ix_chats_specialist_id",          "specialist_id"),
        Index("ix_chats_status",                 "status"),
        Index("ix_chats_user_archived_created_at","user_id","is_archived","created_at"),
        Index("ix_chats_status_specialty_created_at","status","specialty","created_at"),
        Index("ix_chats_specialist_status_assigned_at",
              "specialist_id","status","assigned_at"),
    )

    id:              Mapped[int]             = mapped_column(Integer, primary_key=True)
    title:           Mapped[str]             = mapped_column(String, default="New Chat")
    status:          Mapped[ChatStatus]      = mapped_column(SQLEnum(ChatStatus), default=ChatStatus.OPEN)
    specialty:       Mapped[str | None]      = mapped_column(String, nullable=True)
    severity:        Mapped[str | None]      = mapped_column(String, nullable=True)
    patient_context: Mapped[dict | None]     = mapped_column(JSONB, nullable=True)
    specialist_id:   Mapped[int | None]      = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at:     Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_at:     Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_feedback: Mapped[str | None]      = mapped_column(Text, nullable=True)
    is_archived:     Mapped[bool]            = mapped_column(Boolean, default=False)
    user_id:         Mapped[int]             = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))

    owner:    Mapped["User | None"]       = relationship("User", foreign_keys=[user_id])
    specialist: Mapped["User | None"]     = relationship("User", foreign_keys=[specialist_id])
    messages: Mapped[list["Message"]]     = relationship("Message", back_populates="chat",
                                                          cascade="all, delete-orphan")
    files:    Mapped[list["FileAttachment"]] = relationship("FileAttachment",
                                                             cascade="all, delete-orphan")

    @property
    def patient_age(self)    -> Any | None: return (self.patient_context or {}).get("age")
    @property
    def patient_gender(self) -> Any | None: return (self.patient_context or {}).get("gender")
    @property
    def patient_notes(self)  -> Any | None: return (self.patient_context or {}).get("notes")
```

### 2.5 Message Model

```python
# backend/src/db/models/message.py
class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_chat_id",                          "chat_id"),
        Index("ix_messages_sender",                           "sender"),
        Index("ix_messages_chat_created_at",                  "chat_id","created_at"),
        Index("ix_messages_chat_sender_review_created_at",    "chat_id","sender","review_status","created_at"),
    )

    id:              Mapped[int]          = mapped_column(Integer, primary_key=True)
    content:         Mapped[str | None]   = mapped_column(Text)
    role:            Mapped[str | None]   = mapped_column(String, nullable=True)  # legacy column
    sender:          Mapped[str]          = mapped_column(String)   # "user" | "ai" | "specialist"
    created_at:      Mapped[datetime]     = mapped_column(DateTime, default=utc_now)
    citations:       Mapped[list | None]  = mapped_column(JSONB(none_as_null=True), nullable=True)
    is_generating:   Mapped[bool]         = mapped_column(Boolean, default=False, server_default="false")
    is_error:        Mapped[bool]         = mapped_column(Boolean, default=False, server_default="false")
    review_status:   Mapped[str | None]   = mapped_column(String, nullable=True)
    review_feedback: Mapped[str | None]   = mapped_column(Text, nullable=True)
    reviewed_at:     Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    chat_id:         Mapped[int]          = mapped_column(ForeignKey("chats.id"), nullable=False)

    chat: Mapped["Chat | None"] = relationship("Chat", back_populates="messages")
```

`citations` is stored as `JSONB` — each element contains document title, source name, section path, page numbers, and URL. This avoids a separate `citations` table and allows the frontend to render rich citation cards in a single query.

The composite index `(chat_id, sender, review_status, created_at)` supports efficient specialist review queries — e.g. fetching all unreviewed AI messages for a chat in creation order.

`is_error` is set to `True` when RAG generation fails — the error message is still persisted for display, but `build_conversation_history_from_messages()` skips `is_error` messages so they do not pollute the LLM's view of prior conversation turns.

### 2.6 Notification Model

```python
# backend/src/db/models/notification.py
class NotificationType(str, enum.Enum):
    CHAT_ASSIGNED  = "chat_assigned"
    SPECIALIST_MSG = "specialist_msg"
    CHAT_APPROVED  = "chat_approved"
    CHAT_REJECTED  = "chat_rejected"
    CHAT_REVISION  = "chat_revision"

class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_id",             "user_id"),
        Index("ix_notifications_is_read",             "is_read"),
        Index("ix_notifications_user_created_at",     "user_id","created_at"),
        Index("ix_notifications_user_read_created_at","user_id","is_read","created_at"),
    )

    id:         Mapped[int]              = mapped_column(Integer, primary_key=True)
    user_id:    Mapped[int]              = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    type:       Mapped[NotificationType] = mapped_column(SQLEnum(NotificationType))
    title:      Mapped[str]              = mapped_column(String, nullable=False)
    body:       Mapped[str | None]       = mapped_column(String, nullable=True)
    chat_id:    Mapped[int | None]       = mapped_column(ForeignKey("chats.id", ondelete="SET NULL"))
    is_read:    Mapped[bool]             = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime]         = mapped_column(DateTime, default=utc_now)

    user: Mapped["User"]       = relationship("User", back_populates="notifications")
    chat: Mapped["Chat | None"] = relationship("Chat")
```

### 2.7 Database Migrations (Alembic)

Schema changes are applied via Alembic migration scripts. Generating and applying:

```bash
# Auto-detect model changes and create a migration
alembic revision --autogenerate -m "add is_archived to chats"

# Apply all pending migrations
alembic upgrade head
```

Some migrations require raw SQL that cannot be auto-detected — for example, adding the full-text search vector column to the RAG database:

```sql
-- migrations/003_add_text_search_vector.sql
ALTER TABLE rag_chunks
    ADD COLUMN IF NOT EXISTS text_search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;

CREATE INDEX IF NOT EXISTS idx_rag_chunks_text_search
    ON rag_chunks USING GIN (text_search_vector);
```

`GENERATED ALWAYS AS ... STORED` is a PostgreSQL 12+ feature: the column is automatically recomputed by the database engine whenever `text` changes — no application code is needed to maintain it.

**Legacy database detection**

Before running Alembic, `bootstrap.py` inspects the existing schema and detects "unstamped" databases — where backend tables already exist but no `alembic_version` row is present (a sign of a legacy setup pre-dating Alembic). Instead of crashing mid-migration, it fails early with a clear recovery message:

```python
# backend/src/db/bootstrap.py
MANAGED_BACKEND_TABLES = frozenset({
    "audit_logs", "chats", "email_verification_tokens",
    "file_attachments", "messages", "notifications",
    "password_reset_tokens", "users",
})

def _ensure_supported_migration_state() -> None:
    existing = _existing_public_tables()
    managed_present = existing & MANAGED_BACKEND_TABLES
    # If managed tables exist but Alembic has no version stamp → legacy DB
    if managed_present and "alembic_version" not in existing:
        raise RuntimeError(
            "Legacy unstamped database detected. "
            "Run: alembic stamp head  then  alembic upgrade head"
        )
```

### 2.8 SQL Indexes, Unique Constraints & Database Normalisation

**Unique constraints** are enforced at the database level rather than only in application code — this prevents duplicate rows even under concurrent requests that may both pass application-layer validation before either writes.

The most critical unique constraint is on `users.email`:

```sql
-- migration 0001 — users table
sa.UniqueConstraint("email")   -- prevents duplicate accounts at DB level
op.create_index("ix_users_email", "users", ["email"])  -- lookup by email on every auth request
```

The `rag_chunks` table uses a composite unique constraint across three columns to ensure a given chunk (identified by its content hash) can appear at most once per document version:

```sql
CONSTRAINT rag_chunks_unique UNIQUE (doc_id, doc_version, chunk_id)
```

**Normalisation** — the schema follows 3NF. Users, chats, messages, notifications, and file attachments are each in their own table. Foreign keys (`chat_id → chats.id`, `user_id → users.id`, `specialist_id → users.id`) maintain referential integrity. `patient_context` fields on chats are stored in a single JSONB column rather than a separate patient table because they are consultation-specific and never shared across consultations.

**Indexing strategy** — indexes are added in three migration layers, each targeting specific query patterns:

| Migration | What is indexed | Why |
|---|---|---|
| `0001` | `users.email` (unique), PKs on all tables | Email lookup on every auth request |
| `0002` | `chats.user_id`, `.specialist_id`, `.status`, `.specialty`, `.created_at`; `messages.chat_id`, `.sender`, `.created_at`; `audit_logs.user_id`, `.action`, `.timestamp`; `notifications.user_id`, `.is_read` | Avoid full-table scans on the most common single-column filters |
| `0006` | Composite indexes across 2–4 columns | Eliminate sort steps for paginated queries; see table below |

Composite indexes created with `CONCURRENTLY` in migration `0006` (PostgreSQL only), so the migration does not take an exclusive lock on the table while running:

```python
with op.get_context().autocommit_block():
    op.create_index(..., postgresql_concurrently=True)
```

Key composite indexes and the queries they optimise:

| Index | Columns | Query it serves |
|---|---|---|
| `ix_chats_user_archived_created_at` | `user_id, is_archived, created_at` | GP's consultation list (active only, newest first) |
| `ix_chats_status_specialty_created_at` | `status, specialty, created_at` | Specialist queue filtered by specialty |
| `ix_chats_specialist_status_assigned_at` | `specialist_id, status, assigned_at` | Specialist's assigned/reviewing list sorted by assignment date |
| `ix_messages_chat_created_at` | `chat_id, created_at` | Timeline read for a single consultation |
| `ix_messages_chat_sender_review_created_at` | `chat_id, sender, review_status, created_at` | "Latest unreviewed AI message" lookup used in specialist review |
| `ix_messages_chat_sender_generating` | `chat_id, sender, is_generating` | "Is any AI message still generating?" guard on review actions |
| `ix_notifications_user_read_created_at` | `user_id, is_read, created_at` | Unread notification count + dropdown list |
| `ix_audit_logs_action_timestamp` | `action, timestamp` | Admin audit log filtered by action type, sorted by time |

---

## 3. GP Workflow

### Libraries Used

| Library | Purpose |
|---|---|
| `FastAPI` | Route definition, request body parsing, background tasks |
| `Pydantic v2` | Request/response schema validation with automatic error messages |
| `SQLAlchemy` | ORM query building |

### 3.1 Creating a Consultation

A GP creates a consultation by sending a `ChatCreate` payload. FastAPI validates it via Pydantic before the handler runs:

```python
# backend/src/schemas/chat.py
class ChatCreate(BaseModel):
    title:           str       = Field(..., min_length=1, max_length=200)
    specialty:       str | None = None
    severity:        str | None = None
    patient_context: dict | None = None    # {age, gender, notes}
    message:         str       = Field(..., min_length=1, max_length=10_000)
```

The service creates the chat row, the first message row, and schedules AI generation as a FastAPI `BackgroundTask` so the HTTP response returns immediately:

```python
# backend/src/services/chat_service.py
def create_chat(db: Session, user: User, data: ChatCreate) -> ChatResponse:
    chat = chat_repository.create(
        db,
        user_id=user.id,
        title=data.title,
        specialty=data.specialty,
        severity=data.severity,
        patient_context=data.patient_context,
        status=ChatStatus.SUBMITTED,
    )
    message_repository.create(
        db,
        chat_id=chat.id,
        content=data.message,
        sender="user",
    )
    audit_repository.log(
        db, user_id=user.id, action="CREATE_CHAT",
        details=f"Chat {chat.id} created",
    )
    # AI generation runs in the background — does not block this response
    asyncio.ensure_future(
        _async_generate_ai_response(chat.id, user.id, data.message)
    )
    return chat_to_response(chat)
```

### 3.2 Consultation Status Lifecycle

Status transitions are enforced at the service layer throughout the consultation lifecycle. The full state machine is:

```
OPEN ──────────────▶ SUBMITTED ──────────▶ ASSIGNED ──────────▶ REVIEWING
                          ▲                    │                     │
                          │                    │ (unassign)          │
                          └────────────────────┘                     │
                                                          ┌──────────┴──────────┐
                                                          ▼                     ▼
                                                       APPROVED              REJECTED
                                                          │
                                                          ▼
                                                       ARCHIVED  (soft-deleted by admin)
```

Additional status values defined in the enum:
- `CLOSED` — reserved for consultations closed by the GP before specialist review
- `FLAGGED` — reserved for admin moderation use cases
- `ARCHIVED` — soft-deleted; hidden from normal queries via `is_archived=True` flag but retained in the database for audit purposes

### 3.3 Auto-Submit & Async Background Generation

**Auto-submit on first GP message.** When a GP sends a message to a chat that is still in `OPEN` status, `async_send_message` detects this and automatically transitions the chat to `SUBMITTED` before triggering AI generation:

```python
# backend/src/services/chat_service.py
if chat.status == ChatStatus.OPEN:
    await chat_repository.async_update(db, chat, status=ChatStatus.SUBMITTED)
    await audit_repository.async_log(
        db, user_id=user.id, action="AUTO_SUBMIT_FOR_REVIEW",
        details=f"Chat {chat_id} auto-submitted after first GP message",
    )
```

This removes the need for a separate "Submit for Review" step. The GP writes their question and gets a response — the submission happens automatically. A manual `POST /chats/{id}/submit` endpoint still exists for cases where a GP wants to explicitly submit after some preparatory activity, but in practice the auto-submit path is how nearly all consultations enter the pipeline.

**Background AI generation via `asyncio.create_task`.** AI generation is decoupled from the HTTP response path entirely. After the user message is persisted and the auto-submit status transition is committed, the service fires an asyncio task and returns immediately:

```python
task = asyncio.create_task(
    _async_generate_ai_response(chat.id, user.id, content),
    name=f"ai-gen-chat-{chat.id}",
)
task.add_done_callback(_on_generation_task_done)
```

The HTTP response reaches the browser in milliseconds — the GP does not wait for the LLM. The `_on_generation_task_done` callback logs any unhandled exception from the background task so generation failures surface in server logs even though no synchronous caller is waiting for the result.

**Concurrency guard.** The background task begins by querying whether any message for this chat already has `is_generating=True`. If one exists, the new task returns immediately without creating a second placeholder or calling the RAG service. This prevents duplicate AI responses when a client retries the send-message request (e.g. because the first HTTP response was lost in transit but the task had already started).

**`INLINE_AI_TASKS` flag.** In test environments, the `INLINE_AI_TASKS` setting causes the generation to run synchronously within the same request cycle instead of as a background task. This means test assertions can inspect the AI message immediately after the send-message call returns, without needing to await background work.

---

## 4. AI Response Generation & RAG Pipeline

### Libraries Used (RAG Service)

| Library | Purpose |
|---|---|
| `sentence-transformers` (`all-MiniLM-L6-v2`) | Embeds queries into 384-dimensional vectors |
| `pgvector` | PostgreSQL extension for cosine similarity vector search |
| `cross-encoder/ms-marco-MiniLM-L-6-v2` | Cross-encoder model for reranking retrieved chunks |
| `httpx` | Async HTTP client for streaming from Ollama |
| `pdfplumber` | PDF text extraction for uploaded file context |

### 4.1 Overview of Generation Flow

When a GP submits a consultation, the backend schedules an async background task that calls the RAG service and streams the result back via SSE:

```
GP submits message
        │
        ▼
Backend: _async_generate_ai_response(chat_id, user_id, content)
        │
        ├── 1. Concurrency guard (skip if already generating)
        ├── 2. Create placeholder Message (is_generating=True)
        ├── 3. Publish SSE "stream_start" event
        ├── 4. POST /answer to RAG service (streaming)
        │         │
        │         └── RAG 8-stage pipeline (see §5.2)
        │
        ├── 5. For each token: publish SSE "content" event
        ├── 6. Finalise Message (content, citations, is_generating=False)
        └── 7. Publish SSE "complete" event → browser renders full response
```

### 4.2 Document Ingestion Pipeline

Before any retrieval can happen, clinical guidelines must be indexed. The ingestion pipeline in `rag_service/src/ingestion/pipeline.py` processes each PDF through 8 sequential stages. Every stage is wrapped in a `try/except` that raises `PipelineError(stage, path, message)`, so failures are attributed to the exact stage that caused them. When `write_debug_artifacts=True`, each stage's output is serialised to `data/debug/<doc_id>/<stage>.json` for inspection.

```
EXTRACT → CLEAN → SECTION → TABLE → METADATA → CHUNK → EMBED → STORE
```

**Stage 1 — EXTRACT** (`ingestion/extract.py`)

Reads raw text from the source file. Supports PDF (PyPDF2), DOCX (python-docx), and plain text. The output is a `RawDocument` dict containing a list of pages, each with raw text and page number.

**Stage 2 — CLEAN** (`ingestion/clean.py`)

Normalises the raw text: collapses excessive whitespace, strips running headers/footers, and removes control characters. Preserves paragraph breaks.

**Stage 3 — SECTION** (`ingestion/section_detect.py`)

Detects section boundaries by scanning for heading patterns (numbered headings, ALL-CAPS lines, markdown-style `#` headings). Each text block is tagged with a `section_path` (e.g. `["3", "3.2", "Management"]`) used downstream for grouping and citations.

**Stage 4 — TABLE** (`ingestion/table_detect.py`)

Identifies tabular content and converts it to structured plain text. Table blocks are flagged `content_type="table"` so the chunker treats them as atomic — each table becomes exactly one chunk regardless of size.

**Stage 5 — METADATA** (`ingestion/metadata.py`)

Attaches document-level metadata from `configs/sources.yaml`: source name, specialty, doc type, author organisation, publish date, and source URL. Derives a stable `doc_id` from the source name and file path. This is when the `doc_id` is first known, so debug artifacts written before this stage use a temporary MD5-based directory name and are renamed in `_backfill_debug_artifacts()`.

**Stage 6 — CHUNK** (`ingestion/chunk.py`)

Splits the document into embedding-ready chunks using sentence-aligned boundaries:

```python
# ingestion/chunk.py
MIN_CHUNK_TOKENS  = 300
MAX_CHUNK_TOKENS  = 800
OVERLAP_TOKENS    = 80
SHORT_SECTION_TOKENS = 150   # sections smaller than this are merged with the next
MAX_MERGE_SECTIONS   = 2     # maximum number of sections to merge
```

**Why sentence-aligned chunking?** A naive character or token split cuts chunks at arbitrary positions, potentially separating a clinical recommendation from its qualifying condition — for example, splitting "Start aspirin 75 mg daily" from "unless the patient has a contraindication to NSAIDs" onto different chunks. When the LLM receives the first half without the second, the answer is clinically wrong. By splitting only at sentence boundaries detected by NLTK's `sent_tokenize`, every chunk contains only complete, independently meaningful clinical sentences.

**Why NLTK rather than a simple period split?** Medical text contains abbreviations that a period-split would incorrectly break on: "Dr.", "e.g.", "Fig.", "vs.", "approx.", "No." (recommendation number). NLTK's Punkt tokenizer is pre-trained on large text corpora and handles these abbreviations correctly. The `punkt` and `punkt_tab` resources must be present in the container; the code raises a `RuntimeError` at startup if either is missing rather than silently producing malformed chunks.

**Why overlap?** If a clinically relevant sentence spans the very end of one chunk and the very beginning of the next, neither chunk alone contains the full context. The 80-token overlap takes the tail sentences from the previous chunk and prepends them to the next one. This means the same content appears twice in the index — once at the end of chunk N and once at the start of chunk N+1 — but any query that is semantically close to that content will retrieve at least one complete copy.

**Cross-section overlap** — Overlap is now also carried across section boundaries. After finishing a section group, `chunk_section_group` takes the last 3 sentence-block pairs from that group and runs them through `_compute_overlap()`, passing the result into the next section. This ensures that clinical content sitting at a section boundary (e.g. a recommendation that straddles a numbered heading) is not split without context. The previous behaviour reset overlap to `[]` at every section boundary; this caused retrieval misses for short sections immediately followed by critical content.

The process per section group:
1. Table blocks → one chunk each (atomic, never split — tables lose meaning if truncated mid-row)
2. Text blocks grouped by identical `section_path`
3. Short sections (<150 tokens) merged with the following group (up to 2 merges) — a tiny section on its own would produce a chunk too sparse to retrieve reliably
4. Remaining text split into sentence-aligned chunks using NLTK `sent_tokenize`
5. 80-token overlap carried forward into the next chunk, including across section boundaries (last 3 sentences of the previous section seed the next)
6. Oversized single sentences (>800 tokens) are emitted as their own chunk to avoid getting stuck

Each chunk gets a stable `chunk_id`:

```python
def generate_chunk_id(doc_id: str, doc_version: str, text: str) -> str:
    hash_input = f"{doc_id}|{doc_version}|{text}"
    return hashlib.sha256(hash_input.encode()).hexdigest()[:16]
```

**Stage 7 — EMBED** (`ingestion/embed.py`)

Generates L2-normalised dense vectors for each chunk using a `SentenceTransformer` model. Chunks are processed in batches of 32 with retry logic:

```python
EMBEDDING_BATCH_SIZE = 32
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0   # seconds; wait = 2^attempt before each retry
```

If a batch fails after all retries, the embedder falls back to per-chunk embedding. Chunks that still fail are quarantined with `embedding_status="failed"` and excluded from storage — they do not block the rest of the document.

**Stage 8 — STORE** (`ingestion/store.py`)

Persists successful chunks to the pgvector database. Before inserting, **all existing chunks for the `doc_id` are deleted** to prevent orphaned rows from prior versions whose chunk IDs may differ. Each chunk is then upserted using a per-chunk savepoint for partial-failure safety:

```python
# ingestion/store.py — upsert logic (simplified)
cur.execute("DELETE FROM rag_chunks WHERE doc_id = %s", (doc_id,))

for chunk in eligible:   # only embedding_status="success" chunks
    _begin_savepoint(conn, chunk_id)
    action = _upsert_chunk(conn, chunk, doc_id, doc_version)
    # "inserted"  — new chunk
    # "updated"   — text or metadata changed
    # "skipped"   — identical to existing row
    _release_savepoint(conn, chunk_id)
```

The store returns a report `{inserted, updated, skipped, failed}` which propagates all the way up to the CLI and the Admin → RAG Status page.

**Running ingestion**

Documents can be ingested via the Admin Panel UI (`/admin/guidelines`) or via the CLI for bulk operations:

```bash
# Inside the rag_service container
python -m src.ingestion.cli ingest \
  --input /data/guidelines \
  --source-name "NICE Guidelines" \
  --dry-run              # parse, chunk, embed — but skip DB writes
  --since 2026-01-01     # only process files modified after this date
  --write-debug-artifacts  # dump per-stage JSON to data/debug/
```

The `run_ingestion()` function discovers PDFs (sorted oldest-first by mtime), runs `run_pipeline()` per file, and returns a summary report aggregating counts across all files.

### 4.3 The RAG Retrieval Pipeline (8 Stages)

The `retrieve()` function in `rag_service/src/retrieval/retrieve.py` runs a structured 8-stage pipeline. Each stage is timed, logged, and its output is optionally written to disk for debugging:

```python
# rag_service/src/retrieval/retrieve.py
def retrieve(
    query: str,
    db_url: str,
    top_k: int = 5,
    specialty: str | None = None,
    score_threshold: float = 0.3,
    expand_query: bool = False,
) -> list[CitedResult]:

    # Stage 1: Query processing — normalise and optionally expand query with synonyms
    processed = process_query(query, expand=expand_query)

    # Stage 2: Vector search — cosine similarity using pgvector
    vector_results = vector_search(
        query_embedding=processed.embedding,
        db_url=db_url,
        top_k=top_k * 4,        # over-fetch so later stages have candidates to prune
        specialty=specialty,
    )

    # Stage 3: Keyword search — BM25 via PostgreSQL tsvector (with graceful fallback)
    try:
        keyword_results = keyword_search(query=processed.expanded, db_url=db_url,
                                          top_k=top_k * 4, specialty=specialty)
    except Exception as e:
        logger.warning(f"KEYWORD_SEARCH failed — falling back to vector only: {e}")
        keyword_results = []

    # Stage 4: Reciprocal Rank Fusion — merge the two ranked lists
    fused = reciprocal_rank_fusion(vector_results=vector_results,
                                    keyword_results=keyword_results)

    # Stage 5: Filter — 3-tier fallback (see filter_chunks below)
    filtered = filter_chunks(query=query, retrieved=fused)
    if not filtered:
        return []   # no evidence response

    # Stage 6: Rerank — cross-encoder scores each (query, chunk) pair
    reranked = rerank(query=query, results=filtered, top_k=top_k * 2)

    # Stage 7: Deduplicate — remove near-identical chunks
    deduped = deduplicate(reranked)

    # Stage 8: Assemble citations — attach rich metadata to each result
    return assemble_citations(deduped[:top_k])
```

**Why two search methods?** Vector search captures semantic similarity (finds relevant content even when different words are used), while keyword search is better for exact clinical terms, drug names, and guideline codes. Combining them via RRF consistently outperforms either method alone.

**Stage 5 detail — `filter_chunks` 3-tier fallback**

`filter_chunks` in `rag_service/src/api/services.py` applies a staged fallback so that valid clinical queries are not silently dropped when strict lexical matching fails:

```python
MIN_RELEVANCE            = 0.25   # absolute floor — boilerplate and noise gate
HIGH_CONFIDENCE_RELEVANCE = 0.72  # tier 1 upper threshold
SOFT_FALLBACK_RELEVANCE   = 0.55  # tier 2 threshold
LOW_SCORE_FALLBACK_FLOOR  = 0.04  # tier 3 absolute minimum
LOW_SCORE_FALLBACK_RATIO  = 0.85  # tier 3 = max(floor, top_score × ratio)
```

All chunks first pass a base gate: score ≥ `MIN_RELEVANCE`, has a source identifier, and is not boilerplate (checked via `is_boilerplate()` against known header/footer patterns). Then:

| Tier | Condition | Purpose |
|---|---|---|
| **1 — strict** | lexical overlap with query tokens OR score ≥ 0.72 | Standard path; `has_query_overlap()` requires ≥1 shared token of length ≥ 3 (3-char minimum allows clinical abbreviations like `AF`, `BP`, `MI`) |
| **2 — semantic** | score ≥ 0.55 | Catches semantically relevant chunks when query uses synonyms or paraphrasing not present verbatim in the guideline |
| **3 — low-score** | score ≥ max(0.04, top\_score × 0.85) | Last resort; returns the best available evidence rather than an empty response — still requires lexical overlap and non-boilerplate |

Each tier is only attempted if the previous one returned nothing. This change fixed queries that previously returned the "no guideline passage found" error despite relevant content existing in the index.

### 4.4 Hybrid Search: Vector + Keyword

**Vector search** uses pgvector's `<=>` cosine distance operator:

```sql
-- Finds chunks whose embeddings are closest to the query embedding
SELECT chunk_id, text, metadata,
       1 - (embedding <=> $1) AS score   -- cosine similarity (0 to 1)
FROM rag_chunks
WHERE 1 - (embedding <=> $1) > 0.0
ORDER BY embedding <=> $1               -- ascending distance = descending similarity
LIMIT $2;
```

**Keyword search** uses PostgreSQL's built-in `tsvector` full-text search, enabled by the migration that adds a generated `text_search_vector` column:

```sql
-- Finds chunks matching the query's key terms
SELECT chunk_id, text, metadata,
       ts_rank(text_search_vector, plainto_tsquery('english', $1)) AS rank
FROM rag_chunks
WHERE text_search_vector @@ plainto_tsquery('english', $1)
ORDER BY rank DESC
LIMIT $2;
```

The `text_search_vector` column is a PostgreSQL **generated column** maintained automatically by the database engine:

```sql
ALTER TABLE rag_chunks
    ADD COLUMN text_search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
```

**OR-query fallback:** When a long clinical query returns zero rows from the strict AND search (`plainto_tsquery`), the keyword search automatically falls back to an OR-style query built from the top-N non-stopword terms. This prevents retrieval starvation on multi-clause clinical questions where the AND conjunction finds nothing despite relevant chunks existing.

### 4.5 Reciprocal Rank Fusion

RRF combines two ranked lists by position rather than by normalised score — making it robust to the incompatible score scales of cosine similarity (0–1) and BM25 `ts_rank`:

```python
# rag_service/src/retrieval/fusion.py
def reciprocal_rank_fusion(
    vector_results: list[VectorSearchResult],
    keyword_results: list[KeywordSearchResult],
    k: int = 60,      # constant that dampens advantage of top positions
    top_k: int = 20,
) -> list[FusedResult]:
    """
    For each chunk in either list: rrf_score += 1 / (k + rank)
    Chunks appearing in both lists accumulate scores from both.
    """
    rrf_scores: dict[str, float] = {}
    chunk_data:  dict[str, dict] = {}

    for rank, vr in enumerate(vector_results, start=1):
        rrf_scores[vr.chunk_id] = rrf_scores.get(vr.chunk_id, 0.0) + 1.0 / (k + rank)
        chunk_data[vr.chunk_id] = {"doc_id": vr.doc_id, "text": vr.text,
                                    "metadata": vr.metadata}

    for rank, kr in enumerate(keyword_results, start=1):
        rrf_scores[kr.chunk_id] = rrf_scores.get(kr.chunk_id, 0.0) + 1.0 / (k + rank)
        if kr.chunk_id not in chunk_data:
            chunk_data[kr.chunk_id] = {"doc_id": kr.doc_id, "text": kr.text,
                                        "metadata": kr.metadata}

    fused = [
        FusedResult(chunk_id=cid, rrf_score=score,
                    vector_score=vector_scores.get(cid), **chunk_data[cid])
        for cid, score in rrf_scores.items()
    ]
    fused.sort(key=lambda r: r.rrf_score, reverse=True)
    return fused[:top_k]
```

A chunk that ranks 3rd in vector search and 5th in keyword search accumulates `1/(60+3) + 1/(60+5) = 0.0159 + 0.0154 = 0.0313`, outranking a chunk that only appears in one list at rank 1 with `1/(60+1) = 0.0164`.

### 4.6 LLM Provider Routing

The routing system scores each request across four dimensions and selects either the local Ollama model or a cloud LLM:

```python
# rag_service/src/generation/router.py
def select_generation_provider(
    *,
    query: str,
    retrieved_chunks: list[dict],
    severity: str | None = None,
    is_revision: bool = False,
    prompt_length_chars: int | None = None,
    threshold: float | None = None,
) -> RouteDecision:
    score = 0.0
    reasons: list[str] = []

    # Dimension 1: Query complexity (length + clinical terminology)
    complexity_score, c_reasons = _score_complexity(query)
    score += complexity_score; reasons.extend(c_reasons)

    # Dimension 2: Prompt size (longer prompt benefits from larger context window)
    prompt_score, p_reasons = _score_prompt_size(prompt_length_chars)
    score += prompt_score; reasons.extend(p_reasons)

    # Dimension 3: Clinical risk (urgent severity or risk-related terms)
    risk_score, r_reasons = _score_risk(query, severity)
    score += risk_score; reasons.extend(r_reasons)

    # Dimension 4: Retrieval ambiguity (low scores = uncertain evidence = prefer cloud)
    ambiguity_score, a_reasons = _score_ambiguity(retrieved_chunks)
    score += ambiguity_score; reasons.extend(a_reasons)

    resolved_threshold = threshold or routing_config.llm_route_threshold
    score = min(score, 1.0)
    provider = "cloud" if score >= resolved_threshold else "local"

    # If cloud is unavailable (invalid API key/URL), always fall back to local
    if provider == "cloud" and not _cloud_available():
        reasons.append("cloud_unavailable")
        provider = "local"

    return RouteDecision(provider=provider, score=round(score, 3),
                         threshold=resolved_threshold, reasons=tuple(reasons))
```

Scoring details:
- **Long query** (≥240 chars): +0.18; **Medium** (≥140 chars): +0.10
- **Urgent severity**: +0.30; **Emergency**: +0.40
- **Low top retrieval score** (<0.35): +0.22 (evidence is weak, cloud may do better)
- **Long prompt** (≥`long_prompt_chars` config): +0.70

Setting `LLM_ROUTE_THRESHOLD=1.1` in `.env` forces all requests to local Ollama since the score can never exceed 1.0.

### 4.7 Prompt Construction & Injection Protection

All user-supplied text is sanitised before insertion into the prompt:

```python
# rag_service/src/generation/prompts.py
_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?previous\s+instructions", re.IGNORECASE),
    re.compile(r"^system\s*:",  re.IGNORECASE | re.MULTILINE),
    re.compile(r"^assistant\s*:", re.IGNORECASE | re.MULTILINE),
    re.compile(r"<\|?(system|im_start|im_end)\|?>", re.IGNORECASE),
    re.compile(r"\[INST\]|\[/INST\]", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(a|an|in)\b", re.IGNORECASE),
    # ... more patterns
]

def _sanitize_input(text: str, *, max_length: int = 10_000) -> str:
    # Strip ASCII control characters (except newline \n and tab \t)
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    # Remove prompt injection patterns
    for pattern in _INJECTION_PATTERNS:
        cleaned = pattern.sub("", cleaned)
    # Collapse excessive whitespace left by removals
    cleaned = re.sub(r"[ \t]{3,}", "  ", cleaned)
    return cleaned[:max_length].strip()
```

The final prompt is assembled from sanitised sections using a single unified prompt template (previously two variants; collapsed after A/B testing showed the multi-mode approach caused false disclaimers and clinical errors):

```python
def build_grounded_prompt(question, chunks, patient_context=None,
                           file_context=None, ...) -> str:
    question      = _sanitize_input(question)
    context_block = _format_context(question, chunks)   # numbered [1][2]... references
    patient_block = _format_patient_context(patient_context)

    parts = [_INSTRUCTIONS]                # unified 12-rule instruction block
    if patient_block:
        parts.append(patient_block)        # PATIENT CONTEXT section
    parts.append("Context:\n" + (context_block or "(none)"))
    if file_context:
        parts.append(f"UPLOADED DOCUMENTS\n{_sanitize_input(file_context)}")
    parts += [f"Question: {question}", "Answer (with citations):"]
    return "\n\n".join(parts)
```

The unified `_INSTRUCTIONS` block contains 12 rules. The most clinically significant are:

- **Rule 4** — Do not echo guideline recommendation numbers (e.g. 1.1.2) — state clinical content instead.
- **Rule 7** — Aim for 4–8 sentences; keep answers concise and practical.
- **Rule 10** — If context is insufficient, say so briefly rather than guessing.
- **Rule 11 (Emergency override)** — If the query involves neutropenic sepsis, cauda equina syndrome, or acute cord compression, always begin with `"Immediate action:"` and state same-day emergency admission or 999. These presentations must never be described as benign.
- **Rule 12 (TIA accuracy)** — A TIA resolves completely by definition. The model is explicitly prohibited from writing that TIA symptoms "persist for at least 24 hours" or cause "persistent deficits" (which describes stroke).

For revisions, `build_revision_prompt()` extends the same `_INSTRUCTIONS` block with the original question, previous answer, and specialist feedback, plus three additional revision rules (address all feedback points, no fabrication, stay concise).

### 4.8 Conversation History in RAG Context

For follow-up messages in the same consultation, prior turns are included in the RAG request so the model can answer in context. The backend builds a compact conversation transcript from the message history before calling the RAG service:

```python
# backend/src/services/rag_context.py
CHAT_HISTORY_TOKEN_BUDGET   = 2_000   # ~8 000 chars at 4 chars/token estimate
CHAT_HISTORY_MESSAGE_LIMIT  = 20      # cap at last 20 messages

def build_conversation_history_from_messages(messages, *, limit, token_budget) -> str | None:
    char_budget = token_budget * 4
    history_lines = []
    total_chars = 0
    # Walk backwards to keep the most recent messages within budget
    for message in reversed(messages[-limit:]):
        if not message.content or message.is_error:
            continue
        speaker = {"user": "GP", "specialist": "Specialist", "ai": "AI"}.get(
            message.sender, message.sender.title()
        )
        line = f"{speaker}: {message.content.strip()}"
        if total_chars + len(line) + 1 > char_budget and history_lines:
            break
        history_lines.append(line)
        total_chars += len(line) + 1

    history_lines.reverse()   # restore chronological order
    return "\n".join(history_lines) if history_lines else None
```

The transcript is injected into `patient_context["conversation_history"]` and forwarded to the RAG service, where the prompt builder includes it as context before the current question. `is_error` messages are excluded so failed generation attempts do not appear in the model's view of the conversation.

**AI messages are deliberately excluded from conversation history.** Only messages with `sender == "user"` or `sender == "specialist"` are included — AI-generated responses are skipped entirely. The code comment explains the reasoning: "reduces self-anchoring where the model can be biased by its own earlier output instead of the retrieved evidence." If prior AI answers were included, the model would tend to paraphrase and repeat its previous response rather than re-grounding on the current retrieval results. By providing only the clinician's questions and the specialist's comments, each generation is forced to rely on fresh retrieved evidence, which produces more accurate and up-to-date answers when the retrieval results differ from what a prior generation said.

**Token budget estimation.** The budget is expressed as a token count (2,000) and converted to characters using the constant `_CHARS_PER_TOKEN_ESTIMATE = 4`. This "4 characters per token" is a widely-used approximation for English medical text with a cl100k tokenizer. It avoids the overhead of actually calling the tokenizer on every message in the history, while staying conservative enough to prevent prompt overflow in practice.


### 4.9 Generation Retry Worker (RQ)

Failed RAG generation jobs are not silently dropped. The system uses **RQ (Redis Queue)** with a dedicated `rag_worker` Docker container to retry transiently failed jobs:

```python
# rag_service/src/jobs/retry.py
from rq import Queue, Retry
from redis import Redis

ingest_queue = Queue("ingest", connection=Redis.from_url(REDIS_URL))

def enqueue_generation(chat_id: str, idempotency_key: str):
    ingest_queue.enqueue(
        run_generation_job,
        chat_id,
        idempotency_key=idempotency_key,
        retry=Retry(max=3, interval=[10, 30, 60]),   # 10s, 30s, 60s back-off
    )
```

The backend sets the chat's `generation_id` (a UUID per SSE stream) as the idempotency key, so if the SSE connection drops and the client retries, the second call returns the cached result rather than triggering a second LLM call. Failed jobs after max retries are moved to RQ's `failed` queue and surfaced in the Admin → RAG Status page. Telemetry for each attempt is appended to `/logs/retry_metrics.jsonl`.

### 4.10 Inter-Service Authentication (Internal API Key)

The RAG service should not be publicly reachable. In addition to Docker network isolation, all RAG endpoints are protected by an internal API key passed via `X-Internal-API-Key` header:

```python
# rag_service/src/core/security.py
INTERNAL_API_KEY = os.environ.get("RAG_INTERNAL_API_KEY", "")

async def verify_internal_api_key(
    x_internal_api_key: str = Header(alias="X-Internal-API-Key"),
):
    if not INTERNAL_API_KEY or x_internal_api_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="Forbidden")
```

The backend sets the same key as `RAG_INTERNAL_API_KEY` and injects it into every `httpx` request to the RAG service. The `/health` endpoint is excluded so uptime monitoring works without credentials.

### 4.11 Query Expansion with Medical Term Mapping

Before the query reaches the retrieval engine, the backend expands abbreviations and synonyms to improve recall:

```python
# backend/src/services/rag_context.py
MEDICAL_TERM_EXPANSION = {
    "hba1c": "glycated haemoglobin HbA1c",
    "bp": "blood pressure hypertension",
    "mi": "myocardial infarction heart attack",
    "af": "atrial fibrillation",
    "uti": "urinary tract infection",
    # ... ~50 entries
}

def expand_query(query: str) -> str:
    lower = query.lower()
    expansions = [exp for abbrev, exp in MEDICAL_TERM_EXPANSION.items()
                  if re.search(r'\b' + re.escape(abbrev) + r'\b', lower)]
    return query + " " + " ".join(expansions) if expansions else query
```

The expanded query is used only for vector similarity search. The original query is preserved for the LLM prompt so the model sees exactly what the GP wrote.

### 4.12 Specialty-Scoped Retrieval (FilterConfig)

The RAG `/ask` endpoint accepts an optional `FilterConfig` to restrict retrieval to specific sources or documents — enabling future specialty-scoped retrieval (e.g. cardiology guidelines only) without changing the embedding model:

```python
# rag_service/src/models/schemas.py
class FilterConfig(BaseModel):
    source_names: list[str] | None = None   # restrict to named sources
    doc_ids:      list[str] | None = None   # restrict to specific documents
    min_score:    float | None = None       # override minimum similarity threshold
```

If omitted, all indexed documents are searched.

### 4.13 Canonical Query Rewriting

Before vector search runs, the query is checked against a set of known clinical patterns. If matched, it is replaced with a precisely worded canonical retrieval query designed to hit the exact guideline passages that answer the GP's question. This addresses the gap between how GPs phrase questions and how guideline text is indexed.

```python
# rag_service/src/api/canonicalization.py
def build_canonical_retrieval_query(
    *, query: str, specialty: str | None, allowed_specialties: set[str]
) -> str | None:
    """Return a canonical query if a specialty rule fires; None otherwise."""
    ...
```

Four canonical patterns are currently implemented:

| Trigger | Canonical query replaces GP phrasing with |
|---|---|
| Rheumatology — multi-joint persistent synovitis with referral intent | "Adult with suspected persistent synovitis… investigations before urgent rheumatology referral…" |
| Rheumatology — SLE with renal involvement | "Adult with known SLE and new proteinuria… lupus nephritis investigations and specialist referral…" |
| Neurology — gait apraxia + urinary + cognitive decline (NPH) | "Adult with gait apraxia, urinary symptoms, cognitive decline, ventriculomegaly…" |
| Neurology — sudden vertigo + focal deficit | "Adult with sudden-onset dizziness and focal neurological deficit… stroke pathways." |

Each pattern uses a set of regex hints (swelling, multi-joint, chronicity, investigations, referral intent, etc.) with all hints required to fire — keeping false-positive rate near zero. If the canonical query fires, it is used for retrieval only; the original GP question is still sent to the LLM.

### 4.14 rag_chunks Table Structure & Indexes

The `rag_chunks` PostgreSQL table is the central storage layer for the RAG pipeline. Understanding its structure and indexes is key to understanding retrieval performance.

**Table schema.** Each row represents one chunk of a clinical guideline. The `doc_id` and `doc_version` together identify which document version the chunk came from. The `chunk_id` is a 16-character SHA-256 hash of the document ID, version, and chunk text — this makes it stable across re-ingestions (the same content always produces the same ID) and enables the upsert strategy in the store stage. The `embedding` column holds a 384-dimensional vector — the dense numerical representation of the chunk's meaning produced by the SentenceTransformer model. The `metadata` JSONB column holds the full citation: source name, section path, page range, publish date, and source URL.

The composite unique constraint `UNIQUE (doc_id, doc_version, chunk_id)` enforces that a given chunk of text can appear at most once per document version. This is the technical foundation that makes the delete-before-insert upsert safe: the constraint prevents duplicate rows even if the store stage is interrupted and retried.

**HNSW vector index.** Exact nearest-neighbour search over 384-dimensional vectors at scale is computationally prohibitive — comparing a query vector against every row is O(n). The Hierarchical Navigable Small World (HNSW) index solves this with an approximate nearest-neighbour data structure. HNSW builds a layered graph where each node (chunk) is connected to its closest neighbours at each layer. A query traverses the top layer first (coarse navigation), then descends to lower layers for progressively finer search — similar to how a binary search narrows the range on each step. The result is sub-linear query time with high recall. Two key parameters control the quality-versus-speed tradeoff:

- `m = 16`: each node in the graph has 16 bidirectional connections. Higher values improve recall but increase index memory and build time.
- `ef_construction = 64`: the number of candidate neighbours evaluated when building the graph. Higher values produce a more accurate graph but take longer to construct.

**B-tree indexes** on `doc_id`, `doc_version`, and `content_type` allow the retrieval pipeline to quickly filter results to a specific document version or exclude table-type chunks without a full scan.

**GIN index on JSONB metadata.** The `metadata` column is a freeform JSONB object. A standard B-tree index cannot index arbitrary keys inside a JSON document. A GIN (Generalised Inverted Index) decomposes each JSONB document into its key-value pairs and indexes each one individually, enabling fast lookups like `metadata->>'specialty' = 'rheumatology'` without scanning every row.

**Full-text search vector.** The `text_search_vector` column is a PostgreSQL generated column (`GENERATED ALWAYS AS ... STORED`) containing a `tsvector` representation of the chunk text. PostgreSQL automatically updates this column whenever `text` changes. A GIN index on this column powers the keyword (BM25) search leg of hybrid retrieval. Because it is a generated column, no application code is needed to keep it in sync.

### 4.15 RAG Service Logging & Telemetry

The RAG service has two distinct observability outputs that serve different purposes.

**Structured JSON logging** is produced by every module via a shared `setup_logger()` factory. Each logger writes to two sinks simultaneously: the console (at the configured log level, typically INFO in production) and a persistent log file (always at DEBUG level for full verbosity). All log lines are emitted as JSON objects containing the timestamp, log level, logger name, message, source file, and line number. This structure makes logs directly ingestable by log aggregation systems without parsing. The console level is controlled by the `LOG_LEVEL` environment variable; the file path by `LOG_FILE`.

**JSONL route telemetry** is a separate, append-only file (`logs/route_decisions.jsonl`) that records every LLM provider routing decision. Each entry captures the endpoint name, which provider was selected, the routing score, the threshold that triggered the decision, the list of reasons, and a SHA-256 fingerprint of the query (never the raw query, for privacy). The purpose of this file is offline analysis — it allows the development team to audit routing decisions without instrumenting a separate monitoring stack. The query hash rather than the raw query is used so the telemetry file does not contain patient-sensitive clinical text.

The ingestion pipeline logs per-stage progress (chunk counts, merged section counts, embed batch results) and writes optional per-stage debug artifacts to `data/debug/<doc_id>/<stage>.json` when `write_debug_artifacts=True`. These artifacts allow offline inspection of exactly what the pipeline produced at each stage without re-running the full ingestion.

---

## 5. Real-Time Streaming (SSE)

### Libraries Used

| Library | Purpose |
|---|---|
| `asyncio` | Async event loop, queues, and locks |
| `FastAPI StreamingResponse` | HTTP streaming response |
| `EventSource` (browser API) | Frontend SSE subscription |
| `httpx` (async) | Streaming HTTP client to RAG service |

Server-Sent Events (SSE) deliver AI-generated tokens to the browser in real time without polling. The architecture uses an in-process event bus keyed by `chat_id`.

### 5.1 Backend: Event Bus

The `_ChatEventBus` class is a module-level singleton (`chat_event_bus`) that routes events from the background AI generation task to any HTTP SSE connections watching the same chat:

```python
# backend/src/utils/sse.py
@dataclass
class SSEEvent:
    event: str          # "stream_start" | "content" | "complete" | "error"
    data:  dict[str, Any]
    created_at: float = field(default_factory=time.monotonic)

    def encode(self) -> str:
        """Format as an SSE text frame for HTTP transport."""
        return f"event: {self.event}\ndata: {json.dumps(self.data)}\n\n"


class _ChatEventBus:
    def __init__(self):
        self._subscribers: dict[int, list[asyncio.Queue]] = {}
        self._stream_start: dict[int, SSEEvent] = {}  # replay buffer
        self._last_content: dict[int, SSEEvent] = {}
        self._active_streams: set[int] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread_lock = threading.Lock()         # for thread-safe publish path

    async def subscribe(self, chat_id: int) -> asyncio.Queue:
        """Register a new SSE client. Replay buffered events if streaming is active."""
        async with self._lock:
            q = asyncio.Queue(maxsize=256)
            self._subscribers.setdefault(chat_id, []).append(q)
            # Late-connecting clients catch up by replaying stream_start + last_content
            if chat_id in self._active_streams:
                if start := self._stream_start.get(chat_id):
                    q.put_nowait(start)
                if last := self._last_content.get(chat_id):
                    q.put_nowait(last)
            return q

    async def publish(self, chat_id: int, event: SSEEvent) -> None:
        """Deliver event to all subscribers (called from async coroutines)."""
        async with self._lock:
            self._update_buffer(chat_id, event)
            subs = list(self._subscribers.get(chat_id, []))
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning("Dropping SSE event — subscriber queue full")

    def publish_threadsafe(self, chat_id: int, event: SSEEvent) -> None:
        """Deliver event from a background thread using call_soon_threadsafe."""
        with self._thread_lock:
            self._update_buffer(chat_id, event)
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._sync_put, chat_id, event)

    async def close_chat(self, chat_id: int) -> None:
        """Send None sentinel to all subscribers — signals end of stream."""
        async with self._lock:
            subs = list(self._subscribers.get(chat_id, []))
            self._clear_buffer(chat_id)
        for q in subs:
            q.put_nowait(None)   # None = stream ended
```

### 5.2 Backend: SSE Endpoint

```python
# backend/src/api/endpoints/chats.py
@router.get("/{chat_id}/stream")
async def stream_chat(
    chat_id: int,
    user: User = Depends(get_current_user_from_cookie_or_header),
):
    # Validate user has access to this chat
    _assert_chat_stream_access(chat_id, user)

    return StreamingResponse(
        sse_event_generator(chat_id),    # async generator from sse.py
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # prevent nginx from buffering the stream
        },
    )
```

```python
# backend/src/utils/sse.py
async def sse_event_generator(chat_id: int) -> AsyncGenerator[str, None]:
    """Yields SSE-formatted strings. Includes keep-alive and idle timeout."""
    q = await chat_event_bus.subscribe(chat_id)
    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=300)  # 5-min idle timeout
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"    # SSE comment keeps connection alive
                continue
            if event is None:   # sentinel — generation finished
                break
            yield event.encode()
    finally:
        await chat_event_bus.unsubscribe(chat_id, q)
```

### 5.3 Backend: Publishing Events During Generation

```python
# backend/src/services/chat_service.py (simplified)
async def _async_generate_ai_response(chat_id: int, user_id: int, content: str) -> None:
    async with AsyncSessionLocal() as db:
        # Concurrency guard — skip if another generation is running for this chat
        existing = await db.execute(
            select(Message).where(Message.chat_id == chat_id,
                                   Message.is_generating == True)
        )
        if existing.scalars().first():
            return

        # Create placeholder (is_generating=True tells the frontend to show spinner)
        placeholder = await message_repository.async_create(
            db, chat_id=chat_id, content="", sender="ai", is_generating=True
        )

        # Signal stream start — browser inserts placeholder message bubble
        await chat_event_bus.publish(chat_id, SSEEvent(
            event="stream_start",
            data={"chat_id": chat_id, "message_id": placeholder.id},
        ))

        # Stream from RAG service, publish each token incrementally
        async with httpx.AsyncClient(timeout=RAG_REQUEST_TIMEOUT_SECONDS) as client:
            async with client.stream("POST", f"{RAG_SERVICE_URL}/answer",
                                      json=rag_payload) as rag_response:
                async for line in rag_response.aiter_lines():
                    chunk = json.loads(line)
                    if chunk.get("type") == "chunk":
                        ai_content += chunk.get("delta", "")
                        await chat_event_bus.publish(chat_id, SSEEvent(
                            event="content",
                            data={"message_id": placeholder.id, "content": ai_content},
                        ))
                    elif chunk.get("type") == "done":
                        ai_content = chunk.get("answer", ai_content)
                        citations  = _select_rag_citations(chunk)

        # Persist finalised message
        await message_repository.async_update(
            db, placeholder, content=ai_content,
            citations=citations, is_generating=False
        )

        # Signal completion — browser replaces spinner with final content + citations
        await chat_event_bus.publish(chat_id, SSEEvent(
            event="complete",
            data={
                "message_id": placeholder.id,
                "content": ai_content,
                "citations": citations,
                "file_context_truncated": file_context_result.was_truncated,
            },
        ))
```

### 5.4 Frontend: SSE Subscription

```typescript
// frontend/src/services/api.ts
export function subscribeToChatStream(
  chatId: number,
  handlers: {
    onStreamStart?: (messageId: number) => void;
    onContent?:     (messageId: number, content: string) => void;
    onComplete?:    (messageId: number, content: string, citations: unknown[]) => void;
    onFileContextTruncated?: () => void;
    onError?:       (messageId: number, errorMessage: string) => void;
    onConnectionError?: () => void;
  },
): () => void {    // returns a cleanup function

  const source = new EventSource(
    `${API_BASE}/chats/${chatId}/stream`,
    { withCredentials: true }   // send auth cookies
  );
  let closed = false;
  let retryCount = 0;

  source.addEventListener("stream_start", (e) => {
    const { message_id } = JSON.parse(e.data);
    handlers.onStreamStart?.(message_id);
  });

  source.addEventListener("content", (e) => {
    const { message_id, content } = JSON.parse(e.data);
    handlers.onContent?.(message_id, content);
  });

  source.addEventListener("complete", (e) => {
    const { message_id, content, citations, file_context_truncated } = JSON.parse(e.data);
    if (file_context_truncated) handlers.onFileContextTruncated?.();
    handlers.onComplete?.(message_id, content, citations ?? []);
    source.close();
  });

  // onerror fires on native connection drops — track retries
  source.onerror = () => {
    if (retryCount++ >= 5) {
      handlers.onConnectionError?.();
      source.close();
    }
    // EventSource auto-reconnects natively; retryCount guards against infinite loops
  };

  return () => { if (!closed) { closed = true; source.close(); } };
}
```

### 5.5 Frontend: Message State Management

The page component uses the SSE subscription to update the messages list in real time:

```typescript
// Pattern used in GPQueryDetailPage.tsx / SpecialistQueryDetailPage.tsx
useEffect(() => {
  const cleanup = subscribeToChatStream(chatId, {
    onStreamStart: (msgId) => {
      // Insert placeholder bubble immediately
      setMessages(prev => [...prev, {
        id: msgId, senderId: "ai", content: "", isGenerating: true, citations: [],
      }]);
    },
    onContent: (msgId, cumulativeContent) => {
      // Replace placeholder content with latest cumulative token string
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, content: cumulativeContent } : m
      ));
    },
    onComplete: (msgId, fullContent, citations) => {
      setMessages(prev => prev.map(m =>
        m.id === msgId
          ? { ...m, content: fullContent, citations, isGenerating: false }
          : m
      ));
    },
    onFileContextTruncated: () => setShowTruncatedWarning(true),
  });
  return cleanup;
}, [chatId]);
```

### 5.6 SSE Polling Fallback

The `useChatStream` hook implements a full state machine with a polling fallback for environments where SSE connections drop or are blocked. Phases:

```
idle → connecting → streaming → complete
                 ↘ (timeout / error)
                   fallback_polling → complete
```

If the SSE connection does not deliver a `stream_start` event within 500 ms, or if `EventSource` fires an error, the hook transitions to `fallback_polling` and switches to interval-based `GET /chats/{id}` requests. The polling interval uses exponential backoff:

```typescript
// frontend/src/hooks/useChatStream.ts
const POLL_BASE_MS     = 2_000;
const POLL_MULTIPLIER  = 1.5;
const POLL_MAX_MS      = 30_000;

// interval = min(base × multiplier^attempts, max)
```

This ensures that a transient SSE failure (e.g. load balancer timeout, network blip) degrades gracefully rather than leaving the user with a frozen "generating…" spinner.

### 5.7 Sequence Diagram — Full Streaming Flow

```
GP Browser           Backend API          RAG Service           Ollama
    │                     │                    │                    │
    │ POST /chats/         │                    │                    │
    ├────────────────────▶│                    │                    │
    │ 200 {chat}          │                    │                    │
    │◀────────────────────┤                    │                    │
    │                     │  background task   │                    │
    │                     ├──────────────────▶ │                    │
    │ GET /chats/1/stream  │                    │                    │
    ├────────────────────▶│                    │                    │
    │ (connection open)   │                    │                    │
    │                     │                    │ embed query        │
    │                     │                    │ vector + keyword   │
    │                     │                    │ fuse + rerank      │
    │                     │                    │ build prompt       │
    │                     │                    ├───────────────────▶│
    │ event:stream_start  │                    │                    │
    │◀────────────────────┤                    │                    │
    │ event:content (tok) │◀──────── stream ───┤◀──── tokens ───────┤
    │ event:content (tok) │◀──────── stream ───┤◀──── tokens ───────┤
    │   (many tokens)     │                    │                    │
    │ event:complete      │◀──────── done ─────┤                    │
    │◀────────────────────┤                    │                    │
    │ (connection closed) │                    │                    │
```

### 5.8 SSE Replay Buffer & Memory Management

The `_ChatEventBus` maintains a per-chat **replay buffer** to handle late-connecting clients — a client that opens the SSE connection a fraction of a second after `stream_start` was published would otherwise miss the message ID and not know which placeholder to update. The buffer stores the most recent `stream_start` event and the most recent `content` event per chat. When a new subscriber registers (`subscribe(chat_id)`) while a stream is active, both buffered events are immediately placed into the subscriber's queue before the next live event arrives.

**Why only `stream_start` and the latest `content` event, not all events?** Storing every content event per chat would grow the buffer proportionally to token count. Instead, `content` events carry cumulative text (not deltas), so the most recent content event always contains the full text emitted so far. A late subscriber receives one `stream_start` and one `content` with all tokens accumulated to that point, then continues receiving live events as they arrive. The subscriber immediately renders the correct partial text with no visible gap.

**Memory protection.** Without active cleanup, the replay buffer would grow without bound on a long-running server handling many concurrent consultations. Two mechanisms prevent this:

- **TTL eviction.** Entries whose `stream_start` event is older than 10 minutes (`_REPLAY_BUFFER_TTL_SECONDS = 600`) and whose stream is no longer active are cleared during the periodic cleanup pass that runs on every publish call.
- **Max-size eviction.** If the buffer holds more than 1,000 entries (`_REPLAY_BUFFER_MAX_SIZE = 1000`), the oldest inactive entries are evicted by `created_at` timestamp.

**Per-subscriber queue limit.** Each subscriber gets its own `asyncio.Queue` with `maxsize=256`. If a slow SSE client cannot consume events fast enough, subsequent `put_nowait` calls raise `QueueFull`, which the bus catches and logs as a warning rather than blocking. This means a single slow browser tab cannot apply back-pressure to the generation task or to other subscribers watching the same chat.

**Thread-safe publishing.** The `_regenerate_ai_response` path in `specialist_review.py` runs inside a synchronous SQLAlchemy session (not the async event loop), so it uses `publish_threadsafe` and `close_chat_threadsafe`. These methods schedule the queue operations onto the main asyncio event loop using `loop.call_soon_threadsafe()`, which is the correct way to hand work from a background thread to an asyncio loop. If the loop reference is unavailable (early startup or tests), the methods fall back to direct `put_nowait` as a best-effort path.

---

## 6. File Attachment System

### Libraries Used

| Library | Purpose |
|---|---|
| `python-multipart` | Parses `multipart/form-data` upload requests |
| `pdfplumber` | Extracts text content from PDF files for RAG context |
| `aiofiles` / `Path.write_bytes` | Saves uploaded files to disk |

### 6.1 Upload Endpoint

```python
# backend/src/api/endpoints/chats.py
@router.post("/{chat_id}/files", response_model=FileAttachmentResponse)
async def upload_file(
    chat_id: int,
    file:    UploadFile = File(...),
    user:    User       = Depends(get_current_user_from_cookie_or_header),
    db:      Session    = Depends(get_db),
):
    return await chat_service.upload_file(db, user, chat_id, file)
```

### 6.2 File Validation and Storage

```python
# backend/src/services/chat_uploads.py (simplified)
ALLOWED_EXTENSIONS = {".pdf", ".txt", ".md", ".rtf", ".doc", ".docx",
                      ".csv", ".json", ".xml"}
MAX_FILE_SIZE_BYTES = 3 * 1024 * 1024   # 3 MB

async def upload_chat_file(db, user, chat_id, upload_file) -> FileAttachment:
    # 1. Policy check — is this user allowed to upload to this chat?
    chat = _assert_can_upload(db, chat_id, user)

    # 2. Validate file extension
    ext = Path(upload_file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"File type '{ext}' is not allowed")

    # 3. Read and check file size
    data = await upload_file.read()
    if len(data) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(413, "File exceeds 3 MB limit")

    # 4. Sanitise filename — strip non-ASCII and dangerous characters
    safe_name = sanitise_filename(upload_file.filename)

    # 5. Write to disk (organised by chat_id subdirectory)
    dest = UPLOAD_DIR / str(chat_id) / safe_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)

    # 6. Persist metadata to database
    attachment = FileAttachment(
        chat_id=chat_id,
        filename=safe_name,
        file_path=str(dest),
        file_type=ext,
        file_size=len(data),
        uploaded_by=user.id,
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)
    return attachment
```

### 6.3 File Content in RAG Context

When generating an AI response, uploaded files are extracted and injected into the prompt as an "UPLOADED DOCUMENTS" section:

```python
# backend/src/services/rag_context.py (simplified)
def extract_text(file_path: str, file_type: str) -> str | None:
    if file_type == ".pdf":
        try:
            import pdfplumber
            with pdfplumber.open(file_path) as pdf:
                return "\n".join(page.extract_text() or "" for page in pdf.pages)
        except Exception:
            return None   # gracefully handle corrupted or password-protected PDFs
    elif file_type in (".txt", ".md", ".csv"):
        return Path(file_path).read_text(errors="replace")
    return None

def build_file_context(chat: Chat, extract_text_fn) -> str | None:
    texts = []
    for f in (chat.files or []):
        text = extract_text_fn(f.file_path, f.file_type)
        if text and text.strip():
            texts.append(f"[{f.filename}]\n{text.strip()}")
    return "\n\n---\n\n".join(texts) if texts else None
```

The extracted text is capped and passed to the RAG prompt builder. If it exceeds the token budget, a `was_truncated=True` flag is set and a warning banner is shown to the user.

### 6.4 File Context Truncation & Propagation

When an uploaded file's extracted text exceeds `FILE_CONTEXT_CHAR_LIMIT`, the service does not simply hard-cut at the character boundary — that would leave a mid-word or mid-sentence fragment at the end. Instead, `build_file_context_result` attempts to find the last sentence boundary (". ") within the allowed length. If none exists in the relevant range, it falls back to the last word boundary (space). A `[Document truncated to fit context window]` notice is appended to make the truncation visible in the prompt, so the model knows the document continues beyond what it has been given.

The result is a `FileContextBuildResult` dataclass with two fields: the final `file_context` string (or `None`) and a `was_truncated` boolean. The `was_truncated` flag travels all the way from the service layer to the SSE `complete` event:

```
build_file_context_result()
    → FileContextBuildResult(was_truncated=True)
    → RAG payload: file_context_truncated=True
    → SSE complete event: {"file_context_truncated": true}
    → useChatStream: onFileContextTruncated() callback
    → GPQueryDetailPage: setShowTruncatedWarning(true)
    → UI: yellow banner "Your uploaded document was truncated to fit the context window"
```

This end-to-end propagation ensures the GP is always informed when the model answered based on only part of their uploaded document, rather than silently receiving a response that may be missing context from the later pages.

**PDF extraction fallback.** The `extract_text` function uses `pypdf.PdfReader` as a lazy import — it is only loaded when a PDF is actually uploaded, avoiding the import overhead on every request. If extraction produces fewer than 50 characters, the function returns a warning message rather than an empty string: `"⚠️ This PDF appears to be empty, password-protected, or contains only images."` The GP sees this in the file context section of the prompt and can act accordingly rather than receiving an AI answer that silently had no file context.

---

## 7. Specialist Review Workflow

### Libraries Used

| Library | Purpose |
|---|---|
| `FastAPI` | HTTP endpoint |
| `Pydantic v2` | Request validation using `Literal` type for the action field |
| `SQLAlchemy` | Database updates within a transaction |

### 7.1 Assigning a Consultation

A specialist assigns themselves to a consultation by calling the assign endpoint. Status must be `SUBMITTED` — the service layer enforces this and notifies the GP on success:

```python
# backend/src/services/specialist_queries.py
def assign_chat(db: Session, specialist: User, chat_id: int) -> ChatDetailResponse:
    chat = chat_repository.get(db, chat_id)
    if not chat:
        raise HTTPException(404, "Chat not found")
    if chat.status != ChatStatus.SUBMITTED:
        raise HTTPException(409, f"Chat is not submittable (status: {chat.status.value})")
    chat = chat_repository.update(
        db, chat,
        status=ChatStatus.ASSIGNED,
        specialist_id=specialist.id,
        assigned_at=datetime.now(timezone.utc),
    )
    notification_repository.create(
        db, user_id=chat.user_id,
        type=NotificationType.CHAT_ASSIGNED,
        title="Specialist assigned to your consultation",
        chat_id=chat.id,
    )
    return chat_to_response(chat)
```

### 7.2 Review Action Schema

The `action` field uses a `Literal` type — Pydantic rejects any value outside the defined set at the validation layer, before reaching application code:

```python
# backend/src/schemas/chat.py
ReviewAction = Literal[
    "approve",
    "reject",
    "request_changes",
    "manual_response",
    "send_comment",
    "unassign",
]

class ReviewRequest(BaseModel):
    action:              ReviewAction
    feedback:            str | None = None
    replacement_content: str | None = None    # for manual_response
    replacement_sources: list[str] | None = None
    edited_content:      str | None = None    # for per-message edit_response
```

### 7.3 Consultation-Level Review Dispatcher

All five consultation-level actions are handled inside a single `review()` function. Key guards are checked first before dispatching:

```python
# backend/src/services/specialist_review.py
def review(db: Session, specialist: User, chat_id: int, body: ReviewRequest) -> ChatResponse:

    chat = (db.query(Chat)
              .filter(Chat.id == chat_id, Chat.specialist_id == specialist.id)
              .first())
    if not chat:
        raise HTTPException(404, "Chat not found or not assigned to you")

    # Guard 1: Chat must be in a reviewable state
    if chat.status not in (ChatStatus.ASSIGNED, ChatStatus.REVIEWING):
        raise HTTPException(400, f"Chat must be ASSIGNED or REVIEWING (current: {chat.status.value})")

    # Guard 2: Cannot approve/reject/unassign while AI is generating
    if body.action in ("approve", "reject", "manual_response", "unassign"):
        generating = (db.query(Message)
                        .filter(Message.chat_id == chat_id,
                                Message.sender == "ai",
                                Message.is_generating == True)
                        .first())
        if generating:
            raise HTTPException(400, "Cannot act while AI response is generating")

    # ── Action: Send Comment ─────────────────────────────────────────────────
    if body.action == "send_comment":
        message_repository.create(db, chat_id=chat.id,
                                   content=body.feedback.strip(), sender="specialist")
        notification_repository.create(db, user_id=chat.user_id,
                                        type=NotificationType.SPECIALIST_MSG,
                                        title="New comment from specialist",
                                        chat_id=chat.id)
        audit_repository.log(db, user_id=specialist.id, action="SPECIALIST_COMMENT")
        _invalidate_chat_views(chat, specialist.id)
        return chat_to_response(chat)   # status unchanged

    # ── Action: Unassign ─────────────────────────────────────────────────────
    if body.action == "unassign":
        old_specialist_id = chat.specialist_id
        chat = chat_repository.update(db, chat, status=ChatStatus.SUBMITTED,
                                       specialist_id=None, assigned_at=None)
        audit_repository.log(db, user_id=specialist.id, action="SPECIALIST_UNASSIGN")
        _invalidate_chat_views(chat, old_specialist_id)
        return chat_to_response(chat)

    # ── Action: Manual Response ───────────────────────────────────────────────
    if body.action == "manual_response":
        if not body.replacement_content or not body.replacement_content.strip():
            raise HTTPException(400, "replacement_content is required")
        _mark_last_ai_message(db, chat.id, body)   # mark AI message as replaced
        message_repository.create(db, chat_id=chat.id,
                                   content=body.replacement_content.strip(),
                                   sender="specialist",
                                   citations=_build_manual_citations(body.replacement_sources))
        chat = chat_repository.update(db, chat, status=ChatStatus.APPROVED,
                                       reviewed_at=datetime.now(timezone.utc))
        notification_repository.create(db, user_id=chat.user_id,
                                        type=NotificationType.CHAT_APPROVED,
                                        title="Specialist provided a response",
                                        chat_id=chat.id)
        _invalidate_chat_views(chat, specialist.id)
        return chat_to_response(chat)

    # ── Action: Request Changes (AI Revision) ────────────────────────────────
    _mark_last_ai_message(db, chat.id, body)
    if body.action == "request_changes":
        _regenerate_ai_response(db, chat, body.feedback)   # triggers new RAG generation
        chat = chat_repository.update(db, chat, status=ChatStatus.REVIEWING,
                                       review_feedback=body.feedback)
        notification_repository.create(db, user_id=chat.user_id,
                                        type=NotificationType.CHAT_REVISION,
                                        title="AI response is being revised",
                                        chat_id=chat.id)

    # ── Action: Approve / Reject ──────────────────────────────────────────────
    else:
        new_status = ChatStatus.APPROVED if body.action == "approve" else ChatStatus.REJECTED
        chat = chat_repository.update(db, chat, status=new_status,
                                       reviewed_at=datetime.now(timezone.utc),
                                       review_feedback=body.feedback)
        notification_type = (NotificationType.CHAT_APPROVED if body.action == "approve"
                             else NotificationType.CHAT_REJECTED)
        notification_repository.create(db, user_id=chat.user_id,
                                        type=notification_type,
                                        title=f"Consultation {body.action}d",
                                        chat_id=chat.id)

    _invalidate_chat_views(chat, specialist.id)
    return chat_to_response(chat)
```

### 7.4 AI Revision (Request Changes Flow)

When a specialist requests changes, the system re-runs RAG with the original question, the previous AI answer, and the specialist's feedback all included in the prompt:

```python
# backend/src/services/specialist_review.py
def _regenerate_ai_response(db: Session, chat: Chat, feedback: str | None) -> Message:
    messages     = message_repository.list_for_chat(db, chat.id)
    user_msgs    = [m for m in messages if m.sender == "user"]
    ai_msgs      = [m for m in messages if m.sender == "ai"]
    original_query  = user_msgs[-1].content if user_msgs else ""
    previous_answer = ai_msgs[-1].content  if ai_msgs   else ""
    patient_context = _build_patient_context(chat, messages)
    file_context    = _build_file_context(chat)

    # Create new placeholder message
    placeholder = message_repository.create(
        db, chat_id=chat.id,
        content="Revising response based on specialist feedback…",
        sender="ai", is_generating=True,
    )

    # POST to /revise endpoint with full context
    _do_revise(db, placeholder, original_query, previous_answer,
               feedback or "", chat.specialty, chat.severity,
               patient_context, file_context)
    return placeholder
```

The `/revise` RAG endpoint uses `build_revision_prompt()` which includes all three inputs — original question, previous answer, and specialist feedback — allowing the model to address specific concerns while remaining grounded in the same clinical guidelines.

### 7.5 Per-Message Review

In addition to consultation-level actions, specialists can review individual AI messages. This is exposed as a separate endpoint:

```
POST /specialist/chats/{chat_id}/messages/{message_id}/review
```

Per-message actions and their effect on `message.review_status`:

| Action | `review_status` | Chat status change |
|---|---|---|
| `approve` | `"approved"` | → `REVIEWING` (if not already) |
| `reject` | `"rejected"` | → `REVIEWING` |
| `edit_response` | `"edited"` | → `REVIEWING` |
| `manual_response` | `"replaced"` | → `REVIEWING` |
| `request_changes` | unchanged | → `REVIEWING`, triggers regeneration |

The specialist can only close the consultation (approve/reject the whole chat) once **all AI messages** have a `review_status` value. The frontend tracks this with:

```typescript
// frontend/src/pages/specialist/SpecialistQueryDetailPage.tsx
const unreviewedAIIds = new Set(
  messages.filter(m => m.senderType === 'ai' && !m.reviewStatus && !m.isGenerating).map(m => m.id)
);
const allAIReviewed = aiMessages.length > 0 && unreviewedAIIds.size === 0 && !anyGenerating;
```

The "Close & Approve Consultation" button is only enabled when `allAIReviewed === true`.

---

### 7.6 Sequence Diagram — Manual Response Action

```
Specialist Browser     Backend API          Database         GP Browser
       │                    │                   │                 │
       │  Upload file        │                   │                 │
       ├───────────────────▶│                   │                 │
       │  POST /files        │  store file       │                 │
       │                    ├──────────────────▶│                 │
       │  POST /review       │                   │                 │
       │  {action:           │                   │                 │
       │   "manual_response",│                   │                 │
       │   replacement_content}                  │                 │
       ├───────────────────▶│                   │                 │
       │                    │  mark AI msg       │                 │
       │                    │  as "replaced"     │                 │
       │                    ├──────────────────▶│                 │
       │                    │  create specialist │                 │
       │                    │  message           │                 │
       │                    ├──────────────────▶│                 │
       │                    │  set status=       │                 │
       │                    │  APPROVED          │                 │
       │                    ├──────────────────▶│                 │
       │                    │  create            │                 │
       │                    │  CHAT_APPROVED     │                 │
       │                    │  notification      │                 │
       │                    ├──────────────────▶│                 │
       │ 200 {updated chat} │  invalidate cache  │                 │
       │◀───────────────────┤                   │                 │
       │                    │                   │  GET /notifs    │
       │                    │                   │◀────────────────┤
       │                    │                   │  notification + │
       │                    │                   │  chat approved  │
       │                    │                   ├────────────────▶│
```

---

## 8. Notification System

### Libraries Used

| Library | Purpose |
|---|---|
| `SQLAlchemy` | ORM for `notifications` table queries via repository |
| `fastapi` | SSE endpoint (`EventSourceResponse`) for push delivery |
| `sse-starlette` | `EventSourceResponse` streaming support |
| `react` | `NotificationDropdown` component and unread badge state |

### 8.1 Repository Pattern

All database operations for notifications go through a repository module, keeping query logic out of the service layer:

```python
# backend/src/repositories/notification_repository.py

def create(db, *, user_id, type, title, body=None, chat_id=None) -> Notification:
    notif = Notification(user_id=user_id, type=type, title=title,
                         body=body, chat_id=chat_id)
    db.add(notif)
    db.commit()
    db.refresh(notif)
    return notif

def list_for_user(db, user_id, *, unread_only=False) -> list[Notification]:
    query = db.query(Notification).filter(Notification.user_id == user_id)
    if unread_only:
        query = query.filter(Notification.is_read.is_(False))
    return query.order_by(Notification.created_at.desc()).all()

def mark_all_read(db, user_id) -> int:
    count = (db.query(Notification)
               .filter(Notification.user_id == user_id,
                       Notification.is_read.is_(False))
               .update({"is_read": True}))
    db.commit()
    return count

def count_unread(db, user_id) -> int:
    return (db.query(Notification)
              .filter(Notification.user_id == user_id,
                      Notification.is_read.is_(False))
              .count())
```

### 8.2 Frontend: Notification Badge

The navigation bar polls the unread count every 30 seconds and shows a badge:

```typescript
// frontend/src/hooks/useNotifications.ts (simplified)
export function useNotifications() {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const fetchCount = async () => {
      const count = await getUnreadNotificationCount();
      setUnreadCount(count);
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, []);

  return { unreadCount };
}
```

```tsx
// In NavigationBar.tsx
{unreadCount > 0 && (
  <span className="absolute -top-1 -right-1 bg-red-500 text-white
                   text-xs rounded-full w-4 h-4 flex items-center justify-center">
    {unreadCount > 9 ? "9+" : unreadCount}
  </span>
)}
```

### 8.3 Notification Caching Pattern

Notifications are read-heavy and write-infrequent, making them a good fit for caching. The service layer wraps every read operation in a cache check:

```python
# backend/src/services/notification_service.py
def list_notifications(db, user, *, unread_only=False) -> list[NotificationResponse]:
    cache_key = cache_keys.notifications(user.id, unread_only=unread_only)
    cached = cache.get_sync(cache_key, user_id=user.id, resource="notifications")
    if cached is not None:
        return [NotificationResponse(**item) for item in cached]

    notifs = notification_repository.list_for_user(db, user.id, unread_only=unread_only)
    response = [_to_response(n) for n in notifs]
    cache.set_sync(cache_key, [item.model_dump() for item in response],
                   ttl=settings.CACHE_NOTIFICATION_TTL, user_id=user.id, resource="notifications")
    return response
```

Two separate cache keys are maintained: one for the full notification list and one for the unread count (`notifications_unread_count(user_id)`). The unread count endpoint is called every 30 seconds by the navigation bar polling hook — caching it avoids a repeated `COUNT(*)` query on every poll.

The `invalidate_notification_caches(user_id)` helper is called by every action that produces or consumes notifications — specialist review actions, specialist message send, mark-as-read, and mark-all-read. It uses `delete_pattern_sync` to clear both the list cache (with `unread_only=True` and `unread_only=False` variants) and the count cache in a single operation. This ensures the navigation badge and the dropdown list always reflect current state after any action, without leaving stale data from a prior polling cycle.

---

## 9. Caching Layer

### Libraries Used

| Library | Purpose |
|---|---|
| `redis-py` | Redis client for sync and async cache operations |
| `pickle` | Serialises Python objects for Redis storage |

### 9.1 Architecture

The cache layer uses Redis as primary storage with an in-process Python dict as a fallback when Redis is unavailable. All cache keys are scoped by `user_id` and `resource` type to prevent cross-user data leakage:

```python
# backend/src/utils/cache.py (simplified)
class Cache:
    def _scoped_key(self, key: str, user_id: int, resource: str) -> str:
        return f"{resource}:{user_id}:{key}"

    def get_sync(self, key, user_id, resource) -> Any | None:
        scoped = self._scoped_key(key, user_id, resource)
        try:
            raw = self._redis.get(scoped)
            return pickle.loads(raw) if raw else None
        except RedisError:
            entry = self._local.get(scoped)
            if entry and entry[1] > time.time():   # check TTL
                return entry[0]
            return None

    def set_sync(self, key, value, ttl, user_id, resource) -> None:
        scoped = self._scoped_key(key, user_id, resource)
        try:
            self._redis.setex(scoped, ttl, pickle.dumps(value))
        except RedisError:
            self._local[scoped] = (value, time.time() + ttl)

    def delete_pattern_sync(self, pattern, user_id, resource) -> None:
        full_pattern = f"{resource}:{user_id}:{pattern}*"
        try:
            keys = self._redis.keys(full_pattern)
            if keys:
                self._redis.delete(*keys)
        except RedisError:
            prefix = f"{resource}:{user_id}:"
            self._local = {k: v for k, v in self._local.items()
                           if not k.startswith(prefix)}

cache = Cache()
```

### 9.2 Cache-Aside Pattern

The standard read path is: check cache → miss → query DB → store result:

```python
# backend/src/services/chat_service.py
def get_chat_list(db, user, skip, limit, status_filter) -> ChatListResponse:
    cache_key = f"list:{skip}:{limit}:{status_filter}"

    cached = cache.get_sync(cache_key, user_id=user.id, resource="chat_list")
    if cached:
        return cached

    chats  = chat_repository.list_for_user(db, user.id, skip=skip, limit=limit,
                                            status=status_filter)
    result = ChatListResponse(chats=[chat_to_response(c) for c in chats])

    cache.set_sync(cache_key, result, ttl=300,   # 5-minute TTL
                   user_id=user.id, resource="chat_list")
    return result
```

### 9.3 Cache Invalidation

After any mutation, all affected cache entries are invalidated by pattern. For example, after a specialist submits a review:

```python
# backend/src/services/specialist_review.py
def _invalidate_chat_views(chat: Chat, specialist_id: int | None) -> None:
    # Invalidate GP's view of this chat and their chat list
    cache.delete_pattern_sync(cache_keys.chat_detail_pattern(chat.id),
                               user_id=chat.user_id, resource="chat_detail")
    cache.delete_pattern_sync(cache_keys.chat_list_pattern(chat.user_id),
                               user_id=chat.user_id, resource="chat_list")
    # Invalidate specialist's queue/assigned views
    if specialist_id:
        cache.delete_pattern_sync(cache_keys.specialist_queue_pattern(chat.specialty),
                                   user_id=specialist_id, resource="specialist_queue")
    # Invalidate admin caches
    _invalidate_admin_chat_caches(chat.id)
    _invalidate_admin_stats_cache()
```

### 9.4 Async-to-Sync Redis Bridge

The `RedisCache` class is internally async — it uses `redis.asyncio.Redis`, which is the right choice for the async RAG and AI generation paths. However, most of the backend's service layer uses synchronous SQLAlchemy sessions (the standard FastAPI pattern for route handlers). Calling `await` inside a synchronous function is not possible, and `asyncio.run()` fails when an event loop is already running (which is always the case inside a FastAPI request handler).

The solution is a **dedicated background event loop running on a daemon thread**:

```python
# backend/src/utils/cache.py
def _get_sync_loop() -> asyncio.AbstractEventLoop:
    global _sync_loop, _sync_thread
    if _sync_loop is not None and not _sync_loop.is_closed():
        return _sync_loop
    with _sync_loop_lock:
        if _sync_loop is None or _sync_loop.is_closed():
            _sync_loop = asyncio.new_event_loop()
            ready = threading.Event()
            _sync_thread = threading.Thread(
                target=_sync_loop_runner,
                args=(_sync_loop, ready),
                daemon=True,           # exits when the process exits
            )
            _sync_thread.start()
            ready.wait(timeout=1)      # wait until the loop is running
    return _sync_loop

def _run_sync(coro):
    loop = _get_sync_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=5)    # raises if Redis takes > 5 seconds
```

The `_sync_loop` is created lazily on first use and reused for the lifetime of the process. `asyncio.run_coroutine_threadsafe()` is the officially supported way to submit a coroutine from a thread that is not the event loop's own thread. The 5-second timeout prevents a hung Redis connection from blocking a request handler indefinitely. The daemon thread means the background loop does not prevent Python from exiting cleanly. An `atexit` handler calls `_stop_sync_loop()` to cleanly shut down the loop and thread on normal exit.

This pattern allows all sync service functions to call `cache.get_sync(...)`, `cache.set_sync(...)`, and `cache.delete_pattern_sync(...)` without any async plumbing, while the underlying Redis operations remain non-blocking on the background loop.

### 9.5 CacheKeys Namespace Design

The `CacheKeys` class generates all cache keys according to a structured naming convention. Every key includes the application prefix (from `CACHE_KEY_PREFIX`), a resource type, and the user ID where relevant. This namespace design has two purposes.

First, **cross-tenant isolation**: all user-scoped keys embed `user:{user_id}` so a wildcard delete like `{prefix}:user:42:chats:*` is guaranteed to touch only keys belonging to user 42. Without user scoping, invalidating one user's chat list could accidentally clear another user's cached data if the pattern were too broad.

Second, **targeted invalidation**: the `chat_detail_pattern(chat_id)` generates `{prefix}:user:*:chat:{chat_id}`, which is a wildcard across all users. This is used when a single chat is updated by a specialist — the GP's cached view, the specialist's cached view, and any admin cached view all need to be cleared, but they are stored under different user IDs. The `*` wildcard in the middle combined with Redis `SCAN` (which is used instead of `KEYS` to avoid blocking the server) clears all of them in one call. The `SCAN`-based `scan_iter` is an async iteration over the keyspace that never takes an exclusive lock, making it safe to call under production load.

---

## 10. Audit Logging

Every significant action is recorded to an `audit_logs` table for security compliance and debugging.

### Libraries Used

| Library | Purpose |
|---|---|
| `SQLAlchemy` | ORM model for `audit_logs` table and async inserts |
| `fastapi` | Route handler for admin audit log retrieval endpoint |

### 10.1 Usage

```python
# Called throughout service layer — example from specialist_review.py
audit_repository.log(
    db,
    user_id=specialist.id,
    action="REVIEW_MANUAL_RESPONSE",
    details=f"Chat {chat_id} closed with manual response by specialist",
)
```

### 10.2 Actions Logged by Category

| Category | Actions |
|---|---|
| **AUTH** | `LOGIN`, `REGISTER`, `LOGOUT`, `UPDATE_PROFILE`, `PASSWORD_RESET` |
| **CHAT** | `CREATE_CHAT`, `UPDATE_CHAT`, `SUBMIT_FOR_REVIEW`, `VIEW_CHAT` |
| **SPECIALIST** | `ASSIGN_SPECIALIST`, `REVIEW_APPROVE`, `REVIEW_REJECT`, `REQUEST_CHANGES`, `REVIEW_MANUAL_RESPONSE`, `SPECIALIST_COMMENT`, `SPECIALIST_UNASSIGN` |
| **RAG** | `RAG_ANSWER`, `RAG_ERROR`, `AI_RESPONSE_GENERATED` |

---

## 11. Admin Panel

The Admin Panel is a protected section of the frontend accessible only to users with `role = "admin"`. It provides operational oversight of the entire platform — users, consultations, audit logs, clinical guidelines, and the RAG pipeline — without requiring direct database or container access.

### Libraries Used

| Library | Purpose |
|---|---|
| `recharts` | Bar/line charts for dashboard statistics visualisation |
| `react-router-dom` | `/admin/*` route definitions and `AdminLayout` sidebar nav |
| `axios` | API calls for all admin endpoints (users, chats, logs, RAG) |
| `fastapi` | Admin-only route group with role-guard dependency |
| `SQLAlchemy` | Aggregation queries for stats, user/chat/log pagination |

### 11.1 Dashboard Statistics & Visualisation

The dashboard fetches aggregated platform statistics from a single backend endpoint and renders them using the **Recharts** charting library.

**Backend endpoint:**

```python
# backend/src/api/endpoints/admin.py
@router.get("/stats", response_model=AdminStatsResponse)
def get_stats(_admin: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    return admin_service.get_stats(db)
```

The `get_stats` service function computes:

| Field | Description |
|---|---|
| `total_ai_responses` | Total number of AI-generated messages across all chats |
| `rag_grounded_responses` | AI messages that include at least one citation |
| `specialist_responses` | Messages sent by specialists |
| `active_consultations` | Chats in OPEN / SUBMITTED / ASSIGNED / REVIEWING state |
| `chats_by_status` | Dict of `status → count` for all chats |
| `chats_by_specialty` | Dict of `specialty → count` |
| `active_users_by_role` | Dict of `role → count` for active accounts |
| `daily_ai_queries` | Per-day AI response counts over the last 30 days |

**Frontend visualisation** uses Recharts `PieChart` and `BarChart` to render the `chats_by_status` and `chats_by_specialty` breakdowns. Stats are cached per admin user to avoid repeated aggregation queries on busy deployments.

---

### 11.2 User Management

The user management page allows admins to list, filter, promote/demote, and deactivate platform accounts.

**Listing with filters:**

```python
# backend/src/api/endpoints/admin.py
@router.get("/users", response_model=list[UserResponse])
async def list_users(
    role: Optional[str] = Query(None),
    search: Optional[str] = Query(None, max_length=200),
    skip: int = 0,
    limit: int = 100,
    _admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
):
    query = db.query(User)
    if role:
        query = query.filter(User.role == role)
    if search:
        query = query.filter(
            User.email.ilike(f"%{search}%") | User.full_name.ilike(f"%{search}%")
        )
    return query.offset(skip).limit(limit).all()
```

**Role promotion / demotion** is done via a `PATCH /admin/users/{user_id}` endpoint that accepts `role`, `full_name`, `specialty`, and `is_active` fields. Admins cannot change their own role or deactivate their own account — both are blocked with a 400 error to prevent self-lockout.

**Deactivation** sets `is_active = False`. All token validation checks `user.is_active` and raises a 403 if the account has been deactivated, so deactivated users cannot authenticate even with a valid unexpired token.

---

### 11.3 All-Chat Oversight & Search

Admins can view all consultations across every GP with full filtering:

| Filter | Description |
|---|---|
| `status` | Filters by `Chat.status` enum value |
| `specialty` | Match on `Chat.specialty` |
| `user_id` | Filter by GP owner |
| `specialist_id` | Filter by assigned specialist |
| `skip` / `limit` | Offset pagination (max 500 per page) |

Unlike the GP's own chat list (which is scoped to `user_id`), the admin endpoint omits the ownership filter entirely, so all rows across every user are visible. The response schema is `AdminChatResponse` which includes `owner_identifier` and `specialist_identifier` to show who owns and who is reviewing each chat.

---

### 11.4 Audit Log Viewer

Every significant action in the platform is written to the `audit_logs` table. The admin UI provides a searchable, filterable view of this log for security review and debugging.

**Filtering options:**

```python
@router.get("/logs", response_model=list[AuditLogResponse])
def list_audit_logs(
    action: Optional[str] = None,
    category: Optional[str] = None,
    search: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    limit: int = Query(default=50, ge=1, le=500),
    ...
):
```

Each log entry includes `user_identifier` (email or ID), `action`, `category`, `details`, and `timestamp`. The `category` field groups actions (e.g. `AUTH`, `CHAT`, `SPECIALIST`, `RAG`) for quick filtering in the UI.

Logs are **immutable** — there is no update or delete endpoint for `audit_logs`. Entries are only ever inserted, ensuring a tamper-evident record of platform activity.

---

### 11.5 Guideline Management

Admins can manually upload clinical guideline PDFs and trigger a RAG re-sync directly from the UI without needing shell access.

**PDF upload flow:**

```
Admin uploads PDF
    │
    ▼
POST /admin/guidelines/upload
    │  Validates: file extension, MIME type, size limit
    ▼
Saved to /app/uploads/guidelines/
    │
    ▼
Forwarded to RAG service POST /ingest
    │  RAG service: extract text → chunk → embed → store in pgvector
    ▼
Returns { doc_id, chunk_count } to admin UI
```

**Backend upload handler:**

```python
@router.post("/guidelines/upload")
async def upload_guideline(
    file: UploadFile = File(...),
    source_name: str = Form(...),
    _admin: User = Depends(get_admin_user),
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=422, detail="Only PDF files are supported.")

    file_bytes, signature = await _read_upload_with_limit(file)
    validate_upload_content(file.filename, file.content_type, signature)

    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.post(
            f"{settings.RAG_SERVICE_URL}/ingest",
            files={"file": (file.filename, file_bytes, "application/pdf")},
            data={"source_name": source_name},
        )
    return response.json()
```

Notably, the guideline upload does **not** save the file to local disk — it reads the bytes into memory, validates the content signature, and streams them directly to the RAG service. The RAG service handles all storage and ingestion. A 300-second timeout is used because large PDFs can take significant time to embed.

---

### 11.6 RAG Queue Status Monitoring

The RAG Pipeline page gives admins visibility into the health of the clinical knowledge service and the state of the document ingestion queue — without requiring log access or container inspection.

**Backend status endpoint:**

```python
# backend/src/api/endpoints/admin.py
@router.get("/rag/status", response_model=RagStatusResponse)
async def get_rag_status(_admin: User = Depends(get_admin_user)):
    service_status = "unavailable"
    documents: list[RagDocumentHealth] = []

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            health_resp = await client.get(f"{settings.RAG_SERVICE_URL}/health")
            if health_resp.status_code == 200:
                service_status = health_resp.json().get("status", "unknown")
        except (httpx.ConnectError, httpx.TimeoutException):
            pass

        try:
            docs_resp = await client.get(f"{settings.RAG_SERVICE_URL}/documents/health")
            if docs_resp.status_code == 200:
                payload = docs_resp.json()
                if isinstance(payload, list):
                    documents = [RagDocumentHealth.model_validate(item) for item in payload]
        except (httpx.ConnectError, httpx.TimeoutException):
            pass

    return RagStatusResponse(service_status=service_status, documents=documents)
```

The backend proxies two RAG service endpoints. Each is called independently with its own try/except so a failure on one (e.g. documents query times out) does not suppress the other — the health badge still renders even if the documents table fails to load.

**RAG service `/documents/health` endpoint:**

```python
# rag_service/src/api/routes.py
@router.get("/documents/health")
async def documents_health() -> list[dict]:
    with db_manager.raw_connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                doc_id,
                metadata->>'source_name' AS source_name,
                COUNT(*)                 AS chunk_count,
                MAX(updated_at)          AS latest_ingestion
            FROM rag_chunks
            GROUP BY doc_id, metadata->>'source_name'
            ORDER BY latest_ingestion DESC
            """
        )
        rows = cur.fetchall()
    return [
        {
            "doc_id": row[0],
            "source_name": row[1],
            "chunk_count": row[2],
            "latest_ingestion": row[3].isoformat() if row[3] else None,
        }
        for row in rows
    ]
```

Each row represents a unique ingested document. `chunk_count` shows how many text segments the document was split into — a higher count means more of the document's content is retrievable. `latest_ingestion` is the timestamp of the most recent ingest or re-ingest, useful for confirming that a recent sync actually updated a document.

**Frontend display** (`AdminRagPage.tsx`):

The page renders three sections:

1. **Service health badge** — Green "Ready" if the RAG service responds with `status: "ready"`; Amber "Degraded" if the service is partially available; Red with the raw status string for any other response.

2. **Search and filter bar** — Admins can search by document ID or source name, filter by source organisation, and sort the table by Source / Chunk Count / Last Ingested in ascending or descending order.

3. **Indexed Documents table** — Columns: Document ID (content hash), Source, Chunk Count, Last Ingested. Sorting and filtering are applied client-side on the already-fetched dataset.

```tsx
// frontend/src/pages/admin/AdminRagPage.tsx (simplified)
function HealthBadge({ status }: { status: string }) {
  if (status === 'healthy' || status === 'ready') {
    return <span className="text-green-700 bg-green-50 ...">
      <CheckCircle /> {status === 'ready' ? 'Ready' : 'Healthy'}
    </span>;
  }
  if (status === 'degraded') {
    return <span className="text-amber-700 ..."><AlertTriangle /> Degraded</span>;
  }
  return <span className="text-red-700 ..."><XCircle /> {status}</span>;
}
```

The page includes a manual **Refresh** button and an abort controller that cancels in-flight requests on unmount, preventing state updates on an already-unmounted component.

---

## 12. Frontend Architecture

### Libraries Used

| Library | Purpose |
|---|---|
| `React 18` | UI framework with concurrent rendering |
| `TypeScript` | Static typing across all components and API calls |
| `Vite` | Build tool and dev server with HMR |
| `React Router v6` | Client-side routing with lazy-loaded pages |
| `Axios` | HTTP client with interceptors for token injection and refresh |
| `TailwindCSS` | Utility-first CSS |
| `shadcn/ui` | Pre-built accessible component primitives |
| `Lucide React` | Icon library |

### 12.1 Application Routing

`App.tsx` defines 22 routes split across four role-based areas. All non-public routes are wrapped in `ProtectedRoute` which reads the current user's role from `AuthContext` and redirects to `/access-denied` if the role does not match:

```tsx
// frontend/src/App.tsx (simplified)
<Routes>
  {/* Public */}
  <Route path="/" element={<LandingPage />} />
  <Route path="/login" element={<LoginPage />} />
  <Route path="/register" element={<RegisterPage />} />
  <Route path="/forgot-password" element={<ForgotPasswordPage />} />
  <Route path="/reset-password" element={<ResetPasswordPage />} />
  <Route path="/verify-email" element={<VerifyEmailPage />} />
  <Route path="/resend-verification" element={<ResendVerificationPage />} />

  {/* GP — role guard: "gp" */}
  <Route element={<ProtectedRoute allowedRoles={["gp"]} />}>
    <Route path="/queries" element={<GPQueriesPage />} />
    <Route path="/queries/new" element={<GPNewQueryPage />} />
    <Route path="/queries/:id" element={<GPQueryDetailPage />} />
  </Route>

  {/* Specialist — role guard: "specialist" */}
  <Route element={<ProtectedRoute allowedRoles={["specialist"]} />}>
    <Route path="/specialist/queue" element={<SpecialistQueriesPage />} />
    <Route path="/specialist/queries/:id" element={<SpecialistQueryDetailPage />} />
  </Route>

  {/* Admin — role guard: "admin" */}
  <Route element={<ProtectedRoute allowedRoles={["admin"]} />}>
    <Route path="/admin" element={<AdminDashboardPage />} />
    <Route path="/admin/users" element={<AdminUsersPage />} />
    <Route path="/admin/chats" element={<AdminChatsPage />} />
    <Route path="/admin/logs" element={<AdminLogsPage />} />
    <Route path="/admin/guidelines" element={<AdminGuidelinesPage />} />
    <Route path="/admin/rag" element={<AdminRagPage />} />
  </Route>
</Routes>
```

All page components are lazy-loaded via `React.lazy()` so only the code for the current route is downloaded on first navigation.

### 12.2 Secure Storage

`secureStorage.ts` wraps `localStorage` with AES encryption so that user data and tokens stored client-side are not readable in plaintext via browser devtools or XSS. The encryption key is derived from a build-time env var (`VITE_STORAGE_KEY`). All `AuthContext` reads and writes go through this wrapper.

### 12.3 Auth State (AuthContext)

Global authentication state is managed via React Context. `AuthContext` holds the current user object and exposes `login` / `logout` helpers. State is persisted to `secureStorage` so the user remains logged in across page refreshes:

```tsx
// frontend/src/contexts/AuthContext.tsx (simplified)
interface AuthContextValue {
  user: User | null;
  login: (credentials: LoginPayload) => Promise<void>;
  logout: () => void;
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState<User | null>(
    secureStorage.get("user")   // rehydrate from encrypted localStorage
  );

  const login = async (credentials) => {
    const { user } = await api.post("/auth/login", credentials);
    secureStorage.set("user", user);
    setUser(user);
  };

  const logout = () => {
    secureStorage.remove("user");
    setUser(null);
    navigate("/login");
  };

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
};
```

The `useAuth()` hook is the single point of access to auth state across all components — no prop drilling.

### 12.4 API Client & Token Refresh Singleton

The `api.ts` module is the single HTTP client used across all of the frontend. It wraps the browser's native `fetch` API (rather than Axios — the frontend uses `fetch` directly) and handles authentication header injection, 401 token refresh, and error normalisation in a central place.

**Token injection.** Every outgoing request calls `authHeaders()` which reads the access token from `secureStorage` and returns an `Authorization: Bearer <token>` header if present. This happens on every call rather than at request construction time, so a freshly issued access token is always used even if it was stored after the request object was created.

**Single in-flight token refresh.** When an access token expires, multiple concurrent API requests may all receive a 401 simultaneously. Without coordination, each would independently call `POST /auth/refresh`, potentially consuming the refresh token multiple times or creating a race condition. The module-level `refreshInFlight` variable prevents this:

```ts
// frontend/src/services/api.ts
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSessionRequest(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const res = await fetch(apiUrl('/auth/refresh'), {
        method: 'POST', credentials: 'include',    // send HttpOnly refresh cookie
      });
      if (res.ok) persistSession(await res.json());
      return res.ok;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;   // second caller awaits the same Promise
}
```

When the first 401 triggers a refresh, `refreshInFlight` is set to the in-flight Promise. Any subsequent 401s that arrive before the refresh completes also call `refreshSessionRequest()` — they detect `refreshInFlight` is non-null and return the same Promise. All callers wait for the single refresh to finish, then retry their original request with the new access token. After the refresh completes (success or failure), `finally` sets `refreshInFlight = null` so the next expiry cycle can start fresh.

**Login requests skip the refresh retry.** `apiFetch` accepts a `skipAuthRefresh` flag. Login and registration calls set this to `true` — a 401 from the login endpoint means wrong credentials, not an expired token, and should never trigger a silent refresh attempt.

**FastAPI 422 error normalisation.** When a backend Pydantic validation fails, FastAPI returns a 422 with a JSON body of `{detail: [{loc, msg, type}, ...]}`. The `handleResponse` function detects this shape (an array `detail`) and joins the `msg` fields into a single human-readable string. A plain 400 error arrives as `{detail: "some message"}` (a string). Both shapes are extracted cleanly, ensuring the UI always receives a displayable error string rather than a raw JSON object or `[object Object]`.

### 12.5 Page & Component Structure

```
src/
├── pages/
│   ├── auth/          LoginPage, RegisterPage, ForgotPasswordPage,
│   │                  ResetPasswordPage, VerifyEmailPage, ResendVerificationPage
│   ├── gp/            GPQueriesPage, GPNewQueryPage, GPQueryDetailPage
│   ├── specialist/    SpecialistQueriesPage, SpecialistQueryDetailPage,
│   │                  SpecialistQueryDetailView, SpecialistReviewModals
│   │
│   │  SpecialistQueryDetailView renders a consultation-level action panel
│   │  (visible when canReview=true) with five buttons: Approve and Send,
│   │  Request Revision, Replace with Manual Response, Send Comment to GP,
│   │  and Unassign. Per-message review controls (approve/reject/edit) are
│   │  rendered inside a <details> element so they are collapsed by default,
│   │  demoting them to an advanced/secondary workflow.
│   │  SpecialistReviewModals contains all modal dialogs: ApproveConfirm,
│   │  ApproveWithComment, RequestChanges, ManualResponse, EditResponse,
│   │  CloseApprove, SendComment, and UnassignConfirm.
│   ├── admin/         AdminDashboardPage, AdminUsersPage, AdminChatsPage,
│   │                  AdminLogsPage, AdminGuidelinesPage, AdminRagPage
│   └── ProfilePage, LandingPage, NotFoundPage, AccessDeniedPage
├── components/
│   ├── ChatInput.tsx          — message input with file attachment trigger
│   ├── ChatMessage.tsx        — message bubble: streaming content + inline citations
│   ├── NotificationDropdown.tsx — bell icon with unread badge and dropdown list
│   ├── ProtectedRoute.tsx     — role-based route guard, redirects on mismatch
│   ├── AdminLayout.tsx        — sidebar navigation layout for all /admin/* pages
│   ├── PasswordStrengthMeter.tsx — real-time password strength indicator
│   ├── ErrorBoundary.tsx      — catches render errors, shows fallback UI
│   └── LoadingSkeleton.tsx    — skeleton placeholders for list/detail views
├── contexts/
│   └── AuthContext.tsx        — global user state (see §12.3)
├── hooks/
│   └── useChatStream.ts       — manages SSE lifecycle (see §12.6)
├── services/
│   └── api.ts                 — Axios instance with interceptors (see §12.4)
└── utils/
    ├── secureStorage.ts       — encrypted localStorage wrapper (see §12.2)
    ├── chatStream.ts          — SSE event parser
    ├── errors.ts              — FastAPI error normalisation (string vs. 422 array)
    └── messageMapping.ts      — maps API message objects to UI display types
```

### 12.6 useChatStream Hook (5-Phase State Machine)

`useChatStream` is the frontend's primary SSE lifecycle manager. It implements a five-phase state machine that handles connection, streaming, completion, and graceful degradation to polling.

**The five phases:**

```
idle → connecting → streaming → completed → (back to idle after reconciliation)
                ↘ (timeout / error)
                  fallback_polling → idle
```

- **idle** — no SSE connection, no polling.
- **connecting** — `EventSource` opened, waiting for `stream_start`. If `stream_start` does not arrive within `connectTimeout` (default 500 ms), the hook transitions to `fallback_polling` rather than waiting indefinitely.
- **streaming** — `stream_start` received; messages state is being updated on every `content` event. The SSE connection remains open.
- **completed** — `complete` event received; final content and citations applied. The hook calls `onRefresh()` to reconcile local state with the server's persisted version, then transitions to `idle`.
- **fallback_polling** — SSE connection failed or timed out; the hook polls `onRefresh()` on an exponential backoff schedule starting at `pollInterval` (default 2 s), multiplying by 1.5 after each poll, capping at 30 seconds.

**Connection cleanup pattern.** The currently active `EventSource` cleanup function is stored in `cleanupRef` (a `useRef`). When `connectStream` is called while a previous connection exists, the old cleanup runs first — preventing duplicate subscriptions. When the component unmounts, `useEffect` cleanup calls `cleanupRef.current?.()` and clears any pending poll timer. The `mountedRef` guard prevents `setPhase` calls from running on an already-unmounted component, which would produce React state-update warnings.

**Chat ID change cleanup.** A second `useEffect` with `[chatId]` as dependency cleans up the connection and resets to `idle` whenever the user navigates between consultations. This prevents a stream from one chat's generation leaking into a different chat's UI.

**Message state ownership.** The hook receives `setMessages` as a constructor argument rather than managing its own messages state. This means the page component retains ownership of the message list, making it easier to apply non-streaming updates (e.g. a full refetch after reconciliation) without the hook needing to coordinate. The hook calls `setMessages` with a functional updater (`prev => ...`) to avoid stale closures.

### 12.7 Frontend Input Validation & Error Messages

The frontend applies two layers of validation: client-side before the API call (for fast, synchronous feedback) and server-side Pydantic validation as a backstop (for anything that slips through or is sent directly via API tools).

**Client-side field validation.** Every form with user input runs a synchronous validation pass on submit before making any network request. Errors are collected into a `fieldErrors` record (type `Record<string, string>`) rather than stopping at the first failure — this means all problems are shown at once rather than one at a time. The validation logic mirrors the backend rules precisely so the two never disagree:

- Email: trimmed and lowercased, then checked against a basic RFC-5322-style regex. Normalisation happens before validation so `" User@Example.COM "` is treated the same as `user@example.com`.
- Password: must be ≥8 characters with at least one uppercase letter, one lowercase letter, one digit, and one special character. The same rule is enforced in `auth_service.py` on the backend.
- Confirm password: compared directly against the password field — mismatch produces a specific message ("Passwords do not match") rather than a generic error.
- Specialist specialty: conditionally required — if the selected role is `"specialist"`, a non-empty specialty must be chosen.

**Clearing errors on change.** Each field clears its own `fieldErrors` entry as soon as the user types, via `setFieldErrors(prev => ({ ...prev, [name]: '' }))` in the `onChange` handler. This avoids the frustrating experience of stale red error text sitting under a field the user has already fixed.

**Per-field vs global errors.** The two error types serve different purposes. `fieldErrors` is displayed inline under each specific input. A separate top-level `error` string (`useState<string>('')`) holds unexpected API errors — network failures, server 500s, or validation rejections from the backend that did not correspond to a specific field. This is displayed as a prominent alert banner at the top of the form rather than attached to any single field.

**Password strength meter.** The `PasswordStrengthMeter` component gives real-time visual feedback during typing, separate from the form validation. It computes a strength score (weak / fair / strong) and renders a colour-coded progress bar. The registration form only blocks submission when `isStrongPassword()` returns false; the strength meter is purely informational and does not gate submission.

**Error normalisation.** FastAPI validation errors for a 422 response arrive as an array of objects, each with a `loc` (field path) and `msg`. A human-readable description arrives as a plain string on a 400. The `getErrorMessage()` utility (`utils/errors.ts`) handles both shapes and returns a displayable string, preventing raw `[object Object]` from appearing in the UI.

### 12.8 Form, Data, and Error State Management

All page-level components follow a consistent three-tier state architecture. Understanding this pattern makes the pages predictable and testable.

**Loading state** (`loading: boolean`) covers the initial page mount — while the primary data fetch is in flight, the page renders a centred `Loader2` spinner rather than a blank or partially populated view. Once the first fetch resolves (success or error), `loading` is set to `false` and is never re-raised for subsequent refreshes. This prevents layout shift on data refetches.

**Data state** is the main resource held in component state — typically `chat: BackendChatWithMessages | null` and `messages: Message[]` for detail pages, or a list type for list pages. The `null` initial value is deliberate: components guard on `if (!chat)` and render a "not found" fallback rather than crashing on undefined property access. After a mutation (an API call that modifies data), the component calls `loadData()` to refetch and reconcile state from the server rather than attempting to apply optimistic local patches — except for the specific case of appended specialist messages, which use an optimistic append with a temporary ID that is replaced on the next full fetch.

**Action loading state** (`actionLoading: boolean`) is separate from page-load `loading`. It is set to `true` when a mutation (approve, reject, send comment, etc.) is in-flight and cleared in the `finally` block regardless of outcome. While `actionLoading` is true, all action buttons are `disabled` and show a spinner or "…" suffix in their label. This prevents double-submit bugs where a slow API response causes the user to click again.

**Error state** (`error: string`) holds the most recent error message. It is cleared at the start of every action handler (`setError('')`) so a previous stale error does not persist while a new action is running. On success it stays empty; on failure it is set from `getErrorMessage(err, '<fallback>')`. The UI renders the error as a visible banner inside the page rather than a browser `alert()`, so the user does not lose the context of what they were doing.

**Abort controller pattern.** Page-load fetches create an `AbortController` stored in a `useRef`. When the component unmounts or the `loadData` callback is re-invoked (because `chatId` changed), the previous controller is aborted before the new request starts. The `ifNotAbortError()` utility suppresses the resulting `DOMException` (which is expected and harmless) while still surfacing genuine network errors to the user.

---

*Implementation documentation for Ambience-AI-1.5 — branch `main` — March 2026*
