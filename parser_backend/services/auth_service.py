"""
services/auth_service.py
────────────────────────
User authentication via Supabase Auth (ANON_KEY for client-side auth).
user_id is a UUID string (Supabase auth.users.id).
"""

import logging
from config import SUPABASE_URL, SUPABASE_ANON_KEY

logger = logging.getLogger("ledgerai.auth_service")


def _get_auth_client():
    """Auth operations use the ANON_KEY (public client)."""
    from supabase import create_client, ClientOptions
    import httpx
    options = ClientOptions(httpx_client=httpx.Client(http2=False))
    return create_client(SUPABASE_URL, SUPABASE_ANON_KEY, options=options)


def register_user(email: str, password: str) -> str:
    """
    Register via Supabase Auth.
    Returns the new user UUID on success. Raises ValueError on failure.
    """
    client = _get_auth_client()
    try:
        # Default full_name from email to satisfy profiles table constraints/triggers
        user_metadata = {"full_name": email.split('@')[0]}
        response = client.auth.sign_up({
            "email": email,
            "password": password,
            "options": {"data": user_metadata}
        })
        if response.user is None:
            raise ValueError("Registration failed - no user returned by Supabase.")
        logger.info("Registered user_id=%s email=%s", response.user.id, email)
        return str(response.user.id)
    except ValueError:
        raise
    except Exception as e:
        logger.error("register_user error: %s: %s", type(e).__name__, e)
        raise ValueError(f"Registration error: {type(e).__name__}: {e}")


def login_user(email: str, password: str):
    """
    Authenticate via Supabase Auth.
    Returns (user_id_str, access_token) on success, None on failure.
    """
    client = _get_auth_client()
    try:
        response = client.auth.sign_in_with_password({"email": email, "password": password})
        if response.session is None:
            return None
        logger.info("Login: user_id=%s", response.user.id)
        return str(response.user.id), response.session.access_token
    except Exception as e:
        logger.warning("Login failed: %s: %s", type(e).__name__, e)
        return None
