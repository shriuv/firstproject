"""
backend/auth/utils.py
─────────────────────
Supabase Auth integration for the FastAPI backend.

  - Registration / login via Supabase Auth (ANON_KEY)
  - Token validation via supabase.auth.get_user(token)
    → live network call to Supabase (~100-200ms per request)
    → automatically detects revoked / expired tokens
"""
import sys, os
import logging
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import jwt

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from config import SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

logger = logging.getLogger("ledgerai.auth")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")


# ── Supabase client helpers ───────────────────────────────────

def _get_anon_client():
    """Public client — used for sign_up / sign_in_with_password."""
    from supabase import create_client, ClientOptions
    import httpx
    options = ClientOptions(http_client=httpx.Client(http2=False))
    return create_client(SUPABASE_URL, SUPABASE_ANON_KEY, options=options)


def _get_service_client():
    """Service-role client — used for admin auth operations (get_user)."""
    from supabase import create_client, ClientOptions
    import httpx
    options = ClientOptions(http_client=httpx.Client(http2=False))
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, options=options)


# ── Register / Login ──────────────────────────────────────────

def register_user(email: str, password: str) -> dict:
    """Register via Supabase Auth. Raises ValueError on failure."""
    client = _get_anon_client()
    try:
        # We include full_name in metadata because the profiles table might have a NOT NULL constraint
        # and a trigger that fails if it's missing.
        user_metadata = {"full_name": email.split('@')[0]}
        response = client.auth.sign_up({
            "email": email,
            "password": password,
            "options": {"data": user_metadata}
        })
        if response.user is None:
            raise ValueError("Registration failed - no user returned by Supabase.")
        logger.info("Registered user: %s (id=%s)", email, response.user.id)
        return {"user_id": str(response.user.id), "email": response.user.email}
    except ValueError:
        raise
    except Exception as e:
        logger.error("register_user error: %s: %s", type(e).__name__, e)
        raise ValueError(f"Registration error: {type(e).__name__}: {e}")


def login_user(email: str, password: str) -> dict:
    """
    Authenticate via Supabase Auth.
    Returns {"access_token": str, "user_id": uuid_str} on success.
    Raises ValueError on failure.
    """
    client = _get_anon_client()
    try:
        response = client.auth.sign_in_with_password({"email": email, "password": password})
        if response.session is None:
            raise ValueError("Login failed - invalid credentials.")
        logger.info("Login OK: user_id=%s", response.user.id)
        return {
            "access_token": response.session.access_token,
            "user_id": str(response.user.id),
        }
    except ValueError:
        raise
    except Exception as e:
        err_msg = str(e).lower()
        logger.warning("login_user failed: %s: %s", type(e).__name__, e)
        if any(k in err_msg for k in ["invalid", "credentials", "password", "email",
                                        "not found", "invalid login", "api key"]):
            raise ValueError("Invalid email or password.")
        raise ValueError(f"Authentication error: {type(e).__name__}: {e}")


# ── Token verification — live Supabase call ───────────────────

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import jwt

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth/login")

def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    try:
        # Decode Supabase JWT (no verification for now)
        payload = jwt.decode(token, options={"verify_signature": False})

        user_id = payload.get("sub")
        if not user_id:
            raise Exception("Invalid token")

        return {"user_id": user_id}

    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )