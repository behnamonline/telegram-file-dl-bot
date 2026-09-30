// تنظیمات اصلی
const BOT_TOKEN = "8836875453:AAFuIb3giKiGuIZ-Tov7YNilVU_hfR5zCSo"; // توکن ربات شما
const ADMINS = ["admin1", "admin2", "nmmrv00"]; // یوزرنیم‌های ادمین بدون @
const BOT_USERNAME = "mybot"; // یوزرنیم ربات بدون @

// جداسازی قسمت دوم توکن برای مسیر وبهوک
const TOKEN_SECRET = BOT_TOKEN.split(":")[1] || BOT_TOKEN;
const WEBHOOK_PATH = `/webhook-${TOKEN_SECRET}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ----------------------------------------------------
    // 1. روت /init برای ست کردن وبهوک و ساخت جدول دیتابیس
    // ----------------------------------------------------
    if (url.pathname === "/init") {
      try {
        // ساخت جدول در D1
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_chat_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            title TEXT
          )
        `).run();

        // ست کردن وبهوک تلگرام
        const webhookUrl = `${url.origin}${WEBHOOK_PATH}`;
        const setWebhookRes = await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
        );
        const webhookData = await setWebhookRes.json();

        return new Response(
          JSON.stringify({
            status: "Success",
            message: "Database initialized & Webhook set successfully!",
            webhook_result: webhookData
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(`Error in /init: ${err.message}`, { status: 500 });
      }
    }

    // ----------------------------------------------------
    // 2. پردازش درخواست‌های وبهوک تلگرام
    // ----------------------------------------------------
    if (url.pathname === WEBHOOK_PATH && request.method === "POST") {
      try {
        const update = await request.json();

        if (update.message) {
          await handleMessage(update.message, env);
        }

        return new Response("OK", { status: 200 });
      } catch (err) {
        console.error("Webhook processing error:", err);
        return new Response("Error", { status: 500 });
      }
    }

    return new Response("bot is working");
  }
};

// ----------------------------------------------------
// توابع مدیریت منطق ربات
// ----------------------------------------------------

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const username = message.from?.username || "";
  const text = message.text || "";
  const isAdmin = ADMINS.includes(username);

  // --- الف) پردازش دستور /start برای همه کاربرها ---
  if (text.startsWith("/start")) {
    const args = text.split(" ");
    
    // اگر کاربر روی لینک دانلود کلیک کرده باشد: /start <file_id>
    if (args.length > 1 && args[1]) {
      const fileId = parseInt(args[1], 10);
      if (!isNaN(fileId)) {
        // خواندن فایل از دیتابیس
        const record = await env.DB.prepare(
          "SELECT * FROM files WHERE id = ?"
        ).bind(fileId).first();

        if (record) {
          // ارسال فایل با copyMessage
          await callTelegramApi("copyMessage", {
            chat_id: chatId,
            from_chat_id: record.from_chat_id,
            message_id: record.message_id
          });
          return;
        } else {
          await callTelegramApi("sendMessage", {
            chat_id: chatId,
            text: "❌ فایل مورد نظر یافت نشد یا حذف شده است."
          });
          return;
        }
      }
    }

    // استارت معمولی
    const replyMarkup = isAdmin ? {
      keyboard: [[{ text: "ارسال فایل" }]],
      resize_keyboard: true
    } : undefined;

    await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: "سلام! به ربات خوش آمدید.",
      reply_markup: replyMarkup
    });
    return;
  }

  // اگر کاربر ادمین نباشد، ادامه‌ی دستورات ادمین اجرا نمی‌شود
  if (!isAdmin) return;

  // --- ب) بخش مخصوص ادمین ---

  // 1. کلیک روی دکمه "ارسال فایل"
  if (text === "ارسال فایل") {
    // بازنشانی حالت/پیش‌فرض
    await env.DB.prepare(
      "INSERT INTO files (from_chat_id, message_id) VALUES (?, ?)"
    ).bind(chatId, 0).run();

    await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: "لطفاً فایل مورد نظر را ارسال کنید."
    });
    return;
  }

  // بررسی آخرین حالت ادمین در دیتابیس
  const pendingRecord = await env.DB.prepare(
    "SELECT * FROM files WHERE from_chat_id = ? ORDER BY id DESC LIMIT 1"
  ).bind(chatId).first();

  // 2. منتظر دریافت فایل (وقتی message_id برابر 0 باشد)
  if (pendingRecord && pendingRecord.message_id === 0) {
    // هر نوع فایلی که ارسال شود (document, photo, video, audio, etc.)
    if (message.document || message.photo || message.video || message.audio || message.voice || message.sticker) {
      await env.DB.prepare(
        "UPDATE files SET message_id = ? WHERE id = ?"
      ).bind(message.message_id, pendingRecord.id).run();

      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: "فایل دریافت شد.\nحالا عنوان را وارد کنید:"
      });
    } else {
      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: "لطفاً یک فایل معتبر ارسال کنید."
      });
    }
    return;
  }

  // 3. منتظر دریافت عنوان فایل (وقتی message_id ثبت شده اما title خالی/null باشد)
  if (pendingRecord && pendingRecord.message_id !== 0 && !pendingRecord.title && text) {
    const fileId = pendingRecord.id;
    const title = text;

    // ذخیره عنوان فایل
    await env.DB.prepare(
      "UPDATE files SET title = ? WHERE id = ?"
    ).bind(title, fileId).run();

    const downloadLink = `https://t.me/${BOT_USERNAME}?start=${fileId}`;

    // پیام اول: همراه با لینک در متن کدگذاری شده (قابلیت کپی با کلیک)
    const markdownText = `فایل دریافت شد \n عنوان: ${escapeMarkdownV2(title)} \n لینک دریافت: \`${downloadLink}\``;
    
    await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: markdownText,
      parse_mode: "MarkdownV2"
    });

    // پیام دوم: همراه با دکمه شیشه‌ای (Inline Keyboard)
    await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: title,
      reply_markup: {
        inline_keyboard: [
          [{ text: "دریافت", url: downloadLink }]
        ]
      }
    });
    return;
  }
}

// تابع کمکی برای فراخوانی Telegram Bot API
async function callTelegramApi(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await response.json();
}

// کاراکترهای خاص MarkdownV2 برای جلوگیری از خطای پارس
function escapeMarkdownV2(text) {
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, "\\$&");
}
