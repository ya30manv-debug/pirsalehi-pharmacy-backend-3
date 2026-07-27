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
const { startBot, sendTelegramMessage, notifyGroup } = require('./bot');

// ── ساخت متن اعلان گروه بر اساس نوع سفارش ─────────────────────
const faDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
function toFa(n){ return String(n).replace(/\d/g, d=>faDigits[+d]); }
function money(n){ return toFa((+n||0).toLocaleString('en-US')) + ' تومان'; }
function typeLabel(t){
  t = (t||'').toLowerCase();
  if (t==='erx') return 'نسخهٔ الکترونیک';
  if (t==='paper') return 'نسخهٔ کاغذی';
  if (t==='otc') return 'OTC بدون نسخه';
  if (t==='goods') return 'آرایشی بهداشتی';
  return t || 'نامشخص';
}
function deliverLabel(d, o){
  o = o || {};
  if (d==='pickup') return 'تحویل حضوری در داروخانه';
  if (d==='post') return o.postType==='cod' ? 'ارسال با پست — پس‌کرایه (تیپاکس)' : 'ارسال با پست';
  if (d==='courier'||d==='send') return o.speed==='express' ? 'ارسال با پیک فوری' : 'ارسال با پیک (پایان روز)';
  return null;
}
function payLabel(p){
  if (p==='online') return 'پرداخت آنلاین (درگاه بانکی)';
  if (p==='wallet') return 'کیف پول';
  if (p==='pos')    return 'پرداخت درب منزل با کارتخوان پیک';
  if (p==='cash')   return 'پرداخت حضوری در داروخانه';
  return null;
}
function buildGroupMessage(o){
  const t = (o.type||'').toLowerCase();
  const L = [];
  L.push('🔔 <b>سفارش جدید</b>');
  L.push('');
  L.push(`🆔 کد سفارش: <b>${o.id}</b>`);
  L.push(`📋 نوع: <b>${typeLabel(t)}</b>`);
  L.push('');
  // اسم واقعی بیمار همیشه name است؛ forWhom فقط یک برچسب نسبت است (خودم/مادر/پدر…)
  const patient = o.name || '—';
  const rel = (o.forWhom && o.forWhom !== 'خودم') ? o.forWhom : '';
  L.push(`👤 نام بیمار: <b>${patient}</b>${rel ? ` (${rel})` : ''}`);
  if (o.phone) L.push(`📞 موبایل: ${o.phone}`);

  if (t==='erx' || t==='paper') {
    if (o.nid) L.push(`🆔 کد ملی: ${o.nid}`);
    if (o.baseIns) L.push(`🏥 بیمهٔ پایه: ${o.baseIns}`);
    if (o.suppIns) L.push(`🏥 بیمهٔ تکمیلی: ${o.suppIns}`);
    if (t==='erx' && o.track) L.push(`🔖 کد رهگیری نسخه: <b>${o.track}</b>`);
    if (o.note) L.push(`📝 توضیح کاربر: ${o.note}`);
    if (t==='paper') L.push(`\n📎 تصویر نسخه پیوست است.`);
  } else if (t==='otc') {
    if (o.items && o.items.length){
      L.push('');
      L.push('💊 <b>اقلام درخواستی:</b>');
      o.items.forEach(it=> L.push(`   • ${it.name} × ${toFa(it.qty||1)}`));
    }
    if (o.note) L.push(`📝 توضیح کاربر: ${o.note}`);
  } else if (t==='goods') {
    if (o.items && o.items.length){
      L.push('');
      L.push('🛍 <b>محصولات:</b>');
      o.items.forEach(it=> L.push(`   • ${it.name} × ${toFa(it.qty||1)} — ${money((+it.unit||0)*(+it.qty||1))}`));
    }
    const dl = deliverLabel(o.deliver, o);
    if (dl){ L.push(''); L.push(`🚚 روش تحویل: <b>${dl}</b>`); }
    const pl = payLabel(o.payMethod);
    if (pl) L.push(`💳 شیوهٔ پرداخت: <b>${pl}</b>`);
    if (o.addr && Array.isArray(o.addr)) L.push(`📍 آدرس: ${o.addr[2]||''}`);
    if (o.total) L.push(`💰 مبلغ پرداخت‌شده: <b>${money(o.total)}</b>`);
    if (o.note) L.push(`📝 توضیح مشتری: ${o.note}`);
  }
  return L.join('\n');
}
const { startBaleBot } = require('./bale-bot');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());              // اجازه می‌دهد مینی‌اپ و پنل از آدرس دیگری به این سرور وصل شوند
app.use(express.json({ limit: '20mb' }));  // حداکثر ۲۰MB برای پشتیبانی از تصویر base64

// مینی‌اپ برای بله — سرو شدن مستقیم از همین سرور (به‌جای GitHub Pages که در بله کند بارگذاری می‌شود)
// فایل index.html باید در پوشهٔ public/bale-app/ کنار این فایل قرار بگیرد
app.use('/bale-app', require('express').static(require('path').join(__dirname, 'public', 'bale-app')));

// ── امنیت پنل‌ها ──────────────────────────────────────────────
// رمز پنل داروساز و پنل کالا. مقدار واقعی را در .env بگذارید: PANEL_KEY=رمز-دلخواه
const PANEL_KEY = process.env.PANEL_KEY || 'pirsalehi1404';
function checkPanelKey(req, res, next) {
  if ((req.headers['x-panel-key'] || '') !== PANEL_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}
// همهٔ مسیرهای داروساز فقط با رمز
app.use('/api/pharmacist', checkPanelKey);

// ── ذخیرهٔ عکس نسخه روی دیسک (نه داخل db.json) ────────────────
const fsMod = require('fs');
const pathMod = require('path');
const RX_DIR = pathMod.join(__dirname, 'uploads', 'rx');
try { fsMod.mkdirSync(RX_DIR, { recursive: true }); } catch (e) {}
app.use('/uploads', require('express').static(pathMod.join(__dirname, 'uploads')));

// ---------------------------------------------------------------
// یک مسیر سادهٔ تست — وقتی آدرس سرور را در مرورگر باز می‌کنی این را می‌بینی
// ---------------------------------------------------------------
// ── سرچ زندهٔ محصولات آرایشی‌بهداشتی از سایت داروخانه ──────────
// مینی‌اپ به‌جای لیست ثابت داخل فایل، از این مسیر می‌پرسد تا محصولات و
// قیمت‌ها همیشه همان چیزی باشند که روی سایت است.
const GOODS_API = 'https://www.pirsalehipharmacy.com/api/products';
const goodsCache = new Map();           // q → { at, items }
const GOODS_TTL = 30 * 60 * 1000;       // ۳۰ دقیقه

function normalizeProduct(p) {
  return {
    id: String(p.id ?? p.product_id ?? ''),
    title: p.title || p.name || '',
    price: Number(p.current_price ?? p.price ?? 0),
    img: p.image_link || p.img || p.image || '',
    url: p.page_url || p.url || '',
    avail: (p.availability || p.avail || 'instock'),
    summary: p.summary || ''
  };
}

app.get('/api/goods/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ ok: true, items: [] });

  const hit = goodsCache.get(q);
  if (hit && (Date.now() - hit.at) < GOODS_TTL) {
    return res.json({ ok: true, items: hit.items, cached: true });
  }
  try {
    const r = await fetch(`${GOODS_API}?q=${encodeURIComponent(q)}&page=1`, {
      headers: { 'User-Agent': 'PirsalehiPharmacyApp/1.0' }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const raw = data.products || data.items || data.result || (Array.isArray(data) ? data : []);
    const items = raw.map(normalizeProduct).filter(p => p.id && p.title);
    goodsCache.set(q, { at: Date.now(), items });
    res.json({ ok: true, items });
  } catch (e) {
    console.error('سرچ محصولات از سایت ناموفق بود:', e.message);
    // اگر نسخهٔ کش‌شدهٔ قدیمی داریم، همان را بده تا کاربر دست خالی نماند
    if (hit) return res.json({ ok: true, items: hit.items, stale: true });
    res.status(502).json({ ok: false, error: 'دسترسی به فهرست محصولات ممکن نشد' });
  }
});

app.get('/', (req, res) => {
  res.json({ ok: true, message: 'سرور داروخانهٔ دکتر پیرصالحی روشن است ✅' });
});

// مسیر تشخیصی موقت — برای پیدا کردن علت دقیق خطای 500
// (بعداً که مشکل حل شد، این مسیر را حذف می‌کنیم)
app.get('/api/debug', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const info = { cwd: process.cwd(), dirname: __dirname, versionMarker: 'v3-2026-06-19' };
  try{
    info.dataDirExists = fs.existsSync(path.join(__dirname,'data'));
    info.dbFileExists = fs.existsSync(path.join(__dirname,'data','db.json'));
    info.writableTest = (()=>{ try{ fs.writeFileSync(path.join(__dirname,'data','__test.tmp'),'x'); fs.unlinkSync(path.join(__dirname,'data','__test.tmp')); return true; }catch(e){ return 'FAILED: '+e.message; } })();
    const orders = db.getOrders();
    info.ordersOk = true;
    info.ordersCount = orders.length;
    // دقیقاً همان کاری که مسیر /api/pharmacist/orders می‌کند را اینجا هم امتحان می‌کنیم
    info.exactRouteTest = (()=>{ try{ JSON.stringify({ ok: true, orders: db.getOrders() }); return 'OK'; }catch(e){ return 'FAILED: '+e.message+' | '+e.stack; } })();
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
  const { name, forWhom, nid, phone, type, track, baseIns, suppIns, note, telegramUserId,
          items, fee, status, total, deliver, addr, payMethod, postType, speed } = req.body;
  if (!name) {
    return res.status(400).json({ ok: false, error: 'نام الزامی است' });
  }
  const order = db.createOrder({
    name, forWhom, nid, phone, type, track, baseIns, suppIns, note, telegramUserId,
    ...(payMethod !== undefined ? { payMethod } : {}),
    ...(postType !== undefined ? { postType } : {}),
    ...(speed !== undefined ? { speed } : {}),
    // این چندتا اختیاری‌اند: نسخه‌دار خالی می‌فرستد (چون هنوز اقلام معلوم نیست)،
    // ولی OTC/کالا همه را همان لحظه کامل می‌فرستد چون از قبل قیمت معلوم است
    ...(items !== undefined ? { items } : {}),
    ...(fee !== undefined ? { fee } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(deliver !== undefined ? { deliver } : {}),
    ...(addr !== undefined ? { addr } : {})
  });
  res.json({ ok: true, order });

  // اعلان به گروه داروخانه — کاغذی را اینجا نمی‌فرستیم چون عکس نسخه
  // در درخواست بعدی (/image) می‌رسد؛ آنجا با عکس فرستاده می‌شود.
  console.log('🔎 بررسی اعلان گروه برای سفارش', order.id, '— نوع:', order.type);
  try {
    if (!['paper','paperrx'].includes((order.type||'').toLowerCase())) {
      console.log('🔎 در حال ساخت و ارسال پیام گروه برای', order.id);
      notifyGroup(buildGroupMessage(order));
    } else {
      console.log('🔎 نوع کاغذی است — منتظر آپلود عکس می‌مانیم');
      // ایمنی: اگر تا ۲ دقیقه عکس نیامد (مثلاً آپلود شکست خورد)، پیام بدون عکس برود که سفارش گم نشود
      const orderId = order.id;
      setTimeout(() => {
        try {
          const o = db.getOrder(orderId);
          if (o && !o.rxImage && !o._groupNotified) {
            console.log('⏰ عکس نسخه نرسید — اعلان کاغذی بدون عکس ارسال می‌شود:', orderId);
            db.updateOrder(orderId, { _groupNotified: true });
            notifyGroup(buildGroupMessage(o) + '\n\n⚠️ تصویر نسخه هنوز بارگذاری نشده است.');
          }
        } catch(e){ console.error('خطای fallback کاغذی:', e.message); }
      }, 2 * 60 * 1000);
    }
  } catch (e) { console.error('❌ خطا در اعلان گروه:', e.message); }
});
app.get('/api/orders/by-user/:telegramUserId', (req, res) => {
  const orders = db.getOrdersByUser(req.params.telegramUserId);
  res.json({ ok: true, orders });
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
// کاربر تصویر نسخهٔ کاغذی را آپلود می‌کند (به‌صورت base64)
// داروساز این تصویر را در پنل می‌بیند تا نسخه را بررسی کند
app.post('/api/orders/:id/image', (req, res) => {
  const { imageData, imageName } = req.body;
  if (!imageData) return res.status(400).json({ ok: false, error: 'تصویر ارسال نشده' });
  // عکس روی دیسک ذخیره می‌شود؛ در db فقط مسیر فایل می‌ماند تا db.json سنگین نشود
  let rxImagePath = imageData; // fallback: اگر ذخیره روی دیسک شکست خورد، مثل قبل base64
  try {
    const m = imageData.match(/^data:image\/(\w+);base64,(.+)$/s);
    const ext = m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'jpg';
    const buf = Buffer.from(m ? m[2] : imageData, 'base64');
    const fname = req.params.id + '.' + ext;
    fsMod.writeFileSync(pathMod.join(RX_DIR, fname), buf);
    rxImagePath = '/uploads/rx/' + fname;
  } catch (e) { console.error('ذخیرهٔ عکس روی دیسک شکست خورد، base64 ذخیره می‌شود:', e.message); }
  const order = db.updateOrder(req.params.id, { rxImage: rxImagePath, rxImageName: imageName || 'نسخه.jpg' });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });

  // حالا که عکس نسخه رسید، اعلان کاغذی را همراه عکس به گروه می‌فرستیم
  try {
    if (['paper','paperrx'].includes((order.type||'').toLowerCase()) && !order._groupNotified) {
      db.updateOrder(order.id, { _groupNotified: true });
      console.log('🔎 عکس نسخه رسید — اعلان کاغذی با عکس ارسال می‌شود:', order.id);
      notifyGroup(buildGroupMessage(order), imageData);
    }
  } catch (e) { console.error('خطا در اعلان گروه (کاغذی):', e.message); }
});

app.post('/api/orders/:id/delivery', (req, res) => {
  const { deliver, addr } = req.body;
  const order = db.updateOrder(req.params.id, { deliver, addr, deliveryStage: 0 });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// =================================================================
// بخش ۲ — مسیرهایی که پنل داروساز صدا می‌زند
// =================================================================

// گرفتن کل صف سفارش‌ها (پنل این را موقع باز شدن، و هر چند ثانیه، صدا می‌زند)
app.get('/api/pharmacist/orders', (req, res) => {
  try{
    const orders = db.getOrders();
    res.json({ ok: true, orders });
  }catch(e){
    res.status(500).json({ ok:false, error: e.message, stack: e.stack });
  }
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
  const { items, fee, status, total, postTrack } = req.body;
  const patch = {};
  if (items !== undefined) patch.items = items;
  if (fee !== undefined) patch.fee = fee;
  if (status !== undefined) patch.status = status;
  if (total !== undefined) patch.total = total;
  if (postTrack !== undefined) patch.postTrack = postTrack;
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
  sendTelegramMessage(order.telegramUserId, `✅ سفارش «${order.name||''}» (${order.id}): داروساز اقلام نسخه را وارد کرد. لطفاً برای بررسی و تأیید وارد اپ شوید.`);
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
  const order = db.updateOrder(req.params.id, { fee: fee != null ? fee : current.fee, total, status: 'awaiting_payment' });
  sendTelegramMessage(order.telegramUserId, `💰 سفارش «${order.name||''}» (${order.id}): قیمت نهایی آماده شد — ${(order.total||0).toLocaleString('en-US')} تومان. برای پرداخت وارد اپ شوید.`);
  res.json({ ok: true, order });
});

// کاربر پرداخت را کامل کرد (یا از درگاه آنلاین، یا چون مراجعهٔ حضوری انتخاب کرده)
// از این لحظه نوبت داروساز است که آماده‌سازی را شروع کند
app.post('/api/orders/:id/mark-paid', (req, res) => {
  const { payMethod } = req.body;
  // حضوری (cod): پرداخت موقع تحویل انجام می‌شود — status را paid نمی‌گذاریم
  // آنلاین/کیف‌پول: پرداخت همین الان انجام شده — status: paid
  const newStatus = payMethod === 'cod' ? 'awaiting_payment' : 'paid';
  const order = db.updateOrder(req.params.id, { status: newStatus, payMethod });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  res.json({ ok: true, order });
});

// داروساز نسخه را رد می‌کند
app.post('/api/pharmacist/orders/:id/reject', (req, res) => {
  const { reason } = req.body;
  const order = db.updateOrder(req.params.id, { status: 'rejected', rejectReason: reason });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  sendTelegramMessage(order.telegramUserId, `⚠️ سفارش «${order.name||''}» (${order.id}) توسط داروخانه رد شد.` + (reason ? ` علت: ${reason}` : ''));
  res.json({ ok: true, order });
});

// حذف کامل یک سفارش — فقط برای کارهای مدیریتی (مثلاً پاک‌کردن سفارش آزمایشی/تستی)
app.delete('/api/pharmacist/orders/:id', (req, res) => {
  const removed = db.deleteOrder(req.params.id);
  res.json({ ok: true, removed });
});

// عملیات دسته‌ای روی همهٔ سفارش‌های یک وضعیت خاص:
//  - action='reject'  → همه را به rejected می‌برد (در مینی‌اپ کاربر «رد شده» می‌شود)
//  - action='delete'  → همه را از دیتابیس پاک می‌کند (فقط برای تب تحویل‌شده)
app.post('/api/pharmacist/orders/bulk', (req, res) => {
  const { statuses, action, reason } = req.body;
  if (!Array.isArray(statuses) || !statuses.length) {
    return res.status(400).json({ ok: false, error: 'وضعیت‌ها مشخص نشده' });
  }
  const all = db.getOrders();
  const targets = all.filter(o => statuses.includes(o.status));
  let count = 0;
  for (const o of targets) {
    if (action === 'delete') {
      db.deleteOrder(o.id);
      count++;
    } else { // reject
      db.updateOrder(o.id, { status: 'rejected', rejectReason: reason || 'سفارش توسط داروخانه رد شد.' });
      try { sendTelegramMessage(o.telegramUserId, `⚠️ سفارش «${o.name||''}» (${o.id}) توسط داروخانه رد شد.`); } catch(e){}
      count++;
    }
  }
  res.json({ ok: true, count });
});

// داروساز مرحلهٔ تحویل را پیش می‌برد: ۰=ثبت شد، ۱=آماده‌سازی شد، ۲=تحویل پیک شد، ۳=در مسیر، ۴=تحویل شد
// (برای تحویل حضوری فقط ۰ و ۱ و ۲ معنا دارد: ثبت شد → آماده‌سازی شد → آمادهٔ تحویل حضوری)
// داروساز مرحلهٔ آماده‌سازی/تحویل را پیش می‌برد:
// paid → preparing (شروع آماده‌سازی) → ready (آماده شد) → delivered (تحویل داده شد)
app.post('/api/pharmacist/orders/:id/advance-status', (req, res) => {
  const { status } = req.body;
  const order = db.updateOrder(req.params.id, { status });
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  const who = `«${order.name||''}» (${order.id})`;
  const STATUS_MSG = {
    preparing: `🧪 سفارش ${who}: داروساز در حال آماده‌سازی است.`,
    ready: order.deliver==='pickup' ? `✅ سفارش ${who} آماده است — می‌توانید برای دریافت مراجعه کنید.` : `📦 سفارش ${who} آماده شد و به پیک تحویل داده می‌شود.`,
    delivered: `✅ سفارش ${who} تحویل داده شد.`
  };
  if (STATUS_MSG[status]) sendTelegramMessage(order.telegramUserId, STATUS_MSG[status]);
  res.json({ ok: true, order });
});

// داروساز مرحلهٔ تحویل (فقط برای ارسال با پیک، بعد از ready) را پیش می‌برد: ۱=تحویل پیک شد، ۲=در مسیر، ۳=تحویل شد
app.post('/api/pharmacist/orders/:id/delivery-stage', (req, res) => {
  const { stage } = req.body;
  const patch = { deliveryStage: stage };
  if (stage >= 3) patch.status = 'delivered'; // مرحلهٔ نهایی پیک یعنی سفارش کاملاً تحویل داده شده
  const order = db.updateOrder(req.params.id, patch);
  if (!order) return res.status(404).json({ ok: false, error: 'سفارش پیدا نشد' });
  const who2 = `«${order.name||''}» (${order.id})`;
  const STAGE_MSG = {
    1: `📦 سفارش ${who2} تحویل پیک شد.`,
    2: `🛵 پیک سفارش ${who2} به‌سمت آدرس شما حرکت کرد.`,
    3: `✅ سفارش ${who2} تحویل داده شد.`
  };
  if (STAGE_MSG[stage]) sendTelegramMessage(order.telegramUserId, STAGE_MSG[stage]);
  res.json({ ok: true, order });
});

// =================================================================
// بخش ۳ — چت پشتیبانی (مشترک بین مینی‌اپ و پنل)
// =================================================================

app.get('/api/chats', checkPanelKey, (req, res) => {
  res.json({ ok: true, chats: db.getChats() });
});

app.get('/api/chats/:telegramUserId', (req, res) => {
  const chats = db.getChats();
  const chat = chats.find(c => c.telegramUserId === req.params.telegramUserId);
  if (!chat) return res.status(404).json({ ok: false, error: 'مکالمه پیدا نشد' });
  res.json({ ok: true, chat });
});

app.post('/api/chats/:telegramUserId/messages', (req, res) => {
  const { from, text, name, phone, relatedOrder } = req.body; // from: 'user' یا 'pharmacist'
  if (from === 'pharmacist' && (req.headers['x-panel-key'] || '') !== PANEL_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const meta = (name || phone || relatedOrder) ? { name, phone, relatedOrder } : null;
  const chat = db.addChatMessage(req.params.telegramUserId, from, text, meta);
  res.json({ ok: true, chat });
});

// داروساز چت را باز کرد → خوانده‌نشده صفر شود
app.post('/api/chats/:telegramUserId/mark-read', checkPanelKey, (req, res) => {
  const chat = db.markChatRead(req.params.telegramUserId);
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
  startBaleBot(); // بات بله (اگر BALE_BOT_TOKEN تنظیم شده باشد)
});
