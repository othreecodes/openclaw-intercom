
export interface IntercomAdmin {
  id: string;
  email: string;
}

export interface IntercomAuthor {
  type: "user" | "admin" | "bot";
  id: string;
}

export interface IntercomConversation {
  id: string;
  updated_at: number;
  source: {
    body: string;
    author: IntercomAuthor;
  };
}

export interface IntercomConversationPart {
  id: string;
  part_type: string;
  body: string | null;
  created_at: number;
  author: IntercomAuthor;
}

export interface IntercomFullConversation extends IntercomConversation {
  conversation_parts: {
    conversation_parts: IntercomConversationPart[];
  };
}

export interface IntercomWebhookPayload {
  topic: string;
  data: {
    item: IntercomFullConversation;
  };
}
