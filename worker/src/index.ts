import { GameRoom } from './gameRoom';
import { Env } from './types';

export { GameRoom };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Route: /api/room/:roomId/ws  — WebSocket upgrade
    const wsMatch = url.pathname.match(/^\/api\/room\/([a-zA-Z0-9-]+)\/ws$/);
    if (wsMatch) {
      const roomId = wsMatch[1];
      const id = env.GAME_ROOM.idFromName(roomId);
      const stub = env.GAME_ROOM.get(id);
      const wsUrl = new URL(request.url);
      wsUrl.searchParams.set('roomId', roomId);
      return stub.fetch(new Request(wsUrl.toString(), request));
    }

    // Route: POST /api/room/create — generate a new room code
    if (url.pathname === '/api/room/create' && request.method === 'POST') {
      const roomId = generateRoomCode();
      return Response.json({ roomId }, { headers: corsHeaders });
    }

    // Route: GET /api/turn-credentials — short-lived TURN credentials for WebRTC
    if (url.pathname === '/api/turn-credentials') {
      if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) {
        // No TURN configured — return empty so client falls back to STUN only
        return Response.json({ iceServers: [] }, { headers: corsHeaders });
      }
      try {
        const resp = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.TURN_API_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ttl: 86400 }),
          }
        );
        if (!resp.ok) throw new Error(`TURN API ${resp.status}`);
        const data = await resp.json() as { iceServers: unknown[] };
        return Response.json(data, { headers: corsHeaders });
      } catch (err) {
        // Don't break the app if TURN fetch fails — client will use STUN only
        console.error('TURN credential fetch failed:', err);
        return Response.json({ iceServers: [] }, { headers: corsHeaders });
      }
    }

    // Route: GET /api/health
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
