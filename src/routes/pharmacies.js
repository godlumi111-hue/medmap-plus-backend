const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

// Auto-migrate: add frais_livraison column if missing
pool.query(
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS frais_livraison DECIMAL(10,2) DEFAULT 700.00`
).catch(() => {})

const FRAIS_LIVRAISON_DEFAULT = 700

const STATUS_LABELS = {
  en_attente:     'Commande reçue',
  confirme:       'Commande acceptée',
  en_preparation: 'En préparation',
  en_route:       'En livraison',
  livre:          'Livrée',
  annule:         'Annulée',
}

const LIVREUR_LABELS = {
  vers_pharmacie:   'Livreur en route vers la pharmacie',
  arrive_pharmacie: 'Livreur arrivé à la pharmacie',
  vers_patient:     'Livreur en route vers vous',
  arrive_patient:   'Livreur arrivé chez vous',
  livre:            'Livraison confirmée',
}

function formatOrder(r) {
  if (!r) return null
  const total      = r.total      ? parseFloat(r.total)      : 0
  const commission = r.commission ? parseFloat(r.commission) : 0
  const rawFrais   = r.frais_livraison ? parseFloat(r.frais_livraison) : FRAIS_LIVRAISON_DEFAULT
  // Old orders were created without frais_livraison; detect by checking
  // whether (total - commission) can cover the delivery fee.
  const fraisLivraison = (total - commission) >= rawFrais ? rawFrais : 0
  const prixBase       = Math.max(0, parseFloat((total - commission - fraisLivraison).toFixed(2)))
  return {
    ...r,
    items:             r.items ? (typeof r.items === 'string' ? JSON.parse(r.items) : r.items) : [],
    montant_total:     total,
    montant_pharmacie: prixBase,
    commission,
    frais_livraison:   fraisLivraison,
  }
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

// GET /pharmacies
router.get('/', async (req, res) => {
  const { ville, garde, partenaire } = req.query
  try {
    let sql = `
      SELECT sp.id, sp.user_id, sp.nom, sp.adresse, sp.ville, sp.telephone,
             sp.partenaire, sp.note, sp.lat, sp.lng,
             pp.garde, pp.horaires
      FROM structure_profiles sp
      JOIN pharmacy_profiles pp ON pp.structure_id = sp.id
      WHERE sp.type LIKE '%pharma%'
    `
    const params = []
    if (ville)            { sql += ' AND sp.ville LIKE ?';   params.push(`%${ville}%`) }
    if (garde === 'true') { sql += ' AND pp.garde = 1' }
    if (partenaire === 'true') { sql += ' AND sp.partenaire = 1' }
    sql += ' ORDER BY sp.partenaire DESC, sp.nom'

    const [rows] = await pool.query(sql, params)
    res.json(rows.map(r => ({
      ...r,
      partenaire: Boolean(r.partenaire),
      garde: Boolean(r.garde),
      note: r.note ? parseFloat(r.note) : null,
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/garde
router.get('/garde', async (req, res) => {
  const { ville } = req.query
  try {
    let sql = `
      SELECT sp.id, sp.user_id, sp.nom, sp.adresse, sp.ville, sp.telephone,
             sp.partenaire, sp.note, pp.garde, pp.horaires
      FROM structure_profiles sp
      JOIN pharmacy_profiles pp ON pp.structure_id = sp.id
      WHERE sp.type LIKE '%pharma%' AND pp.garde = 1
    `
    const params = []
    if (ville) { sql += ' AND sp.ville LIKE ?'; params.push(`%${ville}%`) }
    const [rows] = await pool.query(sql, params)
    res.json(rows.map(r => ({
      ...r,
      partenaire: Boolean(r.partenaire),
      garde: Boolean(r.garde),
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/:id/medicines
router.get('/:id/medicines', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.*, COALESCE(pm.prix_local, m.prix) AS prix_final, pm.stock_local
       FROM medicines m
       LEFT JOIN pharmacy_medicines pm ON pm.medicine_id = m.id AND pm.pharmacy_id = ?
       ORDER BY m.nom`,
      [req.params.id]
    )
    res.json(rows.map(r => ({
      ...r,
      sur_ordonnance: Boolean(r.sur_ordonnance),
      prix: r.prix_final ? parseFloat(r.prix_final) : null,
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /pharmacies/orders  — patient places order after wallet.pay()
router.post('/orders', requireAuth, async (req, res) => {
  const { pharmacy_id, items, notes, adresse_livraison } = req.body
  if (!pharmacy_id || !Array.isArray(items) || !items.length) {
    return res.status(422).json({ detail: 'Données de commande invalides' })
  }
  try {
    // Resolve structure_profiles.id (handles both user_id and structure_profiles.id)
    let structureId = parseInt(pharmacy_id)
    const [spCheck] = await pool.query('SELECT id FROM structure_profiles WHERE id = ?', [structureId])
    if (!spCheck.length) {
      const [spByUser] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [structureId])
      if (spByUser.length) {
        structureId = spByUser[0].id
      } else {
        return res.status(422).json({ detail: 'Pharmacie introuvable' })
      }
    }

    let prixBase = 0
    for (const item of items) {
      const [med] = await pool.query('SELECT prix FROM medicines WHERE id = ?', [item.medicine_id])
      if (med.length) prixBase += (parseFloat(med[0].prix) || 0) * item.quantite
    }
    const commission     = parseFloat((prixBase * 0.15).toFixed(2)) // 15% ajoutée au client, pharmacie reçoit 100%
    const fraisLivraison = FRAIS_LIVRAISON_DEFAULT
    const total          = parseFloat((prixBase + commission + fraisLivraison).toFixed(2))

    const [result] = await pool.query(
      `INSERT INTO orders
         (patient_id, pharmacy_id, items, notes, adresse_livraison, total, commission, frais_livraison, statut, paiement_statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, structureId, JSON.stringify(items), notes || null, adresse_livraison || null,
       total, commission, fraisLivraison, 'en_attente', 'bloque']
    )
    const [rows] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, sp.adresse AS pharmacy_adresse, sp.telephone AS pharmacy_tel,
              sp.lat AS pharmacy_lat, sp.lng AS pharmacy_lng, sp.user_id AS pharmacy_user_id
       FROM orders o LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id WHERE o.id = ?`,
      [result.insertId]
    )

    const io = req.app.get('io')
    if (rows[0]?.pharmacy_user_id) {
      await notifyAndEmit(io, rows[0].pharmacy_user_id, 'order_new', 'Nouvelle commande reçue',
        `Commande #${result.insertId} — ${req.user.prenom || ''} ${req.user.nom}`,
        { order_id: result.insertId }
      ).catch(() => {})
      if (io) io.to(`user_${rows[0].pharmacy_user_id}`).emit('order:new', { order_id: result.insertId })
    }

    res.status(201).json(formatOrder(rows[0]))
  } catch (err) {
    console.error('[placeOrder]', err)
    res.status(500).json({ detail: err.message || 'Erreur serveur' })
  }
})

// GET /pharmacies/orders/mine  — patient's orders
router.get('/orders/mine', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, sp.telephone AS pharmacy_tel,
              sp.lat AS pharmacy_lat, sp.lng AS pharmacy_lng,
              u.nom AS livreur_nom, u.prenom AS livreur_prenom, u.telephone AS livreur_tel
       FROM orders o
       LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       LEFT JOIN users u ON u.id = o.livreur_id
       WHERE o.patient_id = ? ORDER BY o.created_at DESC`,
      [req.user.id]
    )
    res.json(rows.map(formatOrder))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/orders/pharmacy  — pharmacy sees its orders
router.get('/orders/pharmacy', requireAuth, async (req, res) => {
  try {
    const [sp] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
    if (!sp.length) return res.json([])
    const [rows] = await pool.query(
      `SELECT o.*, u.nom AS patient_nom, u.prenom AS patient_prenom,
              u.telephone AS patient_tel, u.id AS patient_user_id,
              lv.nom AS livreur_nom, lv.prenom AS livreur_prenom
       FROM orders o
       JOIN users u ON u.id = o.patient_id
       LEFT JOIN users lv ON lv.id = o.livreur_id
       WHERE o.pharmacy_id = ? ORDER BY o.created_at DESC`,
      [sp[0].id]
    )
    res.json(rows.map(formatOrder))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/orders/available-deliveries  — livreur sees available orders
router.get('/orders/available-deliveries', requireAuth, async (req, res) => {
  if (req.user.role !== 'livreur' && req.user.role !== 'admin') {
    return res.status(403).json({ detail: 'Accès réservé aux livreurs' })
  }
  try {
    const [rows] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, sp.adresse AS pharmacy_adresse, sp.telephone AS pharmacy_tel,
              sp.lat AS pharmacy_lat, sp.lng AS pharmacy_lng,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel
       FROM orders o
       LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       LEFT JOIN users u ON u.id = o.patient_id
       WHERE o.statut IN ('en_attente','en_preparation')
         AND (o.livreur_id IS NULL OR o.livreur_id = 0)
       ORDER BY o.created_at ASC`
    )
    res.json(rows.map(formatOrder))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/orders/my-deliveries  — livreur's active deliveries
router.get('/orders/my-deliveries', requireAuth, async (req, res) => {
  if (req.user.role !== 'livreur') {
    return res.status(403).json({ detail: 'Accès réservé aux livreurs' })
  }
  try {
    const [rows] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, sp.adresse AS pharmacy_adresse, sp.telephone AS pharmacy_tel,
              sp.lat AS pharmacy_lat, sp.lng AS pharmacy_lng,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel
       FROM orders o
       LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       LEFT JOIN users u ON u.id = o.patient_id
       WHERE o.livreur_id = ? AND o.statut NOT IN ('livre','annule')
       ORDER BY o.created_at DESC`,
      [req.user.id]
    )
    res.json(rows.map(formatOrder))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/orders/livreur-history
router.get('/orders/livreur-history', requireAuth, async (req, res) => {
  if (req.user.role !== 'livreur') {
    return res.status(403).json({ detail: 'Accès réservé aux livreurs' })
  }
  try {
    const [rows] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM orders o
       LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       LEFT JOIN users u ON u.id = o.patient_id
       WHERE o.livreur_id = ? AND o.statut IN ('livre','annule')
       ORDER BY o.created_at DESC LIMIT 30`,
      [req.user.id]
    )
    res.json(rows.map(formatOrder))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/orders/:id/tracking
router.get('/orders/:id/tracking', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*,
              sp.lat AS pharmacy_lat, sp.lng AS pharmacy_lng,
              sp.nom AS pharmacy_nom, sp.adresse AS pharmacy_adresse,
              lv.nom AS livreur_nom, lv.prenom AS livreur_prenom, lv.telephone AS livreur_tel,
              sp.user_id AS pharmacy_user_id
       FROM orders o
       LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       LEFT JOIN users lv ON lv.id = o.livreur_id
       WHERE o.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Commande introuvable' })
    const o = rows[0]
    res.json({
      order_id:         o.id,
      statut:           o.statut,
      livreur_statut:   o.livreur_statut || null,
      paiement_statut:  o.paiement_statut,
      montant_total:    parseFloat(o.total || 0),
      frais_livraison:  parseFloat(o.frais_livraison || FRAIS_LIVRAISON_DEFAULT),
      adresse_livraison: o.adresse_livraison,
      livreur: o.livreur_id ? {
        id:        o.livreur_id,
        nom:       o.livreur_nom,
        prenom:    o.livreur_prenom,
        telephone: o.livreur_tel,
      } : null,
      pharmacy: {
        lat:     o.pharmacy_lat  ? parseFloat(o.pharmacy_lat)  : 5.3520,
        lng:     o.pharmacy_lng  ? parseFloat(o.pharmacy_lng)  : -4.0070,
        nom:     o.pharmacy_nom,
        adresse: o.pharmacy_adresse,
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /pharmacies/orders/:id/status  — pharmacy updates order status
router.put('/orders/:id/status', requireAuth, async (req, res) => {
  const statut = req.query.statut || req.body.statut
  const validStatuts = ['en_attente', 'confirme', 'en_preparation', 'en_route', 'livre', 'annule']
  if (!validStatuts.includes(statut)) {
    return res.status(422).json({ detail: 'Statut invalide' })
  }
  try {
    await pool.query('UPDATE orders SET statut = ? WHERE id = ?', [statut, req.params.id])
    const [rows] = await pool.query(
      `SELECT o.*, u.id AS patient_user_id FROM orders o JOIN users u ON u.id = o.patient_id WHERE o.id = ?`,
      [req.params.id]
    )
    const order = rows[0]
    const io = req.app.get('io')
    if (order?.patient_user_id) {
      const label = STATUS_LABELS[statut] || statut
      await notifyAndEmit(io, order.patient_user_id, `order_${statut}`,
        `Commande #${req.params.id} — ${label}`, null,
        { order_id: parseInt(req.params.id), statut }
      ).catch(() => {})
      if (io) io.to(`user_${order.patient_user_id}`).emit('order:update', { order_id: parseInt(req.params.id), statut })
    }
    res.json(formatOrder(order))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /pharmacies/orders/:id/accept-delivery  — livreur accepts, starts vers_pharmacie automatically
router.post('/orders/:id/accept-delivery', requireAuth, async (req, res) => {
  if (req.user.role !== 'livreur') {
    return res.status(403).json({ detail: 'Accès réservé aux livreurs' })
  }
  try {
    const [rows] = await pool.query(
      `SELECT * FROM orders WHERE id = ? AND statut IN ('en_attente','en_preparation')
       AND (livreur_id IS NULL OR livreur_id = 0)`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Commande non disponible' })

    await pool.query(
      'UPDATE orders SET livreur_id = ?, livreur_statut = ?, statut = ? WHERE id = ?',
      [req.user.id, 'vers_pharmacie', 'en_preparation', req.params.id]
    )
    const [updated] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, sp.adresse AS pharmacy_adresse,
              sp.lat AS pharmacy_lat, sp.lng AS pharmacy_lng, sp.user_id AS pharmacy_user_id,
              u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM orders o LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       LEFT JOIN users u ON u.id = o.patient_id WHERE o.id = ?`,
      [req.params.id]
    )
    const io = req.app.get('io')
    const order = updated[0]
    if (order?.patient_id) {
      await notifyAndEmit(io, order.patient_id, 'order_livreur_assigne',
        `Commande #${req.params.id} — Livreur assigné`,
        `${req.user.prenom} ${req.user.nom} se dirige vers la pharmacie`,
        { order_id: parseInt(req.params.id) }
      ).catch(() => {})
      if (io) io.to(`user_${order.patient_id}`).emit('order:update',
        { order_id: parseInt(req.params.id), livreur_statut: 'vers_pharmacie' })
    }
    if (order?.pharmacy_user_id) {
      await notifyAndEmit(io, order.pharmacy_user_id, 'order_livreur_assigne',
        `Commande #${req.params.id} — Livreur en route`,
        `${req.user.prenom} ${req.user.nom} arrive bientôt`,
        { order_id: parseInt(req.params.id) }
      ).catch(() => {})
      if (io) io.to(`user_${order.pharmacy_user_id}`).emit('order:update',
        { order_id: parseInt(req.params.id), livreur_statut: 'vers_pharmacie' })
    }
    res.json(formatOrder(order))

    // ── AUTO-AVANCE : livreur arrive à la pharmacie après 45 s ───────────────
    // Indépendant de la page tracking — le statut avance côté serveur quoi qu'il arrive
    const oid45 = parseInt(req.params.id)
    const io45  = req.app.get('io')
    setTimeout(async () => {
      try {
        const [chk] = await pool.query('SELECT * FROM orders WHERE id = ?', [oid45])
        if (!chk.length || chk[0].livreur_statut !== 'vers_pharmacie') return
        await pool.query(
          "UPDATE orders SET livreur_statut = 'arrive_pharmacie', statut = 'en_preparation' WHERE id = ?",
          [oid45]
        )
        const [full] = await pool.query(
          `SELECT o.*, sp.user_id AS pharmacy_user_id
           FROM orders o LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id WHERE o.id = ?`,
          [oid45]
        )
        const f = full[0]
        const payload = { order_id: oid45, livreur_statut: 'arrive_pharmacie', statut: 'en_preparation' }
        if (f?.patient_id)       io45?.to(`user_${f.patient_id}`).emit('order:update', payload)
        if (f?.pharmacy_user_id) io45?.to(`user_${f.pharmacy_user_id}`).emit('order:update', payload)
        if (f?.livreur_id)       io45?.to(`user_${f.livreur_id}`).emit('order:update', payload)
        console.log(`📦 [auto] commande #${oid45} → arrive_pharmacie`)
      } catch (e) { console.error('[auto-pharmacie]', e.message) }
    }, 45_000)

  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /pharmacies/orders/:id/sim-arrive  — simulation auto-advances arrival status (idempotent)
// Called by the tracking page when the animated simulation reaches a destination.
// Accepts callers who are patient, pharmacie, or livreur of the order.
router.post('/orders/:id/sim-arrive', requireAuth, async (req, res) => {
  const { event } = req.body
  const validEvents = ['arrive_pharmacie', 'arrive_patient']
  if (!validEvents.includes(event)) {
    return res.status(422).json({ detail: 'Événement invalide' })
  }
  try {
    const [rows] = await pool.query(
      `SELECT o.*, sp.user_id AS pharmacy_user_id
       FROM orders o LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       WHERE o.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Commande introuvable' })
    const order = rows[0]

    const isPatient  = order.patient_id       === req.user.id
    const isPharmacy = order.pharmacy_user_id === req.user.id
    const isLivreur  = order.livreur_id       === req.user.id
    if (!isPatient && !isPharmacy && !isLivreur && req.user.role !== 'admin') {
      return res.status(403).json({ detail: 'Non autorisé' })
    }

    // Idempotent: already at this status or beyond
    const statusOrder = ['vers_pharmacie','arrive_pharmacie','vers_patient','arrive_patient','livre']
    const currentIdx  = statusOrder.indexOf(order.livreur_statut)
    const targetIdx   = statusOrder.indexOf(event)
    if (currentIdx >= targetIdx) {
      return res.json({ success: true, already: true, current: order.livreur_statut })
    }

    // Only advance from the direct predecessor
    const prerequisites = { arrive_pharmacie: 'vers_pharmacie', arrive_patient: 'vers_patient' }
    if (order.livreur_statut !== prerequisites[event]) {
      return res.json({ success: true, skipped: true, current: order.livreur_statut })
    }

    const orderStatutMap = { arrive_pharmacie: 'en_preparation', arrive_patient: 'en_route' }
    await pool.query('UPDATE orders SET livreur_statut = ?, statut = ? WHERE id = ?',
      [event, orderStatutMap[event], req.params.id])

    const io    = req.app.get('io')
    const label = LIVREUR_LABELS[event] || event
    const oid   = parseInt(req.params.id)
    if (order.patient_id) {
      await notifyAndEmit(io, order.patient_id, `order_${event}`,
        `Commande #${oid}`, label,
        { order_id: oid, livreur_statut: event }
      ).catch(() => {})
      if (io) io.to(`user_${order.patient_id}`).emit('order:update', { order_id: oid, livreur_statut: event })
    }
    if (order.pharmacy_user_id) {
      if (io) io.to(`user_${order.pharmacy_user_id}`).emit('order:update', { order_id: oid, livreur_statut: event })
    }
    if (order.livreur_id) {
      if (io) io.to(`user_${order.livreur_id}`).emit('order:update', { order_id: oid, livreur_statut: event })
    }

    res.json({ success: true })
  } catch (err) {
    console.error('[sim-arrive]', err)
    res.status(500).json({ detail: err.message || 'Erreur serveur' })
  }
})

// POST /pharmacies/orders/:id/pharmacy-handoff  — pharmacy confirms "commande remise au livreur"
router.post('/orders/:id/pharmacy-handoff', requireAuth, async (req, res) => {
  try {
    const [sp] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
    if (!sp.length) return res.status(403).json({ detail: 'Accès réservé aux pharmacies' })
    const [rows] = await pool.query(
      `SELECT o.*, u.id AS patient_user_id
       FROM orders o JOIN users u ON u.id = o.patient_id
       WHERE o.id = ? AND o.pharmacy_id = ?`,
      [req.params.id, sp[0].id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Commande introuvable' })
    const order = rows[0]

    await pool.query('UPDATE orders SET livreur_statut = ?, statut = ? WHERE id = ?',
      ['vers_patient', 'en_route', req.params.id])

    const io  = req.app.get('io')
    const oid = parseInt(req.params.id)
    if (order.patient_user_id) {
      await notifyAndEmit(io, order.patient_user_id, 'order_vers_patient',
        `Commande #${oid} — En route vers vous`,
        'Le livreur a récupéré votre commande et arrive chez vous',
        { order_id: oid }
      ).catch(() => {})
      if (io) io.to(`user_${order.patient_user_id}`).emit('order:update',
        { order_id: oid, livreur_statut: 'vers_patient', statut: 'en_route' })
    }
    if (order.livreur_id) {
      if (io) io.to(`user_${order.livreur_id}`).emit('order:update',
        { order_id: oid, livreur_statut: 'vers_patient', statut: 'en_route' })
    }
    res.json({ success: true })

    // ── AUTO-AVANCE : livreur arrive chez le patient après 45 s ─────────────
    const io2 = req.app.get('io')
    setTimeout(async () => {
      try {
        const [chk] = await pool.query('SELECT * FROM orders WHERE id = ?', [oid])
        if (!chk.length || chk[0].livreur_statut !== 'vers_patient') return
        await pool.query(
          "UPDATE orders SET livreur_statut = 'arrive_patient', statut = 'en_route' WHERE id = ?",
          [oid]
        )
        const [full] = await pool.query(
          `SELECT o.*, sp.user_id AS pharmacy_user_id
           FROM orders o LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id WHERE o.id = ?`,
          [oid]
        )
        const f = full[0]
        const payload2 = { order_id: oid, livreur_statut: 'arrive_patient', statut: 'en_route' }
        if (f?.patient_id)       io2?.to(`user_${f.patient_id}`).emit('order:update', payload2)
        if (f?.pharmacy_user_id) io2?.to(`user_${f.pharmacy_user_id}`).emit('order:update', payload2)
        if (f?.livreur_id)       io2?.to(`user_${f.livreur_id}`).emit('order:update', payload2)
        console.log(`🏠 [auto] commande #${oid} → arrive_patient`)
      } catch (e) { console.error('[auto-patient]', e.message) }
    }, 45_000)

  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /pharmacies/orders/:id/livreur-status  — (legacy, kept for compatibility)
router.put('/orders/:id/livreur-status', requireAuth, async (req, res) => {
  if (req.user.role !== 'livreur' && req.user.role !== 'admin') {
    return res.status(403).json({ detail: 'Accès réservé aux livreurs' })
  }
  const { livreur_statut } = req.body
  const validStatuts = ['vers_pharmacie', 'arrive_pharmacie', 'vers_patient', 'arrive_patient', 'livre']
  if (!validStatuts.includes(livreur_statut)) {
    return res.status(422).json({ detail: 'Statut invalide' })
  }
  try {
    const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND livreur_id = ?',
      [req.params.id, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Commande introuvable' })

    const orderStatutMap = {
      vers_pharmacie:   'en_preparation',
      arrive_pharmacie: 'en_preparation',
      vers_patient:     'en_route',
      arrive_patient:   'en_route',
      livre:            'livre',
    }
    await pool.query('UPDATE orders SET livreur_statut = ?, statut = ? WHERE id = ?',
      [livreur_statut, orderStatutMap[livreur_statut], req.params.id])

    const [updated] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, sp.user_id AS pharmacy_user_id,
              u.nom AS patient_nom FROM orders o
       LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       LEFT JOIN users u ON u.id = o.patient_id WHERE o.id = ?`,
      [req.params.id]
    )
    const io    = req.app.get('io')
    const label = LIVREUR_LABELS[livreur_statut] || livreur_statut
    const oid   = parseInt(req.params.id)
    if (updated[0]?.patient_id) {
      await notifyAndEmit(io, updated[0].patient_id, `order_${livreur_statut}`,
        `Commande #${oid}`, label, { order_id: oid, livreur_statut }).catch(() => {})
      if (io) io.to(`user_${updated[0].patient_id}`).emit('order:update',
        { order_id: oid, livreur_statut, statut: orderStatutMap[livreur_statut] })
    }
    if (updated[0]?.pharmacy_user_id) {
      if (io) io.to(`user_${updated[0].pharmacy_user_id}`).emit('order:update',
        { order_id: oid, livreur_statut, statut: orderStatutMap[livreur_statut] })
    }
    res.json(formatOrder(updated[0]))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /pharmacies/orders/:id/confirm-receipt  — patient confirms delivery & releases escrow
router.post('/orders/:id/confirm-receipt', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*, sp.user_id AS pharmacy_user_id
       FROM orders o LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       WHERE o.id = ? AND o.patient_id = ?`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Commande introuvable' })
    const order = rows[0]

    if (order.paiement_statut === 'libere') {
      return res.status(422).json({ detail: 'Fonds déjà libérés' })
    }

    await pool.query(
      'UPDATE orders SET statut = ?, livreur_statut = ?, paiement_statut = ? WHERE id = ?',
      ['livre', 'livre', 'libere', req.params.id]
    )

    const total      = parseFloat(order.total      || 0)
    const commission = parseFloat(order.commission || 0)
    const rawFrais   = parseFloat(order.frais_livraison || FRAIS_LIVRAISON_DEFAULT)
    // Same old-order guard as formatOrder
    const fraisLivraison = (total - commission) >= rawFrais ? rawFrais : 0
    const prixBase       = Math.max(0, parseFloat((total - commission - fraisLivraison).toFixed(2)))
    const oid            = parseInt(req.params.id)

    // Credit pharmacy: price of medicines
    if (order.pharmacy_user_id) {
      const pw = await getOrCreateWallet(order.pharmacy_user_id)
      await pool.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [prixBase, pw.id])
      await addTransaction(pw.id, prixBase, 'credit', `Commande #${oid} — Paiement reçu`, oid)
    }

    // Credit livreur: delivery fee
    if (order.livreur_id) {
      try {
        const lw = await getOrCreateWallet(order.livreur_id)
        await pool.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [fraisLivraison, lw.id])
        await addTransaction(lw.id, fraisLivraison, 'credit', `Livraison commande #${oid}`, oid)
      } catch (e) { /* non-blocking */ }
    }

    // Credit admin (user id=1): commission
    try {
      const aw = await getOrCreateWallet(1)
      await pool.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [commission, aw.id])
      await addTransaction(aw.id, commission, 'credit', `Commission commande #${oid}`, oid)
    } catch (e) { /* non-blocking */ }

    const io = req.app.get('io')
    if (order.pharmacy_user_id) {
      await notifyAndEmit(io, order.pharmacy_user_id, 'order_livre',
        `Commande #${oid} — Paiement libéré`,
        `Vous avez reçu ${prixBase.toLocaleString('fr-FR')} FCFA`,
        { order_id: oid }
      ).catch(() => {})
      if (io) io.to(`user_${order.pharmacy_user_id}`).emit('order:update',
        { order_id: oid, statut: 'livre', paiement_statut: 'libere' })
    }
    if (order.livreur_id) {
      await notifyAndEmit(io, order.livreur_id, 'livraison_paiement',
        `Livraison #${oid} — Paiement reçu`,
        `Vous avez reçu ${fraisLivraison.toLocaleString('fr-FR')} FCFA`,
        { order_id: oid }
      ).catch(() => {})
      if (io) io.to(`user_${order.livreur_id}`).emit('order:update',
        { order_id: oid, statut: 'livre', gains: fraisLivraison })
    }

    res.json({
      success: true,
      montant_pharmacie: prixBase,
      montant_livreur:   fraisLivraison,
      commission,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /pharmacies/orders/myorders (alias)
router.get('/orders/myorders', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.*, sp.nom AS pharmacy_nom, sp.telephone AS pharmacy_tel
       FROM orders o LEFT JOIN structure_profiles sp ON sp.id = o.pharmacy_id
       WHERE o.patient_id = ? ORDER BY o.created_at DESC`,
      [req.user.id]
    )
    res.json(rows.map(formatOrder))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
