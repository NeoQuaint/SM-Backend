require('dotenv').config();
const express = require('express');
const cors = require('cors');

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

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({
  origin: [
    'https://smartclasss.com',
    'https://www.smartclasss.com',
    'https://sm-simple.vercel.app',
    'https://sm-simple-1wj0qfubn-skolify.vercel.app',
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5173'
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SmartClass API', version: '1.0.0' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'Neo is awake', database: 'connected', timestamp: new Date().toISOString() });
});

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

app.listen(PORT, () => {
  console.log(`🚀 SmartClass API running on port ${PORT}`);
});