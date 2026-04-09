import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import crypto from "crypto";
import { PDFParse } from "pdf-parse";
import Database from "better-sqlite3";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const LEGACY_DB_PATH = path.join(DATA_DIR, "db.json");
const DEFAULT_SQLITE_DIR = process.platform === "win32"
  ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), "my-ai-app")
  : DATA_DIR;
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(DEFAULT_SQLITE_DIR, "app.db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static(__dirname));

const API_KEY = process.env.GROQ_API_KEY;
const TEXT_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "";

let sqlite;

function safeParseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readLegacyDatabase() {
  try {
    const raw = await fs.readFile(LEGACY_DB_PATH, "utf8");
    return safeParseJson(raw, { users: [], sessions: [], chats: {} });
  } catch (error) {
    if (error.code === "ENOENT") {
      return { users: [], sessions: [], chats: {} };
    }
    throw error;
  }
}

function getUserByEmail(email) {
  return sqlite.prepare("SELECT * FROM users WHERE email = ?").get(email);
}

function getUserById(id) {
  return sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function getSessionByToken(token) {
  return sqlite.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
}

function getUserChats(userId) {
  const row = sqlite.prepare("SELECT chats_json FROM chats WHERE user_id = ?").get(userId);
  const chats = safeParseJson(row?.chats_json || "[]", []);
  return Array.isArray(chats) ? chats : [];
}

function setUserChats(userId, chats) {
  sqlite.prepare(`
    INSERT INTO chats (user_id, chats_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      chats_json = excluded.chats_json,
      updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(chats), new Date().toISOString());
}

function createSession(userId) {
  const token = createToken();
  sqlite.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    new Date().toISOString()
  );
  return token;
}

async function migrateLegacyJsonIfNeeded() {
  const userCount = sqlite.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (userCount > 0) return;

  const legacy = await readLegacyDatabase();
  const users = Array.isArray(legacy.users) ? legacy.users : [];
  const sessions = Array.isArray(legacy.sessions) ? legacy.sessions : [];
  const chats = legacy.chats && typeof legacy.chats === "object" ? legacy.chats : {};

  const insertUser = sqlite.prepare(`
    INSERT OR IGNORE INTO users (id, name, email, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSession = sqlite.prepare(`
    INSERT OR IGNORE INTO sessions (token, user_id, created_at)
    VALUES (?, ?, ?)
  `);
  const upsertChats = sqlite.prepare(`
    INSERT INTO chats (user_id, chats_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      chats_json = excluded.chats_json,
      updated_at = excluded.updated_at
  `);

  const now = new Date().toISOString();
  const transaction = sqlite.transaction(() => {
    users.forEach((user) => {
      insertUser.run(
        user.id,
        user.name || "",
        normalizeEmail(user.email),
        user.passwordHash || "",
        user.createdAt || now
      );
    });

    sessions.forEach((session) => {
      insertSession.run(session.token, session.userId, session.createdAt || now);
    });

    Object.entries(chats).forEach(([userId, userChats]) => {
      upsertChats.run(userId, JSON.stringify(Array.isArray(userChats) ? userChats : []), now);
    });
  });

  transaction();
}

async function ensureDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(path.dirname(SQLITE_PATH), { recursive: true });
  sqlite = new Database(SQLITE_PATH);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chats (
      user_id TEXT PRIMARY KEY,
      chats_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await migrateLegacyJsonIfNeeded();
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

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Missing auth token." });
  }

  const session = getSessionByToken(token);
  if (!session) {
    return res.status(401).json({ error: "Invalid or expired session." });
  }

  const user = getUserById(session.user_id);
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

  if (getUserByEmail(email)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    password_hash: hashPassword(password),
    created_at: new Date().toISOString()
  };
  sqlite.prepare(`
    INSERT INTO users (id, name, email, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(user.id, user.name, user.email, user.password_hash, user.created_at);

  const token = createSession(user.id);
  setUserChats(user.id, []);

  res.status(201).json({ token, user: sanitizeUser(user), chats: [] });
});

app.post("/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  const user = getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password." });
  }

  const token = createSession(user.id);

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

  if (!verifyPassword(currentPassword, req.user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const nextHash = hashPassword(newPassword);
  sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(nextHash, req.user.id);
  res.json({ success: true });
});

app.post("/auth/reset-password", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const name = String(req.body.name || "").trim().toLowerCase();
  const newPassword = String(req.body.newPassword || "");

  if (!email || !name || !newPassword) {
    return res.status(400).json({ error: "Email, full name, and a new password are required." });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(404).json({ error: "No account was found for that email." });
  }

  if (String(user.name || "").trim().toLowerCase() !== name) {
    return res.status(401).json({ error: "Name and email do not match our records." });
  }

  sqlite.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), user.id);
  sqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);

  res.json({
    success: true,
    message: "Password reset successful. Please log in with your new password."
  });
});

app.post("/auth/logout", authMiddleware, async (req, res) => {
  sqlite.prepare("DELETE FROM sessions WHERE token = ?").run(req.token);
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
