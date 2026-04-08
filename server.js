import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = process.env.GROQ_API_KEY;

app.post("/chat", async (req, res) => {
  const messages = req.body.messages;

  if (!messages) {
    return res.json({ reply: "No messages received ❌" });
  }

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
          messages: messages,
        }),
      }
    );
    if (!response.ok) {
  const errorText = await response.text();
  console.log("HTTP ERROR:", errorText);
  return res.json({ reply: "API request failed ❌" });
}
    const data = await response.json();

    if (!data.choices) {
      console.log("API ERROR:", data);
      return res.json({ reply: "API error ❌" });
    }

    const reply = data.choices[0].message.content;

    res.json({ reply });

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.json({ reply: "Server error 😢" });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));