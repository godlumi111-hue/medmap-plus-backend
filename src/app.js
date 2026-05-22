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

// One-time hospital seeding endpoint — creates/fixes all hospital accounts + structure_profiles
app.get('/setup-hospitals', async (req, res) => {
  if (req.query.secret !== 'medmap2026') return res.status(403).json({ error: 'Forbidden' })
  const pool = require('./db')
  const bcrypt = require('bcryptjs')
  const PASS_HASH = await bcrypt.hash('MedMap2026!', 10)
  const hospitals = [
    { email: 'chu.cocody@medmap.ci',              nom: 'CHU de Cocody',                     tel: '+225 27 22 44 34 34', lits: 580  },
    { email: 'polyclinique.farah@medmap.ci',       nom: 'Polyclinique Farah',                tel: '+225 27 20 31 05 05', lits: 160  },
    { email: 'chu.treichville@medmap.ci',          nom: 'CHU de Treichville',                tel: '+225 27 21 24 22 22', lits: 820  },
    { email: 'pisam@medmap.ci',                    nom: 'PISAM',                             tel: '+225 27 22 44 10 10', lits: 210  },
    { email: 'clinique.internationale@medmap.ci',  nom: 'Clinique Internationale',           tel: '+225 27 22 40 28 28', lits: 95   },
    { email: 'clinique.saintviateur@medmap.ci',    nom: 'Clinique Saint Viateur',            tel: '+225 27 22 41 88 88', lits: 75   },
    { email: 'polyclinique.sogefia@medmap.ci',     nom: 'Polyclinique Sogefia',              tel: '+225 27 21 35 44 44', lits: 130  },
    { email: 'clinique.avicenne@medmap.ci',        nom: 'Clinique Avicenne',                 tel: '+225 27 22 48 39 39', lits: 85   },
    { email: 'polyclinique.agban@medmap.ci',       nom: 'Polyclinique Agban',                tel: '+225 27 23 67 88 99', lits: 65   },
    { email: 'clinique.cathedrale@medmap.ci',      nom: "Clinique de la Cathédrale",         tel: '+225 27 20 22 11 55', lits: 50   },
    { email: 'ica@medmap.ci',                      nom: "Institut de Cardiologie d'Abidjan", tel: '+225 27 21 24 72 72', lits: 120  },
    { email: 'clinique.deuxplateaux@medmap.ci',    nom: 'Clinique des Deux Plateaux',        tel: '+225 27 22 41 50 50', lits: 60   },
    { email: 'clinique.riviera@medmap.ci',         nom: 'Clinique Mère-Enfant La Riviera',   tel: '+225 27 22 43 60 60', lits: 100  },
  ]
  const results = []
  for (const h of hospitals) {
    try {
      await pool.query(
        `INSERT INTO users (email, password_hash, nom, prenom, telephone, role, is_active, is_verified)
         VALUES (?, ?, 'Hopital', ?, ?, 'clinique', 1, 1)
         ON DUPLICATE KEY UPDATE is_active = 1, is_verified = 1`,
        [h.email, PASS_HASH, h.email.split('@')[0], h.tel]
      )
      const [[u]] = await pool.query('SELECT id FROM users WHERE email = ?', [h.email])
      const uid = u.id
      await pool.query('INSERT IGNORE INTO wallets (user_id, solde) VALUES (?, 50000)', [uid])
      await pool.query(
        `INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note)
         VALUES (?, 'clinique', ?, 'Abidjan', 'Abidjan', ?, 1, 4.5)
         ON DUPLICATE KEY UPDATE nom = VALUES(nom), partenaire = 1`,
        [uid, h.nom, h.tel]
      )
      const [[sp]] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [uid])
      await pool.query(
        `INSERT INTO clinic_profiles (structure_id, urgence24h, nombre_lits, horaires) VALUES (?, 1, ?, '24h/24')
         ON DUPLICATE KEY UPDATE nombre_lits = VALUES(nombre_lits)`,
        [sp.id, h.lits]
      )
      results.push({ email: h.email, nom: h.nom, uid, structure_id: sp.id, status: 'ok' })
    } catch (e) {
      results.push({ email: h.email, nom: h.nom, status: 'error', error: e.message })
    }
  }
  console.log('setup-hospitals:', results)
  res.json({ success: true, count: results.filter(r => r.status === 'ok').length, password: 'MedMap2026!', results })
})

// 404
app.use((req, res) => res.status(404).json({ detail: `Route ${req.method} ${req.path} introuvable` }))

// Error handler
app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ detail: 'Erreur serveur interne' })
})

module.exports = app
