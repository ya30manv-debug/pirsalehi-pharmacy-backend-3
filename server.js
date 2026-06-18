// server.js — قلب پروژه.
// این فایل یک سرور وب کوچک است که سه گروه کار را انجام می‌دهد:
//  1) مسیرهای API برای مینی‌اپ کاربر (ثبت سفارش، دیدن وضعیت، چت)
//  2) مسیرهای API برای پنل داروساز (دیدن صف، وارد کردن اقلام، قیمت‌گذاری)
//  3) (در فاز بعد) ارتباط با بات تلگرام
//
// هیچ‌جای این فایل دیتابیس را مستقیم دست نمی‌زند؛ همه‌چیز از طریق db.js
// انجام می‌شود تا اگر بعداً دیتابیس را عوض کردیم، این فایل دست‌نخورده بماند.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const { startBot, sendTelegramMessage } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());              // اجازه می‌دهد مینی‌اپ و پنل از آدرس دیگری به این سرور وصل شوند
app.use(express.json());      // بدنهٔ درخواست‌ها را به‌صورت JSON می‌خواند

// ---------------------------------------------------------------
// یک مسیر سادهٔ تست — وقتی آدرس سرور را در مرورگر باز می‌کنی این را می‌بینی
// ---------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'سرور داروخانهٔ دکتر پیرصالحی روشن است ✅' });
});

// مسیر تشخیصی موقت — برای پیدا کردن علت دقیق خطای 500
// (بعداً که مشکل حل شد، این مسیر را حذف می‌کنیم)
app.get('/api/debug', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const info = { cwd: process.cwd(), dirname: __dirname };
  try{
    info.dataDirExists = fs.existsSync(path.join(__dirname,'data'));
    info.dbFileExists = fs.existsSync(path.join(__dirname,'data','db.json'));
    info.writableTest = (()=>{ try{ fs.writeFileSync(path.join(__dirname,'data','__test.tmp'),'x'); fs.unlinkSync(path.join(__dirname,'data','__test.tmp')); return true; }catch(e){ return 'FAILED: '+e.message; } })();
    const orders = db.getOrders();
    info.ordersOk = true;
    info.ordersCount = orders.length;
  }catch(e){
    info.error = e.message;
    info.stack = e.stack;
  }
  res.json(info);
});

// =================================================================
// بخش ۱ — مسیرهایی که مینی‌اپ کاربر صدا می‌زند
// =================================================================

// ثبت سفارش جدید (وقتی کاربر در مینی‌اپ نسخه را می‌فرستد)
app.post('/api/orders', (req, res) => {
  const { name, forWhom, nid, phone, type, track, baseIns, suppIns, note, telegramUserId } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ ok: false, error: 'نام و شماره تماس الزامی است' });
  }
  const order = db.createOrder({
    name, forWhom, nid, phone, type, track, baseIns, suppIns, note, telegramUserId
  });
  res.json({ ok: true, order });
});

// گرفتن وضعیت یک سفارش خاص (مینی‌اپ هر چند ثانیه این را می‌پرسد تا بفهمد
// داروساز چه کاری کرده — همان «polling» که قبلاً صحبتش را کردیم)
app.get('/api/orders/:id', (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// کاربر اقلام را تأیید می‌کند (بعد از کم/حذف‌کردن دارو) →
// این یعنی برویم سراغ مرحلهٔ قیمت‌گذاری
app.post('/api/orders/:id/confirm-items', (req, res) => {
  const { items } = req.body; // اقلامی که کاربر نهایی کرده (بعد از حذف/کم‌کردن)
  const order = db.updateOrder(req.params.id, {
    items: items || db.getOrder(req.params.id)?.items,
    status: 'items_confirmed'
  });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// کاربر روش تحویل را انتخاب می‌کند (حضوری یا ارسال)
app.post('/api/orders/:id/delivery', (req, res) => {
  const { deliver, addr } = req.body;
  const order = db.updateOrder(req.params.id, { deliver, addr });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// =================================================================
// بخش ۲ — مسیرهایی که پنل داروساز صدا می‌زند
// =================================================================

// گرفتن کل صف سفارش‌ها (پنل این را موقع باز شدن، و هر چند ثانیه، صدا می‌زند)
app.get('/api/pharmacist/orders', (req, res) => {
  res.json({ ok: true, orders: db.getOrders() });
});

// گرفتن جزئیات یک سفارش خاص از دید داروساز
app.get('/api/pharmacist/orders/:id', (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// داروساز اقلام را وارد می‌کند (دستی یا از اکسل) و ذخیره می‌کند
app.put('/api/pharmacist/orders/:id/items', (req, res) => {
  const { items } = req.body;
  const order = db.updateOrder(req.params.id, { items, status: 'review' });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// ذخیرهٔ سریع تغییرات روی اقلام/حق‌فنی، بدون تغییر وضعیت سفارش
// (پنل هر بار که کاربر تعداد/قیمت/یخچالی/موجود بودن را عوض می‌کند، این را صدا می‌زند)
app.patch('/api/pharmacist/orders/:id', (req, res) => {
  const { items, fee } = req.body;
  const patch = {};
  if (items !== undefined) patch.items = items;
  if (fee !== undefined) patch.fee = fee;
  const order = db.updateOrder(req.params.id, patch);
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// داروساز فایل اکسل کارا را آپلود می‌کند — این مسیر آن را می‌خواند،
// ریال را به تومان تبدیل می‌کند، و اقلام را برمی‌گرداند
app.post('/api/pharmacist/parse-excel', upload.single('file'), (req, res) => {
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    const items = parseKaraRows(rows);
    res.json({ ok: true, items });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'خواندن فایل اکسل ناموفق بود' });
  }
});

// داروساز لیست اقلام (بدون قیمت) را برای کاربر می‌فرستد
app.post('/api/pharmacist/orders/:id/send-items', (req, res) => {
  const order = db.updateOrder(req.params.id, { status: 'items_sent' });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  sendTelegramMessage(order.telegramUserId, '✅ داروساز اقلام نسخهٔ شما را وارد کرد. لطفاً برای بررسی و تأیید وارد اپ شوید.');
  res.json({ ok: true, order });
});

// دکمهٔ موقت «شبیه‌سازی تأیید کاربر» در پنل از همین مسیر استفاده می‌کند
// (تا وقتی مینی‌اپ واقعی وصل شود و خودش confirm-items را صدا بزند)
app.post('/api/pharmacist/orders/:id/simulate-confirm', (req, res) => {
  const order = db.updateOrder(req.params.id, { status: 'items_confirmed' });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// داروساز قیمت نهایی (بعد از تأیید کاربر) را تنظیم و ارسال می‌کند
app.post('/api/pharmacist/orders/:id/approve', (req, res) => {
  const { fee } = req.body;
  const current = db.getOrder(req.params.id);
  if (!current) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  const goods = current.items.filter(i => i.avail !== false).reduce((s, i) => s + i.price * i.qty, 0);
  const total = goods + (fee != null ? fee : current.fee);
  const order = db.updateOrder(req.params.id, { fee: fee != null ? fee : current.fee, total, status: 'done' });
  sendTelegramMessage(order.telegramUserId, '💰 قیمت نهایی سفارش شما آماده شد. برای پرداخت وارد اپ شوید.');
  res.json({ ok: true, order });
});

// داروساز نسخه را رد می‌کند
app.post('/api/pharmacist/orders/:id/reject', (req, res) => {
  const { reason } = req.body;
  const order = db.updateOrder(req.params.id, { status: 'rejected', rejectReason: reason });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  sendTelegramMessage(order.telegramUserId, '⚠️ نسخهٔ شما توسط داروخانه رد شد: ' + (reason || 'لطفاً جزئیات را در اپ ببینید.'));
  res.json({ ok: true, order });
});

// =================================================================
// بخش ۳ — چت پشتیبانی (مشترک بین مینی‌اپ و پنل)
// =================================================================

app.get('/api/chats', (req, res) => {
  res.json({ ok: true, chats: db.getChats() });
});

app.get('/api/chats/:telegramUserId', (req, res) => {
  const chats = db.getChats();
  const chat = chats.find(c => c.telegramUserId === req.params.telegramUserId);
  if (!chat) return res.status(404).json({ ok: false, error: 'مکالمه پیدا نشد' });
  res.json({ ok: true, chat });
});

app.post('/api/chats/:telegramUserId/messages', (req, res) => {
  const { from, text } = req.body; // from: 'user' یا 'pharmacist'
  const chat = db.addChatMessage(req.params.telegramUserId, from, text);
  res.json({ ok: true, chat });
});

// =================================================================
// تابع کمکی: خواندن ردیف‌های اکسل کارا و تبدیل ریال → تومان
// (همان منطقی که قبلاً در پنل نوشته بودیم، اینجا هم تکرار شده تا
//  سرور هم بتواند مستقل همین کار را بکند)
// =================================================================
function findCol(headers, ...keys) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').replace(/\s+/g, '');
    if (keys.some(k => h.includes(k))) return i;
  }
  return -1;
}

function parseKaraRows(rows) {
  if (!rows.length) return [];
  let headerRowIndex = rows.findIndex(r => r.some(c => String(c).includes('نام کالا') || String(c).includes('نام')));
  if (headerRowIndex < 0) headerRowIndex = 0;
  const headers = rows[headerRowIndex];
  const col = {
    name: findCol(headers, 'نامکالا', 'ناممحصول', 'نام'),
    qty: findCol(headers, 'تعداد'),
    unit: findCol(headers, 'قیمتفروش', 'قیمتواحد'),
    total: findCol(headers, 'قیمتکل'),
    irc: findCol(headers, 'کدمعادل', 'IRC'),
    dose: findCol(headers, 'دستورمصرف', 'دستور')
  };
  const out = [];
  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    const name = col.name >= 0 ? String(row[col.name] || '').trim() : '';
    if (!name || /جمع|مجموع|ریال/.test(name)) continue;
    const qty = Math.max(1, parseInt(row[col.qty]) || 1);
    let unit = col.unit >= 0 ? parseFloat(String(row[col.unit]).replace(/[^\d.]/g, '')) : 0;
    if (!unit && col.total >= 0) {
      const tot = parseFloat(String(row[col.total]).replace(/[^\d.]/g, '')) || 0;
      unit = tot / qty;
    }
    unit = Math.round((unit || 0) / 10); // ریال → تومان
    out.push({
      name, qty, price: unit, cold: false, avail: true,
      irc: col.irc >= 0 ? String(row[col.irc] || '').trim() : '',
      dose: col.dose >= 0 ? String(row[col.dose] || '').trim() : ''
    });
  }
  return out;
}

app.listen(PORT, () => {
  console.log(`✅ سرور روی پورت ${PORT} روشن شد`);
  startBot(); // بات تلگرام را هم همین‌جا روشن می‌کنیم (اگر BOT_TOKEN تنظیم شده باشد)
});
