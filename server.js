require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ivasRouter = require('./ivas-router');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/ivasms', ivasRouter);

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Home page
app.get('/', (req, res) => {
  res.json({
    name: 'IVAS SMS API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      status: 'GET /api/ivasms/status',
      numbers: 'GET /api/ivasms/?type=numbers',
      sms: 'GET /api/ivasms/?type=sms',
      updateSession: 'POST /api/ivasms/update-session'
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
