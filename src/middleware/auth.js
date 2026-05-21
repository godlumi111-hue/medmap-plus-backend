const { verifyToken } = require('../utils/jwt')
const pool = require('../db')

async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ detail: 'Token manquant' })
  }
  const token = header.slice(7)
  try {
    const payload = verifyToken(token)
    const [rows] = await pool.query(
      'SELECT id, email, nom, prenom, telephone, role, is_active, is_verified, avatar_url FROM users WHERE id = ?',
      [payload.id]
    )
    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ detail: 'Utilisateur introuvable ou inactif' })
    }
    req.user = rows[0]
    next()
  } catch {
    return res.status(401).json({ detail: 'Token invalide ou expiré' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ detail: 'Accès refusé' })
    }
    next()
  }
}

module.exports = { requireAuth, requireRole }
