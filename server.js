import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.GROQ_API_KEY;

console.log("KEY:", API_KEY);

let conversation = [];

app.post("/chat", async (req, res) => {
  const message = req.body.message;

  // 🧠 store user message
  conversation.push({ role: "user", content: message });

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: conversation,
        }),
      }
    );

    const data = await response.json();

    console.log("DEBUG:", data);

    if (!data.choices) {
      return res.json({ reply: "API error ❌" });
    }

    const reply = data.choices[0].message.content;

    // 🧠 store bot reply
    conversation.push({ role: "assistant", content: reply });

    res.json({ reply });

  } catch (err) {
    console.error("ERROR:", err);
    res.json({ reply: "Server error 😢" });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));