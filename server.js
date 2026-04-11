require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PRINTIFY_API = 'https://api.printify.com/v1';
const PRINTIFY_TOKEN = process.env.PRINTIFY_API_TOKEN;
const SHOP_ID = process.env.PRINTIFY_SHOP_ID;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'sznsticker@gmail.com';

// Stripe webhook needs raw body — must come before express.json()
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (err) {
    console.error('Webhook parse error:', err.message);
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

app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ========== ORDER STORAGE ==========
const ORDERS_FILE = path.join(__dirname, 'orders.json');

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

// ========== CHECKOUT ==========
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { items, subtotal } = req.body;
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items in cart' });
    }

    // Build Stripe line items
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${item.product} (${item.size})`,
          description: `Style: ${item.style} · Pet: ${item.petName || 'Not specified'}${item.sendLater ? ' · Photo: will send later' : ''}`,
        },
        unit_amount: Math.round(item.price * 100),
      },
      quantity: 1,
    }));

    // Build order summary for metadata (Stripe metadata max 500 chars per value)
    const orderSummary = items.map(i =>
      `${i.product} | ${i.size} | ${i.style} | Pet: ${i.petName}`
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
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Legacy endpoint (keep for compatibility)
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, customerEmail, artStyle } = req.body;
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name || 'PawCanvas Product',
          description: `Art Style: ${artStyle || 'Watercolor'}`,
        },
        unit_amount: item.price || 3999,
      },
      quantity: item.quantity || 1,
    }));

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/#products`,
      customer_email: customerEmail || undefined,
      metadata: { art_style: artStyle || 'Watercolor' },
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU'] },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get order details (for success page)
app.get('/api/session/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      customerEmail: session.customer_details?.email,
      amountTotal: session.amount_total,
      metadata: session.metadata,
      paymentStatus: session.payment_status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ADMIN ENDPOINTS ==========

// View all orders
app.get('/api/admin/orders', (req, res) => {
  const orders = loadOrders();
  res.json(orders.reverse()); // newest first
});

// Printify catalog
app.get('/api/admin/catalog', async (req, res) => {
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

app.get('/api/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// SPA fallback
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🐾 PawCanvas server running on port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
});
