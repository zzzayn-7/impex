from datetime import datetime, timezone
from typing import Optional
from fastapi import FastAPI, HTTPException, status, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

app = FastAPI(
    title="Impex Auth Service",
    version="1.0.0",
    docs_url="/docs",
    openapi_url="/openapi.json"
)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Schemas
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
    expires_in: int = 3600


class UserProfile(BaseModel):
    id: str
    email: EmailStr
    full_name: str
    role: str
    organization_id: Optional[str] = None
    created_at: str


# Routes
@app.get("/health", tags=["Health"])
@app.get("/api/v1/auth/health", tags=["Health"])
async def health_check():
    return {
        "status": "healthy",
        "service": "auth-service",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }


@app.post("/api/v1/auth/register", response_model=UserProfile, status_code=status.HTTP_201_CREATED, tags=["Auth"])
async def register(user: UserRegister):
    return UserProfile(
        id="usr_01jk987xyz",
        email=user.email,
        full_name=user.full_name,
        role="admin",
        organization_id=user.organization_id,
        created_at=datetime.now(timezone.utc).isoformat()
    )


@app.post("/api/v1/auth/login", response_model=TokenResponse, tags=["Auth"])
async def login(credentials: UserLogin):
    if not credentials.email or not credentials.password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid credentials"
        )
    return TokenResponse(
        access_token="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_token_impex_auth",
        token_type="bearer",
        expires_in=3600
    )


@app.get("/api/v1/auth/me", response_model=UserProfile, tags=["Auth"])
async def get_current_user():
    return UserProfile(
        id="usr_01jk987xyz",
        email="admin@impex.local",
        full_name="Super Admin",
        role="super-admin",
        organization_id="org_root",
        created_at=datetime.now(timezone.utc).isoformat()
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

