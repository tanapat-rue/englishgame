export type PlayerRole = 'giver' | 'guesser' | 'spectator';
export type GameStatus = 'lobby' | 'playing' | 'finished';

export interface Player {
  id: string;
  name: string;
  role: PlayerRole;
  score: number;
  isConnected: boolean;
}

export interface GameState {
  roomId: string;
  status: GameStatus;
  players: Player[];
  secretWord: string | null;
  giverId: string | null;
  currentGuesserId: string | null;
  questionsLeft: number;
  questionLog: QuestionLog[];
  winnerName: string | null;
  aiEnabled: boolean;
}

export interface QuestionLog {
  playerName: string;
  playerId: string;
  question: string;
  score: number;
  feedback: string;
  highlightedWords: string[];
}

// WebSocket message types (Client -> Server)
export type ClientMessage =
  | { type: 'join_room'; playerName: string }
  | { type: 'webrtc_signal'; targetId: string; signalData: unknown }
  | { type: 'start_game' }
  | { type: 'ask_question'; text: string }
  | { type: 'giver_answer'; answer: string }
  | { type: 'next_turn' }
  | { type: 'ping' };

// WebSocket message types (Server -> Client)
export type ServerMessage =
  | { type: 'room_state'; state: GameState; yourPlayerId: string }
  | { type: 'webrtc_signal'; fromId: string; signalData: unknown }
  | { type: 'secret_word'; word: string }
  | { type: 'ai_evaluation'; playerId: string; playerName: string; question: string; score: number; feedback: string; highlightedWords: string[] }
  | { type: 'giver_answer'; playerName: string; answer: string }
  | { type: 'turn_update'; currentGuesserId: string | null; questionsLeft: number }
  | { type: 'game_over'; winnerName: string | null; secretWord: string; scores: Array<{ name: string; score: number }> }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  GEMINI_API_KEY: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}
