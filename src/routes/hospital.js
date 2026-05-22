const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth, requireRole } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

const COMMISSION_TAUX = 15 // 15% — ajoutée au client, l'hôpital reçoit 100%
const TICKET_PREFIX = 'A'
const AVG_CONSULT_MIN = 15 // minutes par consultation estimée
const CALL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes avant absence

// Timers en mémoire: queueEntryId → timeoutHandle
const calledTimers = new Map()

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getRoomsWithQueue(structureId) {
  let services
  try {
    ;[services] = await pool.query(
      `SELECT s.id AS service_id, s.nom AS service_nom, s.specialite, s.prix,
              r.id AS room_id, r.nom AS room_nom, r.statut, r.medecin_nom, r.ordre,
              r.prix AS room_prix
       FROM hospital_services s
       JOIN hospital_rooms r ON r.service_id = s.id
       WHERE s.structure_id = ? AND s.actif = 1
       ORDER BY s.ordre, r.ordre`,
      [structureId]
    )
  } catch (_) {
    // Fallback when prix columns don't exist yet (before migration)
    ;[services] = await pool.query(
      `SELECT s.id AS service_id, s.nom AS service_nom, s.specialite,
              5000 AS prix,
              r.id AS room_id, r.nom AS room_nom, r.statut, r.medecin_nom, r.ordre,
              0 AS room_prix
       FROM hospital_services s
       JOIN hospital_rooms r ON r.service_id = s.id
       WHERE s.structure_id = ? AND s.actif = 1
       ORDER BY s.ordre, r.ordre`,
      [structureId]
    )
  }
  const roomIds = services.map(r => r.room_id)
  let queueMap = {}
  if (roomIds.length) {
    const [queues] = await pool.query(
      `SELECT room_id, COUNT(*) AS total,
              SUM(statut = 'en_attente') AS en_attente,
              SUM(statut = 'appele') AS appele,
              SUM(statut = 'en_consultation') AS en_consultation
       FROM queue_entries
       WHERE room_id IN (?) AND statut NOT IN ('termine')
       GROUP BY room_id`,
      [roomIds]
    )
    queues.forEach(q => { queueMap[q.room_id] = q })
  }

  // Group by service
  const servicesMap = {}
  for (const row of services) {
    if (!servicesMap[row.service_id]) {
      servicesMap[row.service_id] = { id: row.service_id, nom: row.service_nom, specialite: row.specialite, prix: parseFloat(row.prix || 0), rooms: [] }
    }
    const q = queueMap[row.room_id] || { en_attente: 0, appele: 0, en_consultation: 0 }
    const enAttente = parseInt(q.en_attente || 0)
    servicesMap[row.service_id].rooms.push({
      id: row.room_id,
      nom: row.room_nom,
      statut: row.statut,
      medecin_nom: row.medecin_nom,
      en_attente: enAttente,
      appele: parseInt(q.appele || 0),
      en_consultation: parseInt(q.en_consultation || 0),
      eta_min: enAttente * AVG_CONSULT_MIN,
      prix: parseFloat(row.room_prix || 0),
    })
  }
  return Object.values(servicesMap)
}

async function emitQueueUpdate(io, structureId) {
  if (!io) return
  const services = await getRoomsWithQueue(structureId)
  io.to(`hospital_struct_${structureId}`).emit('queue:update', { structureId, services })
}

async function getStructureForUser(userId) {
  const [rows] = await pool.query(
    'SELECT sp.id FROM structure_profiles sp JOIN users u ON u.id = sp.user_id WHERE u.id = ? LIMIT 1',
    [userId]
  )
  return rows[0]?.id ?? null
}

async function nextTicketNumber(structureId) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM appointments
     WHERE structure_id = ? AND DATE(created_at) = CURDATE() AND type_consultation IS NOT NULL`,
    [structureId]
  )
  const n = (parseInt(rows[0].cnt) + 1)
  return `${TICKET_PREFIX}${String(n).padStart(3, '0')}`
}

// ── PUBLIC: services + salles + files ────────────────────────────────────────
// GET /api/v1/hospital/:structureId/services
router.get('/:structureId/services', async (req, res) => {
  try {
    const structureId = parseInt(req.params.structureId)
    const services = await getRoomsWithQueue(structureId)
    res.json({ services })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── PATIENT: rejoindre la room socket hôpital ─────────────────────────────────
// Socket: client envoie 'join:hospital' avec structureId

// ── PATIENT: consultation immédiate ──────────────────────────────────────────
// POST /api/v1/hospital/appointment/immediate
router.post('/appointment/immediate', requireAuth, requireRole('patient'), async (req, res) => {
  const { structure_id, service_id, motif, symptomes, age_patient, sexe_patient, prix } = req.body
  if (!structure_id || !service_id) {
    return res.status(422).json({ detail: 'structure_id et service_id requis' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const today = new Date().toISOString().slice(0, 10)
    const now = new Date().toTimeString().slice(0, 5)

    let paiementStatut = 'non_requis'
    let paiementId = null

    if (prix && parseFloat(prix) > 0) {
      const prixBase = parseFloat(prix)
      const commission = parseFloat((prixBase * COMMISSION_TAUX / 100).toFixed(2))
      const totalDebite = parseFloat((prixBase + commission).toFixed(2))
      const [wallets] = await conn.query('SELECT id, solde FROM wallets WHERE user_id = ?', [req.user.id])
      if (!wallets.length || parseFloat(wallets[0].solde) < totalDebite) {
        await conn.rollback(); conn.release()
        return res.status(422).json({ detail: `Solde insuffisant. Total requis : ${totalDebite.toLocaleString('fr-FR')} FCFA (dont ${commission.toLocaleString('fr-FR')} FCFA de commission MedMap+).` })
      }
      await conn.query('UPDATE wallets SET solde = solde - ? WHERE id = ?', [totalDebite, wallets[0].id])
      await conn.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "debit", ?)',
        [wallets[0].id, totalDebite, `Consultation immédiate — séquestre (base ${prixBase.toLocaleString('fr-FR')} + commission ${commission.toLocaleString('fr-FR')})`]
      )
      const [payRes] = await conn.query(
        `INSERT INTO payments (payer_id, structure_id, montant, commission, description, statut) VALUES (?, ?, ?, ?, ?, 'bloque')`,
        [req.user.id, structure_id, prixBase, commission, 'Consultation immédiate']
      )
      paiementStatut = 'bloque'
      paiementId = payRes.insertId
    }

    const ticketNo = await nextTicketNumber(structure_id)
    const [svcRow] = await conn.query('SELECT nom FROM hospital_services WHERE id = ?', [service_id])
    const serviceName = svcRow[0]?.nom ?? 'Consultation'

    const [apptRes] = await conn.query(
      `INSERT INTO appointments
         (patient_id, provider_type, structure_id, service, date_rdv, heure_rdv, type_rdv, motif,
          statut, prix, symptomes, age_patient, sexe_patient, premiere_consult, antecedents,
          type_consultation, ticket_numero, paiement_statut, paiement_id, commission_taux)
       VALUES (?, 'structure', ?, ?, ?, ?, 'immediate', ?, 'en_attente', ?, ?, ?, ?, 1, '',
               'immediate', ?, ?, ?, ?)`,
      [req.user.id, structure_id, serviceName, today, now, motif || 'Consultation immédiate',
       prix || 0, symptomes || '', age_patient || null, sexe_patient || null,
       ticketNo, paiementStatut, paiementId, COMMISSION_TAUX]
    )
    const apptId = apptRes.insertId

    await conn.commit()
    conn.release()

    // Notify hospital via socket
    const io = req.app.get('io')
    io?.to(`hospital_struct_${structure_id}`).emit('appointment:new', {
      id: apptId, type_consultation: 'immediate', patient_nom: `${req.user.prenom} ${req.user.nom}`,
      service: serviceName, ticket_numero: ticketNo, statut: 'en_attente',
    })

    res.status(201).json({ id: apptId, ticket_numero: ticketNo, service: serviceName, prix: prix || 0 })
  } catch (e) {
    await conn.rollback(); conn.release()
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── HÔPITAL: dashboard complet ────────────────────────────────────────────────
// GET /api/v1/hospital/dashboard
router.get('/dashboard', requireAuth, requireRole('clinique'), async (req, res) => {
  try {
    const structureId = await getStructureForUser(req.user.id)
    if (!structureId) return res.status(404).json({ detail: 'Structure introuvable' })

    // Reception: pending appointments
    const [pending] = await pool.query(
      `SELECT a.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel,
              hs.nom AS service_nom, hr.nom AS room_nom
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       LEFT JOIN hospital_services hs ON hs.nom = a.service AND hs.structure_id = ?
       LEFT JOIN hospital_rooms hr ON hr.id = a.room_id
       WHERE a.structure_id = ? AND a.statut = 'en_attente'
       ORDER BY a.created_at DESC
       LIMIT 50`,
      [structureId, structureId]
    )

    // Confirmed appointments today
    const [confirmedToday] = await pool.query(
      `SELECT a.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom,
              hr.nom AS room_nom, hs.nom AS service_nom,
              qe.statut AS queue_statut, qe.numero_ordre, qe.id AS queue_id
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       LEFT JOIN hospital_rooms hr ON hr.id = a.room_id
       LEFT JOIN hospital_services hs ON hs.nom = a.service AND hs.structure_id = ?
       LEFT JOIN queue_entries qe ON qe.appointment_id = a.id AND qe.statut != 'termine'
       WHERE a.structure_id = ? AND a.statut = 'confirme' AND DATE(a.date_rdv) = CURDATE()
       ORDER BY a.heure_rdv ASC`,
      [structureId, structureId]
    )

    // Services + rooms + queues
    const services = await getRoomsWithQueue(structureId)

    // Queue entries per room (active)
    const roomIds = services.flatMap(s => s.rooms.map(r => r.id))
    let queueDetails = []
    if (roomIds.length) {
      const [qd] = await pool.query(
        `SELECT qe.*, u.nom AS patient_nom_real, u.prenom AS patient_prenom,
                hr.nom AS room_nom, hs.nom AS service_nom,
                DATE_ADD(qe.called_at, INTERVAL 5 MINUTE) AS deadline,
                a.ticket_numero,
                qe.entry_type, qe.exam_id, qe.hospitalization_id,
                me.examens AS exam_liste, me.laboratoire AS exam_laboratoire,
                h.service AS hosp_service, h.motif AS hosp_motif
         FROM queue_entries qe
         JOIN users u ON u.id = qe.patient_id
         JOIN hospital_rooms hr ON hr.id = qe.room_id
         JOIN hospital_services hs ON hs.id = hr.service_id
         LEFT JOIN appointments a ON a.id = qe.appointment_id
         LEFT JOIN medical_exams me ON me.id = qe.exam_id
         LEFT JOIN hospitalizations h ON h.id = qe.hospitalization_id
         WHERE qe.room_id IN (?) AND qe.statut NOT IN ('termine','absent')
         ORDER BY qe.room_id, qe.numero_ordre`,
        [roomIds]
      )
      queueDetails = qd
    }

    // Caisse: payments
    const [payments] = await pool.query(
      `SELECT p.*, u.nom AS payer_nom, u.prenom AS payer_prenom,
              a.service AS service_nom, a.ticket_numero
       FROM payments p
       JOIN users u ON u.id = p.payer_id
       LEFT JOIN appointments a ON a.paiement_id = p.id
       WHERE p.structure_id = ?
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [structureId]
    )

    // Stats
    const [stats] = await pool.query(
      `SELECT
         COUNT(*) AS total_rdv,
         SUM(statut = 'en_attente') AS en_attente,
         SUM(statut = 'confirme') AS confirme,
         SUM(statut = 'termine') AS termine,
         SUM(statut = 'refuse') AS refuse,
         SUM(CASE WHEN type_consultation = 'immediate' THEN 1 ELSE 0 END) AS immediates
       FROM appointments
       WHERE structure_id = ? AND DATE(created_at) = CURDATE()`,
      [structureId]
    )

    const [walletRows] = await pool.query(
      'SELECT solde FROM wallets WHERE user_id = ?', [req.user.id]
    )

    res.json({
      structure_id: structureId,
      stats: stats[0],
      wallet_solde: walletRows[0]?.solde ?? 0,
      pending,
      confirmed_today: confirmedToday,
      services,
      queue_details: queueDetails,
      payments,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION: confirmer + attribuer salle ────────────────────────────────────
// POST /api/v1/hospital/reception/confirm/:appointmentId
router.post('/reception/confirm/:id', requireAuth, requireRole('clinique'), async (req, res) => {
  const apptId = parseInt(req.params.id)
  const { room_id } = req.body // optional — auto-assign if absent

  try {
    const structureId = await getStructureForUser(req.user.id)
    const [appts] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? AND structure_id = ?',
      [apptId, structureId]
    )
    if (!appts.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const appt = appts[0]

    // Auto-assign best room if none given
    let assignedRoomId = room_id || null
    let assignedRoomNom = null
    let assignedServiceNom = appt.service

    if (!assignedRoomId) {
      // Find service matching appointment service name
      const [svcRows] = await pool.query(
        'SELECT id FROM hospital_services WHERE structure_id = ? AND nom = ? AND actif = 1 LIMIT 1',
        [structureId, appt.service]
      )
      let serviceId = svcRows[0]?.id ?? null

      // Fallback to first service
      if (!serviceId) {
        const [first] = await pool.query(
          'SELECT id FROM hospital_services WHERE structure_id = ? AND actif = 1 ORDER BY ordre LIMIT 1',
          [structureId]
        )
        serviceId = first[0]?.id ?? null
      }

      if (serviceId) {
        // Find room with fewest waiting patients, not closed
        const [rooms] = await pool.query(
          `SELECT r.id, r.nom,
                  COUNT(qe.id) AS waiting
           FROM hospital_rooms r
           LEFT JOIN queue_entries qe ON qe.room_id = r.id AND qe.statut NOT IN ('termine')
           WHERE r.service_id = ? AND r.statut != 'fermee'
           GROUP BY r.id
           ORDER BY r.statut = 'libre' DESC, waiting ASC, r.ordre ASC
           LIMIT 1`,
          [serviceId]
        )
        if (rooms[0]) {
          assignedRoomId = rooms[0].id
          assignedRoomNom = rooms[0].nom
          const [svcName] = await pool.query('SELECT nom FROM hospital_services WHERE id = ?', [serviceId])
          assignedServiceNom = svcName[0]?.nom ?? appt.service
        }
      }
    } else {
      const [roomRow] = await pool.query('SELECT nom FROM hospital_rooms WHERE id = ?', [assignedRoomId])
      assignedRoomNom = roomRow[0]?.nom ?? null
    }

    // Get next queue number for this room
    let queuePosition = 1
    let queueEntryId = null
    if (assignedRoomId) {
      const [maxQ] = await pool.query(
        'SELECT MAX(numero_ordre) AS maxn FROM queue_entries WHERE room_id = ? AND statut != "termine"',
        [assignedRoomId]
      )
      queuePosition = (parseInt(maxQ[0]?.maxn ?? 0)) + 1
      const patientNom = `${appt.patient_id}`

      const [qRes] = await pool.query(
        `INSERT INTO queue_entries (room_id, appointment_id, patient_id, patient_nom, numero_ordre)
         VALUES (?, ?, ?, ?, ?)`,
        [assignedRoomId, apptId, appt.patient_id, `Patient #${appt.patient_id}`, queuePosition]
      )
      queueEntryId = qRes.insertId

      // Count people already waiting (before this patient)
      const [before] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM queue_entries
         WHERE room_id = ? AND statut = 'en_attente' AND numero_ordre < ?`,
        [assignedRoomId, queuePosition]
      )
      queuePosition = parseInt(before[0].cnt) // position = people before
    }

    // Update appointment
    await pool.query(
      `UPDATE appointments SET statut = 'confirme', room_id = ?, queue_position = ? WHERE id = ?`,
      [assignedRoomId, queuePosition, apptId]
    )

    // Notify patient
    const io = req.app.get('io')
    await notifyAndEmit(
      io, appt.patient_id, 'appointment',
      'Rendez-vous confirmé',
      `Votre consultation est confirmée${assignedRoomNom ? ` — ${assignedRoomNom}` : ''}. Ticket ${appt.ticket_numero || ''}.`,
      { appointment_id: apptId }
    )
    io?.to(`user_${appt.patient_id}`).emit('appointment:update', {
      id: apptId, statut: 'confirme',
      room_nom: assignedRoomNom,
      queue_position: queuePosition,
      ticket_numero: appt.ticket_numero,
    })

    // Update hospital room queue view
    if (assignedRoomId) {
      await pool.query("UPDATE hospital_rooms SET statut = 'occupee' WHERE id = ? AND statut = 'libre'", [assignedRoomId])
      await emitQueueUpdate(io, structureId)
    }

    res.json({
      success: true,
      room_id: assignedRoomId,
      room_nom: assignedRoomNom,
      queue_position: queuePosition,
      ticket_numero: appt.ticket_numero,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION: refuser ────────────────────────────────────────────────────────
// POST /api/v1/hospital/reception/reject/:appointmentId
router.post('/reception/reject/:id', requireAuth, requireRole('clinique'), async (req, res) => {
  const apptId = parseInt(req.params.id)
  const { motif_refus } = req.body

  try {
    const structureId = await getStructureForUser(req.user.id)
    const [appts] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? AND structure_id = ?',
      [apptId, structureId]
    )
    if (!appts.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = appts[0]

    await pool.query("UPDATE appointments SET statut = 'refuse' WHERE id = ?", [apptId])

    // Rembourser si séquestre
    if (appt.paiement_statut === 'bloque' && appt.paiement_id) {
      await pool.query("UPDATE payments SET statut = 'rembourse' WHERE id = ?", [appt.paiement_id])
      await pool.query('UPDATE wallets SET solde = solde + ? WHERE user_id = ?', [appt.prix, appt.patient_id])
      await pool.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) SELECT id, ?, "credit", ? FROM wallets WHERE user_id = ?',
        [appt.prix, 'Remboursement consultation refusée', appt.patient_id]
      )
    }

    const io = req.app.get('io')
    await notifyAndEmit(
      io, appt.patient_id, 'appointment',
      'Consultation refusée',
      motif_refus || 'Votre demande de consultation a été refusée. Si un paiement a été effectué, il sera remboursé.',
      { appointment_id: apptId }
    )

    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── SALLES: changer statut ────────────────────────────────────────────────────
// PUT /api/v1/hospital/rooms/:roomId/status
router.put('/rooms/:roomId/status', requireAuth, requireRole('clinique'), async (req, res) => {
  const roomId = parseInt(req.params.roomId)
  const { statut, medecin_nom } = req.body
  const VALID = ['libre', 'occupee', 'pause', 'fermee']
  if (!VALID.includes(statut)) return res.status(422).json({ detail: 'Statut invalide' })

  try {
    const updates = ['statut = ?']
    const vals = [statut]
    if (medecin_nom !== undefined) { updates.push('medecin_nom = ?'); vals.push(medecin_nom) }
    vals.push(roomId)
    await pool.query(`UPDATE hospital_rooms SET ${updates.join(', ')} WHERE id = ?`, vals)

    const [roomRow] = await pool.query(
      'SELECT hr.*, hs.structure_id FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id WHERE hr.id = ?',
      [roomId]
    )
    const structureId = roomRow[0]?.structure_id
    if (structureId) await emitQueueUpdate(req.app.get('io'), structureId)

    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── SALLES: patient suivant ───────────────────────────────────────────────────
// POST /api/v1/hospital/rooms/:roomId/next-patient
router.post('/rooms/:roomId/next-patient', requireAuth, requireRole('clinique'), async (req, res) => {
  const roomId = parseInt(req.params.roomId)

  try {
    // Finish current in_consultation entry if any
    const [current] = await pool.query(
      "SELECT * FROM queue_entries WHERE room_id = ? AND statut = 'en_consultation' ORDER BY numero_ordre LIMIT 1",
      [roomId]
    )
    if (current.length) {
      const prevEntry = current[0]
      await pool.query("UPDATE queue_entries SET statut = 'termine' WHERE id = ?", [prevEntry.id])
      const prevType = prevEntry.entry_type || 'consultation'
      const ioRef = req.app.get('io')

      if (prevType === 'exam' && prevEntry.exam_id) {
        await pool.query("UPDATE medical_exams SET statut = 'realise' WHERE id = ? AND statut = 'acceptee'", [prevEntry.exam_id])
        const [examRows] = await pool.query('SELECT * FROM medical_exams WHERE id = ?', [prevEntry.exam_id])
        if (examRows[0]) {
          await notifyAndEmit(ioRef, examRows[0].patient_id, 'exam_done',
            '🔬 Examens réalisés',
            'Vos examens sont terminés. Veuillez confirmer pour valider le paiement.',
            { exam_id: prevEntry.exam_id, action: 'confirm_exam' }
          )
          ioRef?.to(`user_${examRows[0].patient_id}`).emit('exam:done', { exam_id: prevEntry.exam_id, action: 'confirm_exam' })
        }
      } else if (prevType === 'hospitalization' && prevEntry.hospitalization_id) {
        await pool.query("UPDATE hospitalizations SET statut = 'termine' WHERE id = ? AND statut IN ('acceptee','en_cours')", [prevEntry.hospitalization_id])
        const [hospRows] = await pool.query('SELECT * FROM hospitalizations WHERE id = ?', [prevEntry.hospitalization_id])
        if (hospRows[0]) {
          await notifyAndEmit(ioRef, hospRows[0].patient_id, 'hospitalization_done',
            '🏥 Hospitalisation terminée',
            'Votre hospitalisation est terminée. Veuillez confirmer votre sortie pour valider le paiement.',
            { hospitalization_id: prevEntry.hospitalization_id, action: 'confirm_hospitalization' }
          )
          ioRef?.to(`user_${hospRows[0].patient_id}`).emit('hospitalization:done', { hospitalization_id: prevEntry.hospitalization_id, action: 'confirm_hospitalization' })
        }
      } else if (prevEntry.appointment_id) {
        await pool.query("UPDATE appointments SET statut = 'termine', consultation_statut = 'effectuee' WHERE id = ?", [prevEntry.appointment_id])
        const [finishedAppt] = await pool.query('SELECT * FROM appointments WHERE id = ?', [prevEntry.appointment_id])
        if (finishedAppt[0]) {
          await notifyAndEmit(
            ioRef, finishedAppt[0].patient_id, 'appointment',
            'Consultation terminée — Confirmez svp',
            'Votre consultation est terminée. Veuillez confirmer pour valider le paiement.',
            { appointment_id: prevEntry.appointment_id, action: 'confirm_consultation' }
          )
          ioRef?.to(`user_${finishedAppt[0].patient_id}`).emit('appointment:update', {
            id: prevEntry.appointment_id, statut: 'termine',
            consultation_statut: 'effectuee', action: 'confirm_consultation',
          })
        }
      }
    }

    // Get room info first (needed for notifications)
    const [roomInfo] = await pool.query(
      `SELECT hr.nom AS room_nom, hs.nom AS service_nom, hs.structure_id
       FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id
       WHERE hr.id = ?`,
      [roomId]
    )
    const roomNom = roomInfo[0]?.room_nom ?? 'la salle'
    const serviceNom = roomInfo[0]?.service_nom ?? 'le service'
    const structureId = roomInfo[0]?.structure_id
    const io = req.app.get('io')

    // Check if someone is already appele in this room — don't call another
    const [alreadyAppele] = await pool.query(
      "SELECT id FROM queue_entries WHERE room_id = ? AND statut = 'appele'",
      [roomId]
    )
    if (alreadyAppele.length) {
      if (structureId) await emitQueueUpdate(io, structureId)
      return res.json({ success: true, message: 'Un patient est déjà appelé — attendez qu\'il se présente', next_patient: null })
    }

    // Find next 'en_attente' patient
    const [next] = await pool.query(
      "SELECT * FROM queue_entries WHERE room_id = ? AND statut = 'en_attente' ORDER BY numero_ordre LIMIT 1",
      [roomId]
    )

    if (!next.length) {
      // No more patients — room becomes libre
      await pool.query("UPDATE hospital_rooms SET statut = 'libre' WHERE id = ?", [roomId])
      if (structureId) await emitQueueUpdate(io, structureId)
      return res.json({ success: true, message: 'File vide — salle libre', next_patient: null })
    }

    const entry = next[0]
    const calledAt = new Date()

    // Mark as 'appele' (not en_consultation yet — doctor must click "Patient présent")
    await pool.query(
      "UPDATE queue_entries SET statut = 'appele', called_at = ? WHERE id = ?",
      [calledAt, entry.id]
    )
    await pool.query("UPDATE hospital_rooms SET statut = 'occupee' WHERE id = ?", [roomId])

    // Notify called patient
    await notifyAndEmit(
      io, entry.patient_id, 'appointment',
      "C'est votre tour !",
      `Veuillez vous présenter en ${roomNom}. Vous avez 5 minutes !`,
      { appointment_id: entry.appointment_id }
    )
    io?.to(`user_${entry.patient_id}`).emit('patient:called', {
      room_nom: roomNom,
      service_nom: serviceNom,
      queue_entry_id: entry.id,
      appointment_id: entry.appointment_id,
      called_at: calledAt.toISOString(),
      deadline: new Date(calledAt.getTime() + CALL_TIMEOUT_MS).toISOString(),
    })

    // Notify remaining patients of new position
    const [remaining] = await pool.query(
      "SELECT * FROM queue_entries WHERE room_id = ? AND statut = 'en_attente' ORDER BY numero_ordre",
      [roomId]
    )
    for (let i = 0; i < remaining.length; i++) {
      const pat = remaining[i]
      io?.to(`user_${pat.patient_id}`).emit('queue:position', {
        queue_entry_id: pat.id,
        position: i + 1,
        eta_min: (i + 1) * AVG_CONSULT_MIN,
      })
    }

    // Also emit to hospital dashboard
    io?.to(`hospital_struct_${structureId}`).emit('patient:called', {
      room_id: roomId,
      queue_entry_id: entry.id,
      patient_id: entry.patient_id,
      patient_nom: `${entry.patient_nom || 'Patient'}`,
      called_at: calledAt.toISOString(),
      deadline: new Date(calledAt.getTime() + CALL_TIMEOUT_MS).toISOString(),
    })

    // 5-minute server-side timeout → emit warning if still appele
    if (calledTimers.has(entry.id)) clearTimeout(calledTimers.get(entry.id))
    const t = setTimeout(async () => {
      try {
        const [stillCalled] = await pool.query(
          "SELECT id FROM queue_entries WHERE id = ? AND statut = 'appele'",
          [entry.id]
        )
        if (stillCalled.length) {
          io?.to(`hospital_struct_${structureId}`).emit('patient:timeout', {
            queue_entry_id: entry.id, room_id: roomId, patient_id: entry.patient_id,
          })
          io?.to(`user_${entry.patient_id}`).emit('patient:timeout', {
            queue_entry_id: entry.id,
          })
        }
      } catch (_) {}
      calledTimers.delete(entry.id)
    }, CALL_TIMEOUT_MS)
    calledTimers.set(entry.id, t)

    if (structureId) await emitQueueUpdate(io, structureId)

    res.json({
      success: true,
      next_patient: {
        patient_id: entry.patient_id,
        patient_nom: entry.patient_nom,
        appointment_id: entry.appointment_id,
        queue_entry_id: entry.id,
        called_at: calledAt.toISOString(),
        deadline: new Date(calledAt.getTime() + CALL_TIMEOUT_MS).toISOString(),
      },
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── SALLES: terminer consultation / examen / hospitalisation ──────────────────
// POST /api/v1/hospital/rooms/:roomId/finish-consultation
router.post('/rooms/:roomId/finish-consultation', requireAuth, requireRole('clinique'), async (req, res) => {
  const roomId = parseInt(req.params.roomId)
  const { resultats } = req.body // for exams
  try {
    const [current] = await pool.query(
      "SELECT * FROM queue_entries WHERE room_id = ? AND statut = 'en_consultation' ORDER BY numero_ordre LIMIT 1",
      [roomId]
    )
    if (!current.length) return res.status(404).json({ detail: 'Aucune consultation en cours' })

    const entry = current[0]
    const io = req.app.get('io')
    await pool.query("UPDATE queue_entries SET statut = 'termine' WHERE id = ?", [entry.id])

    const entryType = entry.entry_type || 'consultation'

    if (entryType === 'exam' && entry.exam_id) {
      await pool.query(
        "UPDATE medical_exams SET statut = 'realise', resultats = COALESCE(?, resultats) WHERE id = ?",
        [resultats || null, entry.exam_id]
      )
      const [examRows] = await pool.query('SELECT * FROM medical_exams WHERE id = ?', [entry.exam_id])
      if (examRows[0]) {
        const examNames = (() => { try { const p = typeof examRows[0].examens === 'string' ? JSON.parse(examRows[0].examens) : examRows[0].examens; return Array.isArray(p) ? p : [p] } catch { return [] } })()
        await notifyAndEmit(io, examRows[0].patient_id, 'exam_done',
          `🔬 Examens réalisés${examNames[0] ? ' — ' + examNames[0] : ''}`,
          `Vos examens sont terminés.${resultats ? ' Les résultats sont disponibles dans Mon Espace.' : ''} Veuillez confirmer pour valider le paiement.`,
          { exam_id: entry.exam_id, action: 'confirm_exam' }
        )
        io?.to(`user_${examRows[0].patient_id}`).emit('exam:done', {
          exam_id: entry.exam_id, resultats: resultats || null, action: 'confirm_exam',
        })
      }
    } else if (entryType === 'hospitalization' && entry.hospitalization_id) {
      await pool.query(
        "UPDATE hospitalizations SET statut = 'termine' WHERE id = ? AND statut IN ('acceptee','en_cours')",
        [entry.hospitalization_id]
      )
      const [hospRows] = await pool.query('SELECT * FROM hospitalizations WHERE id = ?', [entry.hospitalization_id])
      if (hospRows[0]) {
        await notifyAndEmit(io, hospRows[0].patient_id, 'hospitalization_done',
          '🏥 Hospitalisation terminée — Confirmez svp',
          'Votre hospitalisation est terminée. Veuillez confirmer votre sortie pour valider le paiement.',
          { hospitalization_id: entry.hospitalization_id, action: 'confirm_hospitalization' }
        )
        io?.to(`user_${hospRows[0].patient_id}`).emit('hospitalization:done', {
          hospitalization_id: entry.hospitalization_id, action: 'confirm_hospitalization',
        })
      }
    } else if (entry.appointment_id) {
      await pool.query(
        "UPDATE appointments SET consultation_statut = 'effectuee', statut = 'termine' WHERE id = ?",
        [entry.appointment_id]
      )
      const [appts] = await pool.query('SELECT * FROM appointments WHERE id = ?', [entry.appointment_id])
      const appt = appts[0]
      if (appt) {
        await notifyAndEmit(
          io, appt.patient_id, 'appointment',
          'Consultation terminée — Confirmez svp',
          'Votre consultation est terminée. Veuillez confirmer pour valider le paiement.',
          { appointment_id: entry.appointment_id, action: 'confirm_consultation' }
        )
        io?.to(`user_${appt.patient_id}`).emit('appointment:update', {
          id: entry.appointment_id, statut: 'termine',
          consultation_statut: 'effectuee', action: 'confirm_consultation',
        })
      }
    }

    const [roomInfo] = await pool.query(
      'SELECT hs.structure_id FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id WHERE hr.id = ?',
      [roomId]
    )
    if (roomInfo[0]?.structure_id) await emitQueueUpdate(io, roomInfo[0].structure_id)

    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── SALLES: patient présent → démarrer consultation ──────────────────────────
// POST /api/v1/hospital/rooms/:roomId/start-consultation
router.post('/rooms/:roomId/start-consultation', requireAuth, requireRole('clinique'), async (req, res) => {
  const roomId = parseInt(req.params.roomId)
  try {
    const [called] = await pool.query(
      "SELECT * FROM queue_entries WHERE room_id = ? AND statut = 'appele' ORDER BY called_at DESC LIMIT 1",
      [roomId]
    )
    if (!called.length) return res.status(404).json({ detail: 'Aucun patient appelé dans cette salle' })

    const entry = called[0]

    // Clear timer
    if (calledTimers.has(entry.id)) {
      clearTimeout(calledTimers.get(entry.id))
      calledTimers.delete(entry.id)
    }

    await pool.query("UPDATE queue_entries SET statut = 'en_consultation' WHERE id = ?", [entry.id])
    await pool.query("UPDATE hospital_rooms SET statut = 'occupee' WHERE id = ?", [roomId])

    const [roomInfo] = await pool.query(
      `SELECT hr.nom AS room_nom, hs.nom AS service_nom, hs.structure_id
       FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id WHERE hr.id = ?`,
      [roomId]
    )
    const structureId = roomInfo[0]?.structure_id
    const io = req.app.get('io')

    await notifyAndEmit(
      io, entry.patient_id, 'appointment',
      'Consultation en cours',
      `Votre consultation a commencé en ${roomInfo[0]?.room_nom ?? 'salle'}. Restez disponible.`,
      { appointment_id: entry.appointment_id }
    )
    io?.to(`user_${entry.patient_id}`).emit('appointment:update', {
      id: entry.appointment_id, queue_statut: 'en_consultation',
    })

    if (structureId) await emitQueueUpdate(io, structureId)
    res.json({ success: true, entry_id: entry.id, appointment_id: entry.appointment_id })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── SALLES: patient absent ────────────────────────────────────────────────────
// POST /api/v1/hospital/rooms/:roomId/patient-absent
router.post('/rooms/:roomId/patient-absent', requireAuth, requireRole('clinique'), async (req, res) => {
  const roomId = parseInt(req.params.roomId)
  try {
    const [called] = await pool.query(
      "SELECT * FROM queue_entries WHERE room_id = ? AND statut = 'appele' ORDER BY called_at DESC LIMIT 1",
      [roomId]
    )
    if (!called.length) return res.status(404).json({ detail: 'Aucun patient appelé' })

    const entry = called[0]

    // Clear timer
    if (calledTimers.has(entry.id)) {
      clearTimeout(calledTimers.get(entry.id))
      calledTimers.delete(entry.id)
    }

    const absentCount = (entry.absent_count || 0) + 1
    const io = req.app.get('io')

    if (absentCount >= 2) {
      // Deuxième absence : marqué absent définitivement
      await pool.query(
        "UPDATE queue_entries SET statut = 'absent', absent_count = ? WHERE id = ?",
        [absentCount, entry.id]
      )
      if (entry.appointment_id) {
        await pool.query(
          "UPDATE appointments SET statut = 'refuse' WHERE id = ? AND statut != 'termine'",
          [entry.appointment_id]
        )
      }
      await notifyAndEmit(
        io, entry.patient_id, 'appointment',
        'Passage annulé — Absent',
        'Vous étiez absent(e) deux fois lors de votre appel. Votre consultation a été annulée.',
        { appointment_id: entry.appointment_id }
      )
      io?.to(`user_${entry.patient_id}`).emit('appointment:update', {
        id: entry.appointment_id, statut: 'refuse', queue_statut: 'absent',
      })
    } else {
      // Première absence : remis en fin de file
      const [maxQ] = await pool.query(
        "SELECT MAX(numero_ordre) AS maxn FROM queue_entries WHERE room_id = ? AND statut NOT IN ('termine','absent')",
        [roomId]
      )
      const newOrder = (parseInt(maxQ[0]?.maxn ?? 0)) + 1
      await pool.query(
        "UPDATE queue_entries SET statut = 'en_attente', absent_count = ?, numero_ordre = ?, called_at = NULL WHERE id = ?",
        [absentCount, newOrder, entry.id]
      )
      await notifyAndEmit(
        io, entry.patient_id, 'appointment',
        'Absent — Remis en file',
        'Vous étiez absent lors de votre appel. Vous avez été replacé(e) en fin de file d\'attente.',
        { appointment_id: entry.appointment_id }
      )
      io?.to(`user_${entry.patient_id}`).emit('appointment:update', {
        id: entry.appointment_id, queue_statut: 'en_attente',
      })
    }

    // Room libre si plus personne en consultation
    const [inConsult] = await pool.query(
      "SELECT id FROM queue_entries WHERE room_id = ? AND statut = 'en_consultation'",
      [roomId]
    )
    if (!inConsult.length) {
      await pool.query("UPDATE hospital_rooms SET statut = 'libre' WHERE id = ?", [roomId])
    }

    const [roomInfo] = await pool.query(
      'SELECT hs.structure_id FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id WHERE hr.id = ?',
      [roomId]
    )
    if (roomInfo[0]?.structure_id) await emitQueueUpdate(io, roomInfo[0].structure_id)

    res.json({ success: true, absent_count: absentCount, permanent: absentCount >= 2 })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── MÉDECIN: ajouter une ordonnance ──────────────────────────────────────────
// POST /api/v1/hospital/appointment/:id/prescription
router.post('/appointment/:id/prescription', requireAuth, requireRole('clinique'), async (req, res) => {
  const apptId = parseInt(req.params.id)
  const { medicaments, notes } = req.body

  if (!medicaments || !Array.isArray(medicaments) || medicaments.length === 0) {
    return res.status(422).json({ detail: 'Au moins un médicament requis' })
  }

  try {
    const structureId = await getStructureForUser(req.user.id)
    const [appts] = await pool.query(
      'SELECT * FROM appointments WHERE id = ? AND structure_id = ?',
      [apptId, structureId]
    )
    if (!appts.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const appt = appts[0]

    const [prescRes] = await pool.query(
      'INSERT INTO prescriptions (appointment_id, patient_id, emetteur_id, medicaments, notes) VALUES (?, ?, ?, ?, ?)',
      [apptId, appt.patient_id, req.user.id, JSON.stringify(medicaments), notes || null]
    )
    const prescId = prescRes.insertId

    // Créer rappels MediA pour chaque médicament
    const today = new Date().toISOString().slice(0, 10)
    for (const med of medicaments) {
      if (!med.nom) continue
      const horaires = parseFrequence(med.frequence)
      const dateFin = med.duree ? addDays(today, parseDureeJours(med.duree)) : null
      for (const h of horaires) {
        await pool.query(
          `INSERT INTO medical_reminders
             (patient_id, prescription_id, appointment_id, type, titre, description, horaire, date_debut, date_fin, medicament_nom)
           VALUES (?, ?, ?, 'medicament', ?, ?, ?, ?, ?, ?)`,
          [
            appt.patient_id, prescId, apptId,
            `${med.nom} — Prise`,
            [med.dosage, med.instructions].filter(Boolean).join(' · '),
            h, today, dateFin, med.nom,
          ]
        )
      }
    }

    const io = req.app.get('io')
    await notifyAndEmit(
      io, appt.patient_id, 'prescription',
      '📋 Ordonnance disponible',
      `Votre ordonnance contient ${medicaments.length} médicament(s). Disponible dans Mon Espace.`,
      { prescription_id: prescId, appointment_id: apptId }
    )
    io?.to(`user_${appt.patient_id}`).emit('medical:prescription', { prescription_id: prescId, appointment_id: apptId })

    res.status(201).json({ id: prescId, success: true, reminders_count: medicaments.length })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

function parseFrequence(freq) {
  if (!freq) return ['08:00']
  const f = freq.toLowerCase()
  if (f.includes('matin') && f.includes('soir')) return ['08:00', '20:00']
  if (f.includes('3') || f.includes('trois')) return ['08:00', '13:00', '20:00']
  if (f.includes('4') || f.includes('quatre')) return ['08:00', '12:00', '16:00', '20:00']
  if (f.includes('soir')) return ['20:00']
  if (f.includes('midi')) return ['12:00']
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

// ── HÔPITAL: décharger un patient hospitalisé + ordonnance de sortie ─────────
// POST /api/v1/hospital/hospitalizations/:id/discharge
router.post('/hospitalizations/:id/discharge', requireAuth, requireRole('clinique'), async (req, res) => {
  const hospId = parseInt(req.params.id)
  const { medicaments, consignes, rdv_controle, recommandations, repos_jours, notes } = req.body
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query('SELECT * FROM hospitalizations WHERE id = ?', [hospId])
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Hospitalisation introuvable' }) }
    const hosp = rows[0]

    await conn.query("UPDATE hospitalizations SET statut = 'termine' WHERE id = ?", [hospId])
    await conn.query(
      "UPDATE queue_entries SET statut = 'termine' WHERE hospitalization_id = ? AND statut NOT IN ('absent','termine')",
      [hospId]
    )

    let prescId = null
    const hasMeds = Array.isArray(medicaments) && medicaments.length > 0
    if (hasMeds || consignes || recommandations || repos_jours || rdv_controle) {
      const [prescRes] = await conn.query(
        `INSERT INTO prescriptions
           (appointment_id, hospitalization_id, patient_id, emetteur_id, medicaments, notes, type, consignes, rdv_controle, recommandations, repos_jours)
         VALUES (NULL, ?, ?, ?, ?, ?, 'sortie', ?, ?, ?, ?)`,
        [hospId, hosp.patient_id, req.user.id, JSON.stringify(medicaments || []), notes || null,
         consignes || null, rdv_controle || null, recommandations || null, repos_jours || null]
      )
      prescId = prescRes.insertId

      if (hasMeds) {
        const today = new Date().toISOString().slice(0, 10)
        for (const med of medicaments) {
          if (!med.nom) continue
          const horaires = parseFrequence(med.frequence)
          const dateFin = med.duree ? addDays(today, parseDureeJours(med.duree)) : null
          for (const h of horaires) {
            await conn.query(
              `INSERT INTO medical_reminders
                 (patient_id, prescription_id, type, titre, description, horaire, date_debut, date_fin, medicament_nom)
               VALUES (?, ?, 'medicament', ?, ?, ?, ?, ?, ?)`,
              [hosp.patient_id, prescId,
               `${med.nom} — Prise`,
               [med.dosage, med.instructions].filter(Boolean).join(' · '),
               h, today, dateFin, med.nom]
            )
          }
        }
      }

      if (rdv_controle) {
        await conn.query(
          `INSERT INTO medical_reminders
             (patient_id, prescription_id, type, titre, description, date_debut, date_fin)
           VALUES (?, ?, 'rdv', 'Rendez-vous de contrôle', ?, ?, ?)`,
          [hosp.patient_id, prescId,
           "Rendez-vous de contrôle suite à votre hospitalisation",
           rdv_controle, rdv_controle]
        )
      }
    }

    await conn.commit()

    const io = req.app.get('io')
    await notifyAndEmit(io, hosp.patient_id, 'hospitalization_done',
      '🏥 Sortie d\'hospitalisation',
      `Votre hospitalisation est terminée.${prescId ? ' Une ordonnance de sortie est disponible dans Mon Espace.' : ''}`,
      { hospitalization_id: hospId, action: 'discharged' }
    )
    io?.to(`user_${hosp.patient_id}`).emit('hospitalization:done', {
      hospitalization_id: hospId, action: 'discharged', prescription_id: prescId,
    })

    if (hosp.emetteur_id) {
      await notifyAndEmit(io, hosp.emetteur_id, 'hospitalization_discharged',
        '✅ Patient sorti',
        `Le patient a été libéré.${prescId ? ' Ordonnance de sortie créée.' : ''}`,
        { hospitalization_id: hospId }
      )
    }

    if (hosp.assigned_room_id) {
      const [roomInfo] = await pool.query(
        'SELECT hs.structure_id FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id WHERE hr.id = ?',
        [hosp.assigned_room_id]
      )
      if (roomInfo[0]?.structure_id) await emitQueueUpdate(io, roomInfo[0].structure_id)
    }

    res.json({ success: true, prescription_id: prescId })
  } catch (e) {
    await conn.rollback()
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally { conn.release() }
})

// ── PATIENT: confirmer consultation (libère l'escrow) ─────────────────────────
// POST /api/v1/hospital/appointment/:id/patient-confirm
router.post('/appointment/:id/patient-confirm', requireAuth, requireRole('patient'), async (req, res) => {
  const apptId = parseInt(req.params.id)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [appts] = await conn.query(
      'SELECT * FROM appointments WHERE id = ? AND patient_id = ?',
      [apptId, req.user.id]
    )
    if (!appts.length) {
      await conn.rollback(); conn.release()
      return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    }
    const appt = appts[0]

    if (appt.consultation_statut !== 'effectuee') {
      await conn.rollback(); conn.release()
      return res.status(422).json({ detail: 'La consultation n\'est pas encore terminée' })
    }
    if (appt.paiement_statut === 'libere') {
      await conn.rollback(); conn.release()
      return res.json({ success: true, message: 'Déjà confirmé' })
    }

    // Release escrow: hôpital reçoit 100% du montant de base, MedMap+ reçoit la commission
    if (appt.paiement_id && appt.paiement_statut === 'bloque' && parseFloat(appt.prix) > 0) {
      // Lire commission stockée au moment du paiement
      const [payRows] = await conn.query('SELECT montant, commission FROM payments WHERE id = ?', [appt.paiement_id])
      const montantBase = payRows.length ? parseFloat(payRows[0].montant) : parseFloat(appt.prix)
      const commission = payRows.length ? parseFloat(payRows[0].commission || (montantBase * COMMISSION_TAUX / 100)) : parseFloat((montantBase * COMMISSION_TAUX / 100).toFixed(2))

      await conn.query("UPDATE payments SET statut = 'libere' WHERE id = ?", [appt.paiement_id])

      // Hôpital reçoit 100% du montant de base
      const [structRows] = await conn.query('SELECT user_id FROM structure_profiles WHERE id = ?', [appt.structure_id])
      if (structRows[0]) {
        const [hopWallet] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [structRows[0].user_id])
        if (hopWallet[0]) {
          await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montantBase, hopWallet[0].id])
          await conn.query(
            'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
            [hopWallet[0].id, montantBase, `Consultation #${appt.ticket_numero || apptId} — paiement intégral (100%)`]
          )
        }
      }

      // MedMap+ reçoit la commission payée en sus par le client
      const [adminRows] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [1])
      if (adminRows[0]) {
        await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [commission, adminRows[0].id])
        await conn.query(
          'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
          [adminRows[0].id, commission, `Commission MedMap+ 15% — consultation #${appt.ticket_numero || apptId}`]
        )
      }
    }

    // Mark appointment as fully confirmed/liberated
    await conn.query(
      "UPDATE appointments SET consultation_statut = 'confirmee', paiement_statut = 'libere' WHERE id = ?",
      [apptId]
    )

    // Patient confirmed → unlock referrals that were waiting for this (envoyee_reception → en_traitement)
    const [pendingRefs] = await conn.query(
      "SELECT * FROM medical_referrals WHERE appointment_id = ? AND statut = 'envoyee_reception'",
      [apptId]
    )
    for (const ref of pendingRefs) {
      await conn.query(
        "UPDATE medical_referrals SET statut = 'en_traitement' WHERE id = ?",
        [ref.id]
      )
    }

    await conn.commit()
    conn.release()

    const io = req.app.get('io')

    // Notify hospital dashboard: payment confirmed
    io?.to(`hospital_struct_${appt.structure_id}`).emit('appointment:update', {
      id: apptId, consultation_statut: 'confirmee', paiement_statut: 'libere',
    })

    // Notify reception that referral buttons are now unlocked
    if (pendingRefs.length > 0) {
      const structId = appt.structure_id || pendingRefs[0]?.structure_id
      if (structId) {
        io?.to(`hospital_struct_${structId}`).emit('referral:confirmed', {
          referral_ids: pendingRefs.map(r => r.id),
          specialites: pendingRefs.map(r => r.specialite),
          message: 'Patient a confirmé — vous pouvez attribuer la salle',
        })
      }
    }

    res.json({ success: true, referrals_unlocked: pendingRefs.length })
  } catch (e) {
    await conn.rollback(); conn.release()
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION : orientations en attente d'attribution ────────────────────────
// GET /api/v1/hospital/referrals/pending
router.get('/referrals/pending', requireAuth, requireRole('clinique'), async (req, res) => {
  try {
    const [structRows] = await pool.query(
      'SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id]
    )
    if (!structRows.length) return res.json([])
    const structureId = structRows[0].id

    const [rows] = await pool.query(
      `SELECT r.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel,
              ue.nom AS emetteur_nom, ue.prenom AS emetteur_prenom,
              a.service AS appt_service, a.date_rdv AS appt_date,
              a.consultation_statut AS appt_consultation_statut,
              hr.nom AS assigned_room_nom, hs.nom AS assigned_service_nom,
              (r.statut != 'envoyee_reception') AS patient_confirmed
       FROM medical_referrals r
       JOIN users u ON u.id = r.patient_id
       JOIN users ue ON ue.id = r.emetteur_id
       JOIN appointments a ON a.id = r.appointment_id
       LEFT JOIN hospital_rooms hr ON hr.id = r.assigned_room_id
       LEFT JOIN hospital_services hs ON hs.id = hr.service_id
       WHERE r.structure_id = ? AND r.statut IN ('envoyee_reception','en_traitement','attribuee')
       ORDER BY
         CASE r.urgence WHEN 'tres_urgent' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
         r.created_at ASC`,
      [structureId]
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION : attribuer salle à une orientation ────────────────────────────
// POST /api/v1/hospital/referrals/:id/assign
router.post('/referrals/:id/assign', requireAuth, requireRole('clinique'), async (req, res) => {
  const refId = parseInt(req.params.id)
  const { room_id, date_rdv, heure_rdv, tarif } = req.body
  try {
    const [structRows] = await pool.query(
      'SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id]
    )
    if (!structRows.length) return res.status(403).json({ detail: 'Structure introuvable' })
    const structureId = structRows[0].id

    const [refs] = await pool.query(
      `SELECT r.*, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM medical_referrals r
       JOIN users u ON u.id = r.patient_id
       WHERE r.id = ? AND r.structure_id = ?`,
      [refId, structureId]
    )
    if (!refs.length) return res.status(404).json({ detail: 'Orientation introuvable' })
    if (refs[0].statut === 'envoyee_reception') {
      return res.status(422).json({ detail: 'Le patient n\'a pas encore confirmé la première consultation. Attribution impossible pour l\'instant.' })
    }
    if (refs[0].statut !== 'en_traitement') {
      return res.status(422).json({ detail: 'Orientation déjà attribuée ou traitée.' })
    }
    const ref = refs[0]

    // Get room info for notification
    let roomNom = null
    if (room_id) {
      const [roomRows] = await pool.query(
        `SELECT hr.nom AS room_nom, hs.nom AS service_nom
         FROM hospital_rooms hr
         JOIN hospital_services hs ON hs.id = hr.service_id
         WHERE hr.id = ? AND hs.structure_id = ?`,
        [room_id, structureId]
      )
      if (!roomRows.length) return res.status(422).json({ detail: 'Salle introuvable dans cet établissement' })
      roomNom = `${roomRows[0].service_nom} — ${roomRows[0].room_nom}`
    }

    const assignedTarif = tarif != null ? parseFloat(tarif) : ref.tarif
    const assignedDate  = date_rdv  || ref.date_proposee || new Date().toISOString().split('T')[0]
    const assignedHeure = heure_rdv || ref.heure_proposee || '09:00'

    await pool.query(
      `UPDATE medical_referrals
       SET statut = 'attribuee', assigned_room_id = ?, assigned_by_id = ?,
           date_proposee = ?, heure_proposee = ?, tarif = ?
       WHERE id = ?`,
      [room_id || null, req.user.id, assignedDate, assignedHeure, assignedTarif, refId]
    )

    // Notify patient: referral is ready with room, date, tarif — needs accept/pay
    const io = req.app.get('io')
    const tariStr  = assignedTarif ? ` Tarif : ${parseFloat(assignedTarif).toLocaleString('fr-FR')} FCFA.` : ''
    const roomStr  = roomNom ? ` Salle : ${roomNom}.` : ''
    const dateStr  = assignedDate ? ` Date : ${assignedDate} à ${assignedHeure}.` : ''

    await notifyAndEmit(io, ref.patient_id, 'referral_assigned',
      `📋 Orientation attribuée — ${ref.specialite}`,
      `Votre orientation vers ${ref.specialite} a été traitée.${roomStr}${dateStr}${tariStr} Veuillez accepter ou refuser dans Mon Espace.`,
      { referral_id: refId }
    )
    io?.to(`user_${ref.patient_id}`).emit('referral:assigned', {
      referral_id: refId,
      specialite: ref.specialite,
      room_nom: roomNom,
      date_rdv: assignedDate,
      heure_rdv: assignedHeure,
      tarif: assignedTarif,
    })

    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── PATIENT: statut de son ticket / position file ────────────────────────────
// GET /api/v1/hospital/ticket/:appointmentId
router.get('/ticket/:appointmentId', requireAuth, async (req, res) => {
  const apptId = parseInt(req.params.appointmentId)
  try {
    const [appts] = await pool.query(
      `SELECT a.*,
              sp.nom AS structure_nom, sp.adresse AS structure_adresse, sp.telephone AS structure_tel,
              hr.nom AS room_nom, hs.nom AS service_nom
       FROM appointments a
       LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
       LEFT JOIN hospital_rooms hr ON hr.id = a.room_id
       LEFT JOIN hospital_services hs ON hs.nom = a.service AND hs.structure_id = a.structure_id
       WHERE a.id = ? AND a.patient_id = ?`,
      [apptId, req.user.id]
    )
    if (!appts.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = appts[0]

    // Queue info
    let queueInfo = null
    if (appt.room_id) {
      const [myEntry] = await pool.query(
        "SELECT * FROM queue_entries WHERE appointment_id = ? AND statut != 'termine' LIMIT 1",
        [apptId]
      )
      if (myEntry.length) {
        const entry = myEntry[0]
        const [before] = await pool.query(
          `SELECT COUNT(*) AS cnt FROM queue_entries
           WHERE room_id = ? AND statut IN ('en_attente','appele') AND numero_ordre < ?`,
          [appt.room_id, entry.numero_ordre]
        )
        const personneAvant = parseInt(before[0].cnt)
        queueInfo = {
          entry_id: entry.id,
          statut: entry.statut,
          numero_ordre: entry.numero_ordre,
          personnes_avant: personneAvant,
          eta_min: personneAvant * AVG_CONSULT_MIN,
          called_at: entry.called_at ?? null,
          deadline: entry.called_at
            ? new Date(new Date(entry.called_at).getTime() + CALL_TIMEOUT_MS).toISOString()
            : null,
        }
      }
    }

    res.json({ ...appt, queue_info: queueInfo })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── SETUP: créer un service ───────────────────────────────────────────────────
// POST /api/v1/hospital/setup/services
router.post('/setup/services', requireAuth, requireRole('clinique'), async (req, res) => {
  const { nom, specialite } = req.body
  if (!nom) return res.status(422).json({ detail: 'Nom requis' })
  try {
    const structureId = await getStructureForUser(req.user.id)
    const [r] = await pool.query(
      'INSERT INTO hospital_services (structure_id, nom, specialite) VALUES (?, ?, ?)',
      [structureId, nom, specialite || nom]
    )
    res.status(201).json({ id: r.insertId, nom, specialite: specialite || nom })
  } catch (e) {
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── SETUP: ajouter une salle ──────────────────────────────────────────────────
// POST /api/v1/hospital/setup/services/:serviceId/rooms
router.post('/setup/services/:serviceId/rooms', requireAuth, requireRole('clinique'), async (req, res) => {
  const { nom, medecin_nom } = req.body
  if (!nom) return res.status(422).json({ detail: 'Nom requis' })
  try {
    const [r] = await pool.query(
      'INSERT INTO hospital_rooms (service_id, nom, medecin_nom) VALUES (?, ?, ?)',
      [parseInt(req.params.serviceId), nom, medecin_nom || null]
    )
    res.status(201).json({ id: r.insertId, nom })
  } catch (e) {
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION : examens en attente ──────────────────────────────────────────
// GET /api/v1/hospital/exams/pending
router.get('/exams/pending', requireAuth, requireRole('clinique'), async (req, res) => {
  try {
    const [structRows] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
    if (!structRows.length) return res.json([])
    const structureId = structRows[0].id

    const [rows] = await pool.query(
      `SELECT e.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel,
              ue.nom AS emetteur_nom, ue.prenom AS emetteur_prenom,
              hr.nom AS assigned_room_nom, hs.nom AS assigned_service_nom
       FROM medical_exams e
       JOIN users u ON u.id = e.patient_id
       JOIN users ue ON ue.id = e.emetteur_id
       LEFT JOIN hospital_rooms hr ON hr.id = e.assigned_room_id
       LEFT JOIN hospital_services hs ON hs.id = hr.service_id
       WHERE e.structure_id = ? AND e.statut IN ('envoyee_reception','en_traitement','attribuee')
       ORDER BY
         CASE e.urgence WHEN 'urgent' THEN 0 WHEN 'tres_urgent' THEN 0 ELSE 1 END,
         e.created_at ASC`,
      [structureId]
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION : attribuer salle à un examen ──────────────────────────────────
// POST /api/v1/hospital/exams/:id/assign
router.post('/exams/:id/assign', requireAuth, requireRole('clinique'), async (req, res) => {
  const examId = parseInt(req.params.id)
  const { room_id, date_rdv, heure_rdv, tarif } = req.body
  try {
    const [structRows] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
    if (!structRows.length) return res.status(403).json({ detail: 'Structure introuvable' })
    const structureId = structRows[0].id

    const [exams] = await pool.query(
      `SELECT e.*, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM medical_exams e JOIN users u ON u.id = e.patient_id
       WHERE e.id = ? AND e.structure_id = ?`,
      [examId, structureId]
    )
    if (!exams.length) return res.status(404).json({ detail: 'Examen introuvable' })
    if (exams[0].statut === 'envoyee_reception') {
      return res.status(422).json({ detail: 'Le patient n\'a pas encore confirmé la consultation. Attribution impossible.' })
    }
    if (exams[0].statut !== 'en_traitement') {
      return res.status(422).json({ detail: 'Examen déjà attribué ou traité.' })
    }
    const exam = exams[0]

    let roomNom = null
    if (room_id) {
      const [roomRows] = await pool.query(
        `SELECT hr.nom AS room_nom, hs.nom AS service_nom
         FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id
         WHERE hr.id = ? AND hs.structure_id = ?`,
        [room_id, structureId]
      )
      if (!roomRows.length) return res.status(422).json({ detail: 'Salle introuvable dans cet établissement' })
      roomNom = `${roomRows[0].service_nom} — ${roomRows[0].room_nom}`
    }

    const examNames = (() => { try { const p = typeof exam.examens === 'string' ? JSON.parse(exam.examens) : exam.examens; return Array.isArray(p) ? p : [p] } catch { return [exam.examens] } })()
    const assignedTarif = tarif != null ? parseFloat(tarif) : (exam.tarif || exam.frais)
    const assignedDate  = date_rdv  || exam.date_proposee || new Date().toISOString().split('T')[0]
    const assignedHeure = heure_rdv || '09:00'

    await pool.query(
      `UPDATE medical_exams SET statut = 'attribuee', assigned_room_id = ?, assigned_by_id = ?,
          date_proposee = ?, heure_rdv = ?, tarif = ? WHERE id = ?`,
      [room_id || null, req.user.id, assignedDate, assignedHeure, assignedTarif, examId]
    )

    const io = req.app.get('io')
    const tariStr = assignedTarif ? ` Tarif : ${parseFloat(assignedTarif).toLocaleString('fr-FR')} FCFA.` : ''
    const roomStr = roomNom ? ` Salle : ${roomNom}.` : ''
    await notifyAndEmit(io, exam.patient_id, 'exam_assigned',
      `🔬 Examens planifiés — ${examNames.slice(0,2).join(', ')}`,
      `Vos examens ont été planifiés.${roomStr}${tariStr} Veuillez accepter ou refuser dans Mon Espace.`,
      { exam_id: examId }
    )
    io?.to(`user_${exam.patient_id}`).emit('exam:assigned', {
      exam_id: examId, room_nom: roomNom, date_rdv: assignedDate, heure_rdv: assignedHeure, tarif: assignedTarif,
    })
    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION : hospitalisations en attente ──────────────────────────────────
// GET /api/v1/hospital/hospitalizations/pending
router.get('/hospitalizations/pending', requireAuth, requireRole('clinique'), async (req, res) => {
  try {
    const [structRows] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
    if (!structRows.length) return res.json([])
    const structureId = structRows[0].id

    const [rows] = await pool.query(
      `SELECT h.*,
              u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel,
              ue.nom AS emetteur_nom, ue.prenom AS emetteur_prenom,
              hr.nom AS assigned_room_nom, hs.nom AS assigned_service_nom
       FROM hospitalizations h
       JOIN users u ON u.id = h.patient_id
       JOIN users ue ON ue.id = h.emetteur_id
       LEFT JOIN hospital_rooms hr ON hr.id = h.assigned_room_id
       LEFT JOIN hospital_services hs ON hs.id = hr.service_id
       WHERE h.structure_id = ? AND h.statut IN ('envoyee_reception','en_traitement','attribuee')
       ORDER BY
         CASE h.urgence WHEN 'urgent' THEN 0 WHEN 'tres_urgent' THEN 0 ELSE 1 END,
         h.created_at ASC`,
      [structureId]
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── RÉCEPTION : attribuer chambre à une hospitalisation ──────────────────────
// POST /api/v1/hospital/hospitalizations/:id/assign
router.post('/hospitalizations/:id/assign', requireAuth, requireRole('clinique'), async (req, res) => {
  const hospId = parseInt(req.params.id)
  const { room_id, date_rdv, heure_rdv, tarif } = req.body
  try {
    const [structRows] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
    if (!structRows.length) return res.status(403).json({ detail: 'Structure introuvable' })
    const structureId = structRows[0].id

    const [hosps] = await pool.query(
      `SELECT h.*, u.nom AS patient_nom, u.prenom AS patient_prenom
       FROM hospitalizations h JOIN users u ON u.id = h.patient_id
       WHERE h.id = ? AND h.structure_id = ?`,
      [hospId, structureId]
    )
    if (!hosps.length) return res.status(404).json({ detail: 'Hospitalisation introuvable' })
    if (hosps[0].statut === 'envoyee_reception') {
      return res.status(422).json({ detail: 'Le patient n\'a pas encore confirmé la consultation. Attribution impossible.' })
    }
    if (hosps[0].statut !== 'en_traitement') {
      return res.status(422).json({ detail: 'Hospitalisation déjà attribuée ou traitée.' })
    }
    const hosp = hosps[0]

    let roomNom = null
    if (room_id) {
      const [roomRows] = await pool.query(
        `SELECT hr.nom AS room_nom, hs.nom AS service_nom
         FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id
         WHERE hr.id = ? AND hs.structure_id = ?`,
        [room_id, structureId]
      )
      if (!roomRows.length) return res.status(422).json({ detail: 'Salle introuvable dans cet établissement' })
      roomNom = `${roomRows[0].service_nom} — ${roomRows[0].room_nom}`
    }

    const assignedTarif = tarif != null ? parseFloat(tarif) : hosp.frais
    const assignedDate  = date_rdv  || new Date().toISOString().split('T')[0]
    const assignedHeure = heure_rdv || '09:00'

    await pool.query(
      `UPDATE hospitalizations SET statut = 'attribuee', assigned_room_id = ?, assigned_by_id = ?,
          frais = COALESCE(?, frais) WHERE id = ?`,
      [room_id || null, req.user.id, assignedTarif || null, hospId]
    )

    const io = req.app.get('io')
    const tariStr = assignedTarif ? ` Frais : ${parseFloat(assignedTarif).toLocaleString('fr-FR')} FCFA.` : ''
    const roomStr = roomNom ? ` Chambre : ${roomNom}.` : ''
    await notifyAndEmit(io, hosp.patient_id, 'hospitalization_assigned',
      `🏥 Hospitalisation attribuée — ${hosp.service || 'Hospitalisation'}`,
      `Une chambre vous a été attribuée.${roomStr}${tariStr} Veuillez accepter ou refuser dans Mon Espace.`,
      { hospitalization_id: hospId }
    )
    io?.to(`user_${hosp.patient_id}`).emit('hospitalization:assigned', {
      hospitalization_id: hospId, room_nom: roomNom, tarif: assignedTarif,
    })
    res.json({ success: true })
  } catch (e) {
    console.error(e)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
