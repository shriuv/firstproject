"""
backend/db/connection.py
────────────────────────
Supabase client singleton for database access (backend process).

Uses SUPABASE_SERVICE_ROLE_KEY so all server-side operations
bypass Row Level Security (RLS) — correct for backend services.
"""

from supabase import create_client, Client, ClientOptions
import httpx
import threading
import logging
import sys, os

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from config import SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

logger = logging.getLogger("ledgerai.db")

# ── Singleton for FastAPI request handlers ───────────────────────────────────
_client: Client | None = None

# ── Thread-local storage for background thread overrides ─────────────────────
# When process_document() runs in a background thread, it calls set_thread_client()
# with a freshly created client. Every repo call in that thread then picks up
# this override via get_client() instead of the shared singleton — giving the
# thread its own HTTP/2 connection pool, fully isolated from request handlers.
_thread_local = threading.local()


def get_client() -> Client:
    """Return the active Supabase client for the current thread.

    - In background threads that called set_thread_client(): returns the
      thread-local isolated client.
    - In FastAPI request handlers (and everywhere else): returns the singleton.

    This single function is the only thing repo files need to call — no
    changes required in any repository file to support thread isolation.
    """
    # Thread-local override takes priority (set by processing pipeline threads)
    thread_client = getattr(_thread_local, "client", None)
    if thread_client is not None:
        return thread_client

    # Fall back to the shared singleton
    global _client
    if _client is None:
        if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
            )
        options = ClientOptions(httpx_client=httpx.Client(http2=False))
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, options=options)
        logger.info("Supabase service-role client initialised.")
    return _client


def make_client() -> Client:
    """Create and return a brand-new Supabase client.

    Call this once per background thread, then pass the result to
    set_thread_client() so all repo calls in that thread use it automatically.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env"
        )
    options = ClientOptions(httpx_client=httpx.Client(http2=False))
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, options=options)


def set_thread_client(client: Client) -> None:
    """Register a client as the override for the current thread.

    Called at the start of process_document() so every repo function in
    the pipeline automatically uses this isolated client.
    """
    _thread_local.client = client


def clear_thread_client() -> None:
    """Remove the thread-local client override.

    Called in the finally block of process_document() to release the
    reference once processing completes (success or failure).
    """
    _thread_local.client = None