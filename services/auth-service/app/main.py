import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.organization_admins import (
    delete_organization_admin,
    precheck_organization_admin,
    provision_organization_admin,
    require_internal_key,
    update_organization_admin,
)
from app.security import hash_password, verify_password

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
    is_active: bool
    created_at: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def to_profile(user: User) -> UserProfile:
    return UserProfile(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        organization_id=str(user.organization_id) if user.organization_id else None,
        is_active=user.is_active,
        created_at=user.created_at.isoformat(),
    )


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        user_id = uuid.UUID(jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM]).get("sub"))
    except (JWTError, ValueError, TypeError):
        raise unauthorized
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise unauthorized
    return user


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
def register(payload: UserRegister, db: Session = Depends(get_db)):
    email = payload.email.lower()
    if len(payload.password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Password must be at least 8 characters")
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")

    # Public registration always creates a plain "user". Elevated roles are never self-assigned.
    user = User(
        email=email,
        full_name=payload.full_name,
        password_hash=hash_password(payload.password),
        role="user",
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:  # concurrent registration with the same email
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    db.refresh(user)
    return to_profile(user)


@app.post("/api/v1/auth/login", response_model=TokenResponse, tags=["Auth"])
def login(credentials: UserLogin, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == credentials.email.lower()))
    if not user or not verify_password(credentials.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is disabled")
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


@app.get("/api/v1/auth/me", response_model=UserProfile, tags=["Auth"])
def get_me(current_user: User = Depends(get_current_user)):
    return to_profile(current_user)


# ---------------------------------------------------------------------------
# Internal service-to-service API (not routed by the gateway, not in the public docs).
# Only the Organization Service holds the key. No role or organization can be chosen by a caller:
# the role is fixed and the organization id comes from the Organization Service's invitation record.
# ---------------------------------------------------------------------------
class OrganizationAdminProvision(BaseModel):
    organization_id: uuid.UUID
    full_name: str
    email: EmailStr
    password: str  # validated in code (not by pydantic) so a rejected password is never echoed back
    allow_weak_password: bool = False  # demo mode only; refused (403) unless DEMO_MODE is on


class OrganizationAdminResult(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    organization_id: str
    created: bool


class OrganizationAdminUpdate(BaseModel):
    organization_id: uuid.UUID
    email: EmailStr
    new_email: Optional[EmailStr] = None
    new_full_name: Optional[str] = None


class OrganizationAdminRef(BaseModel):
    organization_id: uuid.UUID
    email: EmailStr


@app.post("/internal/organization-admins/update", include_in_schema=False, dependencies=[Depends(require_internal_key)])
def update_admin(payload: OrganizationAdminUpdate, db: Session = Depends(get_db)):
    user = update_organization_admin(
        db,
        organization_id=payload.organization_id,
        email=str(payload.email),
        new_email=str(payload.new_email) if payload.new_email else None,
        new_full_name=payload.new_full_name,
    )
    return {"email": user.email, "full_name": user.full_name}


@app.post("/internal/organization-admins/delete", include_in_schema=False, dependencies=[Depends(require_internal_key)])
def delete_admin(payload: OrganizationAdminRef, db: Session = Depends(get_db)):
    return {"deleted": delete_organization_admin(db, organization_id=payload.organization_id, email=str(payload.email))}


class OrganizationAdminPrecheck(BaseModel):
    organization_id: uuid.UUID
    email: EmailStr


@app.post("/internal/organization-admins/precheck", include_in_schema=False, dependencies=[Depends(require_internal_key)])
def precheck_admin(payload: OrganizationAdminPrecheck, db: Session = Depends(get_db)):
    return {"state": precheck_organization_admin(db, organization_id=payload.organization_id, email=str(payload.email))}


@app.post(
    "/internal/organization-admins",
    response_model=OrganizationAdminResult,
    include_in_schema=False,
    dependencies=[Depends(require_internal_key)],
)
def provision_admin(payload: OrganizationAdminProvision, response: Response, db: Session = Depends(get_db)):
    result = provision_organization_admin(
        db,
        organization_id=payload.organization_id,
        full_name=payload.full_name,
        email=str(payload.email),
        password=payload.password,
        allow_weak_password=payload.allow_weak_password,
    )
    response.status_code = status.HTTP_201_CREATED if result.created else status.HTTP_200_OK
    user = result.user
    return OrganizationAdminResult(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        organization_id=str(user.organization_id),
        created=result.created,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=True)
