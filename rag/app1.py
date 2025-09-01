import os, json, re
from typing import List, Dict, Any
from dotenv import load_dotenv
from flask import Flask, request, jsonify
import requests
import numpy as np

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# =========================
# Config
# =========================
load_dotenv()

KB_PATH   = os.getenv("KB_PATH", "shega_rag_v2.json")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
GEN_MODEL  = os.getenv("GEN_MODEL", "tinyllama")
TOP_K      = int(os.getenv("TOP_K", "3"))
MIN_SIM    = float(os.getenv("MIN_SIM", "0.12"))
GEN_TEMP   = float(os.getenv("GEN_TEMP", "0.2"))

SYSTEM_PROMPT = """You are SHEGA Safety Assistant.
Answer ONLY from the provided context. If the answer is not in the context, say you don't know.
Be brief, clear, and actionable. If the user writes in Amharic, answer in Amharic; otherwise, respond in English."""

# =========================
# App
# =========================
app = Flask(__name__)

kb_items: List[Dict[str, Any]] = []
vectorizer = None
tfidf_matrix = None
doc_lookup: Dict[int, Dict[str, Any]] = {}

# =========================
# Helpers
# =========================
def load_kb(path: str):
    global kb_items, vectorizer, tfidf_matrix, doc_lookup
    with open(path, "r", encoding="utf-8") as f:
        kb_items = json.load(f)
    # Build corpus: title + text
    corpus = [f"{it.get('title','')}.\n{it.get('text','')}".strip() for it in kb_items]
    vectorizer = TfidfVectorizer(ngram_range=(1,2), stop_words=None)  # support EN + AM
    tfidf_matrix = vectorizer.fit_transform(corpus)
    doc_lookup = {i: kb_items[i] for i in range(len(kb_items))}

def retrieve(query: str, top_k: int = TOP_K, min_sim: float = MIN_SIM):
    if not query or not query.strip():
        return []
    q_vec = vectorizer.transform([query])
    sims = cosine_similarity(q_vec, tfidf_matrix)[0]
    order = np.argsort(-sims)[:top_k]
    results = []
    for idx in order:
        score = float(sims[idx])
        if score < min_sim:
            continue
        item = doc_lookup[idx]
        results.append({
            "id": item["id"],
            "title": item.get("title",""),
            "text": item.get("text",""),
            "lang": item.get("lang",""),
            "score": round(score, 4)
        })
    return results

def build_context(matches: List[Dict[str, Any]]) -> str:
    """Concatenate retrieved chunks with lightweight citations."""
    parts = []
    for m in matches:
        parts.append(f"[{m['id']}] {m['title']}\n{m['text']}")
    return "\n\n---\n\n".join(parts)

def call_ollama(messages: List[Dict[str, str]]) -> str:
    url = f"{OLLAMA_URL}/api/chat"
    payload = {
        "model": GEN_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"temperature": GEN_TEMP}
    }
    r = requests.post(url, json=payload, timeout=120)
    r.raise_for_status()
    data = r.json()
    # Ollama chat format returns {"message": {"role": "...", "content": "..."}, ...}
    # but some versions return {"messages":[...]} – handle both
    if "message" in data and isinstance(data["message"], dict):
        return data["message"].get("content", "").strip()
    if "messages" in data and isinstance(data["messages"], list) and data["messages"]:
        return data["messages"][-1].get("content", "").strip()
    return data.get("content","").strip()

def make_prompt(context: str, question: str) -> List[Dict[str, str]]:
    user_content = (
        f"Context:\n{context if context else '(no relevant context)'}\n\n"
        f"Question: {question}\n\n"
        "Answer:"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content}
    ]

# =========================
# Routes
# =========================
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "model": GEN_MODEL, "kb_items": len(kb_items)})

@app.route("/ask", methods=["POST"])
def ask():
    data = request.get_json(force=True, silent=True) or {}
    q = (data.get("question") or "").strip()
    top_k = int(data.get("top_k", TOP_K))
    if not q:
        return jsonify({"error": "Missing 'question'"}), 400

    matches = retrieve(q, top_k=top_k, min_sim=MIN_SIM)
    context = build_context(matches)
    messages = make_prompt(context, q)

    try:
        answer = call_ollama(messages)
    except Exception as e:
        return jsonify({"error": f"Ollama request failed: {e}"}), 500

    return jsonify({
        "answer": answer,
        "matches": matches
    })

@app.route("/ingest", methods=["POST"])
def ingest():
    """
    Add a small text snippet on the fly.
    Body: { "id": "kbX", "title": "...", "text": "...", "lang": "en|am" }
    """
    payload = request.get_json(force=True, silent=True) or {}
    required = ["id", "title", "text"]
    if not all(k in payload and str(payload[k]).strip() for k in required):
        return jsonify({"error": "id, title, text are required"}), 400

    # append and rebuild index (simple but fine for small KBs)
    kb_items.append({
        "id": str(payload["id"]),
        "title": str(payload["title"]),
        "text": str(payload["text"]),
        "lang": str(payload.get("lang",""))
    })
    # persist to file
    with open(KB_PATH, "w", encoding="utf-8") as f:
        json.dump(kb_items, f, ensure_ascii=False, indent=2)

    # rebuild index
    load_kb(KB_PATH)
    return jsonify({"ok": True, "count": len(kb_items)})

# =========================
# Boot
# =========================
if __name__ == "__main__":
    if not os.path.exists(KB_PATH):
        os.makedirs(os.path.dirname(KB_PATH), exist_ok=True)
        with open(KB_PATH, "w", encoding="utf-8") as f:
            json.dump([], f)
    load_kb(KB_PATH)
    app.run(host="0.0.0.0", port=5055, debug=True)
