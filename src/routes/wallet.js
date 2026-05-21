const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

// Auto-create deposit_requests table
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deposit_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        methode ENUM('wave','orange','mtn','moov') NOT NULL,
        montant_demande DECIMAL(10,2) NOT NULL,
        frais DECIMAL(10,2) NOT NULL,
        montant_credit DECIMAL(10,2) NOT NULL,
        reference VARCHAR(50) NOT NULL,
        statut ENUM('en_attente','confirme','expire','echec') DEFAULT 'en_attente',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP NULL
      )
    `)
  } catch {}
})()

const DEPOSIT_FEE_RATE = 0.015  // 1.5%

function generateRef(methode) {
  const prefix = { wave: 'WV', orange: 'OM', mtn: 'MTN', moov: 'MV' }[methode] || 'TX'
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
}

async function getOrCreateWallet(userId) {
  const [rows] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId])
  if (rows.length) return rows[0]
  await pool.query('INSERT INTO wallets (user_id, solde) VALUES (?, 0)', [userId])
  const [created] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId])
  return created[0]
}

async function addTransaction(walletId, montant, type, description, referenceId = null) {
  await pool.query(
    'INSERT INTO wallet_transactions (wallet_id, montant, type, description, reference_id) VALUES (?, ?, ?, ?, ?)',
    [walletId, montant, type, description, referenceId]
  )
}

// GET /wallet/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const w = await getOrCreateWallet(req.user.id)
    res.json({ id: w.id, user_id: w.user_id, solde: parseFloat(w.solde), created_at: w.created_at })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /wallet/transactions
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const w = await getOrCreateWallet(req.user.id)
    const [rows] = await pool.query(
      `SELECT wt.*, p.statut AS payment_statut, p.id AS payment_id
       FROM wallet_transactions wt
       LEFT JOIN payments p ON p.id = wt.reference_id AND wt.type = 'debit'
       WHERE wt.wallet_id = ?
       ORDER BY wt.created_at DESC LIMIT 100`,
      [w.id]
    )
    res.json(rows.map(r => ({
      ...r,
      montant: parseFloat(r.montant),
      statut: r.payment_statut || (r.type === 'credit' ? 'confirme' : null),
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /wallet/recharge
router.post('/recharge', requireAuth, async (req, res) => {
  const { montant, methode = 'simulation' } = req.body
  if (!montant || montant <= 0) {
    return res.status(422).json({ detail: 'Montant invalide' })
  }
  try {
    const w = await getOrCreateWallet(req.user.id)
    const newSolde = parseFloat(w.solde) + parseFloat(montant)
    await pool.query('UPDATE wallets SET solde = ? WHERE id = ?', [newSolde, w.id])
    await addTransaction(w.id, montant, 'credit', `Recharge via ${methode}`)
    res.json({ id: w.id, user_id: w.user_id, solde: newSolde })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /wallet/pay
router.post('/pay', requireAuth, async (req, res) => {
  const { montant, appointment_id, receiver_id, structure_id, description } = req.body
  if (!montant || montant <= 0) {
    return res.status(422).json({ detail: 'Montant invalide' })
  }
  try {
    const w = await getOrCreateWallet(req.user.id)
    if (parseFloat(w.solde) < parseFloat(montant)) {
      return res.status(400).json({ detail: 'Solde insuffisant' })
    }
    const newSolde = parseFloat(w.solde) - parseFloat(montant)
    await pool.query('UPDATE wallets SET solde = ? WHERE id = ?', [newSolde, w.id])

    const [pResult] = await pool.query(
      'INSERT INTO payments (payer_id, receiver_id, appointment_id, structure_id, montant, description, statut) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, receiver_id || null, appointment_id || null, structure_id || null, montant, description || null, 'en_attente']
    )
    await addTransaction(w.id, montant, 'debit', description || `Paiement #${pResult.insertId}`, pResult.insertId)

    const [payments] = await pool.query('SELECT * FROM payments WHERE id = ?', [pResult.insertId])
    res.status(201).json({ ...payments[0], montant: parseFloat(payments[0].montant) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /wallet/confirm-service
router.post('/confirm-service', requireAuth, async (req, res) => {
  const { payment_id } = req.body
  try {
    const [rows] = await pool.query('SELECT * FROM payments WHERE id = ? AND payer_id = ?', [payment_id, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Paiement introuvable' })
    await pool.query("UPDATE payments SET statut = 'confirme' WHERE id = ?", [payment_id])

    // Créditer le receveur si renseigné
    const p = rows[0]
    if (p.receiver_id) {
      const rw = await getOrCreateWallet(p.receiver_id)
      const newSolde = parseFloat(rw.solde) + parseFloat(p.montant)
      await pool.query('UPDATE wallets SET solde = ? WHERE id = ?', [newSolde, rw.id])
      await addTransaction(rw.id, p.montant, 'credit', `Service confirmé #${payment_id}`, payment_id)
    }

    const [updated] = await pool.query('SELECT * FROM payments WHERE id = ?', [payment_id])
    res.json({ ...updated[0], montant: parseFloat(updated[0].montant) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /wallet/deposit — initiate mobile money deposit
router.post('/deposit', requireAuth, async (req, res) => {
  const { methode, montant_demande } = req.body
  if (!['wave', 'orange', 'mtn', 'moov'].includes(methode)) {
    return res.status(422).json({ detail: 'Méthode invalide. Choisir : wave, orange, mtn, moov.' })
  }
  if (!montant_demande || montant_demande < 500) {
    return res.status(422).json({ detail: 'Montant minimum : 500 F CFA.' })
  }
  try {
    const frais = Math.round(parseFloat(montant_demande) * DEPOSIT_FEE_RATE)
    const montant_credit = parseFloat(montant_demande) - frais
    const reference = generateRef(methode)
    const [result] = await pool.query(
      'INSERT INTO deposit_requests (user_id, methode, montant_demande, frais, montant_credit, reference) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, methode, montant_demande, frais, montant_credit, reference]
    )
    const [rows] = await pool.query('SELECT * FROM deposit_requests WHERE id = ?', [result.insertId])
    res.status(201).json({
      ...rows[0],
      montant_demande: parseFloat(rows[0].montant_demande),
      frais: parseFloat(rows[0].frais),
      montant_credit: parseFloat(rows[0].montant_credit),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /wallet/deposit/:id/confirm — simulate user confirmation on mobile app
router.post('/deposit/:id/confirm', requireAuth, async (req, res) => {
  const depositId = parseInt(req.params.id, 10)
  try {
    const [rows] = await pool.query('SELECT * FROM deposit_requests WHERE id = ? AND user_id = ?', [depositId, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Dépôt introuvable.' })
    const dep = rows[0]
    if (dep.statut !== 'en_attente') return res.status(409).json({ detail: `Ce dépôt est déjà ${dep.statut}.` })

    await pool.query("UPDATE deposit_requests SET statut = 'confirme', confirmed_at = NOW() WHERE id = ?", [depositId])

    const w = await getOrCreateWallet(req.user.id)
    const montantCredit = parseFloat(dep.montant_credit)
    const newSolde = parseFloat(w.solde) + montantCredit
    await pool.query('UPDATE wallets SET solde = ? WHERE id = ?', [newSolde, w.id])
    await addTransaction(w.id, montantCredit, 'credit',
      `Dépôt ${dep.methode.toUpperCase()} confirmé — réf. ${dep.reference}`)

    res.json({ detail: 'Dépôt confirmé.', nouveau_solde: newSolde, montant_credit: montantCredit, reference: dep.reference })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /wallet/deposits — list user's deposit requests
router.get('/deposits', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM deposit_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    )
    res.json(rows.map(r => ({
      ...r,
      montant_demande: parseFloat(r.montant_demande),
      frais: parseFloat(r.frais),
      montant_credit: parseFloat(r.montant_credit),
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /wallet/dispute
router.post('/dispute', requireAuth, async (req, res) => {
  const { payment_id, motif } = req.body
  if (!payment_id || !motif) {
    return res.status(422).json({ detail: 'Données manquantes' })
  }
  try {
    const [existing] = await pool.query('SELECT id FROM disputes WHERE payment_id = ? AND user_id = ?', [payment_id, req.user.id])
    if (existing.length) return res.status(409).json({ detail: 'Litige déjà ouvert' })

    await pool.query("UPDATE payments SET statut = 'dispute' WHERE id = ?", [payment_id])
    const [result] = await pool.query(
      'INSERT INTO disputes (payment_id, user_id, motif) VALUES (?, ?, ?)',
      [payment_id, req.user.id, motif]
    )
    const [rows] = await pool.query('SELECT * FROM disputes WHERE id = ?', [result.insertId])
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
