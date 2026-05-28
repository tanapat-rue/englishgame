export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, time: new Date().toISOString() });
    }

    return new Response('Hello from worker!', { status: 200 });
  },
};
