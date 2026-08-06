import type http from "http";

/**
 * Port handshake for a forked engine process.
 *
 * The desktop shell forks this backend with `PORT=0` so the OS picks a free
 * ephemeral port, then needs to learn which port that turned out to be before
 * it can point a window at the engine. Node gives a forked child an IPC
 * channel, which surfaces as `process.send`; the child answers on it once the
 * HTTP server is actually bound.
 *
 * The appliance install (systemd, Docker, `npm start`) has no IPC channel, so
 * `process.send` is undefined and the whole thing is a no-op there.
 */
export const LISTENING_MESSAGE_TYPE = "listening";

export interface ListeningMessage {
  readonly type: typeof LISTENING_MESSAGE_TYPE;
  readonly port: number;
}

interface HandshakeLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const resolveBoundPort = (server: http.Server): number | undefined => {
  const address = server.address();
  // A string address means a UNIX socket or pipe — no port to report.
  if (address === null || typeof address === "string") {
    return undefined;
  }
  return address.port;
};

/**
 * Send the `listening` message for an already-bound server. Returns true when
 * a message was sent. Safe to call with no IPC channel: it reports false and
 * does nothing.
 */
export const notifyListening = (
  server: http.Server,
  logger?: HandshakeLogger
): boolean => {
  const send = process.send?.bind(process);
  if (!send) {
    return false;
  }

  const port = resolveBoundPort(server);
  if (port === undefined) {
    logger?.warn(
      { address: server.address() },
      "No bound TCP port to report over IPC; skipping listening handshake"
    );
    return false;
  }

  const message: ListeningMessage = { type: LISTENING_MESSAGE_TYPE, port };

  let delivered = false;
  try {
    delivered = send(message);
  } catch (error) {
    // A closed channel (parent already gone) must not take the engine down.
    logger?.warn({ err: error }, "Failed to send listening handshake over IPC");
    return false;
  }

  // `process.send` returns false when the message was not handed to the
  // channel (saturated backlog, closing channel) — reporting success there
  // would leave the parent waiting on a port that was never sent (dt1-2).
  if (!delivered) {
    logger?.warn(
      { port },
      "Listening handshake not delivered over IPC (channel backlogged or closing)"
    );
    return false;
  }

  logger?.info({ port }, "Reported listening port to parent process");
  return true;
};

/**
 * Register the handshake against a server that has not been bound yet. Uses
 * `once("listening")` so the real port is read after `listen` resolves it,
 * which is the only moment `PORT=0` has an answer.
 */
export const attachListeningHandshake = (
  server: http.Server,
  logger?: HandshakeLogger
): void => {
  server.once("listening", () => {
    notifyListening(server, logger);
  });
};
