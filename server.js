
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
const PREFIX = "/";

let sock;
let authState;
let qrDataUrl = null;
let pairCode = null;
let pairMessage = "";
let connectionStatus = "Iniciando";
let isRegistered = false;
let starting = false;
let reconnectTimer;

if (!ADMIN_USER || !ADMIN_PASSWORD) {
  console.error("Faltan ADMIN_USER y ADMIN_PASSWORD.");
  process.exit(1);
}

app.use(express.urlencoded({ extended: false, limit: "10kb" }));

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

function renderPanel() {
  const qrSection = qrDataUrl
    ? `<h3>Vincular escaneando QR</h3>
       <img style="max-width:100%;width:280px"
       alt="QR privado de vinculación" src="${qrDataUrl}">`
    : "<p>No hay QR disponible en este momento.</p>";

  const codeSection = pairCode
    ? `<h3>Código de vinculación</h3>
       <p style="font-size:28px;font-weight:bold;letter-spacing:4px">
       ${pairCode}</p>
       <p>Introduce este código en WhatsApp en tu teléfono principal.</p>`
    : "";

  return `
    <!doctype html>
    <html lang="es">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="10">
      <title>Rudo-Bot Premium</title>
    </head>
    <body style="font-family:Arial;max-width:600px;margin:30px auto;padding:16px">
      <h1>🔥 Rudo-Bot Premium</h1>
      <p><b>Estado:</b> ${connectionStatus}</p>
      ${pairMessage ? `<p>${pairMessage}</p>` : ""}
      ${qrSection}
      ${codeSection}

      <hr>
      <h2>Vincular con número de teléfono</h2>
      <p>Escribe el número completo con el prefijo internacional.</p>
      <p>Ejemplos: +57 300 123 4567 o +34 600 123 456</p>

      <form method="post" action="/pair">
        <label for="phone">Número internacional</label><br>
        <input
          id="phone"
          name="phone"
          type="tel"
          autocomplete="tel"
          placeholder="+57 300 123 4567"
          required
          maxlength="25"
          style="box-sizing:border-box;width:100%;padding:12px;margin:10px 0"
        >
        <button type="submit" style="padding:12px;width:100%">
          Generar código de vinculación
        </button>
      </form>

      <hr>
      <p>En WhatsApp: Dispositivos vinculados → Vincular un dispositivo.
      Para emparejar por número, busca la opción de vincular con número de teléfono
      en WhatsApp si está disponible en tu versión.</p>

      <p><b>No compartas el QR ni el código de vinculación.</b></p>

      <form method="post" action="/logout">
        <button type="submit">Desconectar bot</button>
      </form>
    </body>
    </html>
  `;
}

app.get("/panel", authorized, (req, res) => {
  res.send(renderPanel());
});

app.post("/pair", authorized, async (req, res) => {
  const number = String(req.body.phone || "").replace(/\D/g, "");

  if (number.length < 7 || number.length > 15) {
    pairMessage = "Revisa el número e incluye el prefijo internacional.";
    return res.status(400).send(renderPanel());
  }

  if (!sock || !authState) {
    pairMessage = "El bot todavía está iniciando. Espera unos segundos y vuelve a intentarlo.";
    return res.status(503).send(renderPanel());
  }

  if (isRegistered || authState.creds.registered) {
    pairMessage =
      "Ya hay una sesión registrada. No solicites otro código para esta sesión.";
    return res.status(409).send(renderPanel());
  }

  try {
    pairMessage = "Solicitando código de vinculación...";
    pairCode = null;

    const code = await sock.requestPairingCode(number);

    pairCode = code;
    pairMessage =
      "Código generado. Úsalo pronto; puede caducar. No lo compartas.";

    console.log("Se generó un código de vinculación.");
    return res.redirect(303, "/panel");
  } catch (error) {
    console.error("Error al solicitar código de vinculación:", error);
    pairCode = null;
    pairMessage =
      "No se pudo generar el código. Revisa Logs en Render e inténtalo otra vez.";
    return res.status(500).send(renderPanel());
  }
});

app.post("/logout", authorized, async (req, res) => {
  try {
    if (sock) await sock.logout();

    connectionStatus = "Desconectado";
    qrDataUrl = null;
    pairCode = null;
    pairMessage = "La sesión se desconectó.";

    res.redirect(303, "/panel");
  } catch (error) {
    console.error("Error al desconectar:", error);
    res.status(500).send("No se pudo desconectar.");
  }
});

async function startBot() {
  if (starting) return;
  starting = true;

  try {
    await fs.mkdir(AUTH_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    authState = state;
    isRegistered = Boolean(state.creds.registered);

    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
    } catch (error) {
      console.error("No se pudo consultar la versión de WhatsApp:", error.message);
    }

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: "warn" }),
      printQRInTerminal: false,
      browser: ["Rudo-Bot", "Chrome", "1.0.0"],
      markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        isRegistered = Boolean(authState?.creds?.registered);
      } catch (error) {
        console.error("Error guardando la sesión:", error.message);
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        try {
          qrDataUrl = await QRCode.toDataURL(qr);
          connectionStatus = "Esperando escaneo del QR";
          console.log("Se generó un QR de vinculación.");
        } catch (error) {
          console.error("Error generando QR:", error.message);
        }
      }

      if (connection === "open") {
        qrDataUrl = null;
        pairCode = null;
        pairMessage = "";
        connectionStatus = "Conectado";
        isRegistered = true;
        console.log("Rudo-Bot conectado.");
      }

      if (connection === "close") {
        qrDataUrl = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        console.error("Conexión cerrada. Código:", statusCode ?? "desconocido");

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = "Sesión cerrada; requiere nueva vinculación.";
          pairCode = null;
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
            
