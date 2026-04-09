import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import crypto from "crypto";
import { PDFParse } from "pdf-parse";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(__dirname));

const API_KEY = process.env.GROQ_API_KEY;
const TEXT_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "";

let db = {
  users: [],
  sessions: [],
  chats: {}
};

async function ensureDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    db = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      chats: parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {}
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveDatabase();
  }
}

async function saveDatabase() {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash = "") {
  const [salt, originalHash] = storedHash.split(":");
  if (!salt || !originalHash) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
}

function createToken() {
  return base64Url(crypto.randomBytes(32));
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email
  };
}

function getUserChats(userId) {
  return Array.isArray(db.chats[userId]) ? db.chats[userId] : [];
}

function setUserChats(userId, chats) {
  db.chats[userId] = chats;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Missing auth token." });
  }

  const session = db.sessions.find((item) => item.token === token);
  if (!session) {
    return res.status(401).json({ error: "Invalid or expired session." });
  }

  const user = db.users.find((item) => item.id === session.userId);
  if (!user) {
    return res.status(401).json({ error: "User not found." });
  }

  req.user = user;
  req.token = token;
  next();
}

async function extractPdfTextFromDataUrl(dataUrl = "") {
  const match = dataUrl.match(/^data:application\/pdf;base64,(.+)$/);
  if (!match) return "";

  try {
    const buffer = Buffer.from(match[1], "base64");
    const parser = new PDFParse({ data: buffer });
    const parsed = await parser.getText();
    await parser.destroy();
    return String(parsed.text || "").trim();
  } catch (error) {
    console.error("PDF PARSE ERROR:", error);
    return "";
  }
}

async function buildAttachmentText(attachments = []) {
  const blocks = [];

  for (const attachment of attachments) {
    if (attachment.kind === "text" && attachment.extractedText) {
      blocks.push(
        `Attached file: ${attachment.name}\nType: ${attachment.mimeType || "unknown"}\nContent:\n${attachment.extractedText.slice(0, 12000)}`
      );
    }

    if (attachment.kind === "pdf" && attachment.dataUrl) {
      const extractedText = await extractPdfTextFromDataUrl(attachment.dataUrl);
      blocks.push(
        `Attached PDF: ${attachment.name}\nType: ${attachment.mimeType || "application/pdf"}\nContent:\n${(extractedText || "No readable text found in the PDF.").slice(0, 12000)}`
      );
    }
  }

  return blocks.join("\n\n");
}

async function buildChatMessages(messages = []) {
  return Promise.all(messages.map(async (message) => {
    const role = message.sender === "user" ? "user" : "assistant";
    const attachments = message.attachments || [];

    if (role === "assistant") {
      return {
        role,
        content: message.text || ""
      };
    }

    const imageAttachments = attachments.filter((attachment) => attachment.kind === "image" && attachment.dataUrl);
    const textAttachmentBlock = await buildAttachmentText(attachments);

    let combinedText = (message.text || "").trim();
    if (textAttachmentBlock) {
      combinedText = combinedText
        ? `${combinedText}\n\n${textAttachmentBlock}`
        : `Please analyze the attached content.\n\n${textAttachmentBlock}`;
    }

    if (imageAttachments.length === 0) {
      return {
        role,
        content: combinedText || "Please analyze the uploaded content."
      };
    }

    const contentParts = [
      {
        type: "text",
        text: combinedText || "Please analyze the uploaded image and answer the user's request."
      }
    ];

    imageAttachments.forEach((attachment) => {
      contentParts.push({
        type: "image_url",
        image_url: {
          url: attachment.dataUrl
        }
      });
    });

    return {
      role,
      content: contentParts
    };
  }));
}

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "test.html"));
});

app.post("/auth/signup", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  if (db.users.some((user) => user.email === email)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  const token = createToken();
  db.users.push(user);
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  setUserChats(user.id, []);
  await saveDatabase();

  res.status(201).json({ token, user: sanitizeUser(user), chats: [] });
});

app.post("/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  const user = db.users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = createToken();
  db.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  await saveDatabase();

  res.json({ token, user: sanitizeUser(user), chats: getUserChats(user.id) });
});

app.get("/auth/me", authMiddleware, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.post("/auth/change-password", authMiddleware, async (req, res) => {
  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current password and new password are required." });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }

  if (!verifyPassword(currentPassword, req.user.passwordHash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  req.user.passwordHash = hashPassword(newPassword);
  await saveDatabase();
  res.json({ success: true });
});

app.post("/auth/logout", authMiddleware, async (req, res) => {
  db.sessions = db.sessions.filter((session) => session.token !== req.token);
  await saveDatabase();
  res.json({ success: true });
});

app.get("/chats", authMiddleware, (req, res) => {
  res.json({ chats: getUserChats(req.user.id) });
});

app.put("/chats", authMiddleware, async (req, res) => {
  const chats = req.body.chats;
  if (!Array.isArray(chats)) {
    return res.status(400).json({ error: "Chats payload must be an array." });
  }

  setUserChats(req.user.id, chats);
  await saveDatabase();
  res.json({ success: true });
});

app.post("/chat", authMiddleware, async (req, res) => {
  const messages = req.body.messages;

  if (!API_KEY) {
    return res.status(500).json({ reply: "Missing GROQ_API_KEY on the server." });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ reply: "No messages received." });
  }

  const hasImages = messages.some((message) =>
    (message.attachments || []).some((attachment) => attachment.kind === "image" && attachment.dataUrl)
  );

  if (hasImages && !VISION_MODEL) {
    return res.status(400).json({
      reply: "Image analysis is not enabled yet. Add GROQ_VISION_MODEL in your server environment to turn on image understanding."
    });
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: hasImages ? VISION_MODEL : TEXT_MODEL,
        messages: await buildChatMessages(messages),
        temperature: 0.4
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Groq HTTP ERROR:", errorText);
      return res.status(502).json({ reply: "AI request failed. Please check your model settings and try again." });
    }

    const data = await response.json();

    if (!data.choices?.[0]?.message?.content) {
      console.error("Groq API ERROR:", data);
      return res.status(502).json({ reply: "AI response was empty." });
    }

    res.json({ reply: data.choices[0].message.content });
  } catch (error) {
    console.error("SERVER ERROR:", error);
    res.status(500).json({ reply: "Server error. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;

ensureDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
