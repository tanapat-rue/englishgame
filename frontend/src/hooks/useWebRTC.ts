import { useCallback, useEffect, useRef, useState } from 'react';

interface UseWebRTCOptions {
  myId: string | null;
  onSendSignal: (targetId: string, signalData: unknown) => void;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function useWebRTC({ myId, onSendSignal }: UseWebRTCOptions) {
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const onSendSignalRef = useRef(onSendSignal);
  onSendSignalRef.current = onSendSignal;

  const makingOfferRef = useRef<Set<string>>(new Set());
  const initiatedRef = useRef<Set<string>>(new Set());
  // Incremented on every cleanup — any in-flight getUserMedia with an old version is discarded
  const initVersionRef = useRef(0);

  const [streamReady, setStreamReady] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());

  // Debug log only — no 60fps state updates
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const addLog = useCallback((msg: string) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[RTC ${ts}] ${msg}`);
    setDebugLog(prev => [...prev.slice(-50), `${ts} ${msg}`]);
  }, []);

  // VU meter refs — updated directly in RAF, never via React state
  const localLevelRef = useRef(0);
  const remoteLevelRefs = useRef<Map<string, number>>(new Map());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<Map<string, { analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> }>>(new Map());
  const localAnalyserRef = useRef<{ analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> } | null>(null);

  // Expose level-reading function for GameScreen's own RAF loop
  const getAudioLevels = useCallback(() => ({
    local: localLevelRef.current,
    remote: new Map(remoteLevelRefs.current),
  }), []);

  const getAudioContext = useCallback((): AudioContext => {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    return audioCtxRef.current;
  }, []);

  const resumeAudioContext = useCallback(() => {
    if (audioCtxRef.current?.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
  }, []);

  // RAF loop — reads analysers and stores to refs (no React state, no re-renders)
  useEffect(() => {
    let raf: number;
    const tick = () => {
      for (const [pid, { analyser, buf }] of analysersRef.current.entries()) {
        analyser.getByteFrequencyData(buf);
        remoteLevelRefs.current.set(pid, Math.max(0, ...buf) / 255);
      }
      if (localAnalyserRef.current) {
        const { analyser, buf } = localAnalyserRef.current;
        analyser.getByteFrequencyData(buf);
        localLevelRef.current = Math.max(0, ...buf) / 255;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const startAnalyser = useCallback((peerId: string, stream: MediaStream) => {
    try {
      const ctx = getAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
      analysersRef.current.set(peerId, { analyser, buf });
      remoteLevelRefs.current.set(peerId, 0);
      addLog(`  analyser attached [${peerId.slice(0, 8)}]`);
    } catch (e) {
      addLog(`  analyser error: ${String(e)}`);
    }
  }, [getAudioContext, addLog]);

  const getPeer = useCallback((peerId: string): RTCPeerConnection => {
    if (peersRef.current.has(peerId)) return peersRef.current.get(peerId)!;

    addLog(`NEW peer ${peerId.slice(0, 8)}`);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peersRef.current.set(peerId, pc);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => {
        pc.addTrack(t, localStreamRef.current!);
        addLog(`  added local track (${t.kind})`);
      });
    }

    pc.onnegotiationneeded = async () => {
      addLog(`  negotiation needed [${peerId.slice(0, 8)}] state=${pc.signalingState}`);
      if (pc.signalingState !== 'stable') return;
      if (makingOfferRef.current.has(peerId)) return;
      makingOfferRef.current.add(peerId);
      try {
        const offer = await pc.createOffer();
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription(offer);
        addLog(`  → offer → ${peerId.slice(0, 8)}`);
        onSendSignalRef.current(peerId, { type: 'offer', sdp: offer.sdp });
      } catch (err) {
        addLog(`  ❌ offer error: ${String(err)}`);
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onSendSignalRef.current(peerId, { type: 'ice', candidate: ev.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => addLog(`  ICE: ${pc.iceConnectionState} [${peerId.slice(0, 8)}]`);
    pc.onsignalingstatechange = () => addLog(`  signaling: ${pc.signalingState} [${peerId.slice(0, 8)}]`);

    pc.onconnectionstatechange = () => {
      addLog(`  conn: ${pc.connectionState} [${peerId.slice(0, 8)}]`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        setRemoteStreams(prev => { const m = new Map(prev); m.delete(peerId); return m; });
        analysersRef.current.delete(peerId);
        remoteLevelRefs.current.delete(peerId);
        peersRef.current.delete(peerId);
        initiatedRef.current.delete(peerId);
        makingOfferRef.current.delete(peerId);
      }
    };

    pc.ontrack = (ev) => {
      addLog(`  ✅ ontrack kind=${ev.track.kind} [${peerId.slice(0, 8)}]`);
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      setRemoteStreams(prev => new Map(prev).set(peerId, stream));
      startAnalyser(peerId, stream);
    };

    return pc;
  }, [addLog, startAnalyser]);

  const initLocalStream = useCallback(async (): Promise<void> => {
    if (localStreamRef.current) return;
    addLog('mic: requesting...');
    const myVersion = ++initVersionRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // If cleanup ran while we were awaiting, discard this stream
      if (myVersion !== initVersionRef.current) {
        stream.getTracks().forEach(t => t.stop());
        addLog('mic: discarded stale stream');
        return;
      }
      stream.getAudioTracks().forEach(t => { t.enabled = false; });
      localStreamRef.current = stream;
      addLog(`mic: ✅ ${stream.getAudioTracks().map(t => t.label).join(', ')}`);

      // Local VU analyser
      try {
        const ctx = getAudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        localAnalyserRef.current = { analyser, buf: new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer> };
      } catch { /* analyser is optional */ }

      // Retro-add tracks to peers created before stream was ready
      for (const [pid, pc] of peersRef.current.entries()) {
        if (!pc.getSenders().some(s => s.track)) {
          stream.getTracks().forEach(t => pc.addTrack(t, stream));
          addLog(`  retro-added track → ${pid.slice(0, 8)}`);
        }
      }
      setStreamReady(true);
    } catch (err) {
      addLog(`mic: ❌ ${String(err)}`);
    }
  }, [addLog, getAudioContext]);

  const setMuted = useCallback((muted: boolean) => {
    resumeAudioContext();
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    tracks.forEach(t => { t.enabled = !muted; });
    addLog(`muted=${muted} tracks=${tracks.length}`);
  }, [resumeAudioContext, addLog]);

  const handleIncomingSignal = useCallback(async (fromId: string, signalData: unknown): Promise<void> => {
    if (!myId) return;
    const data = signalData as { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
    addLog(`← ${data.type} from ${fromId.slice(0, 8)}`);
    const pc = getPeer(fromId);
    try {
      if (data.type === 'offer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setLocalDescription({ type: 'rollback' });
          makingOfferRef.current.delete(fromId);
        }
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        addLog(`  → answer → ${fromId.slice(0, 8)}`);
        onSendSignalRef.current(fromId, { type: 'answer', sdp: answer.sdp });
      } else if (data.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
        }
      } else if (data.type === 'ice' && data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
    } catch (err) {
      addLog(`  ❌ ${String(err)}`);
    }
  }, [myId, getPeer, addLog]);

  const initiateConnectionTo = useCallback((peerId: string): void => {
    if (!localStreamRef.current) return;
    if (initiatedRef.current.has(peerId)) return;
    initiatedRef.current.add(peerId);
    addLog(`→ initiate ${peerId.slice(0, 8)}`);
    getPeer(peerId); // addTrack inside triggers onnegotiationneeded → offer
  }, [getPeer, addLog]);

  useEffect(() => {
    addLog(`mounted myId=${myId?.slice(0, 8) ?? 'null'}`);
    return () => {
      addLog('unmounting');
      initVersionRef.current++; // invalidate any in-flight getUserMedia
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    initLocalStream, setMuted, handleIncomingSignal, initiateConnectionTo,
    streamReady, remoteStreams, getAudioLevels, resumeAudioContext, debugLog,
  };
}
