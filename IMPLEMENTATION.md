# Ambience AI — Implementation Documentation

> Ambience AI is a clinical consultation platform that connects GPs and Specialists via AI-assisted triage. This document explains how each key feature is implemented — which libraries and frameworks are used, how they are wired together, and relevant code snippets to help readers understand the codebase.

---

## Table of Contents

1. [Database Connection & ORM Models](#1-database-connection--orm-models)
2. [Authentication, Session Management & Security](#2-authentication-session-management--security)
3. [GP Workflow](#3-gp-workflow)
4. [Specialist Review Workflow](#4-specialist-review-workflow)
5. [AI Response Generation & RAG Pipeline](#5-ai-response-generation--rag-pipeline)
6. [Real-Time Streaming (SSE)](#6-real-time-streaming-sse)
7. [File Attachment System](#7-file-attachment-system)
8. [Notification System](#8-notification-system)
9. [Caching Layer](#9-caching-layer)
10. [Admin Panel](#10-admin-panel)
11. [Frontend Architecture](#11-frontend-architecture)

---

## 1. Database Connection & ORM Models

### Libraries Used

| Library | Purpose |
|---|---|
| `SQLAlchemy 2.0` | ORM with declarative typed mapping |
| `alembic` | Schema migration management |
| `psycopg2-binary` | Synchronous PostgreSQL driver |
| `asyncpg` | Asynchronous PostgreSQL driver (used for the AI generation path) |
| `PostgreSQL JSONB` | Native JSON column type for flexible structured data |

### 1.1 Dual-Mode Session Configuration

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

### 1.2 Declarative Base

All models share a single `Base` class so Alembic can auto-detect schema changes:

```python
# backend/src/db/base.py
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass
```

### 1.3 User Model

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

### 1.4 Chat Model

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

### 1.5 Message Model

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

### 1.6 Notification Model

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

### 1.7 Database Migrations (Alembic)

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

---

## 2. Authentication, Session Management & Security

### Libraries Used

| Library | Purpose |
|---|---|
| `python-jose` / `PyJWT` | JWT encoding, decoding, and verification |
| `passlib[bcrypt]` | Password hashing and verification using bcrypt |
| `fastapi.security.OAuth2PasswordBearer` | Extracts Bearer token from `Authorization` header |
| `python-multipart` | Parses OAuth2 form data |

### 2.1 Password Hashing

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

### 2.2 JWT Token Creation

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

The `session_version` field allows immediate token revocation — incrementing a user's `session_version` in the database invalidates all previously issued tokens without a blocklist.

### 2.3 Token Decoding & Verification

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

### 2.4 FastAPI Dependency Injection

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

### 2.5 Auth Cookies

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

### 2.6 Sequence Diagram — Login Flow

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

### 2.7 Password Reset & Email Verification Tokens

These are one-time secure random tokens, stored as SHA-256 hashes in the database (not as JWTs):

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

### 2.8 Auth Endpoint Rate Limiting

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

### 2.9 Profile Management

Users can update their own profile via `PATCH /auth/profile`:

```python
class ProfileUpdate(BaseModel):
    full_name:    str | None = None
    specialty:    str | None = None    # specialists only
    new_password: str | None = None
    current_password: str | None = None   # required when changing password
```

Password changes require the current password for verification. The new password must pass the same strength requirements enforced on registration. After a successful update the response includes a fresh access token so the frontend does not need to re-authenticate.

### 2.10 Nginx Reverse Proxy

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

### 2.11 HTTP Security Headers Middleware

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

---

## 4. Specialist Review Workflow

### Libraries Used

| Library | Purpose |
|---|---|
| `FastAPI` | HTTP endpoint |
| `Pydantic v2` | Request validation using `Literal` type for the action field |
| `SQLAlchemy` | Database updates within a transaction |

### 4.1 Assigning a Consultation

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

### 4.2 Review Action Schema

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

### 4.3 Consultation-Level Review Dispatcher

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

### 4.4 AI Revision (Request Changes Flow)

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

### 4.5 Per-Message Review

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

### 4.6 Sequence Diagram — Manual Response Action

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

## 5. AI Response Generation & RAG Pipeline

### Libraries Used (RAG Service)

| Library | Purpose |
|---|---|
| `sentence-transformers` (`all-MiniLM-L6-v2`) | Embeds queries into 384-dimensional vectors |
| `pgvector` | PostgreSQL extension for cosine similarity vector search |
| `cross-encoder/ms-marco-MiniLM-L-6-v2` | Cross-encoder model for reranking retrieved chunks |
| `httpx` | Async HTTP client for streaming from Ollama |
| `pdfplumber` | PDF text extraction for uploaded file context |

### 5.1 Overview of Generation Flow

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

### 5.2 Document Ingestion Pipeline

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

The process per section group:
1. Table blocks → one chunk each (atomic, no splitting)
2. Text blocks grouped by identical `section_path`
3. Short sections (<150 tokens) merged with the next group (up to 2 merges)
4. Remaining text split into sentence-aligned chunks using NLTK `sent_tokenize`
5. 80-token overlap carried forward into the next chunk from the tail of the previous one — overlap is reset at section boundaries
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

### 5.3 The RAG Retrieval Pipeline (8 Stages)

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

### 5.4 Hybrid Search: Vector + Keyword

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

### 5.5 Reciprocal Rank Fusion

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

### 5.6 LLM Provider Routing

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

### 5.7 Prompt Construction & Injection Protection

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

### 5.8 Conversation History in RAG Context

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

### 5.9 Generation Retry Worker (RQ)

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

### 5.10 Inter-Service Authentication (Internal API Key)

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

### 5.11 Query Expansion with Medical Term Mapping

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

### 5.12 Specialty-Scoped Retrieval (FilterConfig)

The RAG `/ask` endpoint accepts an optional `FilterConfig` to restrict retrieval to specific sources or documents — enabling future specialty-scoped retrieval (e.g. cardiology guidelines only) without changing the embedding model:

```python
# rag_service/src/models/schemas.py
class FilterConfig(BaseModel):
    source_names: list[str] | None = None   # restrict to named sources
    doc_ids:      list[str] | None = None   # restrict to specific documents
    min_score:    float | None = None       # override minimum similarity threshold
```

If omitted, all indexed documents are searched.

### 5.13 Canonical Query Rewriting

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

---

## 6. Real-Time Streaming (SSE)

### Libraries Used

| Library | Purpose |
|---|---|
| `asyncio` | Async event loop, queues, and locks |
| `FastAPI StreamingResponse` | HTTP streaming response |
| `EventSource` (browser API) | Frontend SSE subscription |
| `httpx` (async) | Streaming HTTP client to RAG service |

Server-Sent Events (SSE) deliver AI-generated tokens to the browser in real time without polling. The architecture uses an in-process event bus keyed by `chat_id`.

### 6.1 Backend: Event Bus

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

### 6.2 Backend: SSE Endpoint

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

### 6.3 Backend: Publishing Events During Generation

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

### 6.4 Frontend: SSE Subscription

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

### 6.5 Frontend: Message State Management

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

### 6.6 SSE Polling Fallback

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

### 6.7 Sequence Diagram — Full Streaming Flow

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

---

## 7. File Attachment System

### Libraries Used

| Library | Purpose |
|---|---|
| `python-multipart` | Parses `multipart/form-data` upload requests |
| `pdfplumber` | Extracts text content from PDF files for RAG context |
| `aiofiles` / `Path.write_bytes` | Saves uploaded files to disk |

### 7.1 Upload Endpoint

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

### 7.2 File Validation and Storage

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

### 7.3 File Content in RAG Context

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

---

## 10. Admin Panel

The Admin Panel is a protected section of the frontend accessible only to users with `role = "admin"`. It provides operational oversight of the entire platform — users, consultations, audit logs, clinical guidelines, and the RAG pipeline — without requiring direct database or container access.

### Libraries Used

| Library | Purpose |
|---|---|
| `recharts` | Bar/line charts for dashboard statistics visualisation |
| `react-router-dom` | `/admin/*` route definitions and `AdminLayout` sidebar nav |
| `axios` | API calls for all admin endpoints (users, chats, logs, RAG) |
| `fastapi` | Admin-only route group with role-guard dependency |
| `SQLAlchemy` | Aggregation queries for stats, user/chat/log pagination |

### 10.1 Dashboard Statistics & Visualisation

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

### 10.2 User Management

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

### 10.3 All-Chat Oversight & Search

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

### 10.4 Audit Logging

Every significant action is recorded to an `audit_logs` table for security compliance and debugging.

#### Libraries Used

| Library | Purpose |
|---|---|
| `SQLAlchemy` | ORM model for `audit_logs` table and async inserts |
| `fastapi` | Route handler for admin audit log retrieval endpoint |

#### Usage

```python
# Called throughout service layer — example from specialist_review.py
audit_repository.log(
    db,
    user_id=specialist.id,
    action="REVIEW_MANUAL_RESPONSE",
    details=f"Chat {chat_id} closed with manual response by specialist",
)
```

#### Actions Logged by Category

| Category | Actions |
|---|---|
| **AUTH** | `LOGIN`, `REGISTER`, `LOGOUT`, `UPDATE_PROFILE`, `PASSWORD_RESET` |
| **CHAT** | `CREATE_CHAT`, `UPDATE_CHAT`, `SUBMIT_FOR_REVIEW`, `VIEW_CHAT` |
| **SPECIALIST** | `ASSIGN_SPECIALIST`, `REVIEW_APPROVE`, `REVIEW_REJECT`, `REQUEST_CHANGES`, `REVIEW_MANUAL_RESPONSE`, `SPECIALIST_COMMENT`, `SPECIALIST_UNASSIGN` |
| **RAG** | `RAG_ANSWER`, `RAG_ERROR`, `AI_RESPONSE_GENERATED` |

### 10.5 Audit Log Viewer

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

### 10.6 Guideline Management

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

### 10.7 RAG Queue Status Monitoring

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

## 11. Frontend Architecture

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

### 11.1 Application Routing

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

### 11.2 Secure Storage

`secureStorage.ts` wraps `localStorage` with AES encryption so that user data and tokens stored client-side are not readable in plaintext via browser devtools or XSS. The encryption key is derived from a build-time env var (`VITE_STORAGE_KEY`). All `AuthContext` reads and writes go through this wrapper.

### 11.3 Auth State (AuthContext)

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

### 11.4 Axios Interceptors

The Axios instance in `api.ts` attaches the access token to every outgoing request and handles 401 responses by attempting a silent token refresh before retrying the original request:

```ts
// frontend/src/services/api.ts
api.interceptors.request.use(config => {
  const token = secureStorage.get("access_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  res => res,
  async err => {
    if (err.response?.status === 401 && !err.config._retried) {
      err.config._retried = true;
      await api.post("/auth/refresh");   // refresh token is sent via httponly cookie
      return api(err.config);           // retry original request
    }
    return Promise.reject(err);
  }
);
```

### 11.5 Page & Component Structure

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

### 11.6 useChatStream Hook

`useChatStream` encapsulates the full SSE lifecycle for a single chat. Components mount it to start receiving tokens and unmount to clean up:

```ts
// frontend/src/hooks/useChatStream.ts (simplified)
export function useChatStream(chatId: number) {
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    const cleanup = subscribeToChatStream(chatId, {
      onStreamStart: () => setIsStreaming(true),
      onContent:     (content) => setStreamingContent(content),  // cumulative
      onComplete:    () => setIsStreaming(false),
      onError:       () => setIsStreaming(false),
    });
    return cleanup;   // closes EventSource on unmount
  }, [chatId]);

  return { streamingContent, isStreaming };
}
```

`GPQueryDetailPage` and `SpecialistQueryDetailPage` both consume this hook. The `onContent` callback receives the full cumulative text on each event (not just the delta), so the component can simply replace its display string without concatenation logic.

---

*Implementation documentation for Ambience-AI-1.5 — branch `feature/rag-updates` — March 2026*
