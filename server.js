
import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import fs from "node:fs/promises";

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const AUTH_DIR = process.env.AUTH_DIR || "./auth";
const QR_DIR = "/tmp/rudo-bot";
const PREFIX = "/";

let sock;
let qrDataUrl = null;
let connectionStatus = "Iniciando";
let starting = false;
let reconnectTimer;

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error("Faltan ADMIN_USER y ADMIN_PASSWORD.");
  process.exit(1);
}

app.use(express.urlencoded({ extended: false }));

function authorized(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    let credentials = "";

    try {
      credentials = Buffer.from(encoded, "base64").toString();
    } catch {}

    const index = credentials.indexOf(":");
    const user = credentials.slice(0, index);
    const password = credentials.slice(index + 1);

    if (
      index > 0 &&
      user === ADMIN_USER &&
      password === ADMIN_PASSWORD
    ) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Rudo-Bot"');
  return res.status(401).send("Inicia sesión para acceder al panel.");
}

app.get("/", (req, res) => {
  res.type("text").send("Rudo-Bot está activo.");
});

app.get("/panel", authorized, (req, res) => {
  const qrSection = qrDataUrl
    ? `<h2>Escanea este QR con tu WhatsApp</h2>
       <img width="280" alt="QR privado de vinculación" src="${qrDataUrl}">`
    : "<p>No hay QR disponible. Estado: " + connectionStatus + "</p>";

  res.send(`
    <!doctype html>
    <html lang="es">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Rudo-Bot</title>
    <body style="font-family:Arial;max-width:600px;margin:40px auto;padding:16px">
      <h1>🔥 Rudo-Bot Premium</h1>
      <p>Estado: ${connectionStatus}</p>
      ${qrSection}
      <p>Abre WhatsApp en tu teléfono principal → Dispositivos vinculados
      → Vincular un dispositivo y escanea el QR.</p>
      <p>Por seguridad, no compartas este QR ni una captura del panel.</p>
      <form method="post" action="/logout">
        <button type="submit">Desconectar bot</button>
      </form>
    </body>
    </html>
  `);
});

app.post("/logout", authorized, async (req, res) => {
  try {
    if (sock) await sock.logout();
    connectionStatus = "Desconectado";
    qrDataUrl = null;
    res.send("Bot desconectado. Puedes cerrar esta página.");
  } catch {
    res.status(500).send("No se pudo desconectar.");
  }
});

async function startBot() {
  if (starting) return;
  starting = true;

  try {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    await fs.mkdir(QR_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
    } catch {
      version = undefined;
    }

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Rudo-Bot", "Chrome", "1.0.0"],
      markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        qrDataUrl = await QRCode.toDataURL(qr);
        connectionStatus = "Esperando escaneo del QR";
      }

      if (connection === "open") {
        qrDataUrl = null;
        connectionStatus = "Conectado";
        console.log("Rudo-Bot conectado.");
      }

      if (connection === "close") {
        qrDataUrl = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = "Sesión cerrada; elimina la sesión y vuelve a vincular.";
          console.error(connectionStatus);
          return;
        }

        connectionStatus = "Reconectando";

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          starting = false;
          startBot();
        }, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const message of messages) {
        if (!message.message || message.key.fromMe) continue;

        const chat = message.key.remoteJid;
        if (!chat) continue;

        const text =
          message.message.conversation ||
          message.message.extendedTextMessage?.text ||
          "";

        if (!text.startsWith(PREFIX)) continue;

        const [command] = text.trim().split(/\s+/);
        let response;

        switch (command.toLowerCase()) {
          case "/menu":
            response =
              "🔥 RUDO-BOT PREMIUM\n\n" +
              "/menu - Mostrar comandos\n" +
              "/ping - Probar el bot\n" +
              "/estado - Ver estado del bot";
            break;

          case "/ping":
            response = "🏓 ¡Pong! Rudo-Bot está activo.";
            break;

          case "/estado":
            response = "🤖 Rudo-Bot está conectado y funcionando.";
            break;

          default:
            continue;
        }

        try {
          await sock.sendMessage(chat, { text: response });
        } catch (error) {
          console.error("No se pudo responder:", error.message);
        }
      }
    });
  } catch (error) {
    connectionStatus = "Error al iniciar";
    console.error("Error iniciando Rudo-Bot:", error);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      starting = false;
      startBot();
    }, 10000);
    return;
  }

  starting = false;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Rudo-Bot escuchando en el puerto ${PORT}`);
  startBot();
});
