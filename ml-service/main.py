from contextlib import asynccontextmanager
import os
import json
import re
import math
from typing import Optional, List, Dict, Set
from collections import Counter

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer
import uvicorn
from dotenv import load_dotenv

from app_logger import get_logger

# --- CONFIGURATION ---
load_dotenv()
logger = get_logger("ml-service")

class TextRequest(BaseModel):
    text: str

class BatchTextRequest(BaseModel):
    texts: List[str]
    anchors: Optional[List[str]] = []

# --- 100% DICTIONARY-FREE DYNAMIC NLP ENGINE (V7) ---
class FinancialNLPPipeline:
    """
    V7: Substring-Aware Dynamic Anchoring and Broken Word Recovery.
    """

    FUNCTIONAL_JUNK = {
        'PAYMENT', 'ONLINE', 'THRU', 'VIA', 'SUCCESS', 'TXN', 'TRAN', 
        'TRANSFER', 'FROM', 'REMIT', 'DEBIT', 'CREDIT', 'PAYMENTFROMPHONE'
    }

    def is_semantic_word(self, token: str) -> bool:
        token = token.upper()
        if any(c.isdigit() for c in token): return False
        vowels = re.findall(r'[AEIOU]', token)
        if not vowels: return False
        if len(token) <= 3 and len(vowels) < 1: return False # Allow OLA, TEA
        if token in self.FUNCTIONAL_JUNK: return False
        return True

    def get_entropy(self, word: str) -> float:
        if not word: return 0
        prob = [float(word.count(c)) / len(word) for c in dict.fromkeys(list(word))]
        return - sum([p * math.log(p) / math.log(2.0) for p in prob])

    def distill(self, text: str, batch_context: List[str] = None, anchors: Set[str] = None) -> str:
        if not text: return ""
        text = text.upper()
        
        # 1. Broken Word Recovery: Join isolated single letters to previous word (e.g. OL A -> OLA)
        text = re.sub(r'([A-Z]+)\s+([A-Z])\b', r'\1\2', text)
        
        # 2. Structural Removal
        text = re.sub(r'@[A-Z0-9]+', '', text) 
        text = re.sub(r'[A-Z0-9]+-', '', text) 
        
        # 3. Tokenization
        tokens = re.findall(r'[A-Z]{2,}', text)
        
        # 4. SUBSTRING DYNAMIC ANCHORING
        # If any token contains a category anchor (e.g. MEDICAL in SHREESAIMEDICAL)
        if anchors:
            for t in tokens:
                for a in anchors:
                    if len(a) > 3 and a in t:
                        return a # Return the CLEAN anchor word (e.g. MEDICAL)

        # 5. Discovery
        batch_counts = Counter()
        if batch_context:
            for doc in batch_context:
                batch_counts.update(set(re.findall(r'[A-Z]{2,}', doc.upper())))
        batch_size = len(batch_context) if batch_context else 1

        # 6. Semantic Sieve
        semantic_core = []
        for i, t in enumerate(tokens):
            if batch_counts[t] / batch_size > 0.40: continue
            if not self.is_semantic_word(t): continue
            
            v_density = len(re.findall(r'[AEIOU]', t)) / len(t)
            min_density = 0.20 if len(t) > 8 else 0.30 
            
            if min_density < v_density < 0.6 and 2.2 < self.get_entropy(t) < 3.8 and i < 2:
                if len(tokens) > 1: continue 

            semantic_core.append(t)
        
        return " ".join(semantic_core) if semantic_core else (tokens[0] if tokens else "")

# Initialize
nlp_pipeline = FinancialNLPPipeline()

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.embedder = SentenceTransformer("all-MiniLM-L6-v2")
    yield

app = FastAPI(lifespan=lifespan)

@app.post("/embed")
async def get_embed(payload: TextRequest, request: Request):
    distilled = nlp_pipeline.distill(payload.text)
    vec = request.app.state.embedder.encode(distilled)
    return {"embedding": [float(v) for v in vec.tolist()], "distilled_text": distilled}

@app.post("/embed/batch")
async def get_embed_batch(payload: BatchTextRequest, request: Request):
    if not payload.texts:
        return {"results": []}
        
    anchors = set(payload.anchors) if payload.anchors else set()
    
    # 1. Distill all texts first
    distilled_texts = [
        nlp_pipeline.distill(text, batch_context=payload.texts, anchors=anchors)
        for text in payload.texts
    ]
    
    # 2. Vectorized batch encoding (much more efficient)
    try:
        vectors = request.app.state.embedder.encode(distilled_texts)
        # Convert to list of floats for JSON
        results = []
        for i, text in enumerate(payload.texts):
            results.append({
                "original": text,
                "distilled": distilled_texts[i],
                "embedding": [float(v) for v in vectors[i].tolist()]
            })
        return {"results": results}
    except Exception as e:
        logger.error(f"Batch encoding error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=5000, reload=False)