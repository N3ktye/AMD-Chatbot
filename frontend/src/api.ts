import type { Conversation, ConversationDetail, ImageData, Message } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      // Keep the HTTP status message when the server does not return JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  settings: () => request<{ api_configured: boolean; key_source: string | null; model: string; base_url: string }>("/api/settings"),
  saveKey: (api_key: string) => request<{ api_configured: boolean }>("/api/settings", { method: "PUT", body: JSON.stringify({ api_key }) }),
  testKey: () => request<{ status: string }>("/api/settings/test", { method: "POST" }),
  conversations: () => request<Conversation[]>("/api/conversations"),
  createConversation: () => request<Conversation>("/api/conversations", { method: "POST" }),
  conversation: (id: string) => request<ConversationDetail>(`/api/conversations/${id}`),
  deleteConversation: (id: string) => request<{ deleted: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  send: (id: string, content: string, images: ImageData[]) =>
    request<{ user_message: Message; assistant_message: Message }>(`/api/conversations/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, images }),
    }),
  retry: (id: string) => request<{ assistant_message: Message }>(`/api/conversations/${id}/retry`, { method: "POST" }),
  regenerate: (id: string, messageId: string) =>
    request<{ assistant_message: Message }>(`/api/conversations/${id}/messages/${messageId}/regenerate`, { method: "POST" }),
};

export function imageSrc(image: ImageData): string {
  return `data:${image.mime_type};base64,${image.data_base64}`;
}
