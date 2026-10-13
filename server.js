const express = require("express");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.APP_SECRET;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION;

if (
  !VERIFY_TOKEN ||
  !APP_SECRET ||
  !WHATSAPP_TOKEN ||
  !PHONE_NUMBER_ID ||
  !GRAPH_API_VERSION
) {
  console.error("Faltan variables de entorno.");
  process.exit(1);
}

app.get("/", (req, res) => {
  res.status(200).send("BLT Premium está funcionando.");
});

// Verificación inicial del webhook de Meta.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

async function enviarMensaje(destino, texto) {
  const url =
    `https://graph.facebook.com/` +
    `${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;

  const respuesta = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: destino,
      type: "text",
      text: { body: texto }
    })
  });

  if (!respuesta.ok) {
    const error = await respuesta.text();
    console.error("Error enviando mensaje:", error);
  }
}

// Recibe el cuerpo original para verificar la firma de Meta.
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const firma = req.get("x-hub-signature-256") || "";

    const firmaEsperada =
      "sha256=" +
      crypto
        .createHmac("sha256", APP_SECRET)
        .update(req.body)
        .digest("hex");

    const firmaValida =
      firma.length === firmaEsperada.length &&
      crypto.timingSafeEqual(
        Buffer.from(firma),
        Buffer.from(firmaEsperada)
      );

    if (!firmaValida) {
      return res.sendStatus(401);
    }

    let datos;

    try {
      datos = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.sendStatus(400);
    }

    // Confirmar recepción antes de procesar el evento.
    res.sendStatus(200);

    try {
      for (const entrada of datos.entry || []) {
        for (const cambio of entrada.changes || []) {
          if (cambio.field !== "messages") continue;

          const valor = cambio.value || {};

          for (const mensaje of valor.messages || []) {
            if (mensaje.type !== "text") continue;

            const remitente = mensaje.from;
            const texto = mensaje.text.body.trim();
            const comando = texto.toLowerCase().split(/\s+/)[0];

            let respuesta;

            switch (comando) {
              case "/menu":
                respuesta =
                  "🔥 BLT PREMIUM\n\n" +
                  "/menu - Ver comandos\n" +
                  "/ping - Probar el bot\n" +
                  "/ayuda - Obtener ayuda";
                break;

              case "/ping":
                respuesta = "🏓 ¡Pong! El BLT está activo.";
                break;

              case "/ayuda":
                respuesta =
                  "Escribe /menu para consultar los comandos.";
                break;

              default:
                // Ignorar los mensajes que no sean comandos.
                continue;
            }

            await enviarMensaje(remitente, respuesta);
          }
        }
      }
    } catch (error) {
      console.error("Error procesando webhook:", error);
    }
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`BLT Premium escuchando en el puerto ${PORT}`);
});
