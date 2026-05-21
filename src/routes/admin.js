const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth, requireRole } = require('../middleware/auth')

router.use(requireAuth, requireRole('admin'))

// GET /admin/stats
router.get('/stats', async (req, res) => {
  try {
    const [[users]] = await pool.query('SELECT COUNT(*) as total FROM users WHERE role != "admin"')
    const [[medecins]] = await pool.query('SELECT COUNT(*) as total FROM users WHERE role = "medecin"')
    const [[structures]] = await pool.query('SELECT COUNT(*) as total FROM structure_profiles')
    const [[appointments]] = await pool.query('SELECT COUNT(*) as total FROM appointments')
    const [[orders]] = await pool.query('SELECT COUNT(*) as total FROM orders')
    const [[walletTotal]] = await pool.query('SELECT SUM(solde) as total FROM wallets')
    const [[emergencies]] = await pool.query('SELECT COUNT(*) as total FROM emergency_reports')
    res.json({
      utilisateurs: users.total,
      medecins: medecins.total,
      structures: structures.total,
      rendez_vous: appointments.total,
      commandes: orders.total,
      volume_wallet: parseFloat(walletTotal.total || 0),
      urgences: emergencies.total,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /admin/commissions — breakdown of MedMap+ revenue by category
router.get('/commissions', async (req, res) => {
  try {
    // RDV médecins/hôpitaux: commission stored in payments table
    const [[rdvComm]] = await pool.query(
      "SELECT COALESCE(SUM(commission), 0) as total, COUNT(*) as nb FROM payments WHERE type IN ('rdv','appointment') AND statut = 'libere'"
    )
    // Pharmacie: commission = montant_total - montant_pharmacie (stored in orders)
    const [[pharmacieComm]] = await pool.query(
      "SELECT COALESCE(SUM(commission), 0) as total, COUNT(*) as nb FROM payments WHERE type = 'commande' AND statut = 'libere'"
    )
    // Hôpital/clinique consultations
    const [[hopitalComm]] = await pool.query(
      "SELECT COALESCE(SUM(commission), 0) as total, COUNT(*) as nb FROM payments WHERE type = 'consultation' AND statut = 'libere'"
    )
    // Médecins/coachs personnels: via wallet_transactions to admin
    const [[personalComm]] = await pool.query(
      "SELECT COALESCE(SUM(montant), 0) as total, COUNT(*) as nb FROM wallet_transactions WHERE wallet_id = (SELECT id FROM wallets WHERE user_id = 1 LIMIT 1) AND description LIKE '%Commission MedMap+ 15%% — suivi personnel%'"
    )
    // Urgences: frais d'urgence
    const [[urgenceComm]] = await pool.query(
      "SELECT COALESCE(SUM(montant), 0) as total, COUNT(*) as nb FROM wallet_transactions WHERE wallet_id = (SELECT id FROM wallets WHERE user_id = 1 LIMIT 1) AND description LIKE '%Frais alerte urgence%'"
    )
    // Admin wallet total balance
    const [[adminWallet]] = await pool.query(
      'SELECT COALESCE(solde, 0) as solde FROM wallets WHERE user_id = 1'
    )

    res.json({
      rdv:           { total: parseFloat(rdvComm.total),       nb: rdvComm.nb },
      pharmacie:     { total: parseFloat(pharmacieComm.total), nb: pharmacieComm.nb },
      hopital:       { total: parseFloat(hopitalComm.total),   nb: hopitalComm.nb },
      suivi_perso:   { total: parseFloat(personalComm.total),  nb: personalComm.nb },
      urgence:       { total: parseFloat(urgenceComm.total),   nb: urgenceComm.nb },
      total_platform: parseFloat(rdvComm.total) + parseFloat(pharmacieComm.total) + parseFloat(hopitalComm.total) + parseFloat(personalComm.total) + parseFloat(urgenceComm.total),
      solde_admin:   parseFloat(adminWallet.solde),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /admin/users
router.get('/users', async (req, res) => {
  const { role, is_active, limit = 50, offset = 0 } = req.query
  try {
    let sql = 'SELECT id, email, nom, prenom, telephone, role, is_active, is_verified, avatar_url, created_at FROM users WHERE 1=1'
    const params = []
    if (role) { sql += ' AND role = ?'; params.push(role) }
    if (is_active !== undefined) { sql += ' AND is_active = ?'; params.push(is_active === 'true' ? 1 : 0) }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    params.push(parseInt(limit), parseInt(offset))
    const [rows] = await pool.query(sql, params)
    res.json(rows.map(u => ({ ...u, is_active: Boolean(u.is_active), is_verified: Boolean(u.is_verified) })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /admin/users/:id/activate
router.put('/users/:id/activate', async (req, res) => {
  const is_active = req.query.is_active === 'true'
  try {
    await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id])
    const [rows] = await pool.query('SELECT id, email, nom, prenom, role, is_active, is_verified FROM users WHERE id = ?', [req.params.id])
    res.json({ ...rows[0], is_active: Boolean(rows[0].is_active), is_verified: Boolean(rows[0].is_verified) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /admin/users/:id/verify
router.put('/users/:id/verify', async (req, res) => {
  try {
    await pool.query('UPDATE users SET is_verified = 1 WHERE id = ?', [req.params.id])
    const [rows] = await pool.query('SELECT id, email, nom, prenom, role, is_active, is_verified FROM users WHERE id = ?', [req.params.id])
    res.json({ ...rows[0], is_active: Boolean(rows[0].is_active), is_verified: Boolean(rows[0].is_verified) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /admin/disputes
router.get('/disputes', async (req, res) => {
  const { statut } = req.query
  try {
    let sql = `
      SELECT d.*, u.nom as user_nom, u.email as user_email, p.montant as payment_montant
      FROM disputes d
      JOIN users u ON u.id = d.user_id
      JOIN payments p ON p.id = d.payment_id
    `
    const params = []
    if (statut) { sql += ' WHERE d.statut = ?'; params.push(statut) }
    sql += ' ORDER BY d.created_at DESC'
    const [rows] = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /admin/disputes/:id/resolve
router.put('/disputes/:id/resolve', async (req, res) => {
  const { resolution, refund = 'false' } = req.query
  if (!resolution) return res.status(422).json({ detail: 'Résolution requise' })
  try {
    await pool.query("UPDATE disputes SET statut = 'resolu', resolution = ? WHERE id = ?", [resolution, req.params.id])
    if (refund === 'true') {
      const [disputes] = await pool.query('SELECT * FROM disputes WHERE id = ?', [req.params.id])
      if (disputes.length) {
        const [payments] = await pool.query('SELECT * FROM payments WHERE id = ?', [disputes[0].payment_id])
        if (payments.length) {
          const p = payments[0]
          const [wallets] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [p.payer_id])
          if (wallets.length) {
            const newSolde = parseFloat(wallets[0].solde) + parseFloat(p.montant)
            await pool.query('UPDATE wallets SET solde = ? WHERE id = ?', [newSolde, wallets[0].id])
            await pool.query(
              "UPDATE payments SET statut = 'rembourse' WHERE id = ?",
              [p.id]
            )
          }
        }
      }
    }
    const [rows] = await pool.query('SELECT * FROM disputes WHERE id = ?', [req.params.id])
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /admin/structures
router.get('/structures', async (req, res) => {
  const { type, partenaire } = req.query
  try {
    let sql = 'SELECT sp.*, u.email FROM structure_profiles sp JOIN users u ON u.id = sp.user_id WHERE 1=1'
    const params = []
    if (type) { sql += ' AND sp.type LIKE ?'; params.push(`%${type}%`) }
    if (partenaire !== undefined) { sql += ' AND sp.partenaire = ?'; params.push(partenaire === 'true' ? 1 : 0) }
    sql += ' ORDER BY sp.nom'
    const [rows] = await pool.query(sql, params)
    res.json(rows.map(r => ({ ...r, partenaire: Boolean(r.partenaire) })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /admin/structures/:id/partner
router.put('/structures/:id/partner', async (req, res) => {
  const partenaire = req.query.partenaire === 'true'
  try {
    await pool.query('UPDATE structure_profiles SET partenaire = ? WHERE id = ?', [partenaire ? 1 : 0, req.params.id])
    const [rows] = await pool.query('SELECT * FROM structure_profiles WHERE id = ?', [req.params.id])
    res.json({ ...rows[0], partenaire: Boolean(rows[0].partenaire) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
