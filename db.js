// db.js — یک پایگاه‌دادهٔ خیلی ساده که همه‌چیز را در یک فایل JSON ذخیره می‌کند.
// برای شروع کار کاملاً کافی است؛ بعداً اگر تعداد سفارش‌ها زیاد شد می‌توان
// به یک دیتابیس واقعی (PostgreSQL) مهاجرت کرد بدون اینکه بقیهٔ کد عوض شود،
// چون همهٔ توابع از همینجا صدا زده می‌شوند.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// اگر پوشهٔ data وجود نداشت بسازش (مثلاً روی سروری مثل Render که فقط
// فایل‌های گیت‌هاب را کپی می‌کند و پوشه‌های خالی در گیت ذخیره نمی‌شوند)
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// اگر فایل دیتابیس وجود نداشت، یکی خالی بساز
function ensureDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) {
    const empty = { orders: [], chats: [], nextOrderSeq: 88421 };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  return JSON.parse(raw);
}

function writeDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---------- orders ----------
function createOrder(order) {
  const db = readDb();
  const seq = db.nextOrderSeq++;
  const id = 'PSP-' + seq;
  const full = {
    id,
    status: 'wait',           // wait → review → items_sent → items_confirmed → done
    createdAt: new Date().toISOString(),
    items: [],
    fee: 120000,
    deliver: null,
    ...order
  };
  db.orders.push(full);
  writeDb(db);
  return full;
}

function getOrders() {
  return readDb().orders;
}

// سفارش‌های یک کاربر تلگرام خاص — همان چیزی که صفحهٔ «سفارش‌های من» در مینی‌اپ لازم دارد
function getOrdersByUser(telegramUserId) {
  return readDb().orders.filter(o => o.telegramUserId === telegramUserId);
}

function getOrder(id) {
  return readDb().orders.find(o => o.id === id) || null;
}

function updateOrder(id, patch) {
  const db = readDb();
  const idx = db.orders.findIndex(o => o.id === id);
  if (idx === -1) return null;
  db.orders[idx] = { ...db.orders[idx], ...patch, updatedAt: new Date().toISOString() };
  writeDb(db);
  return db.orders[idx];
}

// ---------- chats (پشتیبانی) ----------
function getChats() {
  return readDb().chats;
}

function getOrCreateChat(telegramUserId, name, phone) {
  const db = readDb();
  let chat = db.chats.find(c => c.telegramUserId === telegramUserId);
  if (!chat) {
    chat = { telegramUserId, name, phone, unread: 0, msgs: [] };
    db.chats.push(chat);
    writeDb(db);
  }
  return chat;
}

function addChatMessage(telegramUserId, from, text) {
  const db = readDb();
  let chat = db.chats.find(c => c.telegramUserId === telegramUserId);
  if (!chat) {
    chat = { telegramUserId, name: 'کاربر', phone: '', unread: 0, msgs: [] };
    db.chats.push(chat);
  }
  chat.msgs.push({ from, text, t: new Date().toISOString() });
  if (from === 'user') chat.unread = (chat.unread || 0) + 1;
  writeDb(db);
  return chat;
}

function deleteOrder(id) {
  const db = readDb();
  const before = db.orders.length;
  db.orders = db.orders.filter(o => o.id !== id);
  writeDb(db);
  return before !== db.orders.length; // true یعنی واقعاً چیزی حذف شد
}

module.exports = {
  createOrder, getOrders, getOrdersByUser, getOrder, updateOrder, deleteOrder,
  getChats, getOrCreateChat, addChatMessage
};
