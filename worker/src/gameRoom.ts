import { GameState, Player, ClientMessage, ServerMessage, SpeakEntry, WordScore } from './types';
import { generateSecretWord, scoreWordDifficulty } from './gemini';

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
}

interface WsAttachment {
  playerId: string;
}

const STOP_WORDS = new Set(['a','an','the','is','it','in','on','at','to','of','and','or','but','i','my','we','he','she','they','you','be','do','go','no','so','up','as','by','if','me','us','am']);

function getMaskedWord(word: string, guessedLetters: string[]): string[] {
  return word.split('').map(l => guessedLetters.includes(l) ? l : '_');
}

function extractWords(text: string): string[] {
  const words = text.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

export class GameRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private gameState: GameState;
  private secretWord = '';

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.gameState = {
      roomId: '',
      status: 'lobby',
      players: [],
      wordLength: 0,
      maskedWord: [],
      guessedLetters: [],
      wrongLetters: [],
      maxWrong: 6,
      llmScoring: false,
      speakLog: [],
      winner: null,
    };
    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get<{ gameState: GameState; secretWord: string }>('state');
      if (saved) {
        this.gameState = saved.gameState;
        this.secretWord = saved.secretWord;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId') ?? 'unknown';
    if (!this.gameState.roomId) this.gameState.roomId = roomId;

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ playerId: '' });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as ClientMessage;
    } catch {
      this.send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;

    switch (msg.type) {
      case 'join_room':     await this.handleJoin(ws, msg.playerName); break;
      case 'webrtc_signal': this.handleSignal(playerId, msg.targetId, msg.signalData); break;
      case 'start_game':    await this.handleStartGame(msg.llmScoring); break;
      case 'guess_letter':  await this.handleGuessLetter(playerId, msg.letter); break;
      case 'speak_log':     await this.handleSpeakLog(playerId, msg.text); break;
      case 'ping':          this.send(ws, { type: 'pong' }); break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
    if (!playerId) return;
    const player = this.gameState.players.find(p => p.id === playerId);
    if (player) {
      player.isConnected = false;
      await this.saveAndBroadcast();
    }
  }

  private async handleJoin(ws: WebSocket, playerName: string): Promise<void> {
    if (this.gameState.status === 'playing') {
      this.send(ws, { type: 'error', message: 'Game already in progress' });
      return;
    }
    const playerId = crypto.randomUUID();
    ws.serializeAttachment({ playerId });
    const player: Player = { id: playerId, name: playerName.trim().slice(0, 20), score: 0, isConnected: true };
    this.gameState.players.push(player);
    await this.saveAndBroadcast();
  }

  private handleSignal(fromId: string, targetId: string, signalData: unknown): void {
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (playerId === targetId) { this.send(ws, { type: 'webrtc_signal', fromId, signalData }); break; }
    }
  }

  private async handleStartGame(llmScoring: boolean): Promise<void> {
    if (this.gameState.status !== 'lobby') return;
    if (this.gameState.players.filter(p => p.isConnected).length < 2) return;

    this.secretWord = await generateSecretWord(this.env.GEMINI_API_KEY);
    this.secretWord = this.secretWord.toLowerCase().replace(/[^a-z]/g, '');

    // Only enable LLM scoring if caller requested it AND the key is available
    this.gameState.llmScoring = llmScoring && Boolean(this.env.GEMINI_API_KEY);
    this.gameState.status = 'playing';
    this.gameState.wordLength = this.secretWord.length;
    this.gameState.guessedLetters = [];
    this.gameState.wrongLetters = [];
    this.gameState.maskedWord = getMaskedWord(this.secretWord, []);
    this.gameState.speakLog = [];
    this.gameState.winner = null;

    await this.saveState();
    this.broadcastAll((playerId) => ({ type: 'room_state' as const, state: this.gameState, yourPlayerId: playerId }));

    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO room_sessions (room_id, secret_word) VALUES (?, ?)`
    ).bind(this.gameState.roomId, this.secretWord).run().catch(() => {});
  }

  private async handleGuessLetter(playerId: string, letter: string): Promise<void> {
    if (this.gameState.status !== 'playing') return;
    const l = letter.toLowerCase();
    if (!/^[a-z]$/.test(l) || this.gameState.guessedLetters.includes(l)) return;

    const correct = this.secretWord.includes(l);
    this.gameState.guessedLetters.push(l);
    if (!correct) this.gameState.wrongLetters.push(l);
    this.gameState.maskedWord = getMaskedWord(this.secretWord, this.gameState.guessedLetters);

    const player = this.gameState.players.find(p => p.id === playerId);
    if (player && correct) player.score += 1;

    this.broadcastAll(() => ({
      type: 'letter_result' as const,
      letter: l, correct,
      maskedWord: this.gameState.maskedWord,
      guessedLetters: this.gameState.guessedLetters,
      wrongLetters: this.gameState.wrongLetters,
      playerId,
      playerName: player?.name ?? '',
    }));

    const allGuessed = this.secretWord.split('').every(c => this.gameState.guessedLetters.includes(c));
    if (allGuessed) { await this.endGame('players'); return; }
    if (this.gameState.wrongLetters.length >= this.gameState.maxWrong) { await this.endGame('house'); return; }

    await this.saveState();
  }

  private async handleSpeakLog(playerId: string, text: string): Promise<void> {
    if (this.gameState.status !== 'playing' || !text.trim()) return;
    const player = this.gameState.players.find(p => p.id === playerId);
    if (!player) return;

    const wordList = extractWords(text);
    if (!wordList.length) return;

    let wordScores: WordScore[];

    if (this.gameState.llmScoring) {
      const difficultyMap = await scoreWordDifficulty(this.env.GEMINI_API_KEY, wordList);
      wordScores = wordList.map(w => ({ word: w, points: difficultyMap[w] ?? 1 }));
    } else {
      wordScores = wordList.map(w => ({ word: w, points: 1 }));
    }

    const totalScore = wordScores.reduce((sum, ws) => sum + ws.points, 0);
    player.score += totalScore;

    const entry: SpeakEntry = {
      playerId,
      playerName: player.name,
      words: wordScores,
      totalScore,
      timestamp: Date.now(),
    };
    this.gameState.speakLog.push(entry);
    this.broadcastAll(() => ({ type: 'speak_logged' as const, entry }));
    await this.saveState();
  }

  private async endGame(winner: 'players' | 'house'): Promise<void> {
    this.gameState.status = 'finished';
    this.gameState.winner = winner;
    this.gameState.maskedWord = this.secretWord.split('');
    const scores = this.gameState.players.map(p => ({ name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
    this.broadcastAll(() => ({ type: 'game_over' as const, winner, secretWord: this.secretWord, scores }));
    await this.saveState();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* closed */ }
  }

  private broadcastAll(msgFn: (playerId: string) => ServerMessage): void {
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (playerId) this.send(ws, msgFn(playerId));
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('state', { gameState: this.gameState, secretWord: this.secretWord });
  }

  private async saveAndBroadcast(): Promise<void> {
    await this.saveState();
    this.broadcastAll((playerId) => ({ type: 'room_state', state: this.gameState, yourPlayerId: playerId }));
  }
}
