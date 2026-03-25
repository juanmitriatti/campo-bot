export interface InteractiveButton {
  id: string;
  title: string;
}

export interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveListSection {
  title: string;
  rows: InteractiveListRow[];
}

export interface BotResponseItem {
  type: 'text' | 'interactive';
  text?: string;
  interactive?: {
    type: 'buttons' | 'list';
    body: string;
    buttons?: InteractiveButton[];
    buttonText?: string;
    sections?: InteractiveListSection[];
  };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'bot';
  text?: string;
  audioUrl?: string;
  transcript?: string;
  items?: BotResponseItem[];
  timestamp: Date;
}
