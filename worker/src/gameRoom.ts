import { GameState, Player, ClientMessage, ServerMessage, SpeakEntry } from './types';
import { generateSecretWord } from './gemini';

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
}

interface WsAttachment {
  playerId: string;
}

// Stripped words to score: remove punctuation, short filler words, duplicates
const STOP_WORDS = new Set(['a','an','the','is','it','in','on','at','to','of','and','or','but','i','my','we','he','she','they','you','be','do','go','no','so','up','as','by','if','me','us','am']);

function scoreWords(text: string): string[] {
  const words = text.toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)]; // deduplicate
}

export class GameRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private gameState: GameState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.gameState = {
      roomId: '',
      status: 'lobby',
      players: [],
      secretWord: null,
      wordLength: 0,
      wordMasterId: null,
      guessedLetters: [],
      wrongLetters: [],
      maxWrong: 6,
      hintsUsed: 0,
      speakLog: [],
      winnerTeam: null,
    };
    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get<GameState>('gameState');
      if (saved) this.gameState = saved;
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
      case 'start_game':    await this.handleStartGame(); break;
      case 'guess_letter':  await this.handleGuessLetter(playerId, msg.letter); break;
      case 'speak_log':     await this.handleSpeakLog(playerId, msg.text); break;
      case 'give_hint':     await this.handleGiveHint(playerId); break;
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
    const player: Player = { id: playerId, name: playerName.trim().slice(0, 20), role: 'guesser', score: 0, isConnected: true };
    this.gameState.players.push(player);
    await this.saveAndBroadcast();
  }

  private handleSignal(fromId: string, targetId: string, signalData: unknown): void {
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (playerId === targetId) { this.send(ws, { type: 'webrtc_signal', fromId, signalData }); break; }
    }
  }

  private async handleStartGame(): Promise<void> {
    if (this.gameState.status !== 'lobby') return;
    const connected = this.gameState.players.filter(p => p.isConnected);
    if (connected.length < 2) return;

    // Random word master
    const masterIdx = Math.floor(Math.random() * connected.length);
    connected.forEach((p, i) => { p.role = i === masterIdx ? 'word_master' : 'guesser'; });
    const master = connected[masterIdx];
    this.gameState.wordMasterId = master.id;

    // Get word
    const word = await generateSecretWord(this.env.GEMINI_API_KEY);
    this.gameState.secretWord = word.toLowerCase().replace(/[^a-z]/g, '');
    this.gameState.wordLength = this.gameState.secretWord.length;
    this.gameState.status = 'playing';
    this.gameState.guessedLetters = [];
    this.gameState.wrongLetters = [];
    this.gameState.hintsUsed = 0;
    this.gameState.speakLog = [];
    this.gameState.winnerTeam = null;

    await this.state.storage.put('gameState', this.gameState);

    // Broadcast — hide word from guessers
    const publicState = { ...this.gameState, secretWord: null };
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (!playerId) continue;
      this.send(ws, { type: 'room_state', state: publicState, yourPlayerId: playerId });
      if (playerId === master.id) {
        this.send(ws, { type: 'secret_word', word: this.gameState.secretWord! });
      }
    }

    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO room_sessions (room_id, secret_word) VALUES (?, ?)`
    ).bind(this.gameState.roomId, this.gameState.secretWord).run().catch(() => {});
  }

  private async handleGuessLetter(playerId: string, letter: string): Promise<void> {
    if (this.gameState.status !== 'playing') return;
    // Word master cannot guess
    if (this.gameState.wordMasterId === playerId) return;

    const l = letter.toLowerCase();
    if (!/^[a-z]$/.test(l)) return;
    if (this.gameState.guessedLetters.includes(l)) return;

    const word = this.gameState.secretWord ?? '';
    const correct = word.includes(l);
    this.gameState.guessedLetters.push(l);
    if (!correct) this.gameState.wrongLetters.push(l);

    const player = this.gameState.players.find(p => p.id === playerId)!;
    if (correct) player.score += 1;

    this.broadcastAll({
      type: 'letter_result',
      letter: l,
      correct,
      guessedLetters: this.gameState.guessedLetters,
      wrongLetters: this.gameState.wrongLetters,
      playerId,
      playerName: player.name,
    });

    // Check win: all letters guessed
    const allGuessed = word.split('').every(c => this.gameState.guessedLetters.includes(c));
    if (allGuessed) {
      await this.endGame('guessers');
      return;
    }

    // Check lose: 6 wrong guesses
    if (this.gameState.wrongLetters.length >= this.gameState.maxWrong) {
      await this.endGame('master');
      return;
    }

    await this.saveState();
  }

  private async handleGiveHint(playerId: string): Promise<void> {
    if (this.gameState.status !== 'playing') return;
    if (this.gameState.wordMasterId !== playerId) return;
    if (this.gameState.hintsUsed >= 3) return; // max 3 hints

    const word = this.gameState.secretWord ?? '';
    // Pick a random unrevealed letter to hint
    const unrevealed = word.split('').filter(
      (l, i) => word.indexOf(l) === i && !this.gameState.guessedLetters.includes(l)
    );
    if (unrevealed.length === 0) return;

    const hintLetter = unrevealed[Math.floor(Math.random() * unrevealed.length)];
    this.gameState.hintsUsed += 1;
    this.gameState.guessedLetters.push(hintLetter);

    this.broadcastAll({
      type: 'hint_given',
      letter: hintLetter,
      hintsUsed: this.gameState.hintsUsed,
    });

    // Check if hint completed the word
    const allGuessed = word.split('').every(c => this.gameState.guessedLetters.includes(c));
    if (allGuessed) {
      await this.endGame('guessers');
      return;
    }

    await this.saveState();
  }

  private async handleSpeakLog(playerId: string, text: string): Promise<void> {
    if (this.gameState.status !== 'playing') return;
    if (!text.trim()) return;

    const player = this.gameState.players.find(p => p.id === playerId);
    if (!player) return;

    const words = scoreWords(text);
    const score = words.length;
    player.score += score;

    const entry: SpeakEntry = {
      playerId,
      playerName: player.name,
      text: text.trim(),
      words,
      score,
      timestamp: Date.now(),
    };
    this.gameState.speakLog.push(entry);
    this.broadcastAll({ type: 'speak_logged', entry });
    await this.saveState();
  }

  private async endGame(winnerTeam: 'guessers' | 'master'): Promise<void> {
    this.gameState.status = 'finished';
    this.gameState.winnerTeam = winnerTeam;

    const scores = this.gameState.players
      .map(p => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    this.broadcastAll({
      type: 'game_over',
      winnerTeam,
      secretWord: this.gameState.secretWord ?? '',
      scores,
    });

    await this.env.DB.prepare(
      `UPDATE room_sessions SET winner_name = ?, ended_at = CURRENT_TIMESTAMP WHERE room_id = ?`
    ).bind(winnerTeam === 'guessers' ? 'guessers_team' : 'word_master', this.gameState.roomId).run().catch(() => {});

    await this.saveState();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* closed */ }
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const ws of this.state.getWebSockets()) this.send(ws, msg);
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('gameState', this.gameState);
  }

  private async saveAndBroadcast(): Promise<void> {
    await this.saveState();
    const state = { ...this.gameState, secretWord: null };
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (playerId) this.send(ws, { type: 'room_state', state, yourPlayerId: playerId });
    }
  }
}
