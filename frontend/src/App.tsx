import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode } from "react";
import {
  AlertCircle, ArrowDown, ArrowUp, Check, Copy, Download, ImagePlus, LoaderCircle,
  Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Plus, Settings2, ShieldCheck,
  Sparkles, Trash2, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { api, imageSrc } from "./api";
import type { Conversation, ImageData, Message } from "./types";

const MODEL = "DeepSeek-V4.1-Flash";
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_IMAGES = 4;

function toImageData(file: File): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve({ mime_type: file.type, data_base64: result.slice(result.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(String(children ?? "").replace(/\n$/, ""));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="code-frame">
      <div className="code-toolbar"><span>{className?.replace("language-", "") || "code"}</span>
        <button className="code-copy" onClick={() => void copy()} aria-label="Copy code">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre><code className={className}>{children}</code></pre>
    </div>
  );
}

function Markdown({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
    components={{ pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children;
      if (child && typeof child === "object" && "props" in child) {
        const code = child as ReactElement<{ className?: string; children?: ReactNode }>;
        return <CodeBlock className={code.props.className}>{code.props.children}</CodeBlock>;
      }
      return <pre>{children}</pre>;
    } }}>{content}</ReactMarkdown>;
}

function App() {
  const [chats, setChats] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [pendingImages, setPendingImages] = useState<ImageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [apiConfigured, setApiConfigured] = useState(false);
  const [keySource, setKeySource] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [connectionState, setConnectionState] = useState<"idle" | "testing" | "connected" | "failed">("idle");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [showScroll, setShowScroll] = useState(false);
  const [toast, setToast] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const refreshChats = useCallback(async () => {
    const [chatList, settings] = await Promise.all([api.conversations(), api.settings()]);
    setChats(chatList);
    setApiConfigured(settings.api_configured);
    setKeySource(settings.key_source);
  }, []);

  const loadChat = useCallback(async (id: string) => {
    setActiveId(id);
    setError("");
    setMessages([]);
    try {
      const detail = await api.conversation(id);
      setMessages(detail.messages);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load this conversation.");
    }
  }, []);

  useEffect(() => {
    const restore = async () => {
      const [chatList, settings] = await Promise.all([api.conversations(), api.settings()]);
      setChats(chatList);
      setApiConfigured(settings.api_configured);
      setKeySource(settings.key_source);
      const rememberedId = localStorage.getItem("deepseek-active-chat");
      const selected = chatList.find((chat) => chat.id === rememberedId) ?? chatList[0];
      if (selected) {
        setActiveId(selected.id);
        setMessages((await api.conversation(selected.id)).messages);
      }
    };
    restore().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not connect to the local API."));
  }, []);

  useEffect(() => {
    if (activeId) localStorage.setItem("deepseek-active-chat", activeId);
    else localStorage.removeItem("deepseek-active-chat");
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const onScroll = () => setShowScroll(node.scrollHeight - node.scrollTop - node.clientHeight > 280);
    node.addEventListener("scroll", onScroll);
    return () => node.removeEventListener("scroll", onScroll);
  }, [activeId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const startNewChat = async () => {
    try {
      const chat = await api.createConversation();
      setChats((current) => [chat, ...current]);
      setActiveId(chat.id);
      setMessages([]);
      setError("");
      setPendingImages([]);
      setDraft("");
      setIsSidebarOpen(false);
      composerRef.current?.focus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create a conversation.");
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    setError("");
    const selected = Array.from(files);
    if (pendingImages.length + selected.length > MAX_IMAGES) {
      setError(`Attach up to ${MAX_IMAGES} images per message.`);
      return;
    }
    for (const file of selected) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError(`${file.name}: use a JPG, PNG, or WEBP image.`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`${file.name}: images must be smaller than 8 MB.`);
        return;
      }
    }
    try {
      const converted = await Promise.all(selected.map(toImageData));
      setPendingImages((current) => [...current, ...converted]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the selected images.");
    }
  };

  const send = async (text = draft, images = pendingImages) => {
    if ((!text.trim() && images.length === 0) || isLoading) return;
    setError("");
    if (!apiConfigured) {
      setIsSettingsOpen(true);
      setError("Add your AMD Token Lab API key in Settings to start chatting.");
      return;
    }
    let conversationId = activeId;
    try {
      if (!conversationId) {
        const chat = await api.createConversation();
        conversationId = chat.id;
        setActiveId(chat.id);
        setChats((current) => [chat, ...current]);
      }
      setIsLoading(true);
      setDraft("");
      setPendingImages([]);
      const result = await api.send(conversationId, text, images);
      setMessages((current) => [...current, result.user_message, result.assistant_message]);
      await refreshChats();
    } catch (reason) {
      setDraft(text);
      setPendingImages(images);
      setError(reason instanceof Error ? reason.message : "The message could not be sent.");
      if (conversationId) {
        try {
          const detail = await api.conversation(conversationId);
          setMessages(detail.messages);
        } catch { /* Keep the original request error visible. */ }
      }
    } finally {
      setIsLoading(false);
      composerRef.current?.focus();
    }
  };

  const retry = async () => {
    if (!activeId || isLoading) return;
    setError("");
    setIsLoading(true);
    try {
      const result = await api.retry(activeId);
      setMessages((current) => [...current, result.assistant_message]);
      await refreshChats();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retry the response.");
    } finally {
      setIsLoading(false);
    }
  };

  const regenerate = async (messageId: string) => {
    if (!activeId || isLoading) return;
    setError("");
    setIsLoading(true);
    try {
      const result = await api.regenerate(activeId, messageId);
      const index = messages.findIndex((message) => message.id === messageId);
      setMessages([...messages.slice(0, index), result.assistant_message]);
      await refreshChats();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not regenerate the response.");
      if (activeId) {
        try { setMessages((await api.conversation(activeId)).messages); } catch { /* Preserve error. */ }
      }
    } finally {
      setIsLoading(false);
    }
  };

  const deleteChat = async (event: MouseEvent, id: string) => {
    event.stopPropagation();
    try {
      await api.deleteConversation(id);
      setChats((current) => current.filter((chat) => chat.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the conversation.");
    }
  };

  const copyMessage = async (message: Message) => {
    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId(null), 1500);
  };

  const exportChat = (format: "md" | "txt") => {
    if (!messages.length) return;
    const text = messages.map((message) => `${message.role === "user" ? "You" : MODEL}:\n${message.content}`).join("\n\n---\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(chats.find((chat) => chat.id === activeId)?.title || "conversation").replace(/[<>:"/\\|?*]/g, "-")}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const saveKey = async () => {
    if (!apiKeyInput.trim()) return;
    setConnectionState("idle");
    try {
      await api.saveKey(apiKeyInput.trim());
      setApiKeyInput("");
      setApiConfigured(true);
      setKeySource("session");
      setToast("API key updated for this server session");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update the API key.");
    }
  };

  const testConnection = async () => {
    setConnectionState("testing");
    try {
      await api.testKey();
      setConnectionState("connected");
      setToast("Connected to AMD Token Lab");
    } catch (reason) {
      setConnectionState("failed");
      setError(reason instanceof Error ? reason.message : "Connection test failed.");
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="app-shell">
      {isSidebarOpen && <button className="mobile-backdrop" onClick={() => setIsSidebarOpen(false)} aria-label="Close menu" />}
      <aside className={`sidebar ${isSidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} /></div>
          <div className="brand-name">DeepSeek <span>Vision</span></div>
          <button className="icon-button sidebar-collapse" aria-label="Close sidebar" onClick={() => setIsSidebarOpen(false)}><PanelLeftClose size={17} /></button>
        </div>
        <button className="new-chat-button" onClick={() => void startNewChat()}><Plus size={17} /><span>New chat</span><kbd>Ctrl K</kbd></button>
        <div className="history-heading"><span>YOUR CHATS</span><button className="icon-button small-icon" onClick={() => void startNewChat()} aria-label="New chat"><Plus size={15} /></button></div>
        <nav className="chat-history" aria-label="Conversation history">
          {chats.length === 0 ? <div className="history-empty">Your conversations will appear here.</div> :
            chats.map((chat) => <button key={chat.id} className={`history-item ${activeId === chat.id ? "history-active" : ""}`} onClick={() => { void loadChat(chat.id); setIsSidebarOpen(false); }}>
              <MessageSquare size={15} /><span className="history-title">{chat.title}</span>
              <span className="history-delete" onClick={(event) => void deleteChat(event, chat.id)} role="button" aria-label="Delete conversation"><Trash2 size={14} /></span>
            </button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="model-card">
            <div className="model-dot" />
            <div className="model-info"><span>MODEL</span><strong>{MODEL}</strong></div>
            <span className="model-chevron"><MoreHorizontal size={15} /></span>
          </div>
          <button className="settings-link" onClick={() => { setIsSettingsOpen(true); setError(""); }}><Settings2 size={16} /><span>Settings & API</span><span className={`status-dot ${apiConfigured ? "status-online" : ""}`} /></button>
          <div className="sidebar-footer"><ShieldCheck size={13} /><span>Private by design</span></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setIsSidebarOpen(true)} aria-label="Open menu"><Menu size={19} /></button>
            <div className="header-model"><span>DeepSeek Vision</span><span className="header-divider">/</span><span>{MODEL}</span></div></div>
          <div className="topbar-right">
            <span className={`connection-pill ${apiConfigured ? "connected" : ""}`}><span className="status-dot" />{apiConfigured ? "API ready" : "API key needed"}</span>
            {messages.length > 0 && <div className="export-menu"><button className="icon-button" aria-label="Export conversation" onClick={() => exportChat("md")}><Download size={17} /></button><button className="export-format" onClick={() => exportChat("txt")}>TXT</button></div>}
            <button className="top-settings" onClick={() => setIsSettingsOpen(true)} aria-label="Settings"><Settings2 size={17} /></button>
          </div>
        </header>

        <section className={`conversation ${messages.length ? "conversation-has-messages" : ""}`} ref={listRef}>
          {messages.length === 0 ? <div className="welcome">
            <div className="welcome-orbit"><div className="welcome-icon"><Sparkles size={26} /></div><span className="orbit-dot orbit-one" /><span className="orbit-dot orbit-two" /></div>
            <div className="eyebrow"><span className="eyebrow-line" /> AMD TOKEN LAB <span className="eyebrow-line" /></div>
            <h1>See what you<br /><span>can imagine.</span></h1>
            <p>A thoughtful assistant for your ideas, questions, and images.<br className="desktop-break" /> Start with a message, or bring a picture into the conversation.</p>
            <div className="suggestion-grid">
              <button onClick={() => setDraft("Explain a complex idea simply")}><span className="suggestion-icon idea-icon">✳</span><span><strong>Make it make sense</strong><small>Explain a complex idea simply</small></span></button>
              <button onClick={() => setDraft("Help me write something clear and compelling")}><span className="suggestion-icon write-icon">Aa</span><span><strong>Find the right words</strong><small>Draft, edit, or brainstorm together</small></span></button>
              <button onClick={() => fileInputRef.current?.click()}><span className="suggestion-icon vision-icon"><ImagePlus size={17} /></span><span><strong>Look closer</strong><small>Ask a question about an image</small></span></button>
              <button onClick={() => setDraft("Help me think through this step by step")}><span className="suggestion-icon think-icon">⌁</span><span><strong>Think it through</strong><small>Untangle a problem, step by step</small></span></button>
            </div>
          </div> : <div className="messages-wrap">
            {messages.map((message) => <article key={message.id} className={`message-row ${message.role === "user" ? "user-row" : "assistant-row"}`}>
              {message.role === "assistant" && <div className="assistant-avatar"><Sparkles size={15} /></div>}
              <div className={`message-body ${message.role === "user" ? "user-message-body" : ""}`}>
                <div className="message-author">{message.role === "user" ? "You" : "DeepSeek"}</div>
                {message.images.length > 0 && <div className="message-images">{message.images.map((image, index) => <img key={index} src={imageSrc(image)} alt={`Attached image ${index + 1}`} />)}</div>}
                <div className={message.role === "user" ? "user-bubble" : "assistant-content"}>{message.role === "assistant" ? <Markdown content={message.content} /> : <p>{message.content}</p>}</div>
                {message.role === "assistant" && <div className="message-actions">
                  <button onClick={() => void copyMessage(message)} aria-label="Copy response">{copiedMessageId === message.id ? <Check size={14} /> : <Copy size={14} />}{copiedMessageId === message.id ? "Copied" : "Copy"}</button>
                  {message.usage && <span className="token-count">{message.usage.total_tokens.toLocaleString()} tokens</span>}
                  <button onClick={() => void regenerate(message.id)} aria-label="Regenerate response"><MoreHorizontal size={14} />Regenerate</button>
                </div>}
              </div>
            </article>)}
            {isLoading && <div className="thinking-row"><div className="assistant-avatar"><Sparkles size={15} /></div><div><div className="message-author">DeepSeek</div><div className="thinking-indicator"><span /><span /><span /></div></div></div>}
            {error && <div className="inline-error"><AlertCircle size={16} /><span>{error}</span>{messages.length > 0 && !isLoading && <button onClick={() => void retry()}>Retry</button>}</div>}
            <div ref={bottomRef} />
          </div>}
        </section>
        {showScroll && <button className="scroll-bottom" onClick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth" })} aria-label="Scroll to latest"><ArrowDown size={17} /></button>}

        <footer className="composer-area">
          {pendingImages.length > 0 && <div className="pending-images">{pendingImages.map((image, index) => <div className="pending-image" key={`${image.data_base64.slice(0, 12)}-${index}`}><img src={imageSrc(image)} alt="Image preview" /><button onClick={() => setPendingImages((current) => current.filter((_, i) => i !== index))} aria-label="Remove image"><X size={13} /></button></div>)}</div>}
          {error && messages.length === 0 && <div className="composer-error"><AlertCircle size={15} />{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={14} /></button></div>}
          <div className="composer">
            <textarea ref={composerRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="Message DeepSeek..." rows={1} aria-label="Message" />
            <div className="composer-tools">
              <div className="composer-left">
                <button className="attach-button" onClick={() => fileInputRef.current?.click()} aria-label="Attach images" title="Attach images"><ImagePlus size={17} /><span>Attach</span></button>
                <span className="composer-hint">Shift + Enter for a new line</span>
              </div>
              <button className={`send-button ${draft.trim() || pendingImages.length ? "send-active" : ""}`} onClick={() => void send()} disabled={isLoading || (!draft.trim() && !pendingImages.length)} aria-label="Send message">
                {isLoading ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}
              </button>
            </div>
          </div>
          <div className="composer-disclaimer">DeepSeek can make mistakes. Verify important information.</div>
        </footer>
      </main>

      <input ref={fileInputRef} className="file-input" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple onChange={(event) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = ""; }} />

      {isSettingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsSettingsOpen(false); }}>
        <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="modal-header"><div><div className="modal-kicker">PREFERENCES</div><h2 id="settings-title">Settings</h2></div><button className="icon-button" onClick={() => setIsSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button></div>
          <div className="settings-section"><div className="settings-label-row"><div><h3>AMD Token Lab</h3><p>Your key is sent only to this local backend.</p></div><div className={`connection-badge ${apiConfigured ? "badge-good" : ""}`}><span />{apiConfigured ? "Configured" : "Not connected"}</div></div>
            <label className="field-label" htmlFor="api-key">API key</label>
            <div className="key-input-wrap"><input id="api-key" type={keyVisible ? "text" : "password"} autoComplete="new-password" placeholder="Enter your AMD Token Lab API key" value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveKey(); }} /><button onClick={() => setKeyVisible(!keyVisible)}>{keyVisible ? "Hide" : "Show"}</button></div>
            <div className="settings-button-row"><button className="secondary-button" disabled={!apiConfigured || connectionState === "testing"} onClick={() => void testConnection()}>{connectionState === "testing" && <LoaderCircle size={14} className="spin" />}Test connection</button><button className="primary-button" disabled={!apiKeyInput.trim()} onClick={() => void saveKey()}>Save key</button></div>
            {connectionState === "connected" && <div className="settings-success"><Check size={14} /> Connection verified.</div>}
            {connectionState === "failed" && <div className="settings-failure"><AlertCircle size={14} /> Check your key and try again.</div>}
            <div className="key-storage-note"><ShieldCheck size={15} /><span>{keySource === "environment" ? "Using server environment configuration." : keySource === "session" ? "Stored in backend memory until it restarts." : "Keys entered here are held in backend memory only."}</span></div>
          </div>
          <div className="settings-section model-settings"><div><h3>Model</h3><p>Used for text and image conversations</p></div><div className="model-name-pill"><span className="model-dot" />{MODEL}</div></div>
          <div className="settings-modal-footer">Base URL <code>api.tokenlab.amd.com/v1</code></div>
        </section>
      </div>}
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
    </div>
  );
}

export default App;
