require("websocket-polyfill");

const {
  collateralRequired,
  invoiceExpirySecs,
  authTimeoutSecs,
  proxyUrl,
  relayUri,
  filterNipKind,
} = require("./config");

const { getBalanceInSats } = require("./lnbits");
const { processSpam } = require("./queue");
const { URL } = require("url");
const { v4: uuidV4 } = require("uuid");
const { validateEvent, verifySignature } = require("nostr-tools");
const Bot = require("./bot");
const cors = require("cors");
const express = require("express");
const reports = require("./reports");
const WebSocket = require("ws");

const { Server: WebSocketServer } = WebSocket;
const clients = {};

const bot = new Bot();
bot.connect();

const app = express();

app.use(cors({ origin: "*" }));

app.use((req, res, next) => {
  console.debug(`HTTP: ${req.method} ${req.originalUrl}`);
  return next();
});

reports(app);

app.post("/webhooks/lnbits/paid/:pubKey", (req, res) => {
  const pubKey = req.params.pubKey;
  process.emit(`${pubKey}.paid`, req.body);
  return res.status(200).json({ success: true });
});

const server = app.listen(1337, () => {
  console.log("Aberto na porta 1337");
});

function validateAuthEvent(event, ws) {
  try {
    if (!validateEvent(event) || !verifySignature(event)) return false;

    const [, challengeTag] = event.tags.find(([name]) => name === "challenge");
    if (!challengeTag || challengeTag !== ws.authChallenge) return false;

    const [, relayTag] = event.tags.find(([name]) => name === "relay");
    if (!relayTag) return false;

    const relayTagUrl = new URL(relayTag);

    if (relayTagUrl.host !== proxyUrl.host) return false;

    return true;
  } catch (error) {
    console.error("Failed validating auth event", error);
    return false;
  }
}

let id = 1;
// conexao chegando no proxy
server.on("upgrade", function upgrade(req, socket, head) {
  req.id = id++;

  console.debug("Recebeu upgrade do WS #%s", req.id);
  const wss = new WebSocketServer({ noServer: true });
  const relay = new WebSocket(relayUri);
  /** @type {WebSocket | undefined} */
  let ws;
  const clientObj = (clients[req.id] = clients[req.id] || {
    id: req.id,
    queueUpstream: [],
    queueDownstream: [],
    getRelay: () => relay,
    getWs: () => req.ws,
  });

  clientObj.timeout = setInterval(() => {
    drainMessageQueue(clientObj);
  }, 100);

  req.relay = relay;

  relay.on("message", (data) => {
    clientObj.queueDownstream.push(data);
  });

  relay.on("open", function () {
    console.log(`Upstream connection #${req.id}`);
  });
  relay.on("close", () => {
    closeConnection(clientObj);
  });
  relay.on("error", (err) =>
    console.error(`Erro na upstream connection do cliente ${req.id}`, err)
  );

  wss.on("connection", function connection(_ws, req) {
    req.ws = ws = _ws;

    ws.on("error", function () {
      console.error("Erro na conexao #%s", req.id, ...arguments);
    });
    ws.on("close", () => {
      closeConnection(clientObj);
    });

    ws.on("message", async (data) => {
      console.log(`Recebeu mensagem ${data} na conexão #${req.id}`);

      let msg;
      if (
        !ws.authenticated &&
        data.includes('"AUTH"') &&
        (msg = JSON.parse(data)) &&
        msg[0] === "AUTH"
      ) {
        const event = msg[1];

        console.debug(`Recebeu auth da conexão #${req.id}`, event);

        if (typeof event !== "object" || !validateAuthEvent(event, ws)) {
          console.warn(`Usuário invalido na conexão #${req.id}`);
          return closeConnection(clientObj);
        }

        if (event.pubkey === bot.publicKey) {
          ws.authenticated = true;
          ws.funded = true;
          return;
        }

        ws.authenticated = true;
        console.debug(`Usuário autenticado na conexão #${req.id}`);

        const balance = await getBalanceInSats(event.pubkey);
        if (balance && balance >= collateralRequired) {
          ws.funded = true;

          console.debug(`Usuário autenticado e com colateral #${req.id}`);
          return;
        }

        const didSendDM = await bot.askForCollateral(event.pubkey).then(
          () => true,
          (e) => {
            console.error(`Falhou ao enviar a DM para a conexão #${req.id}`, e);
            return false;
          }
        );

        if (!didSendDM) {
          return closeConnection(clientObj);
        }

        const timeout = setTimeout(async () => {
          if (ws.funded) return;
          const balance = await getBalanceInSats(event.pubkey);

          if (balance && balance >= collateralRequired) {
            ws.funded = true;
            return;
          }

          closeConnection(clientObj);
        }, invoiceExpirySecs * 1000);

        process.once(`${event.pubkey}.paid`, (invoiceInfo) => {
          console.debug(`Recebeu pagamento do ${event.pubkey}`, invoiceInfo);
          ws.funded = true;
          clearTimeout(timeout);
        });

        return;
      }

      clientObj.queueUpstream.push(data);
    });

    sendAuthChallenge(ws, clientObj);
  });

  req.wss = wss;

  wss.handleUpgrade(req, socket, head, function done(ws) {
    wss.emit("connection", ws, req);
  });
});

function sendAuthChallenge(ws, clientObj) {
  ws.send(
    JSON.stringify([
      "NOTICE",
      "restricted: we can't serve unauthenticated users. Does your client implement NIP-42?",
    ])
  );
  ws.authChallenge = uuidV4();
  ws.send(JSON.stringify(["AUTH", ws.authChallenge]));

  setTimeout(() => {
    if (ws.authenticated) return;
    // não deu auth em 5s
    closeConnection(clientObj);
  }, authTimeoutSecs * 1000).unref();
}

function closeConnection(clientObj) {
  if (clientObj.closed) return;

  console.debug(`Fechando conexão #${clientObj.id}`);

  clearInterval(clientObj.timeout);
  delete clients[clientObj.id];

  clientObj.closed = true;
  try {
    clientObj.getWs().close();
  } catch (error) {
    console.debug(
      `Falhou ao fechar conexão com cliente #${clientObj.id}`,
      error
    );
  }
  try {
    clientObj.getRelay().close();
  } catch (error) {
    console.debug(`Falhou ao fechar conexão com relay #${clientObj.id}`, error);
  }
}

function drainMessageQueue(clientObj) {
  const ws = clientObj.getWs();
  const relay = clientObj.getRelay();

  if (!ws.authenticated) return;

  let data;
  if (relay.readyState === WebSocket.OPEN) {
    const reAddUpstream = [];
    while ((data = clientObj.queueUpstream.pop())) {
      let event;

      if (
        !ws.funded &&
        (event = JSON.parse(data)) &&
        event[0] !== "REQ" &&
        event[0] !== "CLOSE"
      ) {
        reAddUpstream.push(data);
      }

      if (
        ws.funded &&
        (event || ((event = JSON.parse(data)) && event[0] === "EVENT"))
      ) {
        const e = event[1];
        if (filterNipKind.includes(e.kind)) {
          processSpam(e.pubkey, e.content, e.id).catch(() => {
            console.error("Failed to process spam", event);
          });
        }
      }

      relay.send(data);
    }
    clientObj.queueUpstream.push(...reAddUpstream);
  }

  if (ws.readyState !== WebSocket.OPEN) return;
  while ((data = clientObj.queueDownstream.pop())) {
    ws.send(data);
  }
}

app.use((req, res, next) => {
  return Promise.resolve()
    .then(() => next())
    .catch((err) => {
      console.error(`HTTP ERROR: `, err);
    });
});

app.use((req, res, next) => res.json({ notFound: true }).status(404));

process.on("unhandledRejection", (reason, promise) => {
  console.error(`ERROR: ${reason} ${promise}`);
});
