import { useEffect } from 'react';
import { ClientMessage, GameState, ServerMessage } from '../types';

interface SharedGameState {
  gameState: GameState | null;
  myId: string | null;
}

interface Props {
  roomId: string;
  playerName: string;
  shared: SharedGameState;
  send: (msg: ClientMessage) => void;
  connected: boolean;
  onRegisterHandler: (fn: (msg: ServerMessage) => void) => void;
  onLeave: () => void;
}

export default function LobbyScreen({ roomId, playerName, shared, send, connected, onRegisterHandler, onLeave }: Props) {
  const { gameState, myId } = shared;

  // Register a no-op handler; App.tsx already handles room_state and screen transitions
  useEffect(() => {
    onRegisterHandler(() => {});
  }, [onRegisterHandler]);

  // Send join_room as soon as the WS is connected
  useEffect(() => {
    if (connected) {
      send({ type: 'join_room', playerName });
    }
    // Only run when connection first comes up — playerName won't change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const handleStartGame = () => {
    const connectedCount = gameState?.players.filter(p => p.isConnected).length ?? 0;
    if (connectedCount >= 2) send({ type: 'start_game' });
  };

  const connectedPlayers = gameState?.players.filter(p => p.isConnected) ?? [];
  const canStart = connectedPlayers.length >= 2;

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-white">Room Lobby</h2>
          <p className="text-gray-400 text-sm mt-1">Share this code with friends</p>
        </div>

        <div className="bg-gray-900 rounded-2xl p-6 space-y-4">
          <div className="text-center">
            <p className="text-gray-400 text-xs uppercase tracking-widest mb-1">Room Code</p>
            <p className="text-4xl font-mono font-bold text-indigo-400 tracking-widest">{roomId}</p>
          </div>

          <div className="space-y-2">
            <p className="text-gray-400 text-xs uppercase tracking-widest">
              Players ({connectedPlayers.length})
            </p>
            {connectedPlayers.map(p => (
              <div key={p.id} className="flex items-center gap-2 bg-gray-800 rounded-xl px-4 py-3">
                <div className="w-2 h-2 rounded-full bg-green-400" />
                <span className="text-white font-medium">{p.name}</span>
                {p.id === myId && <span className="ml-auto text-indigo-400 text-xs">(you)</span>}
              </div>
            ))}
            {connectedPlayers.length === 0 && (
              <p className="text-gray-600 text-sm text-center py-2">
                {connected ? 'Waiting for players...' : 'Connecting...'}
              </p>
            )}
          </div>

          {!connected && (
            <p className="text-yellow-400 text-sm text-center">Reconnecting...</p>
          )}

          <button
            onClick={handleStartGame}
            disabled={!canStart || !connected}
            className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl py-4 text-lg font-semibold transition-colors"
          >
            {canStart ? 'Start Game' : `Need ${2 - connectedPlayers.length} more player(s)`}
          </button>

          <button
            onClick={onLeave}
            className="w-full text-gray-500 text-sm py-2"
          >
            Leave Room
          </button>
        </div>
      </div>
    </div>
  );
}
