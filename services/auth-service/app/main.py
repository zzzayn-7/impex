import hashlib
import hmac
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr

# ---------------------------------------------------------------------------
# Config (from environment, see .env.example)
# ---------------------------------------------------------------------------
SECRET_KEY = os.getenv("SECRET_KEY", "default_dev_secret_key_change_me")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "60"))

app = FastAPI(
    title="Impex Auth Service",
    version="1.0.0",
    docs_url="/docs",
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class UserRegister(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    organization_id: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserProfile(BaseModel):
    id: str
    email: EmailStr
    full_name: str
    role: str
    organization_id: Optional[str] = None
    created_at: str


# ---------------------------------------------------------------------------
# In-memory storage (replace with a real database later)
# keyed by lowercase email
# ---------------------------------------------------------------------------
users_db: Dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt_hex, digest_hex = stored.split("$")
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 200_000)
    return hmac.compare_digest(digest.hex(), digest_hex)


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def to_profile(user: dict) -> UserProfile:
    return UserProfile(**{k: v for k, v in user.items() if k != "password_hash"})


async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        user_id = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM]).get("sub")
    except JWTError:
        raise unauthorized
    for user in users_db.values():
        if user["id"] == user_id:
            return user
    raise unauthorized


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health", tags=["Health"])
@app.get("/api/v1/auth/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "auth-service",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/v1/auth/register", response_model=UserProfile, status_code=status.HTTP_201_CREATED, tags=["Auth"])
async def register(payload: UserRegister):
    email = payload.email.lower()
    if email in users_db:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    if len(payload.password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Password must be at least 8 characters")

    user = {
        "id": f"usr_{uuid.uuid4().hex[:12]}",
        "email": email,
        "full_name": payload.full_name,
        # First registered user becomes super-admin; everyone else is a plain user
        "role": "super-admin" if not users_db else "user",
        "organization_id": payload.organization_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "password_hash": hash_password(payload.password),
    }
    users_db[email] = user
    return to_profile(user)


@app.post("/api/v1/auth/login", response_model=TokenResponse, tags=["Auth"])
async def login(credentials: UserLogin):
    user = users_db.get(credentials.email.lower())
    if not user or not verify_password(credentials.password, user["password_hash"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    return TokenResponse(
        access_token=create_access_token(user["id"]),
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@app.get("/api/v1/auth/me", response_model=UserProfile, tags=["Auth"])
async def get_me(current_user: dict = Depends(get_current_user)):
    return to_profile(current_user)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=True)
