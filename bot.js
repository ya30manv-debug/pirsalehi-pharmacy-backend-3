// bot.js — بات تلگرام داروخانهٔ دکتر پیرصالحی.
// این فایل کاری که BotFather بهت گفت رو واقعی می‌کند: وقتی کاربر در تلگرام
// بات را پیدا و /start می‌زند، یک دکمه نشانش می‌دهد که با زدنش، مینی‌اپ
// (همان فایل HTML که قبلاً ساختیم) داخل تلگرام باز می‌شود.

const TelegramBot = require('node-telegram-bot-api');

// این دو مقدار را از متغیرهای محیطی (Environment Variables) می‌خوانیم،
// نه این‌که مستقیم در کد بنویسیم — چون توکن بات مثل رمز عبور است و
// نباید در کد یا گیت‌هاب ذخیره شود. در Render این مقادیر را در تنظیمات
// «Environment» وارد می‌کنیم.
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINIAPP_URL = process.env.MINIAPP_URL; // آدرسی که مینی‌اپ (فایل HTML) رویش میزبانی می‌شود

let botInstance = null; // بعد از startBot() پر می‌شود تا بقیهٔ کد هم بتواند پیام بفرستد

function startBot() {
  if (!BOT_TOKEN) {
    console.log('⚠️  BOT_TOKEN تنظیم نشده — بات تلگرام غیرفعال است (سرور بدون بات هم کار می‌کند).');
    return null;
  }
  if (!MINIAPP_URL) {
    console.log('⚠️  MINIAPP_URL تنظیم نشده — دکمهٔ شروع سفارش کار نمی‌کند تا این مقدار را اضافه کنی.');
  }

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // وقتی کاربر برای اولین‌بار /start را به بات می‌فرستد
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'سلام 👋 به داروخانهٔ دکتر پیرصالحی خوش آمدید!\nبرای ثبت سفارش دارو، روی دکمهٔ زیر بزنید.',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🛒 شروع سفارش', web_app: { url: MINIAPP_URL } }
          ]]
        }
      }
    );
  });

  // اگر کاربر هر پیام دیگری (غیر از /start) فرستاد، همان دکمه را دوباره یادآوری کن
  bot.on('message', (msg) => {
    if (msg.text === '/start') return; // قبلاً بالا مدیریت شد
    const chatId = msg.chat.id;
    bot.sendMessage(
      chatId,
      'برای ثبت یا پیگیری سفارش، روی دکمهٔ زیر بزنید 👇',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🛒 باز کردن داروخانه', web_app: { url: MINIAPP_URL } }
          ]]
        }
      }
    );
  });

  bot.on('polling_error', (err) => {
    console.error('خطای بات تلگرام:', err.message);
  });

  console.log('✅ بات تلگرام روشن شد و منتظر پیام است');
  botInstance = bot;
  return bot;
}

// این تابع را server.js صدا می‌زند تا وقتی وضعیت سفارش عوض شد
// (مثلاً داروساز قیمت نهایی را تأیید کرد) به کاربر در تلگرام پیام بدهد.
// اگر بات روشن نباشد (مثلاً موقع تست محلی بدون BOT_TOKEN)، فقط در کنسول لاگ می‌شود.
function sendTelegramMessage(telegramUserId, text) {
  if (!botInstance || !telegramUserId) {
    console.log('(بات/شناسهٔ کاربر موجود نیست — پیام فقط لاگ شد):', telegramUserId, text);
    return;
  }
  botInstance.sendMessage(telegramUserId, text, {
    reply_markup: { inline_keyboard: [[{ text: '🛒 باز کردن داروخانه', web_app: { url: MINIAPP_URL } }]] }
  }).catch(err => console.error('ارسال پیام تلگرام ناموفق بود:', err.message));
}

module.exports = { startBot, sendTelegramMessage };
