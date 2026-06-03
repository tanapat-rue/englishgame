export type PlayerRole = 'word_master' | 'guesser';
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
  secretWord: string | null;         // null for guessers
  wordLength: number;                // always visible — length of the secret word
  wordMasterId: string | null;
  guessedLetters: string[];          // all letters tried
  wrongLetters: string[];            // letters not in word
  maxWrong: number;                  // always 6
  hintsUsed: number;                 // how many hints word master has given
  speakLog: SpeakEntry[];
  winnerTeam: 'guessers' | 'master' | null;
}

export interface SpeakEntry {
  playerId: string;
  playerName: string;
  text: string;
  words: string[];    // content words scored
  score: number;      // words.length
  timestamp: number;
}

// Client → Server
export type ClientMessage =
  | { type: 'join_room'; playerName: string }
  | { type: 'webrtc_signal'; targetId: string; signalData: unknown }
  | { type: 'start_game' }
  | { type: 'guess_letter'; letter: string }
  | { type: 'speak_log'; text: string }
  | { type: 'give_hint' }
  | { type: 'ping' };

// Server → Client
export type ServerMessage =
  | { type: 'room_state'; state: GameState; yourPlayerId: string }
  | { type: 'webrtc_signal'; fromId: string; signalData: unknown }
  | { type: 'secret_word'; word: string }
  | { type: 'letter_result'; letter: string; correct: boolean; guessedLetters: string[]; wrongLetters: string[]; playerId: string; playerName: string }
  | { type: 'hint_given'; letter: string; hintsUsed: number }
  | { type: 'speak_logged'; entry: SpeakEntry }
  | { type: 'game_over'; winnerTeam: 'guessers' | 'master'; secretWord: string; scores: Array<{ name: string; score: number }> }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  DB: D1Database;
  GEMINI_API_KEY: string;
  TURN_KEY_ID?: string;
  TURN_API_TOKEN?: string;
}
