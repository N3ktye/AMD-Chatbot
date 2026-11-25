# AMD Chatbot — DeepSeek Vision

A local chat application for conversations with text and images. The React frontend talks to a FastAPI backend, which sends requests to AMD Token Lab's OpenAI-compatible API and saves conversation history in a local SQLite database.

## Features

- Text conversations with `DeepSeek-V4.1-Flash` through AMD Token Lab.
- Image questions with JPG/JPEG, PNG, and WEBP attachments (up to 4 images per message; 8 MB each).
- Persistent conversation history, saved locally in SQLite.
- Markdown and GitHub Flavored Markdown rendering, syntax-highlighted code, and code-copy buttons.
- Create and delete chats, retry or regenerate responses, copy messages, and export conversations as Markdown or TXT.
- API-key settings, connection testing, and model usage information.
- Responsive interface for desktop and smaller screens.

## Requirements

- Windows 10 or 11
- Python 3.10 or newer
- Node.js 20 or newer, including npm
- An AMD Token Lab API key to send model requests

## Quick start on Windows

From the project folder, either double-click **`Run-App.bat`** or run the PowerShell launcher:

```powershell
.\Run-App.ps1
```

The launcher creates the project `.venv` if needed, activates it, installs the backend dependencies, and starts the backend. It installs frontend dependencies with npm if needed, starts the frontend, and opens the app in your browser when both services respond. Keep the two server windows open while using the app.

The app opens at <http://127.0.0.1:5173>. If PowerShell blocks the script, use `Run-App.bat`.

## Configure your API key

You can add your key in **Settings & API** in the app, then use **Test connection** to check it. A key entered there is held in backend memory for that server session and is cleared when the backend restarts.

Alternatively, store a server-side default in a local `.env` file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Replace the placeholder value for `AMD_TOKENLAB_API_KEY` with your own AMD Token Lab key. Do not commit or share `.env`.

## Manual setup and run

Open PowerShell in the project folder:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
Copy-Item .env.example .env
```

Edit `.env` if you want to configure the API key there. Install frontend packages:

```powershell
Set-Location frontend
npm install
```

Start the backend in one PowerShell window from the project folder:

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend in another PowerShell window:

```powershell
Set-Location frontend
npm run dev
```

Open <http://127.0.0.1:5173>. The backend health endpoint is <http://127.0.0.1:8000/api/health>, and interactive API documentation is at <http://127.0.0.1:8000/docs>.

## Project layout

```text
backend/
  main.py                 FastAPI application and API routes
  requirements.txt        Python dependencies
  data/                   Local SQLite conversation database
frontend/
  src/                    React application
  package.json            Frontend dependencies and scripts
Run-App.ps1               PowerShell setup and launcher
Run-App.bat               Double-click Windows launcher
```

## Data and security

- The backend binds to `127.0.0.1` by default and has no user authentication. Do not expose it to an untrusted network.
- API keys entered in Settings are sent to the local backend and held in its memory for that server session. Keys are not saved to browser storage or the chat database.
- A key in `.env` is available to the backend process. Keep `.env` private.
- Chats and attached image contents are stored locally in `backend/data/chat_history.db`. Keep this file private if your conversations or images are sensitive.
- Image type and file signatures are checked by the backend. Actual model requests require a valid API key and network access to AMD Token Lab.

## Build the frontend

```powershell
Set-Location frontend
npm run build
```
