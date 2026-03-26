const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID || "7470698213");

if (!BOT_TOKEN || !ANTHROPIC_API_KEY) {
  console.error("Missing BOT_TOKEN or ANTHROPIC_API_KEY");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Conversation history per user (in-memory)
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
- If asked to send an email, draft it first and confirm before sending`;

async function askClaude(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];

  conversations[userId].push({ role: "user", content: userMessage });

  // Keep last 20 messages to manage context
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
        {
          type: "url",
          url: "https://gmail.mcp.claude.com/mcp",
          name: "gmail"
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Anthropic API error:", data);
    throw new Error(data.error?.message || "API error");
  }

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

// /start command
bot.onText(/\/start/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  conversations[msg.from.id] = []; // reset
  bot.sendMessage(msg.chat.id,
    "👋 Hey Ken! I'm your Gmail assistant, ready to go.\n\n" +
    "Here's what you can ask me:\n\n" +
    "📬 *What are my unread emails?*\n" +
    "↩️ *Which emails need a reply?*\n" +
    "📁 *Move Uber Eats emails to a Deliveries folder*\n" +
    "✍️ *Draft a reply to the wedding inquiry*\n" +
    "🔍 *Find the email from Mahsa*\n\n" +
    "Just type naturally — what do you want to tackle?",
    { parse_mode: "Markdown" }
  );
});

// /reset command - clear conversation history
bot.onText(/\/reset/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  conversations[msg.from.id] = [];
  bot.sendMessage(msg.chat.id, "🔄 Conversation reset. Fresh start — what do you need?");
});

// /help command
bot.onText(/\/help/, (msg) => {
  if (msg.from.id !== ALLOWED_USER_ID) return;
  bot.sendMessage(msg.chat.id,
    "📋 *Commands:*\n\n" +
    "/start — restart and reset conversation\n" +
    "/reset — clear chat history\n" +
    "/help — show this menu\n\n" +
    "*Example requests:*\n" +
    "• What's unread in my inbox?\n" +
    "• Summarize emails from this week\n" +
    "• Create a label called Wedding Inquiries\n" +
    "• Move all Blend catering emails to a folder\n" +
    "• Draft a reply to [person]\n" +
    "• Which emails are urgent?",
    { parse_mode: "Markdown" }
  );
});

// Handle all regular messages
bot.on("message", async (msg) => {
  // Only respond to allowed user
  if (msg.from.id !== ALLOWED_USER_ID) {
    bot.sendMessage(msg.chat.id, "Sorry, this is a private assistant.");
    return;
  }

  // Skip commands (handled above)
  if (msg.text && msg.text.startsWith("/")) return;

  const text = msg.text;
  if (!text) {
    bot.sendMessage(msg.chat.id, "I can only handle text messages for now.");
    return;
  }

  // Show typing indicator
  bot.sendChatAction(msg.chat.id, "typing");

  try {
    const reply = await askClaude(msg.from.id, text);

    // Telegram has a 4096 char limit — split if needed
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

console.log("✅ Blend Gmail Bot is running...");
