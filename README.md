# PawCanvas — AI Pet Portrait Store

A fully functional e-commerce store for selling personalized pet portraits using print-on-demand (Printify) with Stripe payments.

## What's Included
- **Express.js backend** — handles Stripe checkout sessions and Printify API integration
- **Beautiful frontend** — warm cream/amber palette, shopping cart, product grid, reviews, FAQ
- **10 products** — canvas (3 sizes), blankets (2 sizes), mugs (2 sizes), phone case, pillow, tote bag
- **Stripe Checkout** — real payments with shipping address collection
- **Printify integration** — connected to your shop for order fulfillment
- **Success page** — shows order details and next steps after payment

## How to Deploy on Render.com (Free)

### Step 1: Push to GitHub
1. Create a new GitHub repository called `pawcanvas-store`
2. Push this folder to the repository

### Step 2: Deploy on Render
1. Go to [render.com](https://render.com) and sign up (free)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repo
4. Settings:
   - **Name:** pawcanvas-store
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
5. Add environment variables (Settings → Environment):
   - `STRIPE_SECRET_KEY` = your sk_test_... or sk_live_... key
   - `STRIPE_PUBLISHABLE_KEY` = your pk_test_... or pk_live_... key
   - `PRINTIFY_API_TOKEN` = your Printify API token
   - `PRINTIFY_SHOP_ID` = 27142928
   - `PORT` = 10000
6. Click **"Create Web Service"**
7. Your store will be live at: `https://pawcanvas-store.onrender.com`

### Step 3: Add Custom Domain (Optional)
1. Buy a domain (e.g., pawcanvas.com) from [Namecheap](https://namecheap.com)
2. In Render → Settings → Custom Domain → add your domain
3. Follow the DNS instructions

### Step 4: Go Live with Stripe
1. In your Stripe dashboard, activate your account (verify your identity)
2. Get your **live** keys (pk_live_... and sk_live_...)
3. Update the environment variables on Render with the live keys
4. Your store now accepts real payments!

## How It Works (Customer Flow)
1. Customer browses products on your website
2. Customer adds items to cart, selects art style
3. Customer clicks "Proceed to Checkout" → redirected to Stripe
4. Customer enters payment & shipping info on Stripe's secure page
5. After payment, customer sees success page with instructions to send pet photo
6. You receive payment notification and customer's photo
7. You create the portrait (using Canva AI or Midjourney)
8. You upload the design to Printify → Printify prints & ships automatically

## Files
```
pawcanvas-app/
├── server.js          # Express backend (Stripe + Printify API)
├── .env               # API keys (DO NOT commit to public GitHub)
├── package.json       # Dependencies
├── README.md          # This file
└── public/
    ├── index.html     # Main store page
    └── success.html   # Post-checkout confirmation page
```

## Important: Security
- **Never commit your .env file to GitHub** — add it to .gitignore
- Use environment variables on your hosting platform instead
- Switch from test keys to live keys only when ready to accept real payments
