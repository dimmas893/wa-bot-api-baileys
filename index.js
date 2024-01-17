const {
  default: makeWASocket,
  DisconnectReason,
  isJidBroadcast,
  makeInMemoryStore,
  useMultiFileAuthState,
} = require("@adiwajshing/baileys");

const log = (pino = require("pino"));
const { session } = { session: "baileys_auth_info" };
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const app = require("express")();
const unlinkAsync = promisify(fs.unlink);
// enable files upload

app.use(
  fileUpload({
    createParentPath: true,
  })
);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const server = require("http").createServer(app);
const io = require("socket.io")(server);
const port = process.env.PORT || 8001;
const qrcode = require("qrcode");

app.use("/assets", express.static(__dirname + "/client/assets"));

app.get("/scan", (req, res) => {
  res.sendFile("./client/server.html", {
    root: __dirname,
  });
});

app.get("/", (req, res) => {
  res.sendFile("./client/index.html", {
    root: __dirname,
  });
});
const store = makeInMemoryStore({
  logger: pino().child({ level: "silent", stream: "store" }),
});

let sock;
let qr;
let soket;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth_info");
  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: log({ level: "silent" }),
    version: [2, 2323, 4],
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });
  store.bind(sock.ev);
  sock.multi = true;

  sock.ev.on("connection.update", async (update) => {
    await handleConnectionUpdate(update);
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    await handleMessagesUpsert(m);
  });
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect } = update;

  switch (connection) {
    case "close":
      handleConnectionClosed(lastDisconnect);
      break;
    case "open":
      handleConnectionOpen();
      break;
  }
}

function handleConnectionClosed(lastDisconnect) {
  const reason = lastDisconnect.error;

  switch (reason) {
    case DisconnectReason.badSession:
      handleError(
        reason,
        `Bad Session File, Please Delete ${session} and Scan Again`
      );
      sock.logout();
      break;
    case DisconnectReason.connectionClosed:
      handleError(reason, "Connection closed, reconnecting...");
      connectToWhatsApp();
      break;
    case DisconnectReason.connectionLost:
      handleError(reason, "Connection Lost from Server, reconnecting...");
      connectToWhatsApp();
      break;
    // ... handle other cases ...
  }
}
async function handleConnectionOpen() {
  console.log("Opened connection");
  const getGroups = await sock.groupFetchAllParticipating();
  const groups = Object.entries(getGroups)
    .slice(0)
    .map((entry) => entry[1]);
  console.log(groups);
}

function handleError(reason, message) {
  console.error(`Error (${reason}): ${message}`);
  // ... handle error based on reason ...
}
async function handleMessagesUpsert(m) {
  try {
    const remoteJid = m.messages[0].key.remoteJid;
    const messageContent = m.messages[0]?.message?.extendedTextMessage?.text;

    if (
      remoteJid &&
      messageContent &&
      messageContent.toLowerCase() === "ping"
    ) {
      await sock.sendMessage(remoteJid, { text: "Pong!" });
    } else if (
      remoteJid &&
      messageContent &&
      messageContent.toLowerCase() === "tes"
    ) {
      await sock.sendMessage(
        remoteJid,
        { text: "oh hello there" },
        {
          quoted: {
            key: { fromMe: false, id: m.messages[0].key.id },
            message: m.messages[0].message,
          },
        }
      );
    }
  } catch (error) {
    handleError("Unknown", `Error processing incoming message: ${error}`);
  }
}

io.on("connection", async (socket) => {
  soket = socket;
  // console.log(sock)
  if (isConnected) {
    updateQR("connected");
  } else if (qr) {
    updateQR("qr");
  }
});

// functions
const isConnected = () => {
  return sock.user;
};

const updateQR = (data) => {
  switch (data) {
    case "qr":
      qrcode.toDataURL(qr, (err, url) => {
        soket?.emit("qr", url);
        soket?.emit("log", "QR Code received, please scan!");
      });
      break;
    case "connected":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", "WhatsApp terhubung!");
      break;
    case "qrscanned":
      soket?.emit("qrstatus", "./assets/check.svg");
      soket?.emit("log", "QR Code Telah discan!");
      break;
    case "loading":
      soket?.emit("qrstatus", "./assets/loader.gif");
      soket?.emit("log", "Registering QR Code , please wait!");
      break;
    default:
      break;
  }
};

app.post("/send-message", async (req, res) => {
  const pesankirim = req.body.message;
  const number = req.body.number;

  try {
    if (!number) {
      return sendErrorResponse(res, 500, "Nomor WA belum tidak disertakan!");
    }

    const numberWA = "62" + number.substring(1) + "@s.whatsapp.net";
    const exists = await checkContactExists(numberWA);

    if (!isConnected) {
      return sendErrorResponse(res, 500, "WhatsApp belum terhubung.");
    }

    if (exists?.jid || (exists && exists[0]?.jid)) {
      if (!req.files) {
        await sendTextMessage(res, pesankirim, exists.jid || exists[0].jid);
      } else {
        await sendFileMessage(
          res,
          pesankirim,
          exists.jid || exists[0].jid,
          req.files.file_dikirim
        );
      }
    } else {
      sendErrorResponse(res, 500, `Nomor ${number} tidak terdaftar.`);
    }
  } catch (err) {
    sendErrorResponse(res, 500, err.message || "Internal Server Error");
  }
});

async function sendTextMessage(res, pesankirim, jid) {
  validateNumber(res, jid);
  await sock.sendMessage(jid, { text: pesankirim });
  sendSuccessResponse(res, "Text message sent successfully");
}

async function sendFileMessage(res, pesankirim, jid, file) {
  validateNumber(res, jid);

  const filePath = await saveFile(file);
  const mimetype = file.mimetype;
  const caption = pesankirim; // Set caption here

  const media = getMediaObject(filePath, caption, mimetype);

  await sock.sendMessage(jid, media);
  await cleanupFile(filePath);

  sendSuccessResponse(res, "File message sent successfully", file);
}

function validateNumber(res, number) {
  if (!number) {
    sendErrorResponse(res, 500, "Nomor WA belum tidak disertakan!");
  }
}
function getMediaObject(filePath, caption, mimetype) {
  const mediaType = getMediaType(mimetype);

  if (mediaType === "image") {
    return { image: { url: filePath }, caption };
  } else if (mediaType === "audio") {
    return { audio: { url: filePath, caption }, mimetype: "audio/mp4" };
  } else {
    return {
      document: { url: filePath },
      caption,
      mimetype,
      fileName: path.basename(filePath),
    };
  }
}

async function cleanupFile(filePath) {
  if (fs.existsSync(filePath)) {
    await unlinkAsync(filePath).catch((err) => {
      console.error("Error occurred while trying to remove file.", err);
    });
  }
}

// Other functions (getWhatsAppNumber, checkContactExists, saveFile, etc.) remain unchanged
async function checkContactExists(numberWA) {
  return isConnected ? await sock.onWhatsApp(numberWA) : null;
}

function sendSuccessResponse(res, message, data = null) {
  res.status(200).json({
    status: true,
    response: message,
    data,
  });
}
const UPLOADS_DIRECTORY = "./uploads/";
async function saveFile(file) {
  const fileName = new Date().getTime() + "_" + file.name;
  const filePath = UPLOADS_DIRECTORY + fileName;
  await file.mv(filePath);
  return filePath;
}

function sendErrorResponse(res, status, message) {
  res.status(status).json({
    status: false,
    response: message,
  });
}
function getMediaType(mimetype) {
  if (mimetype.startsWith("image")) {
    return "image";
  } else if (mimetype.startsWith("audio")) {
    return "audio";
  } else {
    return "document";
  }
}

connectToWhatsApp().catch((err) => console.log("unexpected error: " + err)); // catch any errors
server.listen(port, () => {
  console.log("Server Berjalan pada Port : " + port);
});
