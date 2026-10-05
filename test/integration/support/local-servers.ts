import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';

export type LocalServer = { url: string; close(): Promise<void> };

/** Accepts TCP connections and never answers: what a hung Zona looks like to the client. */
export async function silentServer(): Promise<LocalServer> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * A project whose Auth hands out a session for one account but then reports another: what
 * a mismatched or tampered session looks like to the client.
 */
export async function mismatchedAuthServer(): Promise<LocalServer> {
  const server = createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const user = (id: string) => ({ id, aud: 'authenticated', role: 'authenticated', email: 'x@agents.alsaqr.app' });
    if (request.url?.startsWith('/auth/v1/token')) {
      response.end(
        JSON.stringify({
          access_token: 'not-a-real-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'x',
          user: user('11111111-1111-4111-8111-111111111111'),
        }),
      );
    } else {
      response.end(JSON.stringify(user('22222222-2222-4222-8222-222222222222')));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
