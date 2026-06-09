import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClientMessage, GameState, ServerMessage, SpeakEntry, WordScore } from '../types';
import { useWebRTC } from '../hooks/useWebRTC';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';

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

const QWERTY_ROWS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
];

export default function HangmanScreen({ playerName, shared, send, connected, onRegisterHandler, onLeave }: Props) {
  const [gameState, setGameState] = useState<GameState | null>(shared.gameState);
  const [myId] = useState<string | null>(shared.myId);
  const [speakLog, setSpeakLog] = useState<SpeakEntry[]>([]);
  const [maskedWord, setMaskedWord] = useState<string[]>(shared.gameState?.maskedWord ?? []);
  const [guessedLetters, setGuessedLetters] = useState<string[]>(shared.gameState?.guessedLetters ?? []);
  const [wrongLetters, setWrongLetters] = useState<string[]>(shared.gameState?.wrongLetters ?? []);
  const [gameOver, setGameOver] = useState<{ winner: 'players' | 'house'; secretWord: string; scores: Array<{ name: string; score: number }> } | null>(null);
  const [lastEvent, setLastEvent] = useState<{ type: 'correct' | 'wrong'; label: string } | null>(null);
  const [newLetters, setNewLetters] = useState<Set<string>>(new Set());
  const [audioBlocked, setAudioBlocked] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
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
    myId, onSendSignal: handleSendSignal, iceServers,
  });

  const localBarRef = useRef<HTMLDivElement>(null);
  const remoteBarRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    let raf: number;
    const tick = () => {
      const { local, remote } = getAudioLevels();
      if (localBarRef.current) {
        localBarRef.current.style.width = `${Math.round(local * 100)}%`;
        localBarRef.current.style.backgroundColor = local > 0.1 ? '#4ade80' : '#374151';
      }
      for (const [pid, el] of remoteBarRefs.current.entries()) {
        const lvl = remote.get(pid) ?? 0;
        el.style.width = `${Math.round(lvl * 100)}%`;
        el.style.backgroundColor = lvl > 0.1 ? '#4ade80' : '#374151';
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
          setMaskedWord(msg.state.maskedWord);
          setGuessedLetters(msg.state.guessedLetters);
          setWrongLetters(msg.state.wrongLetters);
          break;
        case 'letter_result':
          setMaskedWord(msg.maskedWord);
          setGuessedLetters(msg.guessedLetters);
          setWrongLetters(msg.wrongLetters);
          if (msg.correct) {
            setNewLetters(prev => new Set(prev).add(msg.letter));
            setTimeout(() => setNewLetters(prev => { const s = new Set(prev); s.delete(msg.letter); return s; }), 600);
            setLastEvent({ type: 'correct', label: `✅  "${msg.letter.toUpperCase()}"  —  ${msg.playerName}!` });
          } else {
            setLastEvent({ type: 'wrong', label: `❌  No "${msg.letter.toUpperCase()}"` });
          }
          setTimeout(() => setLastEvent(null), 2000);
          break;
        case 'speak_logged':
          setSpeakLog(prev => [...prev, msg.entry]);
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
      if (p.id !== myId && p.isConnected && p.id > myId) initiateConnectionTo(p.id);
    });
  }, [streamReady, gameState, myId, initiateConnectionTo]);

  const wrongCount = wrongLetters.length;
  const livesLeft = (gameState?.maxWrong ?? 6) - wrongCount;
  const myScore = gameState?.players.find(p => p.id === myId)?.score ?? 0;

  const handleGuessLetter = useCallback((letter: string) => {
    if (guessedLetters.includes(letter)) return;
    send({ type: 'guess_letter', letter });
  }, [guessedLetters, send]);

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
    if (text.trim()) send({ type: 'speak_log', text: text.trim() });
  }, [setMuted, stopListening, send]);

  if (gameOver) {
    return <GameOverScreen gameOver={gameOver} onLeave={onLeave} />;
  }

  return (
    <div className="h-screen bg-gray-950 flex flex-col overflow-hidden">

      {Array.from(remoteStreams.entries()).map(([pid, stream]) => (
        <RemoteAudio key={pid} stream={stream} onBlocked={() => setAudioBlocked(true)} />
      ))}

      {!streamReady && (
        <button onClick={() => initLocalStream()}
          className="flex-shrink-0 w-full bg-indigo-600 text-white font-bold text-sm py-2.5 text-center">
          🎙️ Tap to enable microphone
        </button>
      )}

      {audioBlocked && streamReady && (
        <button onClick={() => { document.querySelectorAll<HTMLAudioElement>('audio').forEach(a => a.play().catch(() => {})); setAudioBlocked(false); }}
          className="flex-shrink-0 w-full bg-yellow-500 text-black font-bold text-sm py-2.5 text-center">
          🔇 Tap to enable voice chat
        </button>
      )}

      {/* ═══ HEADER ═══ */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 pt-3 pb-2">
        {/* Lives */}
        <div className="flex items-center gap-0.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={`text-xl transition-all duration-300 ${i < livesLeft ? 'opacity-100' : 'opacity-15 grayscale scale-75'}`}>
              ❤️
            </span>
          ))}
        </div>
        {/* Scoring mode badge */}
        <div className={`px-2 py-1 rounded-full text-[10px] font-bold ${
          gameState?.llmScoring
            ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
            : 'bg-gray-800 text-gray-500 border border-gray-700'
        }`}>
          {gameState?.llmScoring ? '🤖 AI Scoring' : '📝 Basic Scoring'}
        </div>
        {/* My score */}
        <div className="text-right">
          <p className="text-yellow-400 font-black text-2xl leading-none">{myScore}</p>
          <p className="text-gray-600 text-[10px]">your pts</p>
        </div>
      </div>

      {/* ═══ PLAYERS STRIP ═══ */}
      <div className="flex-shrink-0 px-3 pb-2 flex gap-2 overflow-x-auto">
        {gameState?.players.filter(p => p.isConnected).map(p => (
          <div key={p.id} className={`flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl ${p.id === myId ? 'bg-indigo-500/20 border border-indigo-500/30' : 'bg-white/5'}`}>
            <div className="w-6 h-6 rounded-full bg-indigo-600 flex items-center justify-center text-[10px] font-bold text-white">
              {p.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-white text-xs font-medium leading-none">{p.id === myId ? 'You' : p.name}</p>
              <p className="text-yellow-400 text-[10px] leading-none">{p.score}pts</p>
            </div>
            {/* Speaking VU bar */}
            <div className="w-5 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                ref={el => { if (el) remoteBarRefs.current.set(p.id, el); else remoteBarRefs.current.delete(p.id); }}
                className="h-full rounded-full transition-none"
                style={{ width: '0%' }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* ═══ HANGMAN + EVENT FLASH ═══ */}
      <div className="flex-shrink-0 flex items-center justify-between px-4">
        <HangmanDrawing wrongCount={wrongCount} />
        <div className="flex-1 pl-4">
          {lastEvent ? (
            <div className={`px-3 py-2 rounded-xl text-sm font-bold text-center ${
              lastEvent.type === 'correct' ? 'bg-green-500/20 text-green-300 border border-green-500/30' : 'bg-red-500/20 text-red-300 border border-red-500/30'
            }`}>
              {lastEvent.label}
            </div>
          ) : (
            <p className="text-gray-600 text-xs text-center">Tap a letter to guess</p>
          )}
        </div>
      </div>

      {/* ═══ WORD DISPLAY ═══ */}
      <div className="flex-shrink-0 px-4 pb-2">
        <div className="flex flex-wrap justify-center gap-2">
          {maskedWord.map((letter, i) => (
            <LetterSlot key={i} letter={letter} revealed={letter !== '_'} isNew={newLetters.has(letter) && letter !== '_'} />
          ))}
        </div>
        {wrongLetters.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            <span className="text-gray-600 text-xs self-center">Wrong:</span>
            {wrongLetters.map(l => (
              <span key={l} className="w-6 h-6 rounded-md bg-red-900/30 border border-red-700/40 text-red-400 text-xs font-bold flex items-center justify-center uppercase">
                {l}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ═══ KEYBOARD ═══ */}
      <div className="flex-shrink-0 px-2 pb-2 space-y-1">
        {QWERTY_ROWS.map((row, ri) => (
          <div key={ri} className="flex justify-center gap-1">
            {row.map(letter => {
              const isWrong = wrongLetters.includes(letter);
              const isCorrect = guessedLetters.includes(letter) && !isWrong;
              const isUsed = guessedLetters.includes(letter);
              return (
                <button
                  key={letter}
                  onClick={() => handleGuessLetter(letter)}
                  disabled={isUsed}
                  className={`w-9 h-10 rounded-lg font-bold text-sm uppercase select-none transition-all duration-150 ${
                    isWrong ? 'bg-red-900/20 text-red-700 border border-red-900/30' :
                    isCorrect ? 'bg-green-900/20 text-green-600 border border-green-900/30' :
                    'bg-gray-800 text-white border border-gray-700 active:scale-90 active:bg-indigo-600 hover:bg-gray-700'
                  }`}
                >
                  {letter}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* ═══ WORD BOARD + TALK ═══ */}
      <div className="flex-1 flex flex-col min-h-0 px-3 pb-3 gap-2">
        {/* Word board — one row per player, all their scored words */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <WordBoard speakLog={speakLog} myPlayerName={playerName} llmScoring={gameState?.llmScoring ?? false} />
          <div ref={logEndRef} />
        </div>

        {/* Live transcript preview while holding */}
        {transcript && (
          <div className="flex-shrink-0 bg-white/5 rounded-xl px-3 py-2 text-white text-sm border border-white/10 italic">
            {transcript}
          </div>
        )}

        {/* Hold to Talk */}
        <button
          onPointerDown={handlePressStart}
          onPointerUp={handlePressEnd}
          onPointerLeave={handlePressEnd}
          onTouchStart={handlePressStart}
          onTouchEnd={handlePressEnd}
          className={`flex-shrink-0 w-full rounded-2xl py-3.5 text-white font-bold text-base select-none transition-all duration-150 ${
            isListening
              ? 'bg-gradient-to-r from-red-500 to-pink-500 scale-[0.98] shadow-lg shadow-red-500/30'
              : 'bg-gradient-to-r from-indigo-600/50 to-purple-600/50 border border-indigo-500/30 active:scale-[0.98]'
          }`}
        >
          <span className="flex items-center justify-center gap-2">
            {isListening ? (
              <>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
                Recording...
              </>
            ) : <>🎙️ Hold to Talk</>}
          </span>
        </button>

        {!connected && <p className="text-yellow-400 text-xs text-center animate-pulse">Reconnecting...</p>}
      </div>

      {/* Debug */}
      <details className="flex-shrink-0 bg-black/60 border-t border-gray-800/50">
        <summary className="px-3 py-1 text-[10px] text-gray-700 cursor-pointer">
          debug ({remoteStreams.size} peers, mic {streamReady ? '✅' : '❌'})
        </summary>
        <div className="px-3 py-1 flex items-center gap-2">
          <span className="text-gray-700 text-[9px] w-8">local</span>
          <div className="flex-1 h-1 bg-gray-900 rounded-full overflow-hidden">
            <div ref={localBarRef} className="h-full rounded-full" style={{ width: '0%' }} />
          </div>
        </div>
        <div className="px-3 pb-1 max-h-16 overflow-y-auto font-mono text-[9px] text-green-500/50">
          {debugLog.slice(-10).map((l, i) => <p key={i}>{l}</p>)}
        </div>
      </details>
    </div>
  );
}

// ═══ WORD BOARD ═══════════════════════════════════════════════════════════════

const DIFFICULTY_STYLE: Record<number, string> = {
  1: 'bg-gray-700/60 text-gray-300 border-gray-600/40',
  2: 'bg-blue-900/40 text-blue-300 border-blue-700/40',
  3: 'bg-green-900/40 text-green-300 border-green-700/40',
  4: 'bg-yellow-900/40 text-yellow-300 border-yellow-700/40',
  5: 'bg-red-900/40 text-red-300 border-red-700/40',
};

function WordChip({ ws, llmScoring }: { ws: WordScore; llmScoring: boolean }) {
  const style = DIFFICULTY_STYLE[ws.points] ?? DIFFICULTY_STYLE[1];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${style}`}>
      {ws.word}
      <span className="font-black opacity-80">×{ws.points}</span>
    </span>
  );
}

function WordBoard({ speakLog, myPlayerName, llmScoring }: {
  speakLog: SpeakEntry[];
  myPlayerName: string;
  llmScoring: boolean;
}) {
  // Aggregate all words per player, accumulate total score
  const playerMap = useMemo(() => {
    const map = new Map<string, { name: string; total: number; words: WordScore[] }>();
    for (const entry of speakLog) {
      const existing = map.get(entry.playerId);
      if (existing) {
        existing.total += entry.totalScore;
        existing.words.push(...entry.words);
      } else {
        map.set(entry.playerId, {
          name: entry.playerName,
          total: entry.totalScore,
          words: [...entry.words],
        });
      }
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [speakLog]);

  if (playerMap.length === 0) {
    return (
      <p className="text-gray-700 text-xs text-center pt-3">
        Hold to talk — scored words will appear here
      </p>
    );
  }

  return (
    <div className="space-y-2 pt-1">
      {llmScoring && (
        <div className="flex gap-2 flex-wrap px-1 mb-1">
          {[1,2,3,4,5].map(n => (
            <span key={n} className={`text-[9px] px-1.5 py-0.5 rounded-full border ${DIFFICULTY_STYLE[n]}`}>
              {['A1','A2','B1','B2','C1'][n-1]} ×{n}
            </span>
          ))}
        </div>
      )}
      {playerMap.map(player => (
        <div key={player.name} className={`rounded-xl px-3 py-2 ${
          player.name === myPlayerName
            ? 'bg-indigo-950/60 border border-indigo-800/40'
            : 'bg-gray-900/80 border border-gray-800/40'
        }`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-gray-400 text-[11px] font-bold">
              {player.name === myPlayerName ? 'You' : player.name}
            </span>
            <span className="text-yellow-400 text-[11px] font-black">{player.total} pts</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {player.words.map((ws, i) => (
              <WordChip key={`${ws.word}-${i}`} ws={ws} llmScoring={llmScoring} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══ HANGMAN SVG ══════════════════════════════════════════════════════════════

function HangmanDrawing({ wrongCount }: { wrongCount: number }) {
  return (
    <svg width="130" height="145" viewBox="0 0 130 145" className="flex-shrink-0">
      <line x1="10" y1="138" x2="120" y2="138" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      <line x1="35" y1="138" x2="35" y2="8" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      <line x1="35" y1="8" x2="80" y2="8" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      <line x1="80" y1="8" x2="80" y2="22" stroke="#4b5563" strokeWidth="3" strokeLinecap="round" />
      {wrongCount >= 1 && <circle cx="80" cy="33" r="11" stroke="#ef4444" strokeWidth="2.5" fill="none" />}
      {wrongCount >= 1 && <circle cx="76" cy="31" r="1.5" fill="#ef4444" />}
      {wrongCount >= 1 && <circle cx="84" cy="31" r="1.5" fill="#ef4444" />}
      {wrongCount >= 1 && (
        wrongCount >= 6
          ? <path d="M 76 39 Q 80 35 84 39" stroke="#ef4444" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          : <path d="M 76 37 Q 80 41 84 37" stroke="#ef4444" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      )}
      {wrongCount >= 2 && <line x1="80" y1="44" x2="80" y2="84" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />}
      {wrongCount >= 3 && <line x1="80" y1="57" x2="62" y2="74" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />}
      {wrongCount >= 4 && <line x1="80" y1="57" x2="98" y2="74" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />}
      {wrongCount >= 5 && <line x1="80" y1="84" x2="62" y2="110" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />}
      {wrongCount >= 6 && <line x1="80" y1="84" x2="98" y2="110" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" />}
    </svg>
  );
}

// ═══ LETTER SLOT ══════════════════════════════════════════════════════════════

function LetterSlot({ letter, revealed, isNew }: { letter: string; revealed: boolean; isNew: boolean }) {
  return (
    <div className={`w-8 h-10 flex items-end justify-center pb-0.5 border-b-2 ${revealed ? 'border-green-400' : 'border-gray-600'}`}>
      <span className={`text-lg font-black uppercase transition-all duration-300 ${
        revealed ? `text-white ${isNew ? 'scale-125 text-green-300' : 'scale-100'}` : 'text-transparent scale-0'
      }`}>{letter}</span>
    </div>
  );
}

// ═══ REMOTE AUDIO ═════════════════════════════════════════════════════════════

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

// ═══ GAME OVER ════════════════════════════════════════════════════════════════

function GameOverScreen({ gameOver, onLeave }: {
  gameOver: { winner: 'players' | 'house'; secretWord: string; scores: Array<{ name: string; score: number }> };
  onLeave: () => void;
}) {
  const win = gameOver.winner === 'players';
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-4">
          <div className={`text-8xl ${win ? 'animate-bounce' : ''}`}>{win ? '🎉' : '💀'}</div>
          <h2 className="text-3xl font-black text-white">{win ? 'You got it! 🎊' : 'Hanged! 😵'}</h2>
          <div className="inline-flex items-center gap-3 bg-white/10 rounded-2xl px-6 py-3 border border-white/20">
            <span className="text-gray-400 text-sm">The word was</span>
            <span className="text-white font-black text-2xl tracking-widest uppercase">{gameOver.secretWord}</span>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-gray-500 text-xs font-bold uppercase tracking-widest text-center">Scores</p>
          {gameOver.scores.map((s, i) => (
            <div key={s.name} className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${
              i === 0 ? 'bg-gradient-to-r from-yellow-900/40 to-amber-900/30 border border-yellow-600/40' : 'bg-white/5 border border-white/10'
            }`}>
              <span className="text-xl w-8 text-center">{['🥇','🥈','🥉'][i] ?? `${i+1}.`}</span>
              <span className="text-white font-semibold flex-1">{s.name}</span>
              <span className={`font-black text-xl ${i === 0 ? 'text-yellow-400' : 'text-gray-400'}`}>{s.score}</span>
            </div>
          ))}
        </div>

        <button onClick={onLeave}
          className="w-full bg-gradient-to-r from-indigo-500 to-purple-500 active:scale-[0.97] text-white rounded-3xl py-5 text-xl font-black shadow-2xl shadow-indigo-500/30 transition-all">
          Play Again
        </button>
      </div>
    </div>
  );
}
