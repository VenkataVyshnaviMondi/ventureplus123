import { createServer } from "http";
import app from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { attachWebSocketServer } from "./realtime/ws.js";

const server = createServer(app);

if (env.realtimeTransport === "ws") {
  attachWebSocketServer(server);
  logger.info("WebSocket realtime transport enabled");
}

server.listen(env.port, () => {
  logger.info(`API server listening on port ${env.port}`);
});
