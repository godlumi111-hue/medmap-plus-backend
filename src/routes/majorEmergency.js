const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

// ── Auto-create tables ────────────────────────────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS major_emergencies (
        id INT PRIMARY KEY AUTO_INCREMENT,
        reporter_id INT,
        type VARCHAR(100) NOT NULL,
        description TEXT,
        nb_victimes INT DEFAULT 0,
        feu TINYINT(1) DEFAULT 0,
        gravite VARCHAR(50) DEFAULT 'critique',
        lat DECIMAL(10,7),
        lng DECIMAL(10,7),
        adresse TEXT,
        statut VARCHAR(50) DEFAULT 'nouveau',
        needs_samu TINYINT(1) DEFAULT 0,
        needs_pompiers TINYINT(1) DEFAULT 0,
        needs_ambulance TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_me_statut (statut),
        INDEX idx_me_reporter (reporter_id)
      ) ENGINE=InnoDB
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS emergency_responses (
        id INT PRIMARY KEY AUTO_INCREMENT,
        emergency_id INT NOT NULL,
        responder_id INT NOT NULL,
        responder_role VARCHAR(50) NOT NULL,
        statut VARCHAR(50) DEFAULT 'assigne',
        vehicle_lat DECIMAL(10,7),
        vehicle_lng DECIMAL(10,7),
        eta_minutes INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_er_emergency (emergency_id),
        INDEX idx_er_responder (responder_id)
      ) ENGINE=InnoDB
    `)
    console.log('   ✅ Tables urgences majeures : OK')
  } catch (e) {
    if (!e.message.includes('already exists')) console.error('major_emergency init:', e.message)
  }
})()

// ── Dispatch rules ────────────────────────────────────────────────────────────
const DISPATCH = {
  incendie:        { samu: 1, pompiers: 1, ambulance: 1 },
  accident_grave:  { samu: 1, pompiers: 0, ambulance: 1 },
  explosion:       { samu: 1, pompiers: 1, ambulance: 1 },
  malaise_collectif:{ samu: 1, pompiers: 0, ambulance: 1 },
  catastrophe:     { samu: 1, pompiers: 1, ambulance: 1 },
  animal_dangereux:{ samu: 0, pompiers: 1, ambulance: 0 },
  effondrement:    { samu: 1, pompiers: 1, ambulance: 1 },
  urgence_medicale:{ samu: 1, pompiers: 0, ambulance: 1 },
  autre:           { samu: 1, pompiers: 0, ambulance: 0 },
}

// ── POST /major-emergency — signaler une urgence majeure ──────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { type, description, nb_victimes, feu, gravite, lat, lng, adresse } = req.body
  if (!type) return res.status(422).json({ detail: 'Type requis' })

  const reporterId = req.user.id
  const dispatch = DISPATCH[type] || { samu: 1, pompiers: 0, ambulance: 1 }

  // Deduct 5000 FCFA from patient wallet → credit admin wallet (MedMap+)
  {
    const [walletRows] = await pool.query('SELECT id, solde FROM wallets WHERE user_id = ?', [reporterId])
    if (!walletRows.length || Number(walletRows[0].solde) < 5000) {
      return res.status(422).json({
        detail: 'Solde insuffisant pour déclencher une urgence (5 000 FCFA requis).',
        solde_insuffisant: true,
        montant_requis: 5000,
      })
    }
    await pool.query('UPDATE wallets SET solde = solde - 5000 WHERE id = ?', [walletRows[0].id])
    await pool.query(
      'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, 5000, "debit", ?)',
      [walletRows[0].id, 'Frais alerte urgence MedMap+ (5 000 FCFA)']
    )
    const [adminWallet] = await pool.query("SELECT id FROM wallets WHERE user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)")
    if (adminWallet.length) {
      await pool.query('UPDATE wallets SET solde = solde + 5000 WHERE id = ?', [adminWallet[0].id])
      await pool.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, 5000, "credit", ?)',
        [adminWallet[0].id, `Frais urgence majeure — patient #${reporterId}`]
      )
    }
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO major_emergencies
         (reporter_id, type, description, nb_victimes, feu, gravite, lat, lng, adresse,
          needs_samu, needs_pompiers, needs_ambulance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reporterId, type, description || null, nb_victimes || 0,
       feu ? 1 : 0, gravite || 'critique',
       lat || null, lng || null, adresse || null,
       dispatch.samu, dispatch.pompiers, dispatch.ambulance]
    )
    const emergencyId = result.insertId
    const [rows] = await pool.query('SELECT * FROM major_emergencies WHERE id = ?', [emergencyId])
    const emergency = rows[0]

    const io = req.app.get('io')

    // Notify all relevant responders
    const rolesToNotify = []
    if (dispatch.samu) rolesToNotify.push('samu')
    if (dispatch.pompiers) rolesToNotify.push('pompiers')
    if (dispatch.ambulance) rolesToNotify.push('ambulance')

    for (const role of rolesToNotify) {
      const [responders] = await pool.query(
        "SELECT id FROM users WHERE role = ? AND is_active = 1", [role]
      )
      for (const r of responders) {
        await notifyAndEmit(io, r.id, 'major_emergency',
          `🚨 URGENCE MAJEURE — ${type.toUpperCase()}`,
          `${nb_victimes || 'Plusieurs'} victime(s) · ${gravite?.toUpperCase() || 'CRITIQUE'} · ${adresse || 'Position GPS transmise'}`,
          { emergency_id: emergencyId, type, gravite, lat, lng }
        )
        if (io) {
          io.to(`user_${r.id}`).emit('major_emergency:new', {
            ...emergency,
            emergency_id: emergencyId,
          })
        }
      }
    }

    // Also broadcast to role rooms
    if (io) {
      io.to('role_samu').emit('major_emergency:new', { ...emergency })
      io.to('role_pompiers').emit('major_emergency:new', { ...emergency })
      io.to('role_ambulance').emit('major_emergency:new', { ...emergency })
    }

    res.status(201).json(emergency)
  } catch (e) {
    console.error('POST /major-emergency:', e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /major-emergency — liste (pour les services d'urgence) ────────────────
router.get('/', requireAuth, async (req, res) => {
  const allowed = ['samu', 'pompiers', 'ambulance', 'admin']
  if (!allowed.includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const role = req.user.role
    let where = ''
    if (role === 'samu')      where = 'WHERE needs_samu = 1'
    else if (role === 'pompiers') where = 'WHERE needs_pompiers = 1'
    else if (role === 'ambulance') where = 'WHERE needs_ambulance = 1'

    const [rows] = await pool.query(
      `SELECT me.*, u.nom AS reporter_nom, u.prenom AS reporter_prenom, u.telephone AS reporter_tel
       FROM major_emergencies me
       LEFT JOIN users u ON u.id = me.reporter_id
       ${where}
       ORDER BY me.created_at DESC
       LIMIT 50`
    )

    // Attach responses
    const ids = rows.map(r => r.id)
    let responsesByEmergency = {}
    if (ids.length) {
      const [responses] = await pool.query(
        `SELECT er.*, u.nom, u.prenom, u.telephone
         FROM emergency_responses er JOIN users u ON u.id = er.responder_id
         WHERE er.emergency_id IN (?)`, [ids]
      )
      for (const r of responses) {
        if (!responsesByEmergency[r.emergency_id]) responsesByEmergency[r.emergency_id] = []
        responsesByEmergency[r.emergency_id].push(r)
      }
    }

    res.json(rows.map(r => ({ ...r, responses: responsesByEmergency[r.id] || [] })))
  } catch (e) {
    console.error('GET /major-emergency:', e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /major-emergency/my — suivi pour le patient ──────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT me.* FROM major_emergencies me
       WHERE me.reporter_id = ?
       ORDER BY me.created_at DESC LIMIT 10`,
      [req.user.id]
    )
    const ids = rows.map(r => r.id)
    let responsesByEmergency = {}
    if (ids.length) {
      const [responses] = await pool.query(
        `SELECT er.*, u.nom, u.prenom
         FROM emergency_responses er JOIN users u ON u.id = er.responder_id
         WHERE er.emergency_id IN (?)`, [ids]
      )
      for (const r of responses) {
        if (!responsesByEmergency[r.emergency_id]) responsesByEmergency[r.emergency_id] = []
        responsesByEmergency[r.emergency_id].push(r)
      }
    }
    res.json(rows.map(r => ({ ...r, responses: responsesByEmergency[r.id] || [] })))
  } catch (e) {
    console.error(e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /major-emergency/:id ──────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT me.*, u.nom AS reporter_nom, u.prenom AS reporter_prenom, u.telephone AS reporter_tel
       FROM major_emergencies me LEFT JOIN users u ON u.id = me.reporter_id
       WHERE me.id = ?`, [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Urgence introuvable' })
    const emergency = rows[0]

    // Check access
    const allowed = ['samu', 'pompiers', 'ambulance', 'admin']
    if (!allowed.includes(req.user.role) && emergency.reporter_id !== req.user.id) {
      return res.status(403).json({ detail: 'Accès refusé' })
    }

    const [responses] = await pool.query(
      `SELECT er.*, u.nom, u.prenom, u.telephone
       FROM emergency_responses er JOIN users u ON u.id = er.responder_id
       WHERE er.emergency_id = ?`, [req.params.id]
    )
    res.json({ ...emergency, responses })
  } catch (e) {
    console.error(e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /major-emergency/:id/accept — accepter la mission ───────────────────
router.post('/:id/accept', requireAuth, async (req, res) => {
  const allowed = ['samu', 'pompiers', 'ambulance']
  if (!allowed.includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })

  try {
    const [rows] = await pool.query('SELECT * FROM major_emergencies WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ detail: 'Urgence introuvable' })
    const emergency = rows[0]

    // Check if already responded by this user
    const [existing] = await pool.query(
      'SELECT id FROM emergency_responses WHERE emergency_id = ? AND responder_id = ?',
      [req.params.id, req.user.id]
    )
    if (existing.length) return res.json({ already: true, response_id: existing[0].id })

    const [respRes] = await pool.query(
      `INSERT INTO emergency_responses (emergency_id, responder_id, responder_role, statut)
       VALUES (?, ?, ?, 'en_route')`,
      [req.params.id, req.user.id, req.user.role]
    )
    const responseId = respRes.insertId

    await pool.query(
      "UPDATE major_emergencies SET statut = 'accepte' WHERE id = ? AND statut = 'nouveau'",
      [req.params.id]
    )

    const io = req.app.get('io')
    // Notify reporter
    if (emergency.reporter_id) {
      const roleLabel = { samu: 'SAMU', pompiers: 'Pompiers', ambulance: 'Ambulance' }[req.user.role] || req.user.role
      await notifyAndEmit(io, emergency.reporter_id, 'emergency_accepted',
        `✅ ${roleLabel} en route`,
        `Les secours ont accepté votre alerte et sont en route. ETA estimé : 8-12 min.`,
        { emergency_id: parseInt(req.params.id), response_id: responseId }
      )
      io?.to(`user_${emergency.reporter_id}`).emit('major_emergency:update', {
        emergency_id: parseInt(req.params.id),
        statut: 'accepte',
        responder_role: req.user.role,
        response_id: responseId,
      })
    }

    res.status(201).json({ response_id: responseId, success: true })
  } catch (e) {
    console.error(e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /major-emergency/:id/patient-confirm — patient confirme l'arrivée ────
router.post('/:id/patient-confirm', requireAuth, async (req, res) => {
  const { role } = req.body
  const validRoles = ['samu', 'pompiers', 'ambulance']
  if (!validRoles.includes(role)) return res.status(422).json({ detail: 'Rôle invalide' })

  try {
    const [[em]] = await pool.query('SELECT * FROM major_emergencies WHERE id = ?', [req.params.id])
    if (!em) return res.status(404).json({ detail: 'Urgence introuvable' })
    if (Number(em.reporter_id) !== Number(req.user.id)) {
      return res.status(403).json({ detail: 'Seul le signaleur peut confirmer l\'arrivée' })
    }

    const [result] = await pool.query(
      "UPDATE emergency_responses SET statut = 'sur_place' WHERE emergency_id = ? AND responder_role = ? AND statut = 'en_route'",
      [req.params.id, role]
    )
    if (result.affectedRows === 0) {
      return res.status(422).json({ detail: 'Ce service n\'est pas en route ou déjà confirmé' })
    }

    const io = req.app.get('io')
    const updatePayload = { emergency_id: parseInt(req.params.id), statut: 'sur_place', responder_role: role }
    // Notify the responder role room + reporter
    io?.to(`role_${role}`).emit('major_emergency:update', updatePayload)
    io?.to(`user_${em.reporter_id}`).emit('major_emergency:update', updatePayload)

    res.json({ success: true })
  } catch (e) {
    console.error('patient-confirm:', e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /major-emergency/:id/position — mettre à jour position véhicule ─────
router.post('/:id/position', requireAuth, async (req, res) => {
  const { lat, lng, eta_minutes } = req.body
  const allowed = ['samu', 'pompiers', 'ambulance']
  if (!allowed.includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })
  try {
    await pool.query(
      `UPDATE emergency_responses
       SET vehicle_lat = ?, vehicle_lng = ?, eta_minutes = ?, updated_at = NOW()
       WHERE emergency_id = ? AND responder_id = ?`,
      [lat, lng, eta_minutes || null, req.params.id, req.user.id]
    )
    const [rows] = await pool.query('SELECT reporter_id FROM major_emergencies WHERE id = ?', [req.params.id])
    const io = req.app.get('io')
    if (rows[0]?.reporter_id && io) {
      io.to(`user_${rows[0].reporter_id}`).emit('major_emergency:position', {
        emergency_id: parseInt(req.params.id),
        lat, lng, eta_minutes,
        responder_role: req.user.role,
      })
    }
    res.json({ success: true })
  } catch (e) {
    console.error(e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /major-emergency/:id/status — changer statut mission ────────────────
router.post('/:id/status', requireAuth, async (req, res) => {
  const { statut } = req.body
  const validStatuts = ['en_route', 'sur_place', 'prise_en_charge', 'vers_hopital', 'termine']
  if (!validStatuts.includes(statut)) return res.status(422).json({ detail: 'Statut invalide' })
  const allowed = ['samu', 'pompiers', 'ambulance']
  if (!allowed.includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })

  try {
    await pool.query(
      `UPDATE emergency_responses SET statut = ? WHERE emergency_id = ? AND responder_id = ?`,
      [statut, req.params.id, req.user.id]
    )
    if (statut === 'termine') {
      // Close only when ALL needed services have responded 'termine'
      const [[em]] = await pool.query('SELECT needs_samu, needs_pompiers, needs_ambulance FROM major_emergencies WHERE id = ?', [req.params.id])
      const [doneResps] = await pool.query(
        "SELECT responder_role FROM emergency_responses WHERE emergency_id = ? AND statut = 'termine'",
        [req.params.id]
      )
      const doneRoles = new Set(doneResps.map(r => r.responder_role))
      const allDone =
        (!em.needs_samu      || doneRoles.has('samu'))      &&
        (!em.needs_pompiers  || doneRoles.has('pompiers'))  &&
        (!em.needs_ambulance || doneRoles.has('ambulance'))
      if (allDone) {
        await pool.query("UPDATE major_emergencies SET statut = 'termine' WHERE id = ?", [req.params.id])
      }
    }

    const [rows] = await pool.query('SELECT reporter_id FROM major_emergencies WHERE id = ?', [req.params.id])
    const io = req.app.get('io')

    const statusMessages = {
      en_route: '🚑 Secours en route vers vous',
      sur_place: '📍 Secours arrivés sur place',
      prise_en_charge: '🏥 Patient pris en charge',
      vers_hopital: '🚑 Transport vers l\'hôpital',
      termine: '✅ Intervention terminée',
    }

    if (rows[0]?.reporter_id) {
      await notifyAndEmit(io, rows[0].reporter_id, 'emergency_status',
        statusMessages[statut] || 'Mise à jour urgence',
        `Statut : ${statut.replace(/_/g, ' ')}`,
        { emergency_id: parseInt(req.params.id), statut }
      )
      io?.to(`user_${rows[0].reporter_id}`).emit('major_emergency:update', {
        emergency_id: parseInt(req.params.id), statut,
      })
    }

    res.json({ success: true })
  } catch (e) {
    console.error(e.message)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
