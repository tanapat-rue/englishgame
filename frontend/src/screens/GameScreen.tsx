import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatEntry, ClientMessage, GameState, ServerMessage } from '../types';
import { useWebRTC } from '../hooks/useWebRTC';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';

interface SharedGameState {
  gameState: GameState | null;
  myId: string | null;
  secretWord: string | null;
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

type ChatEntryKind = ChatEntry & { kind: 'question' | 'answer' };

export default function GameScreen({ playerName, shared, send, connected, onRegisterHandler, onLeave }: Props) {
  const [gameState, setGameState] = useState<GameState | null>(shared.gameState);
  const [myId] = useState<string | null>(shared.myId);
  const [secretWord, setSecretWord] = useState<string | null>(shared.secretWord);
  const [chatLog, setChatLog] = useState<ChatEntryKind[]>([]);
  const [gameOver, setGameOver] = useState<{ winnerName: string | null; secretWord: string; scores: Array<{ name: string; score: number }> } | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [lastScore, setLastScore] = useState<{ score: number; show: boolean }>({ score: 0, show: false });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const isPressingRef = useRef(false);

  const { transcript, isListening, isSupported, startListening, stopListening } = useSpeechRecognition();

  const [iceServers, setIceServers] = useState<RTCIceServer[]>([]);
  useEffect(() => {
    const base = import.meta.env.DEV ? 'http://localhost:8787' : (import.meta.env.VITE_WORKER_URL ?? '');
    fetch(`${base}/api/turn-credentials`)
      .then(r => r.json())
      .then((d: { iceServers?: RTCIceServer[] }) => { if (d.iceServers?.length) setIceServers(d.iceServers); })
      .catch(() => {});
  }, []);

  const handleSendSignal = useCallback((targetId: string, signalData: unknown) => {
    send({ type: 'webrtc_signal', targetId, signalData });
  }, [send]);

  const { initLocalStream, setMuted, handleIncomingSignal, initiateConnectionTo, streamReady, remoteStreams, getAudioLevels, debugLog } = useWebRTC({
    myId,
    onSendSignal: handleSendSignal,
    iceServers,
  });

  const localBarRef = useRef<HTMLDivElement>(null);
  const remoteBarRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    let raf: number;
    const tick = () => {
      const { local, remote } = getAudioLevels();
      if (localBarRef.current) {
        localBarRef.current.style.width = `${Math.round(local * 100)}%`;
        localBarRef.current.style.backgroundColor = local > 0.6 ? '#4ade80' : local > 0.1 ? '#16a34a' : '#374151';
      }
      for (const [pid, el] of remoteBarRefs.current.entries()) {
        const lvl = remote.get(pid) ?? 0;
        el.style.width = `${Math.round(lvl * 100)}%`;
        el.style.backgroundColor = lvl > 0.6 ? '#4ade80' : lvl > 0.1 ? '#16a34a' : '#374151';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getAudioLevels]);

  const handleIncomingSignalRef = useRef(handleIncomingSignal);
  handleIncomingSignalRef.current = handleIncomingSignal;

  useEffect(() => {
    onRegisterHandler((msg: ServerMessage) => {
      switch (msg.type) {
        case 'room_state':
          setGameState(msg.state);
          break;
        case 'secret_word':
          setSecretWord(msg.word);
          break;
        case 'ai_evaluation':
          setChatLog(prev => [...prev, {
            id: crypto.randomUUID(),
            kind: 'question',
            playerName: msg.playerName,
            question: msg.question,
            score: msg.score,
            feedback: msg.feedback,
            highlightedWords: msg.highlightedWords,
            timestamp: Date.now(),
          }]);
          setLastScore({ score: msg.score, show: true });
          setTimeout(() => setLastScore(prev => ({ ...prev, show: false })), 2000);
          break;
        case 'giver_answer':
          setChatLog(prev => [...prev, {
            id: crypto.randomUUID(),
            kind: 'answer',
            playerName: msg.playerName,
            question: msg.answer,
            score: 0,
            feedback: '',
            highlightedWords: [],
            timestamp: Date.now(),
          }]);
          break;
        case 'turn_update':
          setGameState(prev => prev ? { ...prev, currentGuesserId: msg.currentGuesserId, questionsLeft: msg.questionsLeft } : prev);
          break;
        case 'game_over':
          setGameOver(msg);
          break;
        case 'webrtc_signal':
          handleIncomingSignalRef.current(msg.fromId, msg.signalData);
          break;
      }
    });
  }, [onRegisterHandler]);

  useEffect(() => { initLocalStream(); }, [initLocalStream]);

  useEffect(() => {
    const unlock = () => {
      initLocalStream();
      document.querySelectorAll<HTMLAudioElement>('audio[data-remote]').forEach(el => {
        if (el.paused) el.play().catch(() => {});
      });
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('touchstart', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('touchstart', unlock);
    };
  }, [initLocalStream]);

  useEffect(() => {
    if (!streamReady || !myId || !gameState) return;
    gameState.players.forEach(p => {
      if (p.id !== myId && p.isConnected && p.id > myId) {
        initiateConnectionTo(p.id);
      }
    });
  }, [streamReady, gameState, myId, initiateConnectionTo]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatLog]);

  const myRole = gameState?.players.find(p => p.id === myId)?.role;
  const isGiver = myRole === 'giver';
  const isMyTurn = !isGiver && myId !== null && gameState?.currentGuesserId === myId;

  const handlePressStart = useCallback(() => {
    if (isPressingRef.current) return;
    isPressingRef.current = true;
    initLocalStream();
    setMuted(false);
    if (isSupported) startListening();
  }, [initLocalStream, setMuted, isSupported, startListening]);

  const handlePressEnd = useCallback(() => {
    if (!isPressingRef.current) return;
    isPressingRef.current = false;
    setMuted(true);
    const text = stopListening();
    if (!text.trim()) return;
    if (isMyTurn) {
      send({ type: 'ask_question', text: text.trim() });
    } else if (isGiver) {
      send({ type: 'giver_answer', answer: text.trim() });
    }
  }, [setMuted, stopListening, isMyTurn, isGiver, send]);

  const handleNextTurn = useCallback(() => send({ type: 'next_turn' }), [send]);

  const aiEnabled = gameState?.aiEnabled ?? false;
  const guessers = gameState?.players.filter(p => p.role === 'guesser') ?? [];
  const currentGuesser = gameState?.players.find(p => p.id === gameState?.currentGuesserId);
  const questionsLeft = gameState?.questionsLeft ?? 20;
  const progress = ((20 - questionsLeft) / 20) * 100;

  if (gameOver) {
    return <GameOverScreen gameOver={gameOver} aiEnabled={aiEnabled} onLeave={onLeave} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col overflow-hidden">

      {/* Remote audio elements */}
      {Array.from(remoteStreams.entries()).map(([peerId, stream]) => (
        <RemoteAudio key={peerId} stream={stream} onBlocked={() => setAudioBlocked(true)} />
      ))}

      {/* Mic enable banner */}
      {!streamReady && (
        <button
          onClick={async () => {
            await initLocalStream();
            document.querySelectorAll<HTMLAudioElement>('audio[data-remote]').forEach(el => {
              if (el.paused) el.play().catch(() => {});
            });
          }}
          className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-sm py-3 text-center"
        >
          🎙️ Tap to enable microphone
        </button>
      )}

      {audioBlocked && streamReady && (
        <button
          onClick={() => {
            document.querySelectorAll<HTMLAudioElement>('audio').forEach(a => a.play().catch(() => {}));
            setAudioBlocked(false);
          }}
          className="w-full bg-yellow-500 text-black font-bold text-sm py-3 text-center"
        >
          🔇 Tap to enable voice chat
        </button>
      )}

      {/* ═══ TOP: Role Badge + Progress ═══ */}
      <div className="relative px-4 pt-4 pb-2">
        {/* Role badge */}
        <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-bold ${
          isGiver
            ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-orange-500/30'
            : 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white shadow-lg shadow-indigo-500/30'
        }`}>
          <span className="text-lg">{isGiver ? '🎯' : '🔍'}</span>
          <span>{isGiver ? 'GIVER' : 'GUESSER'}</span>
        </div>

        {/* Question counter */}
        <div className="absolute top-4 right-4 flex flex-col items-center">
          <div className="relative w-14 h-14">
            <svg className="w-14 h-14 -rotate-90" viewBox="0 0 56 56">
              <circle cx="28" cy="28" r="24" stroke="#1f2937" strokeWidth="4" fill="none" />
              <circle cx="28" cy="28" r="24" stroke={questionsLeft <= 5 ? '#ef4444' : '#6366f1'} strokeWidth="4" fill="none"
                strokeDasharray={`${progress * 1.508} 150.8`} strokeLinecap="round" className="transition-all duration-500" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={`text-lg font-black ${questionsLeft <= 5 ? 'text-red-400' : 'text-white'}`}>{questionsLeft}</span>
            </div>
          </div>
          <span className="text-gray-500 text-[10px] mt-0.5">LEFT</span>
        </div>
      </div>

      {/* ═══ SECRET WORD (Giver only) ═══ */}
      {isGiver && secretWord && (
        <div className="mx-4 mb-2">
          <div className="bg-gradient-to-r from-amber-900/40 to-orange-900/40 border border-amber-600/50 rounded-2xl px-5 py-4 backdrop-blur-sm">
            <p className="text-amber-300/70 text-xs font-medium uppercase tracking-widest mb-1">Your Secret Word</p>
            <p className="text-amber-100 text-3xl font-black tracking-wide">{secretWord}</p>
          </div>
        </div>
      )}

      {/* ═══ SCOREBOARD ═══ */}
      <div className="px-4 mb-2">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {guessers.filter(p => p.isConnected).map(p => {
            const isActive = p.id === gameState?.currentGuesserId;
            const isMe = p.id === myId;
            return (
              <div key={p.id} className={`flex-shrink-0 flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-300 ${
                isActive ? 'bg-green-500/20 ring-2 ring-green-400 scale-105' : 'bg-white/5'
              }`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                  isActive ? 'bg-green-500 text-white' : 'bg-indigo-600 text-indigo-100'
                }`}>
                  {p.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className={`text-xs font-semibold truncate max-w-[60px] ${isMe ? 'text-indigo-300' : 'text-white'}`}>
                    {isMe ? 'You' : p.name}
                  </p>
                  {aiEnabled && (
                    <p className="text-yellow-400 text-xs font-bold">{p.score} pts</p>
                  )}
                </div>
                {isActive && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />}
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ CHAT / QUESTION LOG ═══ */}
      <div className="flex-1 overflow-y-auto px-4 space-y-3 py-2">
        {chatLog.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 opacity-60">
            <div className="text-5xl">💬</div>
            <p className="text-gray-400 text-sm">
              {isGiver ? 'Wait for questions from guessers...' : 'Ask Yes/No questions to guess the word!'}
            </p>
          </div>
        )}
        {chatLog.map(entry => (
          <QuestionCard key={entry.id} entry={entry} isMe={entry.playerName === playerName} aiEnabled={aiEnabled} />
        ))}
        <div ref={chatEndRef} />
      </div>

      {/* ═══ FLOATING SCORE POPUP ═══ */}
      {lastScore.show && aiEnabled && (
        <div className="fixed top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 pointer-events-none animate-bounce">
          <div className={`text-6xl font-black ${
            lastScore.score >= 8 ? 'text-green-400' : lastScore.score >= 5 ? 'text-yellow-400' : 'text-red-400'
          } drop-shadow-[0_0_30px_rgba(255,255,255,0.3)]`}>
            +{lastScore.score}
          </div>
        </div>
      )}

      {/* ═══ TURN INDICATOR ═══ */}
      <div className="px-4 py-2 text-center">
        {isMyTurn ? (
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-green-500/20 rounded-full border border-green-500/40">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-300 text-sm font-semibold">Your turn to ask!</span>
          </div>
        ) : isGiver ? (
          <p className="text-orange-300/80 text-sm">
            Listening to <span className="font-bold text-orange-200">{currentGuesser?.name ?? '...'}</span>
          </p>
        ) : (
          <p className="text-gray-400 text-sm">
            <span className="font-bold text-white">{currentGuesser?.name ?? '...'}</span> is thinking...
          </p>
        )}
      </div>

      {/* ═══ CONTROLS ═══ */}
      <div className="px-4 pb-6 pt-2 space-y-3">
        {/* Transcript preview */}
        {transcript && (
          <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl px-4 py-3 text-white text-sm">
            {transcript}
          </div>
        )}

        {/* Speak button — Guesser on their turn */}
        {isMyTurn && !isGiver && (
          <button
            onPointerDown={handlePressStart}
            onPointerUp={handlePressEnd}
            onPointerLeave={handlePressEnd}
            onTouchStart={handlePressStart}
            onTouchEnd={handlePressEnd}
            className={`w-full relative overflow-hidden rounded-3xl py-6 text-white font-bold text-xl select-none transition-all duration-150 ${
              isListening
                ? 'bg-gradient-to-r from-red-500 to-pink-500 scale-[0.97] shadow-2xl shadow-red-500/40'
                : 'bg-gradient-to-r from-indigo-500 to-purple-500 active:scale-[0.97] shadow-xl shadow-indigo-500/30'
            }`}
          >
            {isListening && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-20 h-20 rounded-full bg-white/10 animate-ping" />
              </div>
            )}
            <span className="relative z-10 flex items-center justify-center gap-2">
              <span className="text-2xl">{isListening ? '🎙️' : '🎤'}</span>
              <span>{isListening ? 'Listening...' : 'Hold to Ask'}</span>
            </span>
          </button>
        )}

        {/* Giver controls */}
        {isGiver && (
          <div className="space-y-3">
            <button
              onPointerDown={handlePressStart}
              onPointerUp={handlePressEnd}
              onPointerLeave={handlePressEnd}
              onTouchStart={handlePressStart}
              onTouchEnd={handlePressEnd}
              className={`w-full rounded-3xl py-5 text-white font-bold text-lg select-none transition-all duration-150 ${
                isListening
                  ? 'bg-gradient-to-r from-orange-500 to-amber-500 scale-[0.97] shadow-xl shadow-orange-500/40'
                  : 'bg-white/10 border border-white/20 active:scale-[0.97]'
              }`}
            >
              <span className="flex items-center justify-center gap-2">
                <span className="text-xl">{isListening ? '🔊' : '🎙️'}</span>
                <span>{isListening ? 'Speaking...' : 'Hold to Answer'}</span>
              </span>
            </button>
            <button
              onClick={handleNextTurn}
              className="w-full bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-400 hover:to-emerald-400 active:scale-[0.97] text-white rounded-3xl py-5 text-lg font-bold shadow-xl shadow-green-500/30 transition-all duration-150"
            >
              Next Question →
            </button>
          </div>
        )}

        {/* Waiting state */}
        {!isMyTurn && !isGiver && (
          <div className="text-center py-4">
            <div className="inline-flex items-center gap-2 text-gray-400">
              <div className="flex gap-1">
                <div className="w-2 h-2 rounded-full bg-gray-500 animate-bounce [animation-delay:0ms]" />
                <div className="w-2 h-2 rounded-full bg-gray-500 animate-bounce [animation-delay:150ms]" />
                <div className="w-2 h-2 rounded-full bg-gray-500 animate-bounce [animation-delay:300ms]" />
              </div>
              <span className="text-sm">Waiting for {currentGuesser?.name ?? '...'}</span>
            </div>
          </div>
        )}

        {!connected && (
          <p className="text-yellow-400 text-xs text-center animate-pulse">Reconnecting...</p>
        )}
      </div>

      {/* ═══ DEBUG PANEL ═══ */}
      <details className="bg-black/80 border-t border-gray-800">
        <summary className="px-3 py-1.5 text-xs text-gray-600 cursor-pointer select-none">
          debug ({remoteStreams.size} peer{remoteStreams.size !== 1 ? 's' : ''}, mic: {streamReady ? '✅' : '❌'})
        </summary>
        <div className="px-3 pt-2 pb-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-gray-500 text-[10px] w-14 flex-shrink-0">local</span>
            <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div ref={localBarRef} className="h-full rounded-full" style={{ width: '0%' }} />
            </div>
          </div>
          {Array.from(remoteStreams.keys()).map(pid => (
            <div key={pid} className="flex items-center gap-2">
              <span className="text-gray-500 text-[10px] w-14 flex-shrink-0 truncate">{pid.slice(0, 6)}</span>
              <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div ref={el => { if (el) remoteBarRefs.current.set(pid, el); else remoteBarRefs.current.delete(pid); }} className="h-full rounded-full" style={{ width: '0%' }} />
              </div>
            </div>
          ))}
        </div>
        <div className="px-3 pb-2 max-h-28 overflow-y-auto font-mono text-[9px] text-green-400/70 space-y-0.5">
          {debugLog.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      </details>
    </div>
  );
}

// ═══ COMPONENTS ═══════════════════════════════════════════════════════════════

function RemoteAudio({ stream, onBlocked }: { stream: MediaStream; onBlocked: () => void }) {
  const ref = useRef<HTMLAudioElement>(null);
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => onBlockedRef.current());
  }, [stream]);
  return <audio ref={ref} data-remote="true" />;
}

function QuestionCard({ entry, isMe, aiEnabled }: { entry: ChatEntryKind; isMe: boolean; aiEnabled: boolean }) {
  const isAnswer = entry.kind === 'answer';
  return (
    <div className={`${isMe ? 'ml-6' : 'mr-6'}`}>
      <div className={`rounded-2xl p-4 backdrop-blur-sm border transition-all ${
        isAnswer
          ? 'bg-gradient-to-br from-amber-900/30 to-orange-900/20 border-amber-600/30'
          : isMe
            ? 'bg-gradient-to-br from-indigo-900/40 to-purple-900/30 border-indigo-500/30'
            : 'bg-white/5 border-white/10'
      }`}>
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold ${
            isAnswer ? 'bg-amber-600 text-white' : 'bg-indigo-600 text-white'
          }`}>
            {entry.playerName.charAt(0).toUpperCase()}
          </div>
          <span className="text-gray-400 text-xs font-medium">
            {isAnswer ? `${entry.playerName} (Answer)` : entry.playerName}
          </span>
          {!isAnswer && aiEnabled && (
            <span className={`ml-auto px-2 py-0.5 rounded-full text-xs font-bold ${
              entry.score >= 8 ? 'bg-green-500/20 text-green-300' :
              entry.score >= 5 ? 'bg-yellow-500/20 text-yellow-300' :
              'bg-red-500/20 text-red-300'
            }`}>
              {entry.score}/10
            </span>
          )}
        </div>

        {/* Question text */}
        <p className="text-white text-base leading-relaxed">{entry.question}</p>

        {/* AI Feedback */}
        {!isAnswer && aiEnabled && entry.feedback && (
          <p className="text-gray-400 text-xs mt-2 italic">{entry.feedback}</p>
        )}

        {/* Highlighted words */}
        {!isAnswer && aiEnabled && entry.highlightedWords.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {entry.highlightedWords.map(w => (
              <span key={w} className="bg-emerald-500/20 text-emerald-300 text-xs px-2 py-0.5 rounded-full border border-emerald-500/30">
                {w}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GameOverScreen({ gameOver, aiEnabled, onLeave }: {
  gameOver: { winnerName: string | null; secretWord: string; scores: Array<{ name: string; score: number }> };
  aiEnabled: boolean;
  onLeave: () => void;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        {/* Trophy / Result */}
        <div className="text-center space-y-3">
          <div className="text-7xl animate-bounce">{gameOver.winnerName ? '🏆' : '⏰'}</div>
          <h2 className="text-3xl font-black text-white">
            {gameOver.winnerName ? `${gameOver.winnerName} wins!` : 'Time\'s up!'}
          </h2>
          <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm rounded-full px-5 py-2.5 border border-white/20">
            <span className="text-gray-400 text-sm">The word was</span>
            <span className="text-indigo-300 font-black text-lg">{gameOver.secretWord}</span>
          </div>
        </div>

        {/* Leaderboard */}
        <div className="space-y-3">
          <h3 className="text-gray-400 text-xs font-bold uppercase tracking-widest text-center">
            {aiEnabled ? 'Leaderboard' : 'Players'}
          </h3>
          {gameOver.scores.map((s, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            return (
              <div key={s.name} className={`flex items-center gap-3 rounded-2xl px-4 py-3.5 transition-all ${
                i === 0 ? 'bg-gradient-to-r from-yellow-900/30 to-amber-900/20 border border-yellow-600/30 scale-105' :
                'bg-white/5 border border-white/10'
              }`}>
                <span className="text-2xl w-8 text-center">{medals[i] ?? `#${i + 1}`}</span>
                <span className="text-white font-semibold flex-1">{s.name}</span>
                {aiEnabled && (
                  <span className={`font-black text-lg ${i === 0 ? 'text-yellow-400' : 'text-gray-300'}`}>
                    {s.score}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Play again */}
        <button
          onClick={onLeave}
          className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-400 hover:to-purple-400 active:scale-[0.97] text-white rounded-3xl py-5 text-lg font-bold shadow-xl shadow-indigo-500/30 transition-all duration-150"
        >
          Play Again
        </button>
      </div>
    </div>
  );
}
