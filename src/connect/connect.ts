import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";

export class ConnectConfigurationError extends Error {}

export type ConnectOptions = {
  gatewayToken: string;
  hostname?: string;
  port?: number;
  tls?: { cert: Buffer; key: Buffer };
  openConnection?: (hostname: string, port: number) => Socket;
};

export type ConnectProxy = {
  url: string;
  close: () => Promise<void>;
};

function openConnection(hostname: string, port: number): Socket {
  return connect({ host: hostname, port });
}

function authenticate(req: IncomingMessage, expected: Buffer): boolean {
  const value = req.headers["proxy-authorization"];
  if (typeof value !== "string") {
    return false;
  }
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === "proxy-authorization") {
      count++;
    }
  }
  return count === 1 && timingSafeEqual(createHash("sha256").update(value).digest(), expected);
}

function reject(socket: Socket, status: number): void {
  const challenge = status === 407 ? 'Proxy-Authenticate: Basic realm="ainep"\r\n' : "";
  socket.end(`HTTP/1.1 ${status} Rejected\r\n${challenge}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

export async function startConnectProxy(options: ConnectOptions): Promise<ConnectProxy> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 8444;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
  if (options.gatewayToken.length < 32 || [...options.gatewayToken].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) >= 127)) {
    throw new ConnectConfigurationError("GATEWAY_TOKEN must contain at least 32 printable ASCII characters without spaces");
  }
  if (!loopback && (!options.tls?.cert || !options.tls?.key)) {
    throw new ConnectConfigurationError("Non-loopback CONNECT listeners require TLS_CERT_FILE and TLS_KEY_FILE");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConnectConfigurationError("Invalid CONNECT listener port");
  }
  const credentials = Buffer.from(`ainep:${options.gatewayToken}`).toString("base64");
  const expected = createHash("sha256").update(`Basic ${credentials}`).digest();
  const destinations = new Set(["platform.claude.com:443", "claude.ai:443", "claude.com:443"]);
  const server = options.tls ? createHttpsServer(options.tls) : createHttpServer();
  const sockets = new Set<Socket>();
  server.maxHeadersCount = 32;
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.on("connection", (socket) => {
    if (sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(60000, () => socket.destroy());
  });
  server.on("request", (_req, res) => {
    res.writeHead(405, { "content-length": "0", connection: "close" });
    res.end();
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (req, stream, head) => {
    const client = stream as Socket;
    client.on("error", () => client.destroy());
    if (!authenticate(req, expected)) {
      reject(client, 407);
      return;
    }
    if (req.url === undefined || !destinations.has(req.url)) {
      reject(client, 403);
      return;
    }
    client.pause();
    const remote = (options.openConnection ?? openConnection)(req.url.slice(0, -4), 443);
    sockets.add(remote);
    let connected = false;
    remote.setTimeout(10000, () => remote.destroy());
    client.on("close", () => remote.destroy());
    remote.on("error", () => {
      if (!connected && !client.destroyed) {
        reject(client, 502);
      } else {
        client.destroy();
      }
    });
    remote.on("close", () => {
      sockets.delete(remote);
      if (!connected && !client.destroyed && !client.writableEnded) {
        reject(client, 502);
      } else if (connected) {
        client.destroy();
      }
    });
    remote.on("connect", () => {
      if (client.destroyed) {
        remote.destroy();
        return;
      }
      connected = true;
      remote.setTimeout(60000, () => remote.destroy());
      client.setTimeout(60000, () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        remote.write(head);
      }
      client.pipe(remote);
      remote.pipe(client);
      client.resume();
    });
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, hostname, () => {
      server.removeListener("error", rejectListen);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new ConnectConfigurationError("CONNECT listener address unavailable");
  }
  return {
    url: `${options.tls ? "https" : "http"}://${hostname.includes(":") ? `[${hostname}]` : hostname}:${address.port}`,
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
