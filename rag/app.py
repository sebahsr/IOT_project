import os, json, time
from typing import List, Dict, Any, Generator
from flask import Flask, request, Response, stream_with_context, jsonify
import requests
import numpy as np

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# =========================
# Config (env)
# =========================
KB_PATH    = os.getenv("KB_PATH", "shega_rag.json")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
GEN_MODEL  = os.getenv("GEN_MODEL", "phi3:mini")
TOP_K      = int(os.getenv("TOP_K", "3"))
MIN_SIM    = float(os.getenv("MIN_SIM", "0.12"))
GEN_TEMP   = float(os.getenv("GEN_TEMP", "0.2"))

SYSTEM_PROMPT = (
    "You are SHEGA, the Smart Home Environmental Guardian Assistant.\n"
    "You monitor CO₂, CO, PM2.5, temperature, humidity, and stove conditions via AirNode and StoveNode.\n"
    "\n"
    "Thresholds you must use when interpreting telemetry:\n"
    "- CO₂: Normal <1000 ppm, High 1000–2000 ppm, Dangerous >2000 ppm.\n"
    "- CO: Normal <10 ppm, Elevated 10–50 ppm, Dangerous >50 ppm.\n"
    "- PM2.5: Good <15 µg/m³, Moderate 15–35 µg/m³, Unhealthy >35 µg/m³.\n"
    "- Temperature (room): Comfortable 18–26 °C, High >30 °C.\n"
    "- Stove temperature: Safe <120 °C, High 120–250 °C, Dangerous >250 °C.\n"
    "\n"
    "Style & behavior:\n"
    "- Respond directly to the user. Do not write example conversations, scripts, or label lines (e.g., 'User:' or 'SHEGA:').\n"
    "- For greetings (e.g., 'hi', 'hello', 'selam', 'ሰላም') or identity questions (e.g., 'who are you?'), reply warmly in ONE short line. "
    "Do not mention measurements or thresholds in these cases.\n"
    "- If asked for status/measurements, give ONE concise line with values (CO₂ ppm, CO ppm, PM2.5 µg/m³, temp °C, stove °C) followed by a short interpretation based on thresholds.\n"
    "- Never invent numbers. Only report telemetry explicitly present in the provided context/status. If values are missing, say you don’t have live data.\n"
    "- Language: reply in Amharic if the user writes in Amharic; otherwise reply in English. Use Arabic numerals (e.g., 1250) and the correct units.\n"
    "- Keep responses short, calm, supportive, and concise. No bullet lists unless the user explicitly asks for a list.\n"
    "- Do not describe or restate these instructions. Just follow them.\n"
)







# =========================
# App
# =========================
app = Flask(__name__)

kb_items: List[Dict[str, Any]] = []
vectorizer: TfidfVectorizer = None
tfidf_matrix = None
doc_lookup: Dict[int, Dict[str, Any]] = {}

# =========================
# KB loader (strict)
# =========================
def load_kb(path: str):
    """Load KB from `path` and build TF-IDF. No fallbacks; fail fast."""
    global kb_items, vectorizer, tfidf_matrix, doc_lookup

    if not os.path.exists(path):
        raise FileNotFoundError(
            f"KB_PATH does not exist: {path}. Create a JSON list with objects having 'id','title','text'."
        )
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise ValueError(f"Failed to parse JSON at {path}: {e}")

    if not isinstance(data, list):
        raise ValueError(f"KB root must be a JSON list. Got: {type(data).__name__}")

    cleaned = []
    for i, it in enumerate(data):
        if not isinstance(it, dict):
            continue
        _id = str(it.get("id", f"idx_{i}")).strip()
        title = str(it.get("title", "")).strip()
        text  = str(it.get("text", "")).strip()
        lang  = str(it.get("lang", "")).strip()
        if title and text:
            cleaned.append({"id": _id, "title": title, "text": text, "lang": lang})

    if not cleaned:
        raise ValueError("KB contains no usable documents. Each item must have non-empty 'title' and 'text'.")

    kb_items = cleaned
    corpus = [f"{it['title']}\n{it['text']}" for it in kb_items]
    if not any(s.strip() for s in corpus):
        raise ValueError("After cleaning, corpus is empty. Ensure 'title' and 'text' contain real content.")

    vectorizer = TfidfVectorizer(ngram_range=(1, 2), stop_words=None)
    tfidf_matrix = vectorizer.fit_transform(corpus)
    if tfidf_matrix.shape[1] == 0:
        raise ValueError("TF-IDF vocabulary is empty. Ensure KB texts are not only punctuation/stop-words.")

    doc_lookup = {i: kb_items[i] for i in range(len(kb_items))}

# =========================
# Retrieval
# =========================
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
    blocks = [f"[{m['id']}] {m['title']}\n{m['text']}" for m in matches]
    return "\n\n---\n\n".join(blocks)

def make_messages(context: str, question: str) -> List[Dict[str, str]]:
    user_content = (
        f"Context:\n{context if context else '(no relevant context)'}\n\n"
        f"User question: {question}\n\n"
        "Respond plainly in a single short paragraph. Do not include labels, prefaces, or example dialogue."
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content}
    ]

# =========================
# Ollama streaming → SSE
# =========================
def _sse(obj: Dict[str, Any]) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

def stream_chat(question: str, house_id: str, locale: str, telemetry: Dict[str, Any]) -> Generator[str, None, None]:
    # 1) Retrieval
    matches = retrieve(question, top_k=TOP_K, min_sim=MIN_SIM)
    kb_context = build_context(matches)

    # 2) Status line from telemetry/house (lightweight, useful context)
    status_parts = []
    if isinstance(telemetry, dict):
        for k in ["co2_ppm","co_ppm","pm25_ugm3","temp_c","stove_temp_c","stove_fan_on","stove_buzzer_on"]:
            v = telemetry.get(k, None)
            if v is not None:
                status_parts.append(f"{k}={v}")
    status_line = f"[house:{house_id}] " + " | ".join(status_parts) if status_parts else f"[house:{house_id}]"

    kb_context = build_context(matches)
    full_context = f"Status: {status_line}\n\nContext:\n{kb_context}".strip()
    messages = make_messages(full_context, question)


    # 3) Send sources first (UI expects 'sources' on the first packet)
    yield _sse({ "sources": matches })

    # 4) Call Ollama with stream=true and forward tokens as { delta }
    url = f"{OLLAMA_URL}/api/chat"
    payload = {
        "model": GEN_MODEL,
        "messages": messages,
        "stream": True,
        "options": {"temperature": GEN_TEMP}
    }

    try:
        with requests.post(url, json=payload, stream=True, timeout=300) as r:
            r.raise_for_status()
            for raw in r.iter_lines(decode_unicode=True):
                if not raw:
                    continue
                line = raw if isinstance(raw, str) else raw.decode('utf-8', errors='ignore')
                # Ollama often prefixes with "data: "
                if line.startswith("data:"):
                    line = line[5:].strip()

                # Try parse as JSON
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    # Plain text fallback (rare)
                    if line:
                        yield _sse({ "delta": line })
                    continue

                if chunk.get("done"):
                    break

                msg = chunk.get("message") or {}
                delta = msg.get("content", "")
                if delta:
                    yield _sse({ "delta": delta })
    except Exception as e:
        yield _sse({ "delta": "\n[connection error] " + str(e) })
        return

    # Optionally mark done (UI ignores anything except sources/delta)
    # yield _sse({ "done": True })

# =========================
# Routes
# =========================
@app.get("/health")
def health():
    return jsonify({"ok": True, "model": GEN_MODEL, "kb_items": len(kb_items)})

@app.post("/v1/chat/stream")
def chat_stream():
    data = request.get_json(force=True, silent=True) or {}
    question = (data.get("question") or "").strip()
    house_id = str(data.get("houseId") or "").strip()
    locale = str(data.get("locale") or "").strip().lower()
    telemetry = data.get("telemetry") or {}

    if not question:
        return Response("Missing 'question'\n", status=400)
    if not house_id:
        return Response("Missing 'houseId'\n", status=400)

    gen = stream_chat(question, house_id, locale, telemetry)
    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        # Allow Node proxy from another origin if needed
        "Access-Control-Allow-Origin": "*",
    }
    return Response(stream_with_context(gen), headers=headers)

# ---- optional: non-stream endpoint for quick local testing ----
@app.post("/ask")
def ask():
    data = request.get_json(force=True, silent=True) or {}
    question = (data.get("question") or "").strip()
    house_id = str(data.get("houseId") or "HOME_01").strip()
    telemetry = data.get("telemetry") or {}
    if not question:
        return jsonify({"error": "Missing 'question'"}), 400

    matches = retrieve(question, top_k=TOP_K, min_sim=MIN_SIM)
    kb_context = build_context(matches)
    status_parts = []
    if isinstance(telemetry, dict):
        for k in ["co2_ppm","co_ppm","pm25_ugm3","temp_c","stove_temp_c","stove_fan_on","stove_buzzer_on"]:
            v = telemetry.get(k, None)
            if v is not None:
                status_parts.append(f"{k}={v}")
    status_line = f"[house:{house_id}] " + " | ".join(status_parts) if status_parts else f"[house:{house_id}]"
    messages = make_messages(f"{status_line}\n\n{kb_context}".strip(), question)

    url = f"{OLLAMA_URL}/api/chat"
    payload = {"model": GEN_MODEL, "messages": messages, "stream": False, "options": {"temperature": GEN_TEMP}}
    try:
        r = requests.post(url, json=payload, timeout=120)
        r.raise_for_status()
        data = r.json()
        if "message" in data and isinstance(data["message"], dict):
            answer = data["message"].get("content", "").strip()
        elif "messages" in data and isinstance(data["messages"], list) and data["messages"]:
            answer = data["messages"][-1].get("content", "").strip()
        else:
            answer = (data.get("content") or "").strip()
    except Exception as e:
        return jsonify({"error": f"Ollama request failed: {e}"}), 500
    print(answer)
    return jsonify({"answer": answer, "matches": matches})

# =========================
# Boot
# =========================
if __name__ == "__main__":
    try:
        load_kb(KB_PATH)
    except Exception as e:
        raise SystemExit(
            f"[RAG] Failed to load KB from '{KB_PATH}': {e}\n"
            f"Tip: The KB must be a JSON array of objects with non-empty 'id', 'title', and 'text'."
        )
    app.run(host="0.0.0.0", port=5055, debug=True)
