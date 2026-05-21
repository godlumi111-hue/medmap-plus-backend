const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

const URGENCE_FRAIS = 5000   // 5 000 FCFA — va directement à MedMap+
const ADMIN_USER_ID = 1

async function debitUrgence(userId) {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [wallets] = await conn.query('SELECT id, solde FROM wallets WHERE user_id = ?', [userId])
    if (!wallets.length || parseFloat(wallets[0].solde) < URGENCE_FRAIS) {
      await conn.rollback(); conn.release()
      return { ok: false, message: `Solde insuffisant. Les alertes urgences coûtent ${URGENCE_FRAIS.toLocaleString('fr-FR')} FCFA.` }
    }
    // Débiter le patient
    await conn.query('UPDATE wallets SET solde = solde - ? WHERE id = ?', [URGENCE_FRAIS, wallets[0].id])
    await conn.query(
      'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "debit", ?)',
      [wallets[0].id, URGENCE_FRAIS, 'Frais alerte urgence MedMap+']
    )
    // Créditer MedMap+ directement (pas de séquestre)
    const [aw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [ADMIN_USER_ID])
    if (aw.length) {
      await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [URGENCE_FRAIS, aw[0].id])
      await conn.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
        [aw[0].id, URGENCE_FRAIS, `Frais alerte urgence — patient #${userId}`]
      )
    }
    await conn.commit(); conn.release()
    return { ok: true }
  } catch (err) {
    await conn.rollback(); conn.release()
    throw err
  }
}

// POST /emergency/triage
router.post('/triage', requireAuth, async (req, res) => {
  const { type, gravite, lat, lng, adresse } = req.body
  if (!type || !gravite) {
    return res.status(422).json({ detail: 'Type et gravité requis' })
  }
  try {
    const debit = await debitUrgence(req.user.id)
    if (!debit.ok) return res.status(422).json({ detail: debit.message, solde_insuffisant: true })

    const [result] = await pool.query(
      'INSERT INTO emergency_reports (user_id, type, gravite, lat, lng, adresse) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, type, gravite, lat || null, lng || null, adresse || null]
    )
    const [rows] = await pool.query('SELECT * FROM emergency_reports WHERE id = ?', [result.insertId])
    const io = req.app.get('io')
    if (io) io.emit('emergency:new', { id: result.insertId, type, gravite })
    res.status(201).json({ ...rows[0], frais_debite: URGENCE_FRAIS })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /emergency
router.post('/', requireAuth, async (req, res) => {
  const { type, gravite, description, lat, lng, adresse } = req.body
  if (!type || !gravite) {
    return res.status(422).json({ detail: 'Type et gravité requis' })
  }
  try {
    const debit = await debitUrgence(req.user.id)
    if (!debit.ok) return res.status(422).json({ detail: debit.message, solde_insuffisant: true })

    const [result] = await pool.query(
      'INSERT INTO emergency_reports (user_id, type, gravite, description, lat, lng, adresse) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, type, gravite, description || null, lat || null, lng || null, adresse || null]
    )
    const [rows] = await pool.query('SELECT * FROM emergency_reports WHERE id = ?', [result.insertId])
    const io = req.app.get('io')
    if (io) io.emit('emergency:new', { id: result.insertId, type, gravite, description })
    res.status(201).json({ ...rows[0], frais_debite: URGENCE_FRAIS })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /emergency/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM emergency_reports WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ detail: 'Urgence introuvable' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
