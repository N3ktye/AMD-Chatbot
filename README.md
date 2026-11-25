# DeepSeek Vision Chat — AMD Token Lab

A locally hosted, full-stack chat app for text and image conversations using AMD Token Lab's OpenAI-compatible API. The FastAPI backend keeps API credentials out of browser storage and persists conversations, message history, and image context in SQLite.

## Requirements

- Windows 11
- Python 3.10 or newer
- Node.js 20 or newer
- An AMD Token Lab API key

## Manual setup (optional when using the one-click launcher)

From the project directory:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r backend\requirements.txt
Copy-Item .env.example .env

cd frontend
npm install
cd ..
```

Set `AMD_TOKENLAB_API_KEY` in `.env` for a server-side default, or start the app and enter the key in **Settings → API configuration**. A key entered in the UI is held in backend memory for the lifetime of that server process; it is not written to SQLite, browser local storage, or logs. Restarting the backend clears a key entered in the UI.

## Start the application

For one-click startup on Windows, double-click `Run-App.bat` in the project directory, or run `.\Run-App.ps1` in PowerShell. The launcher creates and activates the project `.venv`, installs the backend requirements into it, starts the backend from that environment, starts the frontend using Node.js, and opens the app in your browser when both services are ready. Frontend packages are installed separately by npm in `frontend\node_modules`. Keep the two server windows open while using the app.

To start the services manually, open two PowerShell windows in the project directory.

**Window 1 — backend**

```powershell
.\.venv\Scripts\Activate.ps1
uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

**Window 2 — frontend**

```powershell
cd frontend
npm run dev
```

Open <http://localhost:5173>. API docs: <http://127.0.0.1:8000/docs>.

## Features

- AMD Token Lab API at `https://api.tokenlab.amd.com/v1`, model `DeepSeek-V4.1-Flash`
- Text-only chat and optional JPG, JPEG, PNG, or WEBP attachments (up to 8 MB each; up to four images per message)
- Image data sent to the model as OpenAI-compatible base64 `image_url` content and retained with its original user message for follow-up context
- Multiple conversations persisted in `backend/data/chat_history.db`
- New chat, conversation deletion, response retry/regeneration, copy, and Markdown/TXT export
- Markdown, GFM, highlighted code blocks, code-copy buttons, token usage, responsive layout, and API connection testing

## Data and security notes

- The frontend only sends a user-entered key to the local backend settings endpoint; it never stores the key in local storage.
- For persistence across backend restarts, use the `.env` environment variable rather than entering the key in the UI.
- Chat history and uploaded image contents are stored locally in the SQLite database under `backend/data/`. Treat this folder as private user data; it is excluded from Git.
- The service binds to localhost by default and has no user authentication. Do not expose it to an untrusted network without adding authentication and transport security.
- Image MIME types and file signatures are validated server-side; uploaded images are size-limited.

## Validation

Frontend production build:

```powershell
cd frontend
npm run build
```

Backend smoke check after installing dependencies:

```powershell
.\.venv\Scripts\Activate.ps1
python -c "from fastapi.testclient import TestClient; from backend.main import app; print(TestClient(app).get('/api/health').json())"
```

Actual model requests and vision compatibility require a valid AMD Token Lab key and network access.
