from __future__ import annotations

import base64
import binascii
import json
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI
from pydantic import BaseModel, Field

load_dotenv()

BASE_URL = "https://api.tokenlab.amd.com/v1"
MODEL = "DeepSeek-V4.1-Flash"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGES = 4
DB_PATH = Path(__file__).parent / "data" / "chat_history.db"
session_api_key: str | None = None


class ImageInput(BaseModel):
    mime_type: str
    data_base64: str


class MessageInput(BaseModel):
    content: str = Field(max_length=20_000)
    images: list[ImageInput] = Field(default_factory=list, max_length=MAX_IMAGES)


class ApiKeyInput(BaseModel):
    api_key: str = Field(min_length=1, max_length=500)


@contextmanager
def connect_db() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_db() -> None:
    with connect_db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                images_json TEXT NOT NULL DEFAULT '[]',
                usage_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS messages_by_conversation
                ON messages(conversation_id, created_at);
            """
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_db()
    yield


app = FastAPI(title="DeepSeek Vision Chat API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


def get_api_key() -> str | None:
    return session_api_key or os.getenv("AMD_TOKENLAB_API_KEY")


def require_client() -> OpenAI:
    key = get_api_key()
    if not key:
        raise HTTPException(
            status_code=400,
            detail="Add your AMD Token Lab API key in Settings before sending a message.",
        )
    return OpenAI(base_url=BASE_URL, api_key=key, timeout=90.0, max_retries=1)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def decode_images(images: list[ImageInput]) -> list[dict[str, str]]:
    allowed_signatures = {
        "image/jpeg": (b"\xff\xd8\xff",),
        "image/png": (b"\x89PNG\r\n\x1a\n",),
    }
    result = []
    for image in images:
        if image.mime_type not in ("image/jpeg", "image/png", "image/webp"):
            raise HTTPException(status_code=415, detail="Only JPEG, PNG, and WEBP images are supported.")
        try:
            raw = base64.b64decode(image.data_base64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="An uploaded image was not valid base64 data.")
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Each image must be smaller than 8 MB.")
        valid_signature = raw.startswith(allowed_signatures.get(image.mime_type, ()))
        if image.mime_type == "image/webp":
            valid_signature = len(raw) >= 12 and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP"
        if not valid_signature:
            raise HTTPException(status_code=415, detail="The image content does not match its file type.")
        result.append({"mime_type": image.mime_type, "data_base64": base64.b64encode(raw).decode("ascii")})
    return result


def chat_error(exc: Exception) -> HTTPException:
    if isinstance(exc, APITimeoutError):
        return HTTPException(status_code=504, detail="AMD Token Lab took too long to respond. Please retry.")
    if isinstance(exc, APIConnectionError):
        return HTTPException(status_code=502, detail="Could not connect to AMD Token Lab. Check your connection and retry.")
    if isinstance(exc, APIStatusError):
        message = getattr(exc, "message", "") or ""
        status = exc.status_code
        if status in (401, 403):
            detail = "AMD Token Lab rejected the API key. Check the key in Settings."
        elif status == 429:
            detail = "AMD Token Lab rate limit or quota reached. Wait a moment and retry."
        elif status >= 500:
            detail = "AMD Token Lab is temporarily unavailable. Please retry."
        else:
            detail = f"AMD Token Lab request failed ({status})."
        if message and status not in (401, 403):
            detail = f"{detail} {message[:300]}"
        return HTTPException(status_code=502, detail=detail)
    return HTTPException(status_code=502, detail="The model request failed. Please retry.")


def ensure_conversation(conversation_id: str) -> None:
    with connect_db() as db:
        exists = db.execute("SELECT 1 FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
    if not exists:
        raise HTTPException(status_code=404, detail="Conversation not found.")


def stored_message(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "role": row["role"],
        "content": row["content"],
        "images": json.loads(row["images_json"]),
        "usage": json.loads(row["usage_json"]) if row["usage_json"] else None,
        "created_at": row["created_at"],
    }


def create_chat_completion(conversation_id: str, through_message_id: str | None = None) -> dict[str, Any]:
    client = require_client()
    with connect_db() as db:
        rows = db.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
            (conversation_id,),
        ).fetchall()
    if through_message_id:
        end = next((i for i, row in enumerate(rows) if row["id"] == through_message_id), None)
        if end is None:
            raise HTTPException(status_code=404, detail="Message not found.")
        rows = rows[: end + 1]

    api_messages = []
    for row in rows:
        if row["role"] == "user":
            images = json.loads(row["images_json"])
            if images:
                content: str | list[dict[str, Any]] = [{"type": "text", "text": row["content"]}]
                content.extend(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{image['mime_type']};base64,{image['data_base64']}"},
                    }
                    for image in images
                )
            else:
                content = row["content"]
            api_messages.append({"role": "user", "content": content})
        else:
            api_messages.append({"role": "assistant", "content": row["content"]})

    try:
        response = client.chat.completions.create(model=MODEL, messages=api_messages)
    except (APITimeoutError, APIConnectionError, APIStatusError) as exc:
        raise chat_error(exc) from exc

    answer = response.choices[0].message.content
    if not isinstance(answer, str) or not answer.strip():
        raise HTTPException(status_code=502, detail="The model returned an empty response. Please retry.")
    usage = None
    if response.usage:
        usage = {
            "prompt_tokens": response.usage.prompt_tokens,
            "completion_tokens": response.usage.completion_tokens,
            "total_tokens": response.usage.total_tokens,
        }
    message = {
        "id": str(uuid.uuid4()),
        "role": "assistant",
        "content": answer,
        "images": [],
        "usage": usage,
        "created_at": now_iso(),
    }
    with connect_db() as db:
        db.execute(
            "INSERT INTO messages (id, conversation_id, role, content, usage_json, created_at) "
            "VALUES (?, ?, 'assistant', ?, ?, ?)",
            (message["id"], conversation_id, answer, json.dumps(usage) if usage else None, message["created_at"]),
        )
        db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (message["created_at"], conversation_id))
    return message


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/settings")
def settings() -> dict[str, Any]:
    return {
        "api_configured": bool(get_api_key()),
        "key_source": "session" if session_api_key else ("environment" if os.getenv("AMD_TOKENLAB_API_KEY") else None),
        "model": MODEL,
        "base_url": BASE_URL,
    }


@app.put("/api/settings")
def save_settings(payload: ApiKeyInput) -> dict[str, bool]:
    global session_api_key
    key = payload.api_key.strip()
    if not key:
        raise HTTPException(status_code=422, detail="API key cannot be empty.")
    session_api_key = key
    return {"api_configured": True}


@app.post("/api/settings/test")
def test_connection() -> dict[str, str]:
    client = require_client()
    try:
        client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": "Reply with OK."}],
            max_tokens=8,
        )
    except (APITimeoutError, APIConnectionError, APIStatusError) as exc:
        raise chat_error(exc) from exc
    return {"status": "connected", "model": MODEL}


@app.get("/api/conversations")
def list_conversations() -> list[dict[str, str]]:
    with connect_db() as db:
        rows = db.execute(
            "SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/conversations")
def new_conversation() -> dict[str, str]:
    conversation = {
        "id": str(uuid.uuid4()),
        "title": "New chat",
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    with connect_db() as db:
        db.execute(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (conversation["id"], conversation["title"], conversation["created_at"], conversation["updated_at"]),
        )
    return conversation


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str) -> dict[str, Any]:
    with connect_db() as db:
        conversation = db.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        rows = db.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid", (conversation_id,)
        ).fetchall()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {
        "id": conversation["id"],
        "title": conversation["title"],
        "created_at": conversation["created_at"],
        "updated_at": conversation["updated_at"],
        "messages": [stored_message(row) for row in rows],
    }


@app.delete("/api/conversations/{conversation_id}")
def delete_conversation(conversation_id: str) -> dict[str, bool]:
    with connect_db() as db:
        cursor = db.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return {"deleted": True}


@app.post("/api/conversations/{conversation_id}/messages")
def send_message(conversation_id: str, payload: MessageInput) -> dict[str, Any]:
    ensure_conversation(conversation_id)
    if not payload.content.strip() and not payload.images:
        raise HTTPException(status_code=422, detail="Write a message or attach an image.")
    images = decode_images(payload.images)
    message_id = str(uuid.uuid4())
    created_at = now_iso()
    with connect_db() as db:
        db.execute(
            "INSERT INTO messages (id, conversation_id, role, content, images_json, created_at) "
            "VALUES (?, ?, 'user', ?, ?, ?)",
            (message_id, conversation_id, payload.content, json.dumps(images), created_at),
        )
        count = db.execute(
            "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?", (conversation_id,)
        ).fetchone()["count"]
        if count == 1:
            title = payload.content.strip() or "Image conversation"
            title = title[:48] + ("…" if len(title) > 48 else "")
            db.execute("UPDATE conversations SET title = ? WHERE id = ?", (title, conversation_id))
        db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (created_at, conversation_id))
    user_message = {
        "id": message_id,
        "role": "user",
        "content": payload.content,
        "images": images,
        "usage": None,
        "created_at": created_at,
    }
    assistant_message = create_chat_completion(conversation_id, message_id)
    return {"user_message": user_message, "assistant_message": assistant_message}


@app.post("/api/conversations/{conversation_id}/retry")
def retry_message(conversation_id: str) -> dict[str, Any]:
    ensure_conversation(conversation_id)
    with connect_db() as db:
        row = db.execute(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' "
            "AND NOT EXISTS (SELECT 1 FROM messages later WHERE later.conversation_id = messages.conversation_id "
            "AND later.role = 'assistant' AND later.created_at >= messages.created_at) "
            "ORDER BY created_at DESC LIMIT 1",
            (conversation_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=409, detail="There is no unanswered message to retry.")
    return {"assistant_message": create_chat_completion(conversation_id, row["id"])}


@app.post("/api/conversations/{conversation_id}/messages/{message_id}/regenerate")
def regenerate_response(conversation_id: str, message_id: str) -> dict[str, Any]:
    ensure_conversation(conversation_id)
    with connect_db() as db:
        row = db.execute(
            "SELECT role FROM messages WHERE id = ? AND conversation_id = ?", (message_id, conversation_id)
        ).fetchone()
        if not row or row["role"] != "assistant":
            raise HTTPException(status_code=404, detail="Assistant response not found.")
        target = db.execute("SELECT created_at, rowid FROM messages WHERE id = ?", (message_id,)).fetchone()
        previous = db.execute(
            "SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' "
            "AND rowid < ? ORDER BY rowid DESC LIMIT 1",
            (conversation_id, target["rowid"]),
        ).fetchone()
    if not previous:
        raise HTTPException(status_code=409, detail="There is no user message to regenerate.")
    regenerated = create_chat_completion(conversation_id, previous["id"])
    with connect_db() as db:
        db.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND rowid >= ? AND id != ?",
            (conversation_id, target["rowid"], regenerated["id"]),
        )
    return {"assistant_message": regenerated}
