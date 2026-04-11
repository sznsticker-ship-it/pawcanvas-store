require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PRINTIFY_API = 'https://api.printify.com/v1';
const PRINTIFY_TOKEN = process.env.PRINTIFY_API_TOKEN;
const SHOP_ID = process.env.PRINTIFY_SHOP_ID;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'sznsticker@gmail.com';
const ADMIN_SECRET = process.env.ADMIN_SECRET || crypto.randomBytes(32).toString('hex');
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET; // Set this in Render env vars

// ========== SECURITY: Rate Limiting ==========
const rateLimits = new Map();
function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  if (!rateLimits.has(key)) rateLimits.set(key, []);
  const timestamps = rateLimits.get(key).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) return false;
  timestamps.push(now);
  rateLimits.set(key, timestamps);
  return true;
}
// Clean up rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimits) {
    const fresh = timestamps.filter(t => now - t < 600000);
    if (fresh.length === 0) rateLimits.delete(key);
    else rateLimits.set(key, fresh);
  }
}, 300000);

// ========== SECURITY: Request size limits ==========
// Stripe webhook needs raw body — must come before express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    // Verify webhook signature if secret is configured
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      // Fallback for development (no signature verification)
      event = JSON.parse(req.body);
      console.warn('⚠️  Webhook signature verification disabled — set STRIPE_WEBHOOK_SECRET in production');
    }
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const orderMeta = session.metadata;
    console.log('═══════════════════════════════════');
    console.log('✅ NEW ORDER RECEIVED');
    console.log('═══════════════════════════════════');
    console.log('Customer:', email);
    console.log('Amount:', '$' + (session.amount_total / 100).toFixed(2));
    console.log('Order details:', orderMeta?.order_summary);
    console.log('═══════════════════════════════════');

    // Save order to file for admin dashboard
    const order = {
      id: session.id,
      date: new Date().toISOString(),
      email,
      amount: session.amount_total,
      shipping: session.shipping_details || null,
      items: JSON.parse(orderMeta?.items_json || '[]'),
      status: 'pending_artwork'
    };
    saveOrder(order);
  }

  res.json({ received: true });
});

// Body parsing with strict size limits
app.use(express.json({ limit: '2mb' })); // Reduced from 50mb — no reason for huge payloads
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// ========== SECURITY: CORS — restrict in production ==========
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5000', 'http://127.0.0.1:5000', 'https://pawcanvas-store.onrender.com'];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin, server-to-server, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'DELETE'],
  credentials: false
}));

// ========== SECURITY: Security Headers ==========
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP — allow inline styles/scripts (needed for our SPA), images from our domain + data URIs
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://js.stripe.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://api.stripe.com; frame-src https://js.stripe.com;"
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', // Cache static assets for 1 day
  etag: true
}));

// ========== ORDER STORAGE ==========
const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');
const REVIEWS_FILE = path.join(__dirname, 'data', 'reviews.json');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch(e) { console.error('Error loading orders:', e.message); }
  return [];
}

function saveOrder(order) {
  const orders = loadOrders();
  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  console.log(`📋 Order saved (${orders.length} total)`);
}

// ========== REVIEWS STORAGE ==========
function loadReviews() {
  try {
    if (fs.existsSync(REVIEWS_FILE)) return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  } catch(e) { console.error('Error loading reviews:', e.message); }
  return [];
}

function saveReviews(reviews) {
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
}

// ========== REVIEW ENDPOINTS ==========

// Get approved reviews (public)
app.get('/api/reviews', (req, res) => {
  const reviews = loadReviews().filter(r => r.approved);
  res.json(reviews);
});

// Submit a review (public, rate-limited)
app.post('/api/reviews', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(`review:${ip}`, 3, 3600000)) { // Max 3 reviews per hour per IP
    return res.status(429).json({ error: 'Too many reviews submitted. Please try again later.' });
  }

  const { rating, name, product, text, photo } = req.body;

  // Input validation
  if (!rating || !name || !text) {
    return res.status(400).json({ error: 'Rating, name, and review text are required.' });
  }
  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  }
  if (typeof name !== 'string' || name.length > 100) {
    return res.status(400).json({ error: 'Name must be under 100 characters.' });
  }
  if (typeof text !== 'string' || text.length > 2000) {
    return res.status(400).json({ error: 'Review must be under 2000 characters.' });
  }
  if (product && (typeof product !== 'string' || product.length > 100)) {
    return res.status(400).json({ error: 'Invalid product name.' });
  }

  // Sanitize photo — only allow data URIs of images, limit size
  let sanitizedPhoto = null;
  if (photo && typeof photo === 'string') {
    if (photo.startsWith('data:image/') && photo.length < 5000000) { // 5MB max
      sanitizedPhoto = photo;
    }
  }

  const review = {
    id: crypto.randomUUID(),
    rating: Math.floor(rating),
    name: name.trim().slice(0, 100),
    product: product ? product.trim().slice(0, 100) : '',
    text: text.trim().slice(0, 2000),
    photo: sanitizedPhoto,
    date: new Date().toISOString(),
    approved: false // Reviews require admin approval
  };

  const reviews = loadReviews();
  reviews.push(review);
  saveReviews(reviews);

  console.log(`📝 New review from ${review.name} (pending approval)`);
  res.json({ success: true, message: 'Review submitted for approval.' });
});

// ========== CHECKOUT ==========
app.post('/api/create-checkout', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(`checkout:${ip}`, 10, 3600000)) { // Max 10 checkout attempts per hour
    return res.status(429).json({ error: 'Too many checkout attempts. Please try again later.' });
  }

  try {
    const { items, subtotal } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items in cart' });
    }
    if (items.length > 20) {
      return res.status(400).json({ error: 'Too many items in cart' });
    }

    // Validate each item
    for (const item of items) {
      if (!item.product || !item.size || !item.style || typeof item.price !== 'number') {
        return res.status(400).json({ error: 'Invalid item data' });
      }
      if (item.price < 0 || item.price > 10000) {
        return res.status(400).json({ error: 'Invalid price' });
      }
    }

    // Build Stripe line items
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${item.product} (${item.size})`,
          description: `Style: ${item.style}${item.petName ? ' · Pet: ' + item.petName : ''}${item.sendLater ? ' · Photo: will send later' : ''}`,
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: 1,
    }));

    // Build order summary (Stripe metadata max 500 chars per value)
    const orderSummary = items.map(i =>
      `${i.product} | ${i.size} | ${i.style} | Pet: ${i.petName || 'N/A'}`
    ).join(' || ');

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/#products`,
      metadata: {
        order_summary: orderSummary.slice(0, 500),
        items_json: JSON.stringify(items).slice(0, 500),
      },
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU'],
      },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error.message);
    res.status(500).json({ error: 'Unable to create checkout session. Please try again.' });
  }
});

// Get order details (for success page — rate limited)
app.get('/api/session/:sessionId', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (!rateLimit(`session:${ip}`, 20, 60000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Validate session ID format (Stripe session IDs start with cs_)
  const { sessionId } = req.params;
  if (!sessionId || !sessionId.startsWith('cs_') || sessionId.length > 200) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.json({
      customerEmail: session.customer_details?.email,
      amountTotal: session.amount_total,
      metadata: session.metadata,
      paymentStatus: session.payment_status,
    });
  } catch (error) {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ========== ADMIN ENDPOINTS (protected) ==========

// Simple admin auth middleware
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized. Provide x-admin-token header.' });
  }
  next();
}

// View all orders (admin only)
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const orders = loadOrders();
  res.json(orders.reverse());
});

// View all reviews including pending (admin only)
app.get('/api/admin/reviews', adminAuth, (req, res) => {
  const reviews = loadReviews();
  res.json(reviews.reverse());
});

// Approve a review (admin only)
app.post('/api/admin/reviews/:id/approve', adminAuth, (req, res) => {
  const reviews = loadReviews();
  const review = reviews.find(r => r.id === req.params.id);
  if (!review) return res.status(404).json({ error: 'Review not found' });
  review.approved = true;
  saveReviews(reviews);
  res.json({ success: true, review });
});

// Delete a review (admin only)
app.delete('/api/admin/reviews/:id', adminAuth, (req, res) => {
  let reviews = loadReviews();
  const before = reviews.length;
  reviews = reviews.filter(r => r.id !== req.params.id);
  if (reviews.length === before) return res.status(404).json({ error: 'Review not found' });
  saveReviews(reviews);
  res.json({ success: true });
});

// Printify catalog (admin only)
app.get('/api/admin/catalog', adminAuth, async (req, res) => {
  try {
    const response = await fetch(`${PRINTIFY_API}/catalog/blueprints.json`, {
      headers: { 'Authorization': `Bearer ${PRINTIFY_TOKEN}` }
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Stripe publishable key (public — but only the publishable key, never the secret)
app.get('/api/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ========== SECURITY: Block direct access to sensitive files ==========
app.use((req, res, next) => {
  const blocked = ['.env', 'orders.json', 'reviews.json', 'package.json', 'server.js', '.git'];
  if (blocked.some(f => req.path.includes(f))) {
    return res.status(404).send('Not found');
  }
  next();
});

// SPA fallback
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Endpoint not found' });
  }
});

// Global error handler — don't leak stack traces in production
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🐾 PawCanvas server running on port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set — webhook verification disabled');
  }
  console.log(`🔐 Admin token: ${ADMIN_SECRET.slice(0, 8)}...`);
});
