export type GameStatus = 'lobby' | 'playing' | 'finished';

export interface Player {
  id: string;
  name: string;
  score: number;
  isConnected: boolean;
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
  speakLog: SpeakEntry[];
  winner: 'players' | 'house' | null;
}

export interface SpeakEntry {
  playerId: string;
  playerName: string;
  text: string;
  words: string[];
  score: number;
  timestamp: number;
}

export type ServerMessage =
  | { type: 'room_state'; state: GameState; yourPlayerId: string }
  | { type: 'webrtc_signal'; fromId: string; signalData: unknown }
  | { type: 'letter_result'; letter: string; correct: boolean; maskedWord: string[]; guessedLetters: string[]; wrongLetters: string[]; playerId: string; playerName: string }
  | { type: 'speak_logged'; entry: SpeakEntry }
  | { type: 'game_over'; winner: 'players' | 'house'; secretWord: string; scores: Array<{ name: string; score: number }> }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'join_room'; playerName: string }
  | { type: 'webrtc_signal'; targetId: string; signalData: unknown }
  | { type: 'start_game' }
  | { type: 'guess_letter'; letter: string }
  | { type: 'speak_log'; text: string }
  | { type: 'ping' };

export interface ChatEntry {
  id: string;
  playerName: string;
  question: string;
  score: number;
  feedback: string;
  highlightedWords: string[];
  timestamp: number;
}
