require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PRINTIFY_API = 'https://api.printify.com/v1';
const PRINTIFY_TOKEN = process.env.PRINTIFY_API_TOKEN;
const SHOP_ID = process.env.PRINTIFY_SHOP_ID;

// Stripe webhook needs raw body
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = JSON.parse(req.body);
  } catch (err) {
    console.error('Webhook parse error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ Payment successful for:', session.customer_details?.email);
    console.log('📦 Order metadata:', session.metadata);
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Product catalog — 6 product types, each with size variants
const PRODUCTS = [
  {
    id: 'canvas',
    name: 'Pet Portrait Canvas',
    subtitle: 'Gallery-Ready Stretched Canvas',
    description: 'Museum-quality stretched canvas, ready to hang. Your pet transformed into a stunning work of art.',
    category: 'canvas',
    badge: 'Best Seller',
    sizes: [
      { sizeId: 'canvas-8x10',  label: '8" × 10"',  price: 3999, priceDisplay: '$39.99' },
      { sizeId: 'canvas-16x20', label: '16" × 20"', price: 6999, priceDisplay: '$69.99' },
      { sizeId: 'canvas-24x36', label: '24" × 36"', price: 9999, priceDisplay: '$99.99' }
    ]
  },
  {
    id: 'blanket',
    name: 'Pet Portrait Blanket',
    subtitle: 'Velveteen Plush Throw',
    description: 'Ultra-soft velveteen plush blanket with your pet\'s portrait. Perfect for cozy nights on the couch.',
    category: 'blanket',
    badge: 'Popular',
    sizes: [
      { sizeId: 'blanket-50x60', label: '50" × 60"', price: 6499, priceDisplay: '$64.99' },
      { sizeId: 'blanket-60x80', label: '60" × 80"', price: 7999, priceDisplay: '$79.99' }
    ]
  },
  {
    id: 'mug',
    name: 'Pet Portrait Mug',
    subtitle: 'Classic White Ceramic',
    description: 'Start every morning with your best friend. Premium white ceramic with vivid wrap-around print.',
    category: 'mug',
    badge: 'Gift Favorite',
    sizes: [
      { sizeId: 'mug-11oz', label: '11 oz', price: 2799, priceDisplay: '$27.99' },
      { sizeId: 'mug-15oz', label: '15 oz', price: 3299, priceDisplay: '$32.99' }
    ]
  },
  {
    id: 'phone',
    name: 'Pet Portrait Phone Case',
    subtitle: 'Tough Dual-Layer Case',
    description: 'Dual-layer tough case with your pet\'s portrait. Impact resistant with glossy vivid printing.',
    category: 'phone',
    badge: null,
    sizes: [
      { sizeId: 'phone-case', label: 'All Models', price: 3499, priceDisplay: '$34.99' }
    ]
  },
  {
    id: 'pillow',
    name: 'Pet Portrait Pillow',
    subtitle: 'Spun Polyester Square',
    description: 'Decorative throw pillow with your pet\'s portrait. Soft, huggable, and makes any couch special.',
    category: 'pillow',
    badge: null,
    sizes: [
      { sizeId: 'pillow-16x16', label: '16" × 16"', price: 4499, priceDisplay: '$44.99' }
    ]
  },
  {
    id: 'tote',
    name: 'Pet Portrait Tote',
    subtitle: 'Cotton Canvas Tote Bag',
    description: 'Take your pet everywhere. Durable cotton canvas tote with full-color portrait printing.',
    category: 'tote',
    badge: null,
    sizes: [
      { sizeId: 'tote-bag', label: 'Standard', price: 2999, priceDisplay: '$29.99' }
    ]
  }
];

// Flat lookup for checkout
const ALL_VARIANTS = {};
PRODUCTS.forEach(p => {
  p.sizes.forEach(s => {
    ALL_VARIANTS[s.sizeId] = { ...s, productName: p.name, subtitle: p.subtitle, category: p.category };
  });
});

// API Routes
app.get('/api/products', (req, res) => {
  res.json(PRODUCTS);
});

app.get('/api/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// Create Stripe Checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { items, customerEmail, artStyle, petNotes } = req.body;

    const lineItems = items.map(item => {
      const variant = ALL_VARIANTS[item.id];
      if (!variant) throw new Error(`Product not found: ${item.id}`);
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${variant.productName} (${variant.label})`,
            description: `${variant.subtitle} — Art Style: ${artStyle || 'Watercolor'}`,
          },
          unit_amount: variant.price,
        },
        quantity: item.quantity || 1,
      };
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/#shop`,
      customer_email: customerEmail || undefined,
      metadata: {
        art_style: artStyle || 'Watercolor',
        pet_notes: petNotes || '',
        items: JSON.stringify(items),
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

// Admin: list orders from Printify
app.get('/api/admin/orders', async (req, res) => {
  try {
    const response = await fetch(`${PRINTIFY_API}/shops/${SHOP_ID}/orders.json`, {
      headers: { 'Authorization': `Bearer ${PRINTIFY_TOKEN}` }
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Printify: get catalog blueprints
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
