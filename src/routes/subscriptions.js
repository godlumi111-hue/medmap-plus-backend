const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

async function getOrCreateSubscription(userId) {
  const today = new Date().toISOString().slice(0, 10)
  const [rows] = await pool.query('SELECT * FROM subscriptions WHERE user_id = ?', [userId])
  if (!rows.length) {
    await pool.query(
      'INSERT INTO subscriptions (user_id, plan, messages_used, last_reset_date) VALUES (?, "basic", 0, ?)',
      [userId, today]
    )
    const [created] = await pool.query('SELECT * FROM subscriptions WHERE user_id = ?', [userId])
    return created[0]
  }
  const sub = rows[0]
  const lastReset = sub.last_reset_date ? new Date(sub.last_reset_date).toISOString().slice(0, 10) : null
  if (lastReset !== today) {
    await pool.query('UPDATE subscriptions SET messages_used = 0, last_reset_date = ? WHERE user_id = ?', [today, userId])
    sub.messages_used = 0
  }
  return sub
}

// GET /subscriptions/status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const sub = await getOrCreateSubscription(req.user.id)
    const isPremium = sub.plan === 'premium'
    const messagesLeft = isPremium ? null : Math.max(0, 20 - (sub.messages_used || 0))
    res.json({
      plan: sub.plan,
      is_premium: isPremium,
      messages_used: sub.messages_used || 0,
      messages_left: messagesLeft,
      messages_limit: 20,
      expires_at: sub.expires_at,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /subscriptions/upgrade
router.post('/upgrade', requireAuth, async (req, res) => {
  const { plan = 'premium', methode = 'simulation', duree_mois = 1 } = req.body
  try {
    const sub = await getOrCreateSubscription(req.user.id)
    if (sub.plan === 'premium' && sub.expires_at && new Date(sub.expires_at) > new Date()) {
      return res.status(409).json({ detail: 'Vous êtes déjà abonné Premium' })
    }

    const prices = { 1: 2900, 3: 7500, 12: 24900 }
    const montant = prices[duree_mois] || 2900
    const expiresAt = new Date()
    expiresAt.setMonth(expiresAt.getMonth() + parseInt(duree_mois))

    // Débiter le portefeuille si assez de solde
    const [wallets] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [req.user.id])
    if (wallets.length && parseFloat(wallets[0].solde) >= montant) {
      const newSolde = parseFloat(wallets[0].solde) - montant
      await pool.query('UPDATE wallets SET solde = ? WHERE user_id = ?', [newSolde, req.user.id])
      await pool.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "debit", ?)',
        [wallets[0].id, montant, `Abonnement MediA Premium ${duree_mois} mois`]
      )
    }

    await pool.query(
      'UPDATE subscriptions SET plan = "premium", expires_at = ?, messages_used = 0 WHERE user_id = ?',
      [expiresAt.toISOString().slice(0, 19).replace('T', ' '), req.user.id]
    )

    res.json({
      message: 'Abonnement Premium activé avec succès !',
      plan: 'premium',
      expires_at: expiresAt,
      montant,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /subscriptions/downgrade
router.post('/downgrade', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE subscriptions SET plan = "basic", expires_at = NULL WHERE user_id = ?',
      [req.user.id]
    )
    res.json({ message: 'Abonnement repassé en Basic', plan: 'basic' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
