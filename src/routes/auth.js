const express = require('express')
const router = express.Router()
const pool = require('../db')
const { hash, compare } = require('../utils/password')
const { signToken } = require('../utils/jwt')
const { requireAuth } = require('../middleware/auth')

function formatUser(u) {
  return {
    id: u.id,
    email: u.email,
    nom: u.nom,
    prenom: u.prenom,
    telephone: u.telephone || null,
    role: u.role,
    is_active: Boolean(u.is_active),
    is_verified: Boolean(u.is_verified),
    avatar_url: u.avatar_url || null,
  }
}

// POST /auth/register
router.post('/register', async (req, res) => {
  const { email, password, nom, prenom, telephone, role } = req.body
  const validRoles = ['patient', 'medecin', 'coach', 'pharmacie', 'clinique', 'veterinaire', 'livreur', 'samu', 'pompiers', 'ambulance']

  if (!email || !password || !nom || !prenom || !role) {
    return res.status(422).json({ detail: 'Champs obligatoires manquants' })
  }
  if (!validRoles.includes(role)) {
    return res.status(422).json({ detail: 'Rôle invalide' })
  }

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email])
    if (existing.length) {
      return res.status(409).json({ detail: 'Cet email est déjà utilisé' })
    }

    const password_hash = await hash(password)
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, nom, prenom, telephone, role) VALUES (?, ?, ?, ?, ?, ?)',
      [email, password_hash, nom, prenom, telephone || null, role]
    )
    const userId = result.insertId

    // Créer le portefeuille automatiquement
    await pool.query('INSERT INTO wallets (user_id, solde) VALUES (?, 0)', [userId])

    // Créer le profil selon le rôle
    if (role === 'medecin') {
      await pool.query('INSERT INTO doctor_profiles (user_id) VALUES (?)', [userId])
    } else if (role === 'coach') {
      await pool.query(
        "INSERT INTO coach_profiles (user_id, specialite, description) VALUES (?, 'Coaching de santé', '') ON DUPLICATE KEY UPDATE user_id=user_id",
        [userId]
      )
    } else if (['pharmacie', 'clinique', 'veterinaire'].includes(role)) {
      const [spRes] = await pool.query(
        'INSERT INTO structure_profiles (user_id, type, nom) VALUES (?, ?, ?)',
        [userId, role, `${prenom} ${nom}`]
      )
      const structId = spRes.insertId
      if (role === 'pharmacie') {
        await pool.query('INSERT INTO pharmacy_profiles (structure_id) VALUES (?)', [structId])
      } else if (role === 'clinique') {
        await pool.query('INSERT INTO clinic_profiles (structure_id) VALUES (?)', [structId])
      } else if (role === 'veterinaire') {
        await pool.query('INSERT INTO vet_profiles (structure_id) VALUES (?)', [structId])
      }
    } else if (role === 'livreur') {
      await pool.query('INSERT INTO livreur_profiles (user_id) VALUES (?)', [userId])
    }

    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId])
    const user = formatUser(users[0])
    const access_token = signToken({ id: userId, role })

    res.status(201).json({ access_token, token_type: 'bearer', user })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) {
    return res.status(422).json({ detail: 'Email et mot de passe requis' })
  }
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email])
    if (!rows.length) {
      return res.status(401).json({ detail: 'Email ou mot de passe incorrect' })
    }
    const u = rows[0]
    if (!u.is_active) {
      return res.status(403).json({ detail: 'Compte désactivé' })
    }
    const ok = await compare(password, u.password_hash)
    if (!ok) {
      return res.status(401).json({ detail: 'Email ou mot de passe incorrect' })
    }
    const user = formatUser(u)
    const access_token = signToken({ id: u.id, role: u.role })
    res.json({ access_token, token_type: 'bearer', user })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /auth/logout
router.post('/logout', requireAuth, (req, res) => {
  res.json({ message: 'Déconnexion réussie' })
})

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json(formatUser(req.user))
})

module.exports = router
