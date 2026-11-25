export type ImageData = {
  mime_type: string;
  data_base64: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  images: ImageData[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  created_at: string;
};

export type Conversation = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type ConversationDetail = Conversation & { messages: Message[] };
