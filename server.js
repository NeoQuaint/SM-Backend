require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5001;

console.log('✅ Environment variables loaded');
console.log('🚀 SMARTCLASS SERVER STARTING');

// ====================
// DATABASE
// ====================
const pool = require('./db');

// ====================
// SECURITY MIDDLEWARE
// ====================
app.set('trust proxy', 1);

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again later.' },
});

const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 50,
  message: { error: 'Too many payment attempts. Please wait a moment.' },
});

const supportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many support requests. Please try again later.' },
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://js.yoco.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.yoco.com", "https://accounts.google.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://payments.yoco.com", "https://api.yoco.com", "https://js.yoco.com"],
      frameSrc: ["'self'", "https://payments.yoco.com", "https://js.yoco.com"],
      frameAncestors: ["'self'"],
      formAction: ["'self'", "https://payments.yoco.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use((req, res, next) => {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-ID', req.id);
  next();
});

// ====================
// CORS
// ====================
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5000',
    'https://www.smartclasss.com',
    'https://smartclasss.com',
    'https://smartclass-wlgb.onrender.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// ====================
// COMPRESSION & BODY PARSING
// ====================
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ====================
// RATE LIMITING
// ====================
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/yoco/', paymentLimiter);
app.use('/api/support/', supportLimiter);

// ====================
// ROUTES
// ====================
const authRoutes = require('./routes/auth');
const subjectsRoutes = require('./routes/subjects');
const tutorsRoutes = require('./routes/tutors');
const matchingRoutes = require('./routes/matching');
const packagesRoutes = require('./routes/packages');
const subscriptionsRoutes = require('./routes/subscriptions');
const sessionsRoutes = require('./routes/sessions');
const messagesRoutes = require('./routes/messages');
const reviewsRoutes = require('./routes/reviews');
const analyticsRoutes = require('./routes/analytics');
const neoRoutes = require('./routes/neo');
const yocoRoutes = require('./routes/yoco');
const supportRoutes = require('./routes/support'); // NEW - Support route

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SmartClass API', 
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'Neo is awake', 
    database: 'connected', 
    timestamp: new Date().toISOString() 
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/subjects', subjectsRoutes);
app.use('/api/tutors', tutorsRoutes);
app.use('/api/match-tutors', matchingRoutes);
app.use('/api/packages', packagesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/track-event', analyticsRoutes);
app.use('/api/neo', neoRoutes);
app.use('/api/yoco', yocoRoutes);
app.use('/api/support', supportRoutes); // NEW - Support route

// ====================
// ERROR HANDLERS
// ====================
// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ 
    error: 'Route not found', 
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled Error:', err.stack);
  const status = err.status || 500;
  res.status(status).json({ 
    error: 'Internal server error',
    requestId: req.id
  });
});

// ====================
// DATABASE INITIALIZATION
// ====================
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    console.log('📦 Initializing SmartClass database...');
    
    // Subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS smartclass_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        package VARCHAR(50),
        amount DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'active',
        payment_reference VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      )
    `);
    console.log('✅ Subscriptions table ready');
    
    // Payment tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS smartclass_subscription_payments (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        checkout_id VARCHAR(255) NOT NULL,
        package VARCHAR(50),
        amount DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        UNIQUE(checkout_id)
      )
    `);
    console.log('✅ Payment tracking table ready');
    
    // Support tickets table (NEW)
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255),
        user_name VARCHAR(255),
        user_email VARCHAR(255),
        subject VARCHAR(255),
        message TEXT,
        status VARCHAR(20) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      )
    `);
    console.log('✅ Support tickets table ready');
    
    // Notification settings table (NEW)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_notifications (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        enabled BOOLEAN DEFAULT false,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      )
    `);
    console.log('✅ Notification settings table ready');
    
    console.log('✅ Database initialization complete');
    
  } catch (err) {
    console.error('❌ Database init error:', err);
  } finally {
    client.release();
  }
}

// ====================
// GRACEFUL SHUTDOWN
// ====================
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received. Shutting down gracefully...');
  app.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// ====================
// START SERVER
// ====================
(async () => {
  try {
    await initializeDatabase();
    
    app.listen(PORT, () => {
      console.log(`\n🚀 SMARTCLASS API RUNNING ON PORT ${PORT}`);
      console.log(`✅ Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`✅ Ready for production\n`);
    });
    
  } catch (err) {
    console.error('❌ Startup error:', err);
    process.exit(1);
  }
})();

module.exports = app;