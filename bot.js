const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "7470698213");

if (!BOT_TOKEN || !ANTHROPIC_API_KEY || !OPENAI_API_KEY) {
  console.error("Missing BOT_TOKEN, ANTHROPIC_API_KEY, or OPENAI_API_KEY");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const conversations = {};

const SYSTEM_PROMPT = `You are Ken's personal Gmail assistant for Blend Bubble Tea & Café, his bubble tea and café business in Vancouver/North Vancouver, BC.

Ken's business context:
- Blend Bubble Tea & Café: handles catering, events, delivery platforms (Uber Eats, DoorDash), and corporate/community partnerships
- Active areas: wedding catering, event partnerships, community fundraising (e.g. Cops for Cancer), vendor relationships
- Key contacts include: Mahsa (123 Dentist dental convention client), Key Events & Weddings (Richmond), The Hive (Port Coquitlam)
- Ken signs all emails as "Ken"

Your capabilities via Gmail:
- Read and summarize unread emails with priority ranking
- Search for specific emails or threads
- Organize emails into Gmail labels/folders (create, move, apply)
- Draft professional replies in Ken's warm but concise tone
- Identify which emails need urgent replies
- Mark emails as read, archive, or trash

Guidelines:
- Be concise and action-oriented — Ken is a busy owner
- When summarizing unread emails, group by priority: urgent, needs reply, FYI
- When drafting, always sign off as "Ken"
- For Gmail organization, use Labels (they function as folders)
- Always confirm before taking bulk destructive actions (mass delete, etc.)
- If asked to send an email, draft it first and confirm before sending
- When replying via voice, keep responses conversational and concise — avoid long bullet lists, speak naturally`;

async function askClaude(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];

  conversations[userId].push({ role: "user", content: userMessage });

  if (conversations[userId].length > 20) {
    conversations[userId] = conversations[userId].slice(-20);
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: conversations[userId],
      mcp_servers: [
        { type: "url", url: "https://gmail.mcp.claude.com/mcp", name: "gmail" }
      ]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API error");

  const replyText = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();

  if (replyText) {
    conversations[userId].push({ role: "assistant", content: replyText });
  }

  return replyText || "I didn't get a response. Please try again.";
}

// Transcribe voice using OpenAI Whisper
async function transcribeVoice(audioBuffer) {
  const tmpPath = `/tmp/voice_${Date.now()}.ogg`;
  fs.writeFileSync(tmpPath, audioBuffer);

  const formData = new FormData();
  const fileBlob = new Blob([fs.readFileSync(tmpPath)], { type: "audio/ogg" });
  formData.append("file", fileBlob, "voice.ogg");
  formData.append("model", "whisper-1");
  formData.append("language", "en");
  fs.unlinkSync(tmpPath);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: formData
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Whisper error");
  return data.text;
}

// Convert reply text to speech using OpenAI TTS
async function textToSpeech(text) {
  // Strip markdown symbols so they aren't spoken aloud
  const cleanText = text
    .replace(/\*\*/g, "").replace(/\*/g, "")
    .replace(/_/g, "").replace(/`/g, "")
    .replace(/#+\s/g, "").trim();

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "tts-1",
      input: cleanText,
      voice: "nova",  // Friendly, clear voice
      response_format: "ogg_opus"
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || "TTS error");
  }

  return Buffer.from(await response.arrayBuffer());
}

// /start command
bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  conversations[msg.from.id] = [];
  bot.sendMessage(msg.chat.id,
    "👋 Hey Ken! Your Gmail assistant is ready — now with two-way voice!\n\n" +
    "🎤 *Hold the mic* in Telegram to send a voice message → I'll talk back\n" +
    "⌨️ *Or type* like normal\n\n" +
    "Try asking:\n" +
    "• What are my unread emails?\n" +
    "• Which emails need a reply?\n" +
    "• Draft a reply to the wedding inquiry\n" +
    "• Move Uber Eats emails to a Deliveries folder",
    { parse_mode: "Markdown" }
  );
});

// /reset command
bot.onText(/\/reset/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  conversations[msg.from.id] = [];
  bot.sendMessage(msg.chat.id, "🔄 Conversation reset. What do you need?");
});

// /help command
bot.onText(/\/help/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  bot.sendMessage(msg.chat.id,
    "📋 *Commands:*\n/start — restart\n/reset — clear history\n/help — this menu\n\n" +
    "🎤 *Voice:* Hold the mic button in Telegram — I'll reply with voice + text\n\n" +
    "💬 *Try saying:*\n" +
    "• What's unread in my inbox?\n" +
    "• Which emails are urgent?\n" +
    "• Find the email from Mahsa\n" +
    "• Draft a reply to [someone]",
    { parse_mode: "Markdown" }
  );
});

// Handle voice messages
bot.on("voice", async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;

  bot.sendChatAction(msg.chat.id, "record_voice");

  try {
    // Download voice file
    const fileInfo = await bot.getFile(msg.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    const audioResponse = await fetch(fileUrl);
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());

    // Transcribe with Whisper
    const transcription = await transcribeVoice(audioBuffer);
    console.log("Transcribed:", transcription);

    // Echo what was heard
    await bot.sendMessage(msg.chat.id, `🎤 _"${transcription}"_`, { parse_mode: "Markdown" });

    bot.sendChatAction(msg.chat.id, "typing");

    // Get Claude's reply
    const reply = await askClaude(msg.from.id, transcription);

    // Convert to speech and send as voice message
    try {
      const audioReply = await textToSpeech(reply);
      const tmpPath = `/tmp/reply_${Date.now()}.ogg`;
      fs.writeFileSync(tmpPath, audioReply);
      await bot.sendVoice(msg.chat.id, tmpPath);
      fs.unlinkSync(tmpPath);
    } catch (ttsErr) {
      console.error("TTS failed, sending text only:", ttsErr.message);
    }

    // Always send text too so Ken can read it
    if (reply.length > 4000) {
      const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
      for (const chunk of chunks) {
        await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(msg.chat.id, reply, { parse_mode: "Markdown" });
    }

  } catch (err) {
    console.error("Voice error:", err.message);
    bot.sendMessage(msg.chat.id, "⚠️ Couldn't process voice message. Try again or type instead.");
  }
});

// Handle text messages
bot.on("message", async (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  if (msg.text && msg.text.startsWith("/")) return;
  if (msg.voice) return;

  const text = msg.text;
  if (!text) {
    bot.sendMessage(msg.chat.id, "I can handle text and voice messages.");
    return;
  }

  bot.sendChatAction(msg.chat.id, "typing");

  try {
    const reply = await askClaude(msg.from.id, text);
    if (reply.length > 4000) {
      const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
      for (const chunk of chunks) {
        await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
      }
    } else {
      await bot.sendMessage(msg.chat.id, reply, { parse_mode: "Markdown" });
    }
  } catch (err) {
    console.error("Error:", err.message);
    bot.sendMessage(msg.chat.id, "⚠️ Something went wrong. Please try again.");
  }
});

console.log("✅ Blend Gmail Bot is running (voice enabled)...");
