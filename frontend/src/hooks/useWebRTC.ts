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

  const [streamReady, setStreamReady] = useState(false);
  // remoteStreams drives <audio> elements rendered in JSX — the only reliable autoplay approach
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  // Track which peers we've already offered to, so gameState re-renders don't spam offers
  const initiatedRef = useRef<Set<string>>(new Set());

  const getPeer = useCallback((peerId: string): RTCPeerConnection => {
    if (peersRef.current.has(peerId)) return peersRef.current.get(peerId)!;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peersRef.current.set(peerId, pc);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current!));
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onSendSignalRef.current(peerId, { type: 'ice', candidate: ev.candidate });
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) {
        setRemoteStreams(prev => new Map(prev).set(peerId, stream));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        setRemoteStreams(prev => { const m = new Map(prev); m.delete(peerId); return m; });
        peersRef.current.delete(peerId);
        initiatedRef.current.delete(peerId);
      }
    };

    return pc;
  }, []);

  const initLocalStream = useCallback(async (): Promise<void> => {
    if (localStreamRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getAudioTracks().forEach(t => { t.enabled = false; });
      localStreamRef.current = stream;

      // Retroactively add tracks to peers that were created before stream was ready
      for (const pc of peersRef.current.values()) {
        if (!pc.getSenders().some(s => s.track)) {
          stream.getTracks().forEach(t => pc.addTrack(t, stream));
        }
      }
      setStreamReady(true);
    } catch (err) {
      console.warn('Microphone access denied:', err);
    }
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }, []);

  const handleIncomingSignal = useCallback(async (fromId: string, signalData: unknown): Promise<void> => {
    if (!myId) return;
    const data = signalData as { type: string; sdp?: string; candidate?: RTCIceCandidateInit };
    const pc = getPeer(fromId);

    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        onSendSignalRef.current(fromId, { type: 'answer', sdp: answer.sdp });
      } else if (data.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
        }
      } else if (data.type === 'ice' && data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
      }
    } catch (err) {
      console.warn('WebRTC signal error:', err);
    }
  }, [myId, getPeer]);

  const initiateConnectionTo = useCallback(async (peerId: string): Promise<void> => {
    if (!localStreamRef.current) return;
    if (initiatedRef.current.has(peerId)) return;
    initiatedRef.current.add(peerId);

    const pc = getPeer(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      onSendSignalRef.current(peerId, { type: 'offer', sdp: offer.sdp });
    } catch (err) {
      console.warn('WebRTC offer error:', err);
      initiatedRef.current.delete(peerId); // allow retry on failure
    }
  }, [getPeer]);

  useEffect(() => {
    return () => {
      peersRef.current.forEach(pc => pc.close());
      peersRef.current.clear();
      localStreamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return { initLocalStream, setMuted, handleIncomingSignal, initiateConnectionTo, streamReady, remoteStreams };
}
