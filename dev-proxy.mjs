// Routes /extensions/* to the CLI extension proxy (port 61728)
// Routes everything else to Remix (port 61733)
import http from "http";

const REMIX_PORT = 61733;
const CLI_PROXY_PORT = 61800; // CLI proxy takes this port when --tunnel-url :61800 is used
const LISTEN_PORT = 61801;   // dev-proxy listens here; cloudflared tunnels to this port

const server = http.createServer((req, res) => {
  const target =
    req.url.startsWith("/extensions") || req.url.startsWith("/hot-reload")
      ? CLI_PROXY_PORT
      : REMIX_PORT;

  const proxy = http.request(
    { hostname: "localhost", port: target, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxy.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    }
  });
  req.on("error", () => proxy.destroy());
  req.pipe(proxy);
});

server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());
  const target =
    req.url.startsWith("/extensions") || req.url.startsWith("/hot-reload")
      ? CLI_PROXY_PORT
      : REMIX_PORT;
  const proxyReq = http.request({
    hostname: "localhost",
    port: target,
    path: req.url,
    method: req.method,
    headers: req.headers,
  });
  proxyReq.on("error", () => socket.destroy());
  proxyReq.on("upgrade", (proxyRes, proxySocket) => {
    proxySocket.on("error", () => socket.destroy());
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n"
    );
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.end();
});

server.on("error", (err) => {
  console.error(`Dev proxy server error: ${err.message}`);
});

server.listen(LISTEN_PORT, () => {
  console.log(`Dev proxy on :${LISTEN_PORT} → Remix:${REMIX_PORT} | CLI:${CLI_PROXY_PORT}`);
});
