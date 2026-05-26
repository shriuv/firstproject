import logging
import time
from typing import Union

import requests
from google import genai
from google.genai import types

from config import (
    GEMINI_API_KEY,
    CLASSIFIER_MODEL,
    LLM_PARSER_MODEL,
    CODE_GEN_PROVIDER,
    OPENROUTER_API_KEY,
    OPENROUTER_URL,
    NINEROUTER_API_KEY,
    NINEROUTER_MODEL,
    NINEROUTER_URL,
)

logger = logging.getLogger("ledgerai.llm_provider")

# ── Provider config ───────────────────────────────────────────────────────────

# Gemini model names → OpenRouter equivalents
_GEMINI_TO_OPENROUTER = {
    "models/gemini-2.5-flash":        "google/gemini-2.5-flash-preview",
    "models/gemini-2.5-flash-latest": "google/gemini-2.5-flash-preview",
    "models/gemini-2.0-flash":        "google/gemini-2.0-flash-001",
    "models/gemini-2.0-flash-lite-preview-02-05": "google/gemini-2.0-flash-lite-preview-02-05",
    "models/gemini-1.5-flash":        "google/gemini-1.5-flash",
    "models/gemini-1.5-pro":          "google/gemini-1.5-pro",
}

# Last-resort model when even Gemini-via-OpenRouter fails.
_OPENROUTER_FALLBACK_MODEL = "anthropic/claude-haiku-4-5"

# Retry settings for the Gemini direct path
_GEMINI_RETRY_ATTEMPTS = 3
_GEMINI_RETRY_DELAYS   = [2, 5, 10]   # seconds between retries

# ── Gemini client (reuse across calls) ───────────────────────────────────────
_gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


# ═════════════════════════════════════════════════════════════════════════════
# PUBLIC API
# ═════════════════════════════════════════════════════════════════════════════

def call_llm(
    prompt:  Union[str, None] = None,
    parts:   Union[list, None] = None,
    model:   str = None,
    temperature: float = 0,
) -> str:
    """
    Call the LLM with automatic fallback chain:
      1. 9router (local, cheapest — if NINEROUTER_API_KEY is set)
      2. Gemini direct (Google API)
      3. Gemini via OpenRouter
      4. Fallback model via OpenRouter (Claude Haiku)

    Args:
        prompt:      Plain text prompt (use this OR parts, not both).
        parts:       List of google.genai.types.Part objects for multimodal calls.
        model:       Gemini model string (e.g. "models/gemini-2.5-flash").
                     Defaults to LLM_PARSER_MODEL from config.
        temperature: Sampling temperature (default 0 for deterministic extraction).

    Returns:
        Model response as a plain string.

    Raises:
        RuntimeError: If all providers fail.
    """
    if model is None:
        model = LLM_PARSER_MODEL

    content = parts if parts is not None else prompt
    if content is None:
        raise ValueError("Either prompt or parts must be provided")

    errors = []

    # ── FALLBACK CHAIN ORCHESTRATION ──────────────────────────────────────────
    
    # We dynamically order the providers based on CODE_GEN_PROVIDER.
    # If the user explicitly set a provider in .env, we try it first.
    primary_provider = CODE_GEN_PROVIDER.lower()
    
    def try_ninerouter():
        if NINEROUTER_API_KEY:
            try:
                result = _call_ninerouter(prompt=prompt, parts=parts, model=model, temperature=temperature)
                logger.info("9router OK (model=%s)", model if model else NINEROUTER_MODEL)
                return result
            except Exception as e:
                err_str = str(e)
                errors.append(f"9router: {err_str}")
                logger.warning("9router failed: %s", err_str)
        return None

    def try_gemini_direct():
        if _gemini_client:
            for attempt in range(_GEMINI_RETRY_ATTEMPTS):
                try:
                    response = _gemini_client.models.generate_content(
                        model=model,
                        contents=content,
                        config=types.GenerateContentConfig(temperature=temperature),
                    )
                    logger.debug("Gemini direct OK (attempt %d)", attempt + 1)
                    return response.text.strip()
                except Exception as e:
                    err_str = str(e)
                    errors.append(f"gemini_direct[{attempt+1}]: {err_str}")
                    logger.warning("Gemini direct attempt %d failed: %s", attempt + 1, err_str)
                    if "503" in err_str and primary_provider != "gemini":
                        # If Gemini is at capacity and NOT our primary, fail fast to fallback
                        logger.info("Gemini 503 detected — failing fast to fallback")
                        break
                    if attempt < _GEMINI_RETRY_ATTEMPTS - 1:
                        time.sleep(_GEMINI_RETRY_DELAYS[attempt])
        return None

    def try_openrouter():
        if OPENROUTER_API_KEY:
            # Map Gemini model to OR equivalent
            or_model = _GEMINI_TO_OPENROUTER.get(model, "google/gemini-2.0-flash-001")
            try:
                result = _call_openrouter(model=or_model, prompt=prompt, parts=parts, temperature=temperature)
                logger.info("OpenRouter Gemini fallback OK (model=%s)", or_model)
                return result
            except Exception as e:
                errors.append(f"openrouter_gemini: {e}")
                logger.warning("OpenRouter Gemini fallback failed: %s", e)
            
            # Last resort: Haiku
            try:
                result = _call_openrouter(model=_OPENROUTER_FALLBACK_MODEL, prompt=prompt, parts=parts, temperature=temperature)
                logger.info("OpenRouter fallback model OK (model=%s)", _OPENROUTER_FALLBACK_MODEL)
                return result
            except Exception as e:
                errors.append(f"openrouter_fallback: {e}")
                logger.warning("OpenRouter fallback model failed: %s", e)
        return None

    # Execute based on priority
    if primary_provider == "9router":
        res = try_ninerouter() or try_gemini_direct() or try_openrouter()
    elif primary_provider == "openrouter":
        res = try_openrouter() or try_gemini_direct() or try_ninerouter()
    else:
        # Default: Gemini first (historical default)
        res = try_gemini_direct() or try_ninerouter() or try_openrouter()

    if res:
        return res

    # ── All providers failed ──────────────────────────────────────────────────
    summary = " | ".join(errors)
    logger.error("All LLM providers failed: %s", summary)
    raise RuntimeError(
        f"All LLM providers failed. This is usually a temporary capacity issue — "
        f"please retry in a few seconds. Details: {summary}"
    )


# ═════════════════════════════════════════════════════════════════════════════
# INTERNAL HELPERS
# ═════════════════════════════════════════════════════════════════════════════

def _call_ninerouter(
    prompt: Union[str, None],
    parts: Union[list, None],
    temperature: float,
    model: str = None,
) -> str:
    """
    Call the 9router endpoint (OpenAI-compatible REST API, local proxy).
    Uses provided model or defaults to NINEROUTER_MODEL from config.
    """
    # Build messages from prompt or parts
    if prompt:
        messages = [{"role": "user", "content": prompt}]
    elif parts:
        text_parts = []
        for p in parts:
            if isinstance(p, str):
                text_parts.append(p)
            elif isinstance(p, types.Part) and hasattr(p, "text") and p.text:
                text_parts.append(p.text)
        combined = "\n".join(text_parts)
        if not combined.strip():
            raise ValueError("No text content extractable from parts for 9router")
        messages = [{"role": "user", "content": combined}]
    else:
        raise ValueError("No content to send")

    # If the model is a Gemini string, use NINEROUTER_MODEL instead
    target_model = model
    if not target_model or target_model.startswith("models/"):
        target_model = NINEROUTER_MODEL

    headers = {
        "Authorization": f"Bearer {NINEROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": target_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 8192,
        "stream": False,
    }

    # For local/proxy endpoints, use a much shorter timeout for connection establishment
    timeout = 120
    if "localhost" in NINEROUTER_URL or "127.0.0.1" in NINEROUTER_URL:
        timeout = 5
        
    resp = requests.post(NINEROUTER_URL, headers=headers, json=body, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()

    if "error" in data:
        raise RuntimeError(f"9router error: {data['error']}")

    return data["choices"][0]["message"]["content"].strip()


def _call_openrouter(
    model: str,
    prompt: Union[str, None],
    parts: Union[list, None],
    temperature: float,
) -> str:
    """
    Call any OpenRouter model using the OpenAI-compatible REST endpoint.

    For vision/multimodal calls (parts list), we extract the text portions.
    OpenRouter supports base64 images but NOT Google's types.Part objects —
    so PDF bytes are not forwarded (vision falls back to text-only on this path).
    """
    if prompt:
        messages = [{"role": "user", "content": prompt}]
    elif parts:
        # Extract text parts; skip raw bytes (PDF/image data)
        text_parts = []
        for p in parts:
            if isinstance(p, str):
                text_parts.append(p)
            elif isinstance(p, types.Part) and hasattr(p, "text") and p.text:
                text_parts.append(p.text)
        combined = "\n".join(text_parts)
        if not combined.strip():
            raise ValueError("No text content extractable from parts for OpenRouter")
        messages = [{"role": "user", "content": combined}]
    else:
        raise ValueError("No content to send")

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ledgerai.app",   # OpenRouter asks for this
        "X-Title": "LedgerAI",
    }
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 8192,
    }

    resp = requests.post(OPENROUTER_URL, headers=headers, json=body, timeout=120)
    resp.raise_for_status()
    data = resp.json()

    # OpenRouter returns OpenAI-format responses
    return data["choices"][0]["message"]["content"].strip()
