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
