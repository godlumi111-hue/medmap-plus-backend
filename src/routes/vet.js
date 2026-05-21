const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

const COMMISSION_TAUX = 10
const ADMIN_USER_ID = 1

async function getStructureId(userId) {
  const [rows] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [userId])
  return rows[0]?.id ?? null
}

function parseFrequence(freq) {
  if (!freq) return ['08:00']
  const f = freq.toLowerCase()
  if (f.includes('matin') && f.includes('soir')) return ['08:00', '20:00']
  if (f.includes('3') || f.includes('trois')) return ['08:00', '13:00', '20:00']
  if (f.includes('soir')) return ['20:00']
  return ['08:00']
}

function parseDureeJours(duree) {
  if (!duree) return 7
  const m = duree.match(/(\d+)\s*(jour|j|semaine|mois)/i)
  if (!m) return 7
  const n = parseInt(m[1])
  if (m[2].startsWith('semaine')) return n * 7
  if (m[2].startsWith('mois')) return n * 30
  return n
}

function addDays(dateStr, days) {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── GET /vet/dashboard ────────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    if (!structureId) return res.status(404).json({ detail: 'Structure introuvable' })

    // Pending appointments
    const [pending] = await pool.query(
      `SELECT a.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel,
              an.nom AS animal_nom, an.espece AS animal_espece, an.race AS animal_race,
              an.poids AS animal_poids, an.id AS animal_id_real
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       LEFT JOIN animals an ON an.id = a.animal_id
       WHERE a.structure_id = ? AND a.statut = 'en_attente'
       ORDER BY a.date_rdv ASC, a.heure_rdv ASC`,
      [structureId]
    )

    // Confirmed appointments today + upcoming
    const [confirmed] = await pool.query(
      `SELECT a.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel,
              an.nom AS animal_nom, an.espece AS animal_espece, an.race AS animal_race,
              an.id AS animal_id_real
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       LEFT JOIN animals an ON an.id = a.animal_id
       WHERE a.structure_id = ? AND a.statut = 'confirme'
       ORDER BY a.date_rdv ASC, a.heure_rdv ASC`,
      [structureId]
    )

    // Done today
    const [done] = await pool.query(
      `SELECT a.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom,
              an.nom AS animal_nom, an.espece AS animal_espece
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       LEFT JOIN animals an ON an.id = a.animal_id
       WHERE a.structure_id = ? AND a.statut = 'termine' AND DATE(a.date_rdv) = CURDATE()
       ORDER BY a.date_rdv DESC`,
      [structureId]
    )

    // Escrow payments pending
    const [payments] = await pool.query(
      `SELECT p.*, u.nom AS payer_nom, u.prenom AS payer_prenom
       FROM payments p JOIN users u ON u.id = p.payer_id
       WHERE p.structure_id = ? ORDER BY p.created_at DESC LIMIT 50`,
      [structureId]
    )

    const [walletRows] = await pool.query('SELECT solde FROM wallets WHERE user_id = ?', [req.user.id])

    const [stats] = await pool.query(
      `SELECT
         COUNT(*) AS total_rdv,
         SUM(statut = 'en_attente') AS en_attente,
         SUM(statut = 'confirme') AS confirme,
         SUM(statut = 'termine') AS termine,
         SUM(statut = 'refuse') AS refuse
       FROM appointments WHERE structure_id = ? AND DATE(created_at) = CURDATE()`,
      [structureId]
    )

    // Fetch structure + vet profile info
    const [structRows] = await pool.query(
      `SELECT sp.nom, sp.adresse, sp.ville, sp.telephone, sp.note, sp.partenaire,
              vp.services AS vet_services, vp.horaires AS vet_horaires
       FROM structure_profiles sp
       LEFT JOIN vet_profiles vp ON vp.structure_id = sp.id
       WHERE sp.id = ?`,
      [structureId]
    )
    const structInfo = structRows[0] ?? {}

    // Combined appointments list (pending first, then confirmed, then done)
    const allAppts = [
      ...pending.map(a => ({ ...a, animal_id: a.animal_id_real ?? a.animal_id })),
      ...confirmed.map(a => ({ ...a, animal_id: a.animal_id_real ?? a.animal_id })),
      ...done.map(a => ({ ...a, animal_id: a.animal_id_real ?? a.animal_id })),
    ]

    // Rooms + queue
    let rooms = [], queueEntries = []
    try {
      const [rRows] = await pool.query('SELECT * FROM vet_rooms WHERE structure_id = ? ORDER BY ordre', [structureId])
      rooms = rRows
      const [qRows] = await pool.query(
        `SELECT vq.*, vr.nom as room_nom FROM vet_queue vq
         LEFT JOIN vet_rooms vr ON vr.id = vq.room_id
         WHERE vq.structure_id = ? AND vq.statut IN ('en_attente','appele','en_cours')
         ORDER BY vq.type DESC, vq.position ASC`,
        [structureId]
      )
      queueEntries = qRows

      // Enrich rooms with queue counts
      const qCounts = {}
      for (const q of qRows) if (q.room_id) qCounts[q.room_id] = (qCounts[q.room_id] || 0) + 1
      rooms = rooms.map(r => ({ ...r, queue_count: qCounts[r.id] || 0 }))
    } catch (_) {}

    res.json({
      structure_id: structureId,
      appointments: allAppts,
      structure: {
        nom: structInfo.nom,
        adresse: structInfo.adresse,
        ville: structInfo.ville,
        telephone: structInfo.telephone,
      },
      vet_profile: {
        services: structInfo.vet_services ? JSON.parse(structInfo.vet_services) : [],
        horaires: structInfo.vet_horaires,
      },
      note: structInfo.note ? parseFloat(structInfo.note) : null,
      payments,
      wallet_solde: walletRows[0]?.solde ?? 0,
      stats: stats[0],
      rooms,
      queue: queueEntries,
    })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/confirm — vétérinaire confirme le RDV ──────────
router.post('/appointments/:id/confirm', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      'SELECT a.*, u.id AS patient_user_id FROM appointments a JOIN users u ON u.id = a.patient_id WHERE a.id = ? AND a.structure_id = ?',
      [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const appt = rows[0]

    await pool.query("UPDATE appointments SET statut = 'confirme' WHERE id = ?", [req.params.id])

    // Auto-add to queue if not already there
    try {
      const [existQ] = await pool.query('SELECT id FROM vet_queue WHERE appointment_id = ?', [req.params.id])
      if (!existQ.length) {
        const [maxPos] = await pool.query(
          'SELECT COALESCE(MAX(position),0) as max FROM vet_queue WHERE structure_id = ? AND statut IN ("en_attente","appele")',
          [structureId]
        )
        const pos = parseInt(maxPos[0].max) + 1
        const ticket = `VET${Date.now().toString().slice(-5)}`
        await pool.query(
          `INSERT INTO vet_queue (structure_id, appointment_id, patient_id, animal_name, animal_species, owner_name, type, position, ticket_numero)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [structureId, appt.id, appt.patient_user_id,
           appt.animal_nom ?? null, appt.animal_espece ?? null,
           [appt.patient_prenom, appt.patient_nom].filter(Boolean).join(' '),
           appt.type_rdv === 'urgence' ? 'urgence' : 'normal',
           pos, ticket]
        )
      }
    } catch (_) {}

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_user_id, 'appointment_confirme',
      '✅ RDV vétérinaire confirmé',
      `Votre rendez-vous vétérinaire du ${appt.date_rdv} à ${appt.heure_rdv} est confirmé.`,
      { appointment_id: parseInt(req.params.id) }
    )
    io?.to(`user_${appt.patient_user_id}`).emit('appointment:update', {
      appointment_id: parseInt(req.params.id), statut: 'confirme',
    })

    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/reject — refuser le RDV ───────────────────────
router.post('/appointments/:id/reject', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { motif_refus } = req.body
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const structureId = await getStructureId(req.user.id)
    const [rows] = await conn.query(
      'SELECT * FROM appointments WHERE id = ? AND structure_id = ?',
      [req.params.id, structureId]
    )
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const appt = rows[0]

    await conn.query("UPDATE appointments SET statut = 'refuse' WHERE id = ?", [req.params.id])

    if (appt.paiement_statut === 'bloque' && appt.paiement_id && parseFloat(appt.prix || 0) > 0) {
      const [pw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [appt.patient_id])
      if (pw.length) {
        await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [parseFloat(appt.prix), pw[0].id])
        await conn.query(
          'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
          [pw[0].id, parseFloat(appt.prix), 'Remboursement RDV vétérinaire refusé']
        )
      }
      await conn.query("UPDATE payments SET statut = 'rembourse' WHERE id = ?", [appt.paiement_id])
      await conn.query("UPDATE appointments SET paiement_statut = 'rembourse' WHERE id = ?", [req.params.id])
    }

    await conn.commit()

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_id, 'appointment_refuse',
      '❌ RDV vétérinaire refusé',
      motif_refus || 'Votre demande de rendez-vous vétérinaire a été refusée.',
      { appointment_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (e) {
    await conn.rollback()
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  } finally { conn.release() }
})

// ── POST /vet/appointments/:id/finish — consultation terminée ─────────────────
router.post('/appointments/:id/finish', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? AND structure_id = ?',
      [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]
    if (!['confirme'].includes(appt.statut)) {
      return res.status(422).json({ detail: 'Le RDV doit être confirmé d\'abord.' })
    }

    await pool.query(
      "UPDATE appointments SET statut = 'termine', consultation_statut = 'effectuee' WHERE id = ?",
      [req.params.id]
    )

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_id, 'vet_consultation_done',
      '🐾 Consultation vétérinaire terminée',
      `La consultation de votre animal est terminée. Confirmez pour valider le paiement.`,
      { appointment_id: parseInt(req.params.id), action: 'confirm_consultation' }
    )
    io?.to(`user_${appt.patient_id}`).emit('appointment:update', {
      appointment_id: parseInt(req.params.id), statut: 'termine', consultation_statut: 'effectuee',
      action: 'confirm_consultation',
    })

    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/prescription — ordonnance vétérinaire ──────────
router.post('/appointments/:id/prescription', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { medicaments, consignes, recommandations, notes } = req.body
  if (!medicaments || !Array.isArray(medicaments)) {
    return res.status(422).json({ detail: 'Liste de médicaments requise' })
  }
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? AND structure_id = ?',
      [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]

    const [prescRes] = await pool.query(
      `INSERT INTO vet_prescriptions (animal_id, appointment_id, veterinaire_id, medicaments, consignes, recommandations, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [appt.animal_id, appt.id, req.user.id, JSON.stringify(medicaments),
       consignes || null, recommandations || null, notes || null]
    )
    const prescId = prescRes.insertId

    // MediA reminders for each medication
    if (appt.animal_id) {
      const [animalRows] = await pool.query('SELECT name AS nom, owner_id FROM pet_animals WHERE id = ?', [appt.animal_id])
      if (animalRows[0]) {
        const animalNom = animalRows[0].nom
        const today = new Date().toISOString().slice(0, 10)
        for (const med of medicaments) {
          if (!med.nom) continue
          const horaires = parseFrequence(med.frequence)
          const dateFin = med.duree ? addDays(today, parseDureeJours(med.duree)) : null
          for (const h of horaires) {
            await pool.query(
              `INSERT INTO medical_reminders
                 (patient_id, type, titre, description, horaire, date_debut, date_fin, medicament_nom)
               VALUES (?, 'medicament', ?, ?, ?, ?, ?, ?)`,
              [animalRows[0].owner_id,
               `💊 ${animalNom} — ${med.nom}`,
               [med.dosage, med.instructions].filter(Boolean).join(' · '),
               h, today, dateFin, `[${animalNom}] ${med.nom}`]
            )
          }
        }

        const io = req.app.get('io')
        await notifyAndEmit(io, animalRows[0].owner_id, 'vet_prescription',
          `📋 Ordonnance vétérinaire — ${animalNom}`,
          `L'ordonnance de ${animalNom} est disponible avec ${medicaments.length} médicament(s).`,
          { appointment_id: parseInt(req.params.id), prescription_id: prescId }
        )
      }
    }

    res.status(201).json({ id: prescId, success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/vaccine — vaccin administré ───────────────────
router.post('/appointments/:id/vaccine', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { nom, date_admin, prochaine_date, lot, notes } = req.body
  if (!nom) return res.status(422).json({ detail: 'Nom du vaccin requis' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? AND structure_id = ?',
      [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]
    if (!appt.animal_id) return res.status(422).json({ detail: 'Aucun animal lié à ce RDV' })

    const dateAdmin = date_admin || new Date().toISOString().slice(0, 10)
    const vetNom = `${req.user.prenom} ${req.user.nom}`

    const [vaccRes] = await pool.query(
      `INSERT INTO vet_vaccines (animal_id, appointment_id, nom, date_admin, prochaine_date, lot, veterinaire_nom, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [appt.animal_id, appt.id, nom, dateAdmin, prochaine_date || null, lot || null, vetNom, notes || null]
    )

    // MediA reminder for next vaccine
    if (prochaine_date) {
      const [animalRows] = await pool.query('SELECT name AS nom, owner_id FROM pet_animals WHERE id = ?', [appt.animal_id])
      if (animalRows[0]) {
        await pool.query(
          `INSERT INTO medical_reminders
             (patient_id, type, titre, description, date_debut, date_fin, medicament_nom)
           VALUES (?, 'examen', ?, ?, ?, ?, ?)`,
          [animalRows[0].owner_id,
           `🐾 Rappel vaccin — ${animalRows[0].nom} — ${nom}`,
           `Rappel du vaccin ${nom} pour ${animalRows[0].nom}`,
           prochaine_date, prochaine_date,
           `[${animalRows[0].nom}] Rappel ${nom}`]
        )

        const io = req.app.get('io')
        await notifyAndEmit(io, animalRows[0].owner_id, 'vet_vaccine',
          `💉 Vaccin administré — ${animalRows[0].nom}`,
          `Le vaccin ${nom} a été administré. Prochain rappel: ${prochaine_date}.`,
          { appointment_id: parseInt(req.params.id) }
        )
      }
    }

    res.status(201).json({ id: vaccRes.insertId, success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /vet/rooms — salles de la clinique ────────────────────────────────────
router.get('/rooms', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    if (!structureId) return res.status(404).json({ detail: 'Structure introuvable' })

    const [rooms] = await pool.query(
      'SELECT * FROM vet_rooms WHERE structure_id = ? ORDER BY ordre ASC', [structureId]
    )
    let queueCounts = {}
    try {
      const [qRows] = await pool.query(
        `SELECT room_id, COUNT(*) as count FROM vet_queue
         WHERE structure_id = ? AND statut IN ('en_attente','appele','en_cours') GROUP BY room_id`,
        [structureId]
      )
      for (const q of qRows) queueCounts[q.room_id] = parseInt(q.count)
    } catch (_) {}

    res.json(rooms.map(r => ({ ...r, queue_count: queueCounts[r.id] || 0 })))
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /vet/queue — file d'attente courante ──────────────────────────────────
router.get('/queue', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    if (!structureId) return res.status(404).json({ detail: 'Structure introuvable' })

    const [entries] = await pool.query(
      `SELECT vq.*, vr.nom as room_nom, vr.type as room_type
       FROM vet_queue vq
       LEFT JOIN vet_rooms vr ON vr.id = vq.room_id
       WHERE vq.structure_id = ? AND vq.statut IN ('en_attente','appele','en_cours')
       ORDER BY vq.type DESC, vq.position ASC`,
      [structureId]
    )
    res.json(entries)
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/assign-room — attribuer une salle ──────────────
router.post('/appointments/:id/assign-room', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { room_id } = req.body
  if (!room_id) return res.status(422).json({ detail: 'room_id requis' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      `SELECT a.*, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM appointments a JOIN users u ON u.id = a.patient_id
       WHERE a.id = ? AND a.structure_id = ?`,
      [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]

    const [roomRows] = await pool.query('SELECT nom FROM vet_rooms WHERE id = ? AND structure_id = ?', [room_id, structureId])
    if (!roomRows.length) return res.status(404).json({ detail: 'Salle introuvable' })
    const roomName = roomRows[0].nom

    await pool.query('UPDATE appointments SET room_id = ? WHERE id = ?', [room_id, req.params.id])
    await pool.query("UPDATE vet_rooms SET statut = 'occupee' WHERE id = ?", [room_id])

    // Add to queue if not already there
    const [existQ] = await pool.query('SELECT id FROM vet_queue WHERE appointment_id = ?', [req.params.id])
    if (!existQ.length) {
      const [maxPos] = await pool.query(
        'SELECT COALESCE(MAX(position),0) as max FROM vet_queue WHERE structure_id = ? AND statut IN ("en_attente","appele")',
        [structureId]
      )
      const pos = parseInt(maxPos[0].max) + 1
      const ticket = `VET${Date.now().toString().slice(-5)}`
      await pool.query(
        `INSERT INTO vet_queue (structure_id, room_id, appointment_id, patient_id,
          animal_name, animal_species, owner_name, type, position, ticket_numero)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [structureId, room_id, appt.id, appt.patient_id,
         appt.animal_nom ?? null, appt.animal_espece ?? null,
         [appt.patient_prenom, appt.patient_nom].filter(Boolean).join(' '),
         appt.type_rdv === 'urgence' ? 'urgence' : 'normal',
         pos, ticket]
      )
    } else {
      await pool.query('UPDATE vet_queue SET room_id = ? WHERE appointment_id = ?', [room_id, req.params.id])
    }

    // Notify patient
    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_id, 'vet_room_assigned',
      '🏥 Salle attribuée',
      `Votre animal est attendu en ${roomName}. Présentez-vous à l'accueil.`,
      { appointment_id: parseInt(req.params.id) }
    )
    io?.to(`user_${appt.patient_id}`).emit('appointment:update', {
      appointment_id: parseInt(req.params.id), room_id: parseInt(room_id), room_nom: roomName,
    })

    res.json({ success: true, room_nom: roomName })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/queue/:id/call — appeler l'animal suivant ──────────────────────
router.post('/queue/:id/call', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      'SELECT * FROM vet_queue WHERE id = ? AND structure_id = ?', [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Entrée introuvable' })

    await pool.query("UPDATE vet_queue SET statut = 'appele' WHERE id = ?", [req.params.id])

    const io = req.app.get('io')
    if (rows[0].patient_id) {
      await notifyAndEmit(io, rows[0].patient_id, 'vet_called',
        '🔔 Votre animal est appelé !',
        `Présentez-vous en ${rows[0].room_nom || 'salle de consultation'} avec votre animal.`,
        { queue_id: parseInt(req.params.id) }
      )
      io?.to(`user_${rows[0].patient_id}`).emit('vet:called', { queue_id: parseInt(req.params.id) })
    }
    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /vet/caisse — dashboard financier complet ────────────────────────────
router.get('/caisse', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    if (!structureId) return res.status(404).json({ detail: 'Structure introuvable' })

    const [[walletRow]] = await pool.query('SELECT solde FROM wallets WHERE user_id = ?', [req.user.id])

    // Revenus libérés (total)
    const [[libere]] = await pool.query(
      `SELECT COALESCE(SUM(prix),0) as total, COUNT(*) as count
       FROM appointments WHERE structure_id = ? AND paiement_statut = 'libere'`, [structureId]
    )
    // Revenus libérés ce mois
    const [[libereMonth]] = await pool.query(
      `SELECT COALESCE(SUM(prix),0) as total, COUNT(*) as count
       FROM appointments WHERE structure_id = ? AND paiement_statut = 'libere'
         AND YEAR(updated_at) = YEAR(NOW()) AND MONTH(updated_at) = MONTH(NOW())`, [structureId]
    )
    // En séquestre
    const [[bloque]] = await pool.query(
      `SELECT COALESCE(SUM(prix),0) as total, COUNT(*) as count
       FROM appointments WHERE structure_id = ? AND paiement_statut = 'bloque'`, [structureId]
    )
    // Aujourd'hui
    const [[today]] = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(prix),0) as total
       FROM appointments WHERE structure_id = ? AND statut = 'termine' AND DATE(updated_at) = CURDATE()`, [structureId]
    )
    // Paiements en attente (RDV à valider avec prix)
    const [[pending]] = await pool.query(
      `SELECT COUNT(*) as count, COALESCE(SUM(prix),0) as total
       FROM appointments WHERE structure_id = ? AND statut = 'en_attente' AND prix > 0`, [structureId]
    )

    // Répartition par type de service
    const [parService] = await pool.query(
      `SELECT
         COALESCE(NULLIF(service,''), type_rdv, 'Consultation') as service,
         COUNT(*) as count,
         COALESCE(SUM(CASE WHEN paiement_statut = 'libere' THEN prix ELSE 0 END), 0) as total_libere,
         COALESCE(SUM(CASE WHEN paiement_statut = 'bloque'  THEN prix ELSE 0 END), 0) as total_sequestre,
         COALESCE(SUM(prix), 0) as total_brut
       FROM appointments
       WHERE structure_id = ? AND prix > 0
       GROUP BY COALESCE(NULLIF(service,''), type_rdv, 'Consultation')
       ORDER BY total_brut DESC`, [structureId]
    )

    // Historique complet (50 derniers)
    const [historique] = await pool.query(
      `SELECT a.id, a.date_rdv, a.heure_rdv, a.prix, a.paiement_statut, a.statut,
              a.service, a.type_rdv, a.animal_nom, a.animal_espece,
              u.nom as patient_nom, u.prenom as patient_prenom,
              a.updated_at
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       WHERE a.structure_id = ? AND a.prix > 0
       ORDER BY a.updated_at DESC LIMIT 50`, [structureId]
    )

    const totalLibere = parseFloat(libere.total)
    const commission   = Math.round(totalLibere * COMMISSION_TAUX / 100)

    res.json({
      solde_wallet:          walletRow?.solde ?? 0,
      revenus_total:         totalLibere,
      revenus_ce_mois:       parseFloat(libereMonth.total),
      revenu_net:            totalLibere - commission,
      commission,
      en_sequestre:          parseFloat(bloque.total),
      en_sequestre_count:    parseInt(bloque.count),
      rdv_liberes_count:     parseInt(libere.count),
      rdv_mois_count:        parseInt(libereMonth.count),
      paiements_en_attente:  { count: parseInt(pending.count), total: parseFloat(pending.total) },
      aujourd_hui:           { count: parseInt(today.count), total: parseFloat(today.total) },
      par_service:           parService,
      historique,
    })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/exam — demande d'examen ───────────────────────
router.post('/appointments/:id/exam', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { type_examen, description, prix } = req.body
  if (!type_examen) return res.status(422).json({ detail: 'type_examen requis' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      `SELECT a.*, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM appointments a JOIN users u ON u.id = a.patient_id
       WHERE a.id = ? AND a.structure_id = ?`, [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]

    let examId = null
    try {
      const [r] = await pool.query(
        `INSERT INTO vet_exams (animal_id, appointment_id, veterinaire_id, patient_id, structure_id, type_examen, description, prix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [appt.animal_id ?? null, appt.id, req.user.id, appt.patient_id, structureId,
         type_examen, description || null, prix || 0]
      )
      examId = r.insertId
    } catch (_) {}

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_id, 'vet_exam',
      `🔬 Examen demandé — ${appt.animal_nom || 'votre animal'}`,
      `Votre vétérinaire demande un examen : ${type_examen}.`,
      { appointment_id: parseInt(req.params.id), exam_id: examId }
    )

    res.status(201).json({ id: examId, success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/hospitalize — hospitalisation animale ──────────
router.post('/appointments/:id/hospitalize', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { motif, duree_estimee, salle, prix } = req.body
  if (!motif) return res.status(422).json({ detail: 'motif requis' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      `SELECT a.*, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM appointments a JOIN users u ON u.id = a.patient_id
       WHERE a.id = ? AND a.structure_id = ?`, [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]

    let hospId = null
    try {
      const [r] = await pool.query(
        `INSERT INTO vet_hospitalizations (animal_id, appointment_id, veterinaire_id, patient_id, structure_id, motif, salle, duree_estimee, prix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [appt.animal_id ?? null, appt.id, req.user.id, appt.patient_id, structureId,
         motif, salle || null, duree_estimee || null, prix || 0]
      )
      hospId = r.insertId
    } catch (_) {}

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_id, 'vet_hospitalization',
      `🏥 Hospitalisation demandée — ${appt.animal_nom || 'votre animal'}`,
      `Votre vétérinaire recommande une hospitalisation : ${motif}. Durée estimée : ${duree_estimee || 'à définir'}.`,
      { appointment_id: parseInt(req.params.id), hospitalization_id: hospId }
    )

    res.status(201).json({ id: hospId, success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/queue/:id/next-patient — appeler le patient suivant ─────────────
router.post('/queue/:id/next-patient', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      `SELECT vq.*, vr.nom as room_nom
       FROM vet_queue vq LEFT JOIN vet_rooms vr ON vr.id = vq.room_id
       WHERE vq.id = ? AND vq.structure_id = ?`, [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Entrée introuvable' })
    const entry = rows[0]

    await pool.query(
      "UPDATE vet_queue SET statut = 'appele', called_at = NOW() WHERE id = ?", [req.params.id]
    )

    const io = req.app.get('io')
    if (entry.patient_id) {
      const roomName = entry.room_nom || 'salle de consultation'
      await notifyAndEmit(io, entry.patient_id, 'vet_next_patient',
        `🔔 C'est votre tour !`,
        `Présentez-vous en ${roomName} avec votre animal dans les 5 minutes.`,
        { queue_id: parseInt(req.params.id), countdown: 300, room: roomName }
      )
      io?.to(`user_${entry.patient_id}`).emit('vet:next-patient', {
        queue_id: parseInt(req.params.id),
        room_nom: roomName,
        animal_name: entry.animal_name,
        countdown: 300,
      })
    }

    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/queue/:id/absent — marquer le patient absent ───────────────────
router.post('/queue/:id/absent', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    await pool.query(
      "UPDATE vet_queue SET statut = 'absent', absent_count = absent_count + 1 WHERE id = ? AND structure_id = ?",
      [req.params.id, structureId]
    )
    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/rooms/:id/toggle — changer statut d'une salle ──────────────────
router.post('/rooms/:id/toggle', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { statut } = req.body
  if (!['libre', 'occupee', 'fermee'].includes(statut)) return res.status(422).json({ detail: 'statut invalide' })
  try {
    const structureId = await getStructureId(req.user.id)
    await pool.query(
      'UPDATE vet_rooms SET statut = ? WHERE id = ? AND structure_id = ?',
      [statut, req.params.id, structureId]
    )
    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── Tarifs & labels ──────────────────────────────────────────────────────────
const VET_TARIFS = {
  consultation: 15000, vaccination: 10000, soins: 12000,
  chirurgie: 80000, hospitalisation: 40000, examens: 20000, urgence: 25000,
}
const VET_SERVICE_LABELS = {
  consultation: 'Consultation générale', vaccination: 'Vaccination',
  soins: 'Soins', chirurgie: 'Chirurgie animale',
  hospitalisation: 'Hospitalisation animale', examens: 'Examens & Analyses',
  urgence: 'Urgences 24h',
}
const VET_SERVICE_ORDER = ['urgence','consultation','vaccination','soins','chirurgie','hospitalisation','examens']

// ── GET /vet/services — salles groupées par type avec file ───────────────────
router.get('/services', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    if (!structureId) return res.status(404).json({ detail: 'Structure introuvable' })

    const [rooms] = await pool.query(
      'SELECT * FROM vet_rooms WHERE structure_id = ? ORDER BY ordre ASC', [structureId]
    )
    const [queueRows] = await pool.query(
      `SELECT vq.*, a.animal_nom, a.animal_espece, u.nom as pat_nom, u.prenom as pat_prenom
       FROM vet_queue vq
       LEFT JOIN appointments a ON a.id = vq.appointment_id
       LEFT JOIN users u ON u.id = vq.patient_id
       WHERE vq.structure_id = ? AND vq.statut IN ('en_attente','appele','en_cours')
       ORDER BY vq.type DESC, vq.position ASC`,
      [structureId]
    )

    // Group rooms by type
    const grouped = {}
    for (const type of VET_SERVICE_ORDER) {
      const typeRooms = rooms.filter(r => r.type === type)
      if (!typeRooms.length) continue
      grouped[type] = {
        type,
        label: VET_SERVICE_LABELS[type] || type,
        tarif: VET_TARIFS[type] || 0,
        rooms: typeRooms.map(r => {
          const roomQueue = queueRows.filter(q => q.room_id === r.id)
          const called = roomQueue.find(q => q.statut === 'appele')
          const enCours = roomQueue.find(q => q.statut === 'en_cours')
          const waiting = roomQueue.filter(q => q.statut === 'en_attente')
          return {
            ...r,
            queue_count: roomQueue.length,
            en_attente_count: waiting.length,
            called_patient: called ?? null,
            current_patient: enCours ?? null,
          }
        }),
      }
    }
    // Also add rooms without a recognized type
    const otherRooms = rooms.filter(r => !VET_SERVICE_ORDER.includes(r.type))
    if (otherRooms.length) {
      grouped['autre'] = {
        type: 'autre', label: 'Autres salles', tarif: 0,
        rooms: otherRooms.map(r => ({ ...r, queue_count: 0, en_attente_count: 0, called_patient: null, current_patient: null })),
      }
    }

    res.json({ services: Object.values(grouped), queue: queueRows })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/rooms/:id/next-patient — appeler le patient suivant (par salle) ─
router.post('/rooms/:id/next-patient', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [roomRows] = await pool.query(
      'SELECT * FROM vet_rooms WHERE id = ? AND structure_id = ?', [req.params.id, structureId]
    )
    if (!roomRows.length) return res.status(404).json({ detail: 'Salle introuvable' })
    const room = roomRows[0]

    // Find next waiting patient in this room
    const [waiting] = await pool.query(
      `SELECT vq.* FROM vet_queue vq
       WHERE vq.room_id = ? AND vq.structure_id = ? AND vq.statut = 'en_attente'
       ORDER BY vq.type DESC, vq.position ASC LIMIT 1`,
      [req.params.id, structureId]
    )
    if (!waiting.length) return res.status(404).json({ detail: 'Aucun patient en attente dans cette salle' })
    const entry = waiting[0]

    const deadline = new Date(Date.now() + 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')

    await pool.query(
      "UPDATE vet_queue SET statut = 'appele', called_at = NOW(), deadline = ? WHERE id = ?",
      [deadline, entry.id]
    )

    const io = req.app.get('io')
    if (entry.patient_id) {
      await notifyAndEmit(io, entry.patient_id, 'vet_next_patient',
        `🔔 C'est votre tour !`,
        `Présentez-vous en ${room.nom} avec votre animal dans les 5 minutes.`,
        { queue_id: entry.id, countdown: 300, room: room.nom, deadline }
      )
      io?.to(`user_${entry.patient_id}`).emit('vet:next-patient', {
        queue_id: entry.id, room_nom: room.nom, animal_name: entry.animal_name,
        countdown: 300, deadline,
      })
    }

    res.json({ success: true, queue_id: entry.id, deadline })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/rooms/:id/start — patient présent, démarrer consultation ────────
router.post('/rooms/:id/start', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [roomRows] = await pool.query(
      'SELECT * FROM vet_rooms WHERE id = ? AND structure_id = ?', [req.params.id, structureId]
    )
    if (!roomRows.length) return res.status(404).json({ detail: 'Salle introuvable' })

    // Find called patient in this room
    const [called] = await pool.query(
      "SELECT * FROM vet_queue WHERE room_id = ? AND structure_id = ? AND statut = 'appele' LIMIT 1",
      [req.params.id, structureId]
    )
    if (!called.length) return res.status(404).json({ detail: 'Aucun patient appelé dans cette salle' })

    await pool.query(
      "UPDATE vet_queue SET statut = 'en_cours', deadline = NULL WHERE id = ?", [called[0].id]
    )
    await pool.query("UPDATE vet_rooms SET statut = 'occupee' WHERE id = ?", [req.params.id])

    res.json({ success: true, queue_id: called[0].id })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/rooms/:id/absent — patient absent ───────────────────────────────
router.post('/rooms/:id/absent', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [roomRows] = await pool.query(
      'SELECT * FROM vet_rooms WHERE id = ? AND structure_id = ?', [req.params.id, structureId]
    )
    if (!roomRows.length) return res.status(404).json({ detail: 'Salle introuvable' })

    const [called] = await pool.query(
      "SELECT * FROM vet_queue WHERE room_id = ? AND structure_id = ? AND statut = 'appele' LIMIT 1",
      [req.params.id, structureId]
    )
    if (!called.length) return res.status(404).json({ detail: 'Aucun patient appelé' })
    const entry = called[0]
    const absCount = (entry.absent_count || 0) + 1

    if (absCount >= 2) {
      // Definitivement absent
      await pool.query(
        "UPDATE vet_queue SET statut = 'absent', absent_count = ?, deadline = NULL WHERE id = ?",
        [absCount, entry.id]
      )
      await pool.query("UPDATE vet_rooms SET statut = 'libre' WHERE id = ?", [req.params.id])
      if (entry.patient_id) {
        const io = req.app.get('io')
        await notifyAndEmit(io, entry.patient_id, 'vet_absent_final',
          '❌ Rendez-vous annulé',
          `Votre rendez-vous vétérinaire a été annulé car vous ne vous êtes pas présenté(e) à temps.`,
          { queue_id: entry.id }
        )
      }
    } else {
      // Remettre en attente en fin de file
      const [maxPos] = await pool.query(
        "SELECT COALESCE(MAX(position),0) as max FROM vet_queue WHERE structure_id = ? AND statut = 'en_attente'",
        [structureId]
      )
      const newPos = parseInt(maxPos[0].max) + 1
      await pool.query(
        "UPDATE vet_queue SET statut = 'en_attente', position = ?, absent_count = ?, deadline = NULL WHERE id = ?",
        [newPos, absCount, entry.id]
      )
      await pool.query("UPDATE vet_rooms SET statut = 'libre' WHERE id = ?", [req.params.id])
      if (entry.patient_id) {
        const io = req.app.get('io')
        await notifyAndEmit(io, entry.patient_id, 'vet_absent_warning',
          '⚠️ Absence signalée',
          `Vous avez manqué votre appel. Vous avez été replacé(e) en fin de file.`,
          { queue_id: entry.id }
        )
      }
    }

    res.json({ success: true, absent_count: absCount })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/rooms/:id/finish — fin de consultation ─────────────────────────
router.post('/rooms/:id/finish', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [roomRows] = await pool.query(
      'SELECT * FROM vet_rooms WHERE id = ? AND structure_id = ?', [req.params.id, structureId]
    )
    if (!roomRows.length) return res.status(404).json({ detail: 'Salle introuvable' })

    const [current] = await pool.query(
      "SELECT * FROM vet_queue WHERE room_id = ? AND structure_id = ? AND statut = 'en_cours' LIMIT 1",
      [req.params.id, structureId]
    )
    if (!current.length) return res.status(404).json({ detail: 'Aucune consultation en cours' })
    const entry = current[0]

    await pool.query(
      "UPDATE vet_queue SET statut = 'termine', deadline = NULL WHERE id = ?", [entry.id]
    )
    await pool.query("UPDATE vet_rooms SET statut = 'libre' WHERE id = ?", [req.params.id])

    if (entry.appointment_id) {
      await pool.query(
        "UPDATE appointments SET statut = 'termine', consultation_statut = 'effectuee' WHERE id = ? AND statut != 'termine'",
        [entry.appointment_id]
      )
    }

    const io = req.app.get('io')
    if (entry.patient_id) {
      await notifyAndEmit(io, entry.patient_id, 'vet_consultation_done',
        '🐾 Consultation terminée',
        `La consultation vétérinaire est terminée. Merci de confirmer pour libérer le paiement.`,
        { queue_id: entry.id, appointment_id: entry.appointment_id, action: 'confirm_consultation' }
      )
      io?.to(`user_${entry.patient_id}`).emit('appointment:update', {
        appointment_id: entry.appointment_id, statut: 'termine', action: 'confirm_consultation',
      })
    }

    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/rooms/:id/status — changer statut d'une salle ──────────────────
router.post('/rooms/:id/status', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { statut } = req.body
  if (!['libre', 'occupee', 'pause', 'fermee'].includes(statut)) {
    return res.status(422).json({ detail: 'statut invalide' })
  }
  try {
    const structureId = await getStructureId(req.user.id)
    await pool.query(
      'UPDATE vet_rooms SET statut = ? WHERE id = ? AND structure_id = ?',
      [statut, req.params.id, structureId]
    )
    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /vet/appointments/:id/surgery — chirurgie animale ───────────────────
router.post('/appointments/:id/surgery', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  const { type_chirurgie, motif, urgence, observations, recommandations } = req.body
  if (!type_chirurgie) return res.status(422).json({ detail: 'type_chirurgie requis' })
  try {
    const structureId = await getStructureId(req.user.id)
    const [rows] = await pool.query(
      `SELECT a.*, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM appointments a JOIN users u ON u.id = a.patient_id
       WHERE a.id = ? AND a.structure_id = ?`, [req.params.id, structureId]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]

    const prix = VET_TARIFS.chirurgie
    let surgId = null
    try {
      const [r] = await pool.query(
        `INSERT INTO vet_surgeries
           (animal_id, appointment_id, veterinaire_id, patient_id, structure_id,
            type_chirurgie, motif, urgence, observations, recommandations, prix)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [appt.animal_id ?? null, appt.id, req.user.id, appt.patient_id, structureId,
         type_chirurgie, motif || null, urgence || 'normal',
         observations || null, recommandations || null, prix]
      )
      surgId = r.insertId
    } catch (_) {}

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_id, 'vet_surgery',
      `🔪 Chirurgie recommandée — ${appt.animal_nom || 'votre animal'}`,
      `Votre vétérinaire recommande une chirurgie : ${type_chirurgie}. Tarif : ${prix.toLocaleString('fr-FR')} FCFA.`,
      { appointment_id: parseInt(req.params.id), surgery_id: surgId, prix }
    )

    res.status(201).json({ id: surgId, prix, success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /vet/animals/:id — dossier animal (vue vétérinaire) ───────────────────
router.get('/animals/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'veterinaire') return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const [rows] = await pool.query(
      `SELECT a.*, a.name AS nom, u.nom AS owner_nom, u.prenom AS owner_prenom, u.telephone AS owner_tel
       FROM pet_animals a JOIN users u ON u.id = a.owner_id
       WHERE a.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Animal introuvable' })
    const animal = rows[0]

    const [vaccines] = await pool.query(
      'SELECT * FROM vet_vaccines WHERE animal_id = ? ORDER BY date_admin DESC', [animal.id]
    )
    const [prescriptions] = await pool.query(
      `SELECT vp.*, u.nom AS vet_nom FROM vet_prescriptions vp
       JOIN users u ON u.id = vp.veterinaire_id WHERE vp.animal_id = ? ORDER BY vp.created_at DESC`,
      [animal.id]
    )
    const [rdvs] = await pool.query(
      'SELECT * FROM appointments WHERE animal_id = ? ORDER BY date_rdv DESC', [animal.id]
    )

    res.json({ ...animal, vaccins: vaccines, prescriptions, rdvs })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
