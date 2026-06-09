export type GameStatus = 'lobby' | 'playing' | 'finished';

export interface Player {
  id: string;
  name: string;
  score: number;
  isConnected: boolean;
}

export interface WordScore {
  word: string;
  points: number; // 1 (flat) or 1–5 (CEFR difficulty via LLM)
}

export interface GameState {
  roomId: string;
  status: GameStatus;
  players: Player[];
  wordLength: number;
  maskedWord: string[];
  guessedLetters: string[];
  wrongLetters: string[];
  maxWrong: number;
  llmScoring: boolean;
  speakLog: SpeakEntry[];
  winner: 'players' | 'house' | null;
}

export interface SpeakEntry {
  playerId: string;
  playerName: string;
  words: WordScore[];
  totalScore: number;
  timestamp: number;
}

// Client → Server
export type ClientMessage =
  | { type: 'join_room'; playerName: string }
  | { type: 'webrtc_signal'; targetId: string; signalData: unknown }
  | { type: 'start_game'; llmScoring: boolean }
  | { type: 'guess_letter'; letter: string }
  | { type: 'speak_log'; text: string }
  | { type: 'ping' };

// Server → Client
export type ServerMessage =
  | { type: 'room_state'; state: GameState; yourPlayerId: string }
  | { type: 'webrtc_signal'; fromId: string; signalData: unknown }
  | { type: 'letter_result'; letter: string; correct: boolean; maskedWord: string[]; guessedLetters: string[]; wrongLetters: string[]; playerId: string; playerName: string }
  | { type: 'speak_logged'; entry: SpeakEntry }
  | { type: 'game_over'; winner: 'players' | 'house'; secretWord: string; scores: Array<{ name: string; score: number }> }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  GEMINI_API_KEY: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}
