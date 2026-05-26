import { GameState, Player, ClientMessage, ServerMessage } from './types';
import { generateSecretWord, evaluateQuestion } from './gemini';

export interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
}

interface WsAttachment {
  playerId: string;
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
      giverId: null,
      currentGuesserId: null,
      questionsLeft: 20,
      questionLog: [],
      winnerName: null,
      aiEnabled: false,
    };
    // Restore persisted state before handling any request or message.
    // blockConcurrencyWhile ensures no fetch/webSocketMessage runs until this completes.
    state.blockConcurrencyWhile(async () => {
      const saved = await state.storage.get<GameState>('gameState');
      if (saved) this.gameState = saved;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId') ?? 'unknown';

    if (!this.gameState.roomId) {
      this.gameState.roomId = roomId;
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      // Store empty playerId; filled in when client sends join_room
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
      case 'join_room':
        await this.handleJoin(ws, msg.playerName);
        break;
      case 'webrtc_signal':
        this.handleSignal(playerId, msg.targetId, msg.signalData);
        break;
      case 'start_game':
        await this.handleStartGame(playerId);
        break;
      case 'ask_question':
        await this.handleAskQuestion(playerId, msg.text);
        break;
      case 'giver_answer':
        this.handleGiverAnswer(playerId, msg.answer);
        break;
      case 'next_turn':
        await this.handleNextTurn(playerId);
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
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

    const player: Player = {
      id: playerId,
      name: playerName.trim().slice(0, 20),
      role: 'guesser',
      score: 0,
      isConnected: true,
    };
    this.gameState.players.push(player);

    // saveAndBroadcast sends room_state to every connected player including the one who just joined
    await this.saveAndBroadcast();
  }

  private handleSignal(fromId: string, targetId: string, signalData: unknown): void {
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (playerId === targetId) {
        this.send(ws, { type: 'webrtc_signal', fromId, signalData });
        break;
      }
    }
  }

  private async handleStartGame(_requesterId: string): Promise<void> {
    if (this.gameState.status !== 'lobby') return;
    const connected = this.gameState.players.filter(p => p.isConnected);
    if (connected.length < 2) return;

    const giverIdx = Math.floor(Math.random() * connected.length);
    connected.forEach((p, i) => { p.role = i === giverIdx ? 'giver' : 'guesser'; });

    const giver = connected[giverIdx];
    this.gameState.giverId = giver.id;
    this.gameState.currentGuesserId = connected.find(p => p.role === 'guesser')?.id ?? null;
    this.gameState.secretWord = await generateSecretWord(this.env.GEMINI_API_KEY);
    this.gameState.status = 'playing';
    this.gameState.questionsLeft = 20;
    this.gameState.questionLog = [];
    this.gameState.aiEnabled = Boolean(this.env.GEMINI_API_KEY);

    await this.state.storage.put('gameState', this.gameState);

    // Send everyone room_state, then send the secret word only to the giver
    const publicState = { ...this.gameState, secretWord: null };
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (!playerId) continue;
      this.send(ws, { type: 'room_state', state: publicState, yourPlayerId: playerId });
      if (playerId === giver.id) {
        this.send(ws, { type: 'secret_word', word: this.gameState.secretWord! });
      }
    }

    await this.env.DB.prepare(
      `INSERT OR REPLACE INTO room_sessions (room_id, secret_word) VALUES (?, ?)`
    ).bind(this.gameState.roomId, this.gameState.secretWord).run();
  }

  private handleGiverAnswer(playerId: string, answer: string): void {
    if (this.gameState.status !== 'playing') return;
    if (this.gameState.giverId !== playerId) return;
    if (!answer.trim()) return;
    const player = this.gameState.players.find(p => p.id === playerId);
    if (!player) return;
    this.broadcastAll({ type: 'giver_answer', playerName: player.name, answer: answer.trim() });
  }

  private async handleAskQuestion(playerId: string, text: string): Promise<void> {
    if (this.gameState.status !== 'playing') return;
    if (this.gameState.currentGuesserId !== playerId) return;
    if (!text.trim()) return;

    const player = this.gameState.players.find(p => p.id === playerId);
    if (!player) return;

    const trimmed = text.trim();

    if (this.gameState.aiEnabled) {
      const result = await evaluateQuestion(this.env.GEMINI_API_KEY, trimmed);
      player.score += result.score;
      this.gameState.questionLog.push({ playerName: player.name, playerId, question: trimmed, score: result.score, feedback: result.feedback, highlightedWords: result.highlightedWords });
      this.broadcastAll({ type: 'ai_evaluation', playerId, playerName: player.name, question: trimmed, score: result.score, feedback: result.feedback, highlightedWords: result.highlightedWords });
      await this.env.DB.prepare(
        `INSERT INTO game_logs (room_id, secret_word, player_name, question, score, feedback) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(this.gameState.roomId, this.gameState.secretWord ?? '', player.name, trimmed, result.score, result.feedback).run();
    } else {
      this.gameState.questionLog.push({ playerName: player.name, playerId, question: trimmed, score: 0, feedback: '', highlightedWords: [] });
      this.broadcastAll({ type: 'ai_evaluation', playerId, playerName: player.name, question: trimmed, score: 0, feedback: '', highlightedWords: [] });
    }

    const secretLower = this.gameState.secretWord?.toLowerCase() ?? '';
    const questionLower = trimmed.toLowerCase();
    if (secretLower && (questionLower.includes(`is it ${secretLower}`) || questionLower.includes(`is it a ${secretLower}`) || questionLower === secretLower)) {
      await this.endGame(player.name);
      return;
    }

    await this.saveState();
  }

  private async handleNextTurn(playerId: string): Promise<void> {
    if (this.gameState.status !== 'playing') return;
    if (this.gameState.giverId !== playerId) return;

    this.gameState.questionsLeft -= 1;
    if (this.gameState.questionsLeft <= 0) {
      await this.endGame(null);
      return;
    }

    const guessers = this.gameState.players.filter(p => p.role === 'guesser' && p.isConnected);
    if (guessers.length === 0) return;

    const currentIdx = guessers.findIndex(p => p.id === this.gameState.currentGuesserId);
    this.gameState.currentGuesserId = guessers[(currentIdx + 1) % guessers.length].id;

    this.broadcastAll({ type: 'turn_update', currentGuesserId: this.gameState.currentGuesserId, questionsLeft: this.gameState.questionsLeft });
    await this.saveState();
  }

  private async endGame(winnerName: string | null): Promise<void> {
    this.gameState.status = 'finished';
    this.gameState.winnerName = winnerName;

    const scores = this.gameState.players
      .filter(p => p.role === 'guesser')
      .map(p => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    this.broadcastAll({ type: 'game_over', winnerName, secretWord: this.gameState.secretWord ?? '', scores });

    await this.env.DB.prepare(
      `UPDATE room_sessions SET winner_name = ?, ended_at = CURRENT_TIMESTAMP WHERE room_id = ?`
    ).bind(winnerName, this.gameState.roomId).run();

    await this.saveState();
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* connection closed */ }
  }

  private broadcastAll(msg: ServerMessage): void {
    for (const ws of this.state.getWebSockets()) {
      this.send(ws, msg);
    }
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('gameState', this.gameState);
  }

  private async saveAndBroadcast(): Promise<void> {
    await this.saveState();
    const state = { ...this.gameState, secretWord: null };
    for (const ws of this.state.getWebSockets()) {
      const { playerId } = (ws.deserializeAttachment() ?? { playerId: '' }) as WsAttachment;
      if (playerId) {
        this.send(ws, { type: 'room_state', state, yourPlayerId: playerId });
      }
    }
  }
}
