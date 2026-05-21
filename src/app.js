const express = require('express')
const cors = require('cors')
require('dotenv').config()

const app = express()

// CORS — FRONTEND_URL can be comma-separated for multiple origins (e.g. Vercel + localhost)
const allowedOrigins = [
  ...(process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(s => s.trim()),
  'https://medmap-plus-frontend.vercel.app',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true)
    cb(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Routes
app.use('/api/v1/auth', require('./routes/auth'))
app.use('/api/v1/users', require('./routes/users'))
app.use('/api/v1/appointments', require('./routes/appointments'))
app.use('/api/v1/pharmacies', require('./routes/pharmacies'))
app.use('/api/v1/medicines', require('./routes/medicines'))
app.use('/api/v1/wallet', require('./routes/wallet'))
app.use('/api/v1/emergency', require('./routes/emergency'))
app.use('/api/v1/chat', require('./routes/chat'))
app.use('/api/v1/subscriptions', require('./routes/subscriptions'))
app.use('/api/v1/admin', require('./routes/admin'))
app.use('/api/v1/messages', require('./routes/messages'))
app.use('/api/v1/notifications', require('./routes/notifications'))
app.use('/api/v1/medical', require('./routes/medical'))
app.use('/api/v1/hospital', require('./routes/hospital'))
app.use('/api/v1/animals', require('./routes/animals'))
app.use('/api/v1/vet', require('./routes/vet'))
app.use('/api/v1/major-emergency', require('./routes/majorEmergency'))
app.use('/api/v1/personal-care', require('./routes/personalCare'))

// Nouvelle logique animaux (simple, propre)
app.use('/api/animals', require('./routes/petAnimals'))

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }))

// 404
app.use((req, res) => res.status(404).json({ detail: `Route ${req.method} ${req.path} introuvable` }))

// Error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ detail: 'Erreur serveur interne' })
})

module.exports = app
