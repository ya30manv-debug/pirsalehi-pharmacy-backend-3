// bale-bot.js — بات پیام‌رسان «بله» برای داروخانهٔ دکتر پیرصالحی.
// بله برخلاف تلگرام صفحهٔ تنظیمات «دکمهٔ منو» در بازوساز ندارد — این کد
// همان کار را با فرستادن یک دکمهٔ inline از نوع web_app انجام می‌دهد.
// API بله دقیقاً شبیه تلگرام است: https://tapi.bale.ai/bot<TOKEN>/METHOD

const BALE_TOKEN = process.env.BALE_BOT_TOKEN; // توکنی که بازوساز داد
const MINIAPP_URL = process.env.MINIAPP_URL;   // همان آدرس مینی‌اپ که برای تلگرام هم استفاده کردیم
const API = `https://tapi.bale.ai/bot${BALE_TOKEN}`;

let lastUpdateId = 0;

async function baleCall(method, params) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  return res.json();
}

async function sendWelcome(chatId) {
  await baleCall('sendMessage', {
    chat_id: chatId,
    text: 'سلام 👋 به داروخانهٔ دکتر پیرصالحی خوش آمدید!\nبرای ثبت سفارش دارو، روی دکمهٔ زیر بزنید.',
    reply_markup: {
      inline_keyboard: [[
        { text: '🛒 شروع سفارش', web_app: { url: MINIAPP_URL } }
      ]]
    }
  });
}

async function sendReminder(chatId) {
  await baleCall('sendMessage', {
    chat_id: chatId,
    text: 'برای ثبت یا پیگیری سفارش، روی دکمهٔ زیر بزنید 👇',
    reply_markup: {
      inline_keyboard: [[
        { text: '🛒 باز کردن داروخانه', web_app: { url: MINIAPP_URL } }
      ]]
    }
  });
}

async function poll() {
  try {
    const data = await baleCall('getUpdates', { offset: lastUpdateId + 1, timeout: 25 });
    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg) continue;
        const chatId = msg.chat.id;
        if (msg.text === '/start') await sendWelcome(chatId);
        else await sendReminder(chatId);
      }
    }
  } catch (e) {
    console.error('خطای polling بله:', e.message);
  }
  setTimeout(poll, 1000); // تکرار polling
}

function startBaleBot() {
  if (!BALE_TOKEN) {
    console.log('⚠️  BALE_BOT_TOKEN تنظیم نشده — بات بله غیرفعال است.');
    return;
  }
  if (!MINIAPP_URL) {
    console.log('⚠️  MINIAPP_URL تنظیم نشده — دکمهٔ شروع سفارش در بله کار نمی‌کند.');
  }
  console.log('✅ بات بله شروع به کار کرد.');
  poll();
}

module.exports = { startBaleBot };
