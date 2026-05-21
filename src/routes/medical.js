const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

const COMMISSION_TAUX = 15 // 15% — ajoutée au client, le provider reçoit 100%
const ADMIN_USER_ID = 1

const URGENCE_LABELS = { normal: 'Normal', urgent: 'Urgent', tres_urgent: 'Très urgent' }

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function escrowDebit(conn, patientId, montant, description) {
  const montantBase = parseFloat(montant)
  const commission = parseFloat((montantBase * COMMISSION_TAUX / 100).toFixed(2))
  const totalDebite = parseFloat((montantBase + commission).toFixed(2))

  const [wallets] = await conn.query('SELECT id, solde FROM wallets WHERE user_id = ?', [patientId])
  if (!wallets.length || parseFloat(wallets[0].solde) < totalDebite) {
    throw new Error(`Solde insuffisant. Besoin de ${totalDebite.toLocaleString('fr-FR')} FCFA (dont ${commission.toLocaleString('fr-FR')} FCFA de commission MedMap+).`)
  }
  // Client paie base + commission
  await conn.query('UPDATE wallets SET solde = solde - ? WHERE id = ?', [totalDebite, wallets[0].id])
  await conn.query(
    'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "debit", ?)',
    [wallets[0].id, totalDebite, `${description} (base ${montantBase.toLocaleString('fr-FR')} + commission ${commission.toLocaleString('fr-FR')})`]
  )
  // Stocke montant de base + commission séparément
  const [payRes] = await conn.query(
    `INSERT INTO payments (payer_id, montant, commission, description, statut) VALUES (?, ?, ?, ?, 'en_attente')`,
    [patientId, montantBase, commission, description]
  )
  return payRes.insertId
}

async function escrowRelease(conn, paiementId, providerId) {
  const [payments] = await conn.query('SELECT * FROM payments WHERE id = ?', [paiementId])
  if (!payments.length || payments[0].statut !== 'en_attente') return
  const payment = payments[0]
  const montantBase = parseFloat(payment.montant)
  const commission = parseFloat(payment.commission || (montantBase * COMMISSION_TAUX / 100).toFixed(2))

  // Provider reçoit 100% du montant de base
  if (providerId) {
    const [pw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [providerId])
    if (pw.length) {
      await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montantBase, pw[0].id])
      await conn.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
        [pw[0].id, montantBase, `${payment.description} — paiement intégral (100%)`]
      )
    }
  }
  // MedMap+ reçoit la commission payée en sus par le client
  const [aw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [ADMIN_USER_ID])
  if (aw.length) {
    await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [commission, aw[0].id])
    await conn.query(
      'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
      [aw[0].id, commission, `Commission MedMap+ 15% — ${payment.description}`]
    )
  }
  await conn.query("UPDATE payments SET statut = 'confirme' WHERE id = ?", [paiementId])
}

async function escrowRefund(conn, paiementId, patientId, reason) {
  const [payments] = await conn.query('SELECT * FROM payments WHERE id = ?', [paiementId])
  if (!payments.length || payments[0].statut !== 'en_attente') return
  const montant = parseFloat(payments[0].montant)
  const [pw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [patientId])
  if (pw.length) {
    await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montant, pw[0].id])
    await conn.query(
      'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
      [pw[0].id, montant, `Remboursement — ${reason}`]
    )
  }
  await conn.query("UPDATE payments SET statut = 'rembourse' WHERE id = ?", [paiementId])
}

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function getStructureUserId(structureId) {
  if (!structureId) return null
  const [rows] = await pool.query('SELECT user_id FROM structure_profiles WHERE id = ?', [structureId])
  return rows[0]?.user_id ?? null
}

// ─── ORIENTATIONS / TRANSFERTS ──────────────────────────────────────────────

// POST /medical/appointments/:id/refer — créer une orientation
router.post('/appointments/:id/refer', requireAuth, async (req, res) => {
  if (!['clinique', 'medecin', 'veterinaire'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Accès refusé' })
  }
  const {
    specialite, motif, urgence, resume_medical, symptomes_observes,
    medecin_recommande, service_recommande, date_proposee, heure_proposee,
    tarif, examens_necessaires, commentaire,
  } = req.body
  if (!specialite) return res.status(422).json({ detail: 'Spécialité requise' })

  try {
    const [apptRows] = await pool.query('SELECT * FROM appointments WHERE id = ?', [req.params.id])
    if (!apptRows.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const appt = apptRows[0]

    // Resolve structure_id: from appointment, or from the doctor's associated structure,
    // or from the current user's own structure_profile
    let structureId = appt.structure_id || null
    if (!structureId) {
      const [sp] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
      if (sp.length) structureId = sp[0].id
    }
    if (!structureId) {
      // Look up via the queue entry for this appointment
      const [qe] = await pool.query(
        `SELECT hs.structure_id FROM queue_entries qe
         JOIN hospital_rooms hr ON hr.id = qe.room_id
         JOIN hospital_services hs ON hs.id = hr.service_id
         WHERE qe.appointment_id = ? LIMIT 1`,
        [req.params.id]
      )
      if (qe.length) structureId = qe[0].structure_id
    }

    const isUrgent = ['urgent', 'tres_urgent'].includes(urgence)

    const [result] = await pool.query(
      `INSERT INTO medical_referrals
         (appointment_id, patient_id, emetteur_id, structure_id, specialite, motif, urgence,
          resume_medical, symptomes_observes, medecin_recommande, service_recommande,
          date_proposee, heure_proposee, tarif, examens_necessaires, commentaire, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'envoyee_reception')`,
      [req.params.id, appt.patient_id, req.user.id, structureId,
       specialite, motif || null, urgence || 'normal', resume_medical || null,
       symptomes_observes || null, medecin_recommande || null,
       service_recommande || null, date_proposee || null, heure_proposee || null,
       tarif || null, examens_necessaires || null, commentaire || null]
    )
    const referralId = result.insertId

    // Mark the first consultation as "effectuee" so the patient can confirm it
    await pool.query(
      "UPDATE appointments SET consultation_statut = 'effectuee' WHERE id = ? AND consultation_statut != 'confirmee'",
      [req.params.id]
    )

    const io = req.app.get('io')
    const urgLabel = URGENCE_LABELS[urgence] || 'Normal'

    // 1. Notify reception immediately — visible but buttons blocked until patient confirms
    const urgencyFlag = isUrgent ? ' ⚠ URGENT' : ''
    if (structureId) {
      io?.to(`hospital_struct_${structureId}`).emit('referral:new', {
        referral_id: referralId,
        specialite,
        urgence,
        patient_id: appt.patient_id,
        appointment_id: parseInt(req.params.id),
      })
      const structUserid = await getStructureUserId(structureId)
      if (structUserid) {
        await notifyAndEmit(io, structUserid, 'referral_new_reception',
          `Nouvelle orientation${urgencyFlag} — ${specialite}`,
          `Orientation vers ${specialite} créée. En attente de confirmation du patient avant attribution.`,
          { referral_id: referralId }
        )
      }
    }

    // 2. Notify patient to confirm the first consultation (which unlocks the referral for reception)
    await notifyAndEmit(io, appt.patient_id, 'consultation_confirm_request',
      `Confirmez votre consultation — Orientation ${specialite}`,
      `Votre médecin vous a orienté vers ${specialite}${urgLabel !== 'Normal' ? ` (${urgLabel})` : ''}. Confirmez d'abord que la consultation générale a bien eu lieu pour activer l'orientation.`,
      { appointment_id: parseInt(req.params.id), referral_id: referralId, action: 'confirm_consultation' }
    )
    io?.to(`user_${appt.patient_id}`).emit('consultation:confirm_request', {
      appointment_id: parseInt(req.params.id),
      referral_id: referralId,
      specialite,
    })

    const [rows] = await pool.query('SELECT * FROM medical_referrals WHERE id = ?', [referralId])
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /medical/referrals — liste des orientations
router.get('/referrals', requireAuth, async (req, res) => {
  try {
    let sql, params
    if (req.user.role === 'patient') {
      sql = `
        SELECT r.*,
               u.nom AS emetteur_nom, u.prenom AS emetteur_prenom,
               a.service AS appt_service, a.date_rdv AS appt_date
        FROM medical_referrals r
        JOIN users u ON u.id = r.emetteur_id
        JOIN appointments a ON a.id = r.appointment_id
        WHERE r.patient_id = ?
        ORDER BY r.created_at DESC`
      params = [req.user.id]
    } else {
      sql = `
        SELECT r.*,
               u.nom AS patient_nom, u.prenom AS patient_prenom
        FROM medical_referrals r
        JOIN users u ON u.id = r.patient_id
        WHERE r.emetteur_id = ?
        ORDER BY r.created_at DESC`
      params = [req.user.id]
    }
    const [rows] = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /medical/referrals/:id — détail orientation
router.get('/referrals/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*,
              u.nom AS emetteur_nom, u.prenom AS emetteur_prenom,
              up.nom AS patient_nom, up.prenom AS patient_prenom,
              a.service AS appt_service, a.date_rdv AS appt_date,
              sp.nom AS structure_nom
       FROM medical_referrals r
       JOIN users u ON u.id = r.emetteur_id
       JOIN users up ON up.id = r.patient_id
       JOIN appointments a ON a.id = r.appointment_id
       LEFT JOIN structure_profiles sp ON sp.user_id = r.emetteur_id
       WHERE r.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Orientation introuvable' })
    res.json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /medical/referrals/:id/accept — patient accepte l'orientation ATTRIBUÉE → paie + crée RDV + ajoute à la file
router.post('/referrals/:id/accept', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query(
      `SELECT r.*, hr.nom AS room_nom, hs.structure_id AS room_structure_id
       FROM medical_referrals r
       LEFT JOIN hospital_rooms hr ON hr.id = r.assigned_room_id
       LEFT JOIN hospital_services hs ON hs.id = hr.service_id
       WHERE r.id = ? AND r.patient_id = ?`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const ref = rows[0]

    if (ref.statut !== 'attribuee') {
      await conn.rollback(); conn.release()
      return res.status(422).json({
        detail: ref.statut === 'en_attente_attribution'
          ? 'La réception n\'a pas encore attribué de salle. Patientez.'
          : 'Cette orientation a déjà été traitée.'
      })
    }

    // Charge patient escrow for specialist consultation
    let paiementId = null
    const structureId = ref.room_structure_id || ref.structure_id
    if (ref.tarif && parseFloat(ref.tarif) > 0) {
      try {
        paiementId = await escrowDebit(conn, req.user.id, ref.tarif,
          `Consultation ${ref.specialite} — orientation médicale`)
        // Link payment to structure
        if (structureId) {
          await conn.query('UPDATE payments SET structure_id = ? WHERE id = ?', [structureId, paiementId])
        }
      } catch (e) {
        await conn.rollback(); conn.release()
        return res.status(422).json({ detail: e.message })
      }
    }

    // Create new appointment for the specialist consultation
    const today = new Date().toISOString().split('T')[0]
    const [apptResult] = await conn.query(
      `INSERT INTO appointments
         (patient_id, provider_type, structure_id, service, date_rdv, heure_rdv, motif,
          prix, paiement_statut, commission_taux, paiement_id, room_id, statut, type_consultation)
       VALUES (?, 'structure', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirme', 'immediate')`,
      [req.user.id, structureId || null, ref.specialite,
       ref.date_proposee || today,
       ref.heure_proposee || '09:00',
       `Consultation ${ref.specialite} — suite à orientation médicale`,
       ref.tarif || null,
       ref.tarif && parseFloat(ref.tarif) > 0 ? 'bloque' : 'non_requis',
       COMMISSION_TAUX, paiementId, ref.assigned_room_id || null]
    )
    const newApptId = apptResult.insertId

    if (paiementId) {
      await conn.query('UPDATE payments SET appointment_id = ? WHERE id = ?', [newApptId, paiementId])
    }

    // Generate ticket number for the new appointment
    const [ticketCount] = await conn.query(
      'SELECT COUNT(*) AS cnt FROM appointments WHERE structure_id = ? AND DATE(created_at) = CURDATE()',
      [structureId || 0]
    )
    const ticketNum = `A${String((ticketCount[0]?.cnt || 0) + 1).padStart(3, '0')}`
    await conn.query('UPDATE appointments SET ticket_numero = ? WHERE id = ?', [ticketNum, newApptId])

    // Add patient to specialist room queue if a room was assigned
    if (ref.assigned_room_id) {
      const [maxQ] = await conn.query(
        'SELECT MAX(numero_ordre) AS maxn FROM queue_entries WHERE room_id = ? AND statut != ?',
        [ref.assigned_room_id, 'absent']
      )
      const queuePos = (parseInt(maxQ[0]?.maxn ?? 0)) + 1
      await conn.query(
        `INSERT INTO queue_entries (room_id, appointment_id, patient_id, patient_nom, numero_ordre)
         VALUES (?, ?, ?, ?, ?)`,
        [ref.assigned_room_id, newApptId, req.user.id,
         `Patient #${req.user.id}`, queuePos]
      )
    }

    await conn.query(
      "UPDATE medical_referrals SET statut = 'acceptee', new_appointment_id = ?, paiement_id = ? WHERE id = ?",
      [newApptId, paiementId, req.params.id]
    )

    await conn.commit()

    const io = req.app.get('io')
    // Notify the referring doctor
    await notifyAndEmit(io, ref.emetteur_id, 'referral_accepted',
      `✅ Orientation acceptée — ${ref.specialite}`,
      `Le patient a accepté l'orientation vers ${ref.specialite}. Un rendez-vous a été créé (ticket ${ticketNum}).`,
      { referral_id: parseInt(req.params.id), appointment_id: newApptId }
    )
    // Notify specialist room (hospital dashboard will update queue)
    if (structureId) {
      io?.to(`hospital_struct_${structureId}`).emit('appointment:new', {
        id: newApptId, service: ref.specialite, ticket_numero: ticketNum,
        type_consultation: 'immediate', statut: 'confirme',
      })
    }

    res.json({ success: true, appointment_id: newApptId, ticket_numero: ticketNum })
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally {
    conn.release()
  }
})

// POST /medical/referrals/:id/refuse — patient refuse
router.post('/referrals/:id/refuse', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query('SELECT * FROM medical_referrals WHERE id = ? AND patient_id = ?',
      [req.params.id, req.user.id])
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const ref = rows[0]
    if (!['attribuee', 'en_traitement', 'envoyee_reception'].includes(ref.statut)) {
      await conn.rollback(); conn.release()
      return res.status(422).json({ detail: 'Déjà traité' })
    }
    await conn.query("UPDATE medical_referrals SET statut = 'refusee' WHERE id = ?", [req.params.id])
    await conn.commit()
    const io = req.app.get('io')
    await notifyAndEmit(io, ref.emetteur_id, 'referral_refused',
      `❌ Orientation refusée — ${ref.specialite}`,
      `Le patient a refusé l'orientation vers ${ref.specialite}.`,
      { referral_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally {
    conn.release()
  }
})

// ─── HOSPITALISATIONS ────────────────────────────────────────────────────────

// POST /medical/appointments/:id/hospitalize — demande hospitalisation
router.post('/appointments/:id/hospitalize', requireAuth, async (req, res) => {
  if (!['clinique', 'medecin'].includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })
  const {
    motif, duree_estimee, service, chambre, urgence, frais, examens, commentaire
  } = req.body
  if (!motif) return res.status(422).json({ detail: 'Motif requis' })

  try {
    const [apptRows] = await pool.query('SELECT * FROM appointments WHERE id = ?', [req.params.id])
    if (!apptRows.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const appt = apptRows[0]

    const [structRows] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
    const structId = structRows.length ? structRows[0].id : null

    const [result] = await pool.query(
      `INSERT INTO hospitalizations
         (appointment_id, patient_id, emetteur_id, structure_id, motif, duree_estimee,
          service, chambre, urgence, frais, examens, commentaire, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'envoyee_reception')`,
      [req.params.id, appt.patient_id, req.user.id, structId, motif,
       duree_estimee || null, service || null, chambre || null,
       urgence || 'normal', frais || null, examens || null, commentaire || null]
    )

    const io = req.app.get('io')
    // Notify patient: request submitted, pending reception processing
    await notifyAndEmit(io, appt.patient_id, 'hospitalization_new',
      '🏥 Demande d\'hospitalisation soumise',
      `Votre médecin a soumis une demande d'hospitalisation. La réception va l'attribuer après confirmation de votre consultation actuelle.`,
      { hospitalization_id: result.insertId, appointment_id: parseInt(req.params.id) }
    )
    // Notify hospital reception
    if (structId) {
      io?.to(`hospital_struct_${structId}`).emit('hospitalization:new', {
        hospitalization_id: result.insertId,
        patient_nom: appt.patient_nom || `Patient #${appt.patient_id}`,
        service: service || 'Hospitalisation',
        urgence: urgence || 'normal',
      })
    }

    const [rows] = await pool.query('SELECT * FROM hospitalizations WHERE id = ?', [result.insertId])
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /medical/hospitalizations — liste des hospitalisations
router.get('/hospitalizations', requireAuth, async (req, res) => {
  try {
    let sql, params
    if (req.user.role === 'patient') {
      sql = `
        SELECT h.*, u.nom AS emetteur_nom, u.prenom AS emetteur_prenom,
               sp.nom AS structure_nom
        FROM hospitalizations h
        JOIN users u ON u.id = h.emetteur_id
        LEFT JOIN structure_profiles sp ON sp.id = h.structure_id
        WHERE h.patient_id = ? ORDER BY h.created_at DESC`
      params = [req.user.id]
    } else {
      const [spRows] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
      const structId = spRows.length ? spRows[0].id : -1
      sql = `
        SELECT h.*, u.nom AS patient_nom, u.prenom AS patient_prenom, u.telephone AS patient_tel
        FROM hospitalizations h
        JOIN users u ON u.id = h.patient_id
        WHERE h.emetteur_id = ? OR h.structure_id = ?
        ORDER BY h.created_at DESC`
      params = [req.user.id, structId]
    }
    const [rows] = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /medical/hospitalizations/:id/accept — patient accepte l'hospitalisation (paiement direct)
router.post('/hospitalizations/:id/accept', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query('SELECT * FROM hospitalizations WHERE id = ? AND patient_id = ?',
      [req.params.id, req.user.id])
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const hosp = rows[0]
    if (hosp.statut !== 'attribuee') {
      await conn.rollback(); conn.release()
      return res.status(422).json({ detail: 'La réception n\'a pas encore attribué de chambre.' })
    }

    let paiementId = null
    if (hosp.frais && parseFloat(hosp.frais) > 0) {
      const montant = parseFloat(hosp.frais)
      const commission = parseFloat((montant * COMMISSION_TAUX / 100).toFixed(2))
      const montantNet = parseFloat((montant - commission).toFixed(2))
      const description = `Hospitalisation — ${hosp.service || hosp.motif}`

      // Check balance
      const [wallets] = await conn.query('SELECT id, solde FROM wallets WHERE user_id = ?', [req.user.id])
      if (!wallets.length || parseFloat(wallets[0].solde) < montant) {
        await conn.rollback(); conn.release()
        return res.status(422).json({ detail: `Solde insuffisant. Besoin de ${montant.toLocaleString('fr-FR')} FCFA.` })
      }

      // Debit patient
      await conn.query('UPDATE wallets SET solde = solde - ? WHERE id = ?', [montant, wallets[0].id])
      await conn.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "debit", ?)',
        [wallets[0].id, montant, description]
      )

      // Record payment as confirmed (direct, no escrow)
      const [payRes] = await conn.query(
        `INSERT INTO payments (payer_id, structure_id, montant, commission, description, statut)
         VALUES (?, ?, ?, ?, ?, 'confirme')`,
        [req.user.id, hosp.structure_id, montant, commission, description]
      )
      paiementId = payRes.insertId

      // Credit hospital 90%
      if (hosp.structure_id) {
        const [structUser] = await conn.query('SELECT user_id FROM structure_profiles WHERE id = ?', [hosp.structure_id])
        if (structUser[0]?.user_id) {
          const [hw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [structUser[0].user_id])
          if (hw.length) {
            await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montantNet, hw[0].id])
            await conn.query(
              'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
              [hw[0].id, montantNet, `${description} — paiement net`]
            )
          }
        }
      }

      // Credit admin 10%
      const [aw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [ADMIN_USER_ID])
      if (aw.length) {
        await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [commission, aw[0].id])
        await conn.query(
          'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
          [aw[0].id, commission, `Commission MedMap+ — ${description}`]
        )
      }
    }

    await conn.query(
      "UPDATE hospitalizations SET statut = 'acceptee', paiement_statut = ?, paiement_id = ? WHERE id = ?",
      [hosp.frais && parseFloat(hosp.frais) > 0 ? 'libere' : 'non_requis', paiementId, req.params.id]
    )

    // Add patient to room queue
    if (hosp.assigned_room_id) {
      const [maxQ] = await conn.query(
        "SELECT MAX(numero_ordre) AS maxn FROM queue_entries WHERE room_id = ? AND statut != 'absent'",
        [hosp.assigned_room_id]
      )
      const queuePos = (parseInt(maxQ[0]?.maxn ?? 0)) + 1
      await conn.query(
        `INSERT INTO queue_entries (room_id, hospitalization_id, patient_id, patient_nom, numero_ordre, entry_type)
         VALUES (?, ?, ?, ?, ?, 'hospitalization')`,
        [hosp.assigned_room_id, parseInt(req.params.id), req.user.id, `Patient #${req.user.id}`, queuePos]
      )
      await conn.query(
        "UPDATE hospital_rooms SET statut = 'occupee' WHERE id = ? AND statut = 'libre'",
        [hosp.assigned_room_id]
      )
    }

    await conn.commit()

    const io = req.app.get('io')
    // Notify structure queue update
    if (hosp.assigned_room_id) {
      const [roomInfo] = await pool.query(
        'SELECT hs.structure_id FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id WHERE hr.id = ?',
        [hosp.assigned_room_id]
      )
      if (roomInfo[0]?.structure_id) {
        io?.to(`hospital_struct_${roomInfo[0].structure_id}`).emit('queue:patient_joined', {
          structureId: roomInfo[0].structure_id, type: 'hospitalization',
        })
      }
    }
    await notifyAndEmit(io, hosp.emetteur_id, 'hospitalization_accepted',
      '✅ Hospitalisation acceptée',
      `Le patient a accepté l'hospitalisation.${hosp.frais ? ` ${parseFloat(hosp.frais).toLocaleString('fr-FR')} FCFA payés.` : ''}`,
      { hospitalization_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally {
    conn.release()
  }
})

// POST /medical/hospitalizations/:id/patient-confirm — patient confirme la sortie, libère escrow
router.post('/hospitalizations/:id/patient-confirm', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query('SELECT * FROM hospitalizations WHERE id = ? AND patient_id = ?',
      [req.params.id, req.user.id])
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const hosp = rows[0]
    if (hosp.statut !== 'termine') {
      await conn.rollback(); conn.release()
      return res.status(422).json({ detail: 'L\'hospitalisation n\'est pas encore terminée.' })
    }
    if (hosp.paiement_statut === 'libere') {
      await conn.rollback(); conn.release()
      return res.json({ success: true, message: 'Déjà confirmé' })
    }
    if (hosp.paiement_id) {
      const [structRows] = await conn.query('SELECT user_id FROM structure_profiles WHERE id = ?', [hosp.structure_id])
      await escrowRelease(conn, hosp.paiement_id, structRows[0]?.user_id ?? null)
    }
    await conn.query("UPDATE hospitalizations SET paiement_statut = 'libere' WHERE id = ?", [req.params.id])
    await conn.commit()
    const io = req.app.get('io')
    await notifyAndEmit(io, hosp.emetteur_id, 'hospitalization_confirmed',
      '✅ Sortie confirmée — Paiement libéré',
      'Le patient a confirmé la sortie. Le paiement a été libéré.',
      { hospitalization_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally { conn.release() }
})

// POST /medical/hospitalizations/:id/refuse — patient refuse
router.post('/hospitalizations/:id/refuse', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  try {
    const [rows] = await pool.query('SELECT * FROM hospitalizations WHERE id = ? AND patient_id = ?',
      [req.params.id, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    await pool.query("UPDATE hospitalizations SET statut = 'refusee' WHERE id = ?", [req.params.id])
    const io = req.app.get('io')
    await notifyAndEmit(io, rows[0].emetteur_id, 'hospitalization_refused',
      '❌ Hospitalisation refusée', `Le patient a refusé la demande d'hospitalisation.`,
      { hospitalization_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /medical/hospitalizations/:id/mark-done — hôpital marque la fin de l'hospitalisation (attend confirmation patient)
router.post('/hospitalizations/:id/mark-done', requireAuth, async (req, res) => {
  if (!['clinique', 'medecin'].includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })
  try {
    const [rows] = await pool.query('SELECT * FROM hospitalizations WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const hosp = rows[0]
    await pool.query("UPDATE hospitalizations SET statut = 'termine' WHERE id = ?", [req.params.id])
    // Mark queue entry done
    await pool.query(
      "UPDATE queue_entries SET statut = 'termine' WHERE hospitalization_id = ? AND statut NOT IN ('absent','termine')",
      [parseInt(req.params.id)]
    )
    const io = req.app.get('io')
    await notifyAndEmit(io, hosp.patient_id, 'hospitalization_done',
      '🏥 Hospitalisation terminée — Confirmez svp',
      'Votre hospitalisation est terminée. Veuillez confirmer votre sortie pour valider le paiement.',
      { hospitalization_id: parseInt(req.params.id), action: 'confirm_hospitalization' }
    )
    io?.to(`user_${hosp.patient_id}`).emit('hospitalization:done', {
      hospitalization_id: parseInt(req.params.id), action: 'confirm_hospitalization',
    })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── EXAMENS COMPLÉMENTAIRES ─────────────────────────────────────────────────

// POST /medical/appointments/:id/exams — demander des examens
router.post('/appointments/:id/exams', requireAuth, async (req, res) => {
  if (!['clinique', 'medecin'].includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })
  const { examens, motif, urgence, laboratoire, date_proposee, frais } = req.body
  if (!examens || !examens.length) return res.status(422).json({ detail: 'Au moins un examen requis' })

  try {
    const [apptRows] = await pool.query('SELECT * FROM appointments WHERE id = ?', [req.params.id])
    if (!apptRows.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const appt = apptRows[0]

    // Find structure_id (3-step fallback like referrals)
    let structureId = appt.structure_id || null
    if (!structureId) {
      const [sp] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
      if (sp.length) structureId = sp[0].id
    }
    if (!structureId) {
      const [qe] = await pool.query(
        `SELECT hs.structure_id FROM queue_entries qe
         JOIN hospital_rooms hr ON hr.id = qe.room_id
         JOIN hospital_services hs ON hs.id = hr.service_id
         WHERE qe.appointment_id = ? LIMIT 1`, [req.params.id]
      )
      if (qe.length) structureId = qe[0].structure_id
    }

    const [result] = await pool.query(
      `INSERT INTO medical_exams
         (appointment_id, patient_id, emetteur_id, structure_id, examens, motif, urgence, laboratoire, date_proposee, frais, statut)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'envoyee_reception')`,
      [req.params.id, appt.patient_id, req.user.id, structureId,
       JSON.stringify(Array.isArray(examens) ? examens : [examens]),
       motif || null, urgence || 'normal', laboratoire || null,
       date_proposee || null, frais || null]
    )
    const io = req.app.get('io')
    // Notify patient: request submitted, pending reception
    await notifyAndEmit(io, appt.patient_id, 'exams_requested',
      '🔬 Examens complémentaires demandés',
      `Votre médecin a prescrit des examens : ${Array.isArray(examens) ? examens.join(', ') : examens}. La réception va planifier cela après votre consultation.`,
      { exam_id: result.insertId, appointment_id: parseInt(req.params.id) }
    )
    // Notify reception
    if (structureId) {
      io?.to(`hospital_struct_${structureId}`).emit('exam:new', {
        exam_id: result.insertId,
        patient_nom: appt.patient_nom || `Patient #${appt.patient_id}`,
        examens: Array.isArray(examens) ? examens : [examens],
        urgence: urgence || 'normal',
      })
    }
    const [rows] = await pool.query('SELECT * FROM medical_exams WHERE id = ?', [result.insertId])
    res.status(201).json(rows[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /medical/exams/:id/accept — patient accepte un examen après attribution par réception
router.post('/exams/:id/accept', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query('SELECT * FROM medical_exams WHERE id = ? AND patient_id = ?', [req.params.id, req.user.id])
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const exam = rows[0]
    if (exam.statut !== 'attribuee') {
      await conn.rollback(); conn.release()
      return res.status(422).json({ detail: 'La réception n\'a pas encore attribué de salle.' })
    }

    let paiementId = null
    if (exam.tarif && parseFloat(exam.tarif) > 0) {
      try {
        paiementId = await escrowDebit(conn, req.user.id, exam.tarif,
          `Examens — ${(typeof exam.examens === 'string' ? JSON.parse(exam.examens) : exam.examens).slice(0,2).join(', ')}`)
      } catch (e) {
        await conn.rollback(); conn.release()
        return res.status(422).json({ detail: e.message })
      }
    } else if (exam.frais && parseFloat(exam.frais) > 0) {
      try {
        paiementId = await escrowDebit(conn, req.user.id, exam.frais,
          `Examens — ${(typeof exam.examens === 'string' ? JSON.parse(exam.examens) : exam.examens).slice(0,2).join(', ')}`)
      } catch (e) {
        await conn.rollback(); conn.release()
        return res.status(422).json({ detail: e.message })
      }
    }

    await conn.query(
      "UPDATE medical_exams SET statut = 'acceptee', paiement_id = ?, paiement_statut = ? WHERE id = ?",
      [paiementId, paiementId ? 'bloque' : 'non_requis', req.params.id]
    )

    // Add patient to exam room queue
    if (exam.assigned_room_id) {
      const [maxQ] = await conn.query(
        "SELECT MAX(numero_ordre) AS maxn FROM queue_entries WHERE room_id = ? AND statut != 'absent'",
        [exam.assigned_room_id]
      )
      const queuePos = (parseInt(maxQ[0]?.maxn ?? 0)) + 1
      await conn.query(
        `INSERT INTO queue_entries (room_id, exam_id, patient_id, patient_nom, numero_ordre, entry_type)
         VALUES (?, ?, ?, ?, ?, 'exam')`,
        [exam.assigned_room_id, parseInt(req.params.id), req.user.id, `Patient #${req.user.id}`, queuePos]
      )
      await conn.query(
        "UPDATE hospital_rooms SET statut = 'occupee' WHERE id = ? AND statut = 'libre'",
        [exam.assigned_room_id]
      )
    }

    await conn.commit()

    const io = req.app.get('io')
    if (exam.assigned_room_id) {
      const [roomInfo] = await pool.query(
        'SELECT hs.structure_id FROM hospital_rooms hr JOIN hospital_services hs ON hs.id = hr.service_id WHERE hr.id = ?',
        [exam.assigned_room_id]
      )
      if (roomInfo[0]?.structure_id) {
        io?.to(`hospital_struct_${roomInfo[0].structure_id}`).emit('queue:patient_joined', {
          structureId: roomInfo[0].structure_id, type: 'exam',
        })
      }
    }
    await notifyAndEmit(io, exam.emetteur_id, 'exam_accepted',
      '✅ Examens acceptés', `Le patient a accepté la demande d'examens.`,
      { exam_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally { conn.release() }
})

// POST /medical/exams/:id/mark-done — hôpital marque l'examen réalisé + résultats
router.post('/exams/:id/mark-done', requireAuth, async (req, res) => {
  if (!['clinique', 'medecin'].includes(req.user.role)) return res.status(403).json({ detail: 'Accès refusé' })
  const { resultats } = req.body
  try {
    const [rows] = await pool.query('SELECT * FROM medical_exams WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const exam = rows[0]
    await pool.query(
      "UPDATE medical_exams SET statut = 'realise', resultats = COALESCE(?, resultats) WHERE id = ?",
      [resultats || null, req.params.id]
    )
    // Mark queue entry done
    await pool.query(
      "UPDATE queue_entries SET statut = 'termine' WHERE exam_id = ? AND statut NOT IN ('absent','termine')",
      [parseInt(req.params.id)]
    )
    const io = req.app.get('io')
    const examNames = (() => { try { const p = typeof exam.examens === 'string' ? JSON.parse(exam.examens) : exam.examens; return Array.isArray(p) ? p : [p] } catch { return [exam.examens] } })()
    await notifyAndEmit(io, exam.patient_id, 'exam_done',
      `🔬 Examens réalisés — ${examNames.slice(0,2).join(', ')}`,
      `Vos examens sont terminés.${resultats ? ' Les résultats sont disponibles dans Mon Espace.' : ''} Veuillez confirmer pour valider le paiement.`,
      { exam_id: parseInt(req.params.id), action: 'confirm_exam' }
    )
    io?.to(`user_${exam.patient_id}`).emit('exam:done', {
      exam_id: parseInt(req.params.id), resultats: resultats || null, action: 'confirm_exam',
    })
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /medical/exams/:id/patient-confirm — patient confirme les examens, libère escrow
router.post('/exams/:id/patient-confirm', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query('SELECT * FROM medical_exams WHERE id = ? AND patient_id = ?',
      [req.params.id, req.user.id])
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const exam = rows[0]
    if (exam.statut !== 'realise') {
      await conn.rollback(); conn.release()
      return res.status(422).json({ detail: 'L\'examen n\'est pas encore réalisé.' })
    }
    if (exam.paiement_statut === 'libere') {
      await conn.rollback(); conn.release()
      return res.json({ success: true, message: 'Déjà confirmé' })
    }
    if (exam.paiement_id) {
      const [structRows] = await conn.query('SELECT user_id FROM structure_profiles WHERE id = ?', [exam.structure_id])
      await escrowRelease(conn, exam.paiement_id, structRows[0]?.user_id ?? null)
    }
    await conn.query("UPDATE medical_exams SET paiement_statut = 'libere' WHERE id = ?", [req.params.id])
    await conn.commit()
    const io = req.app.get('io')
    await notifyAndEmit(io, exam.emetteur_id, 'exam_confirmed',
      '✅ Examens confirmés — Paiement libéré',
      'Le patient a confirmé la réalisation des examens. Le paiement a été libéré.',
      { exam_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally { conn.release() }
})

// POST /medical/exams/:id/refuse — patient refuse un examen
router.post('/exams/:id/refuse', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  try {
    const [rows] = await pool.query('SELECT * FROM medical_exams WHERE id = ? AND patient_id = ?', [req.params.id, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    await pool.query("UPDATE medical_exams SET statut = 'refusee' WHERE id = ?", [req.params.id])
    const io = req.app.get('io')
    await notifyAndEmit(io, rows[0].emetteur_id, 'exam_refused',
      '❌ Examens refusés', `Le patient a refusé la demande d'examens.`,
      { exam_id: parseInt(req.params.id) }
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /medical/exams — liste des examens
router.get('/exams', requireAuth, async (req, res) => {
  try {
    let sql, params
    if (req.user.role === 'patient') {
      sql = `
        SELECT e.*, u.nom AS emetteur_nom, u.prenom AS emetteur_prenom
        FROM medical_exams e JOIN users u ON u.id = e.emetteur_id
        WHERE e.patient_id = ? ORDER BY e.created_at DESC`
      params = [req.user.id]
    } else {
      sql = `
        SELECT e.*, u.nom AS patient_nom, u.prenom AS patient_prenom
        FROM medical_exams e JOIN users u ON u.id = e.patient_id
        WHERE e.emetteur_id = ? ORDER BY e.created_at DESC`
      params = [req.user.id]
    }
    const [rows] = await pool.query(sql, params)
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── RAPPELS MÉDIA ────────────────────────────────────────────────────────────

// GET /medical/reminders — rappels du patient
router.get('/reminders', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM medical_reminders WHERE patient_id = ? AND actif = 1 ORDER BY created_at DESC',
      [req.user.id]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /medical/reminders/:id/toggle — activer/désactiver un rappel
router.put('/reminders/:id/toggle', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM medical_reminders WHERE id = ? AND patient_id = ?',
      [req.params.id, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const newActif = rows[0].actif ? 0 : 1
    await pool.query('UPDATE medical_reminders SET actif = ? WHERE id = ?', [newActif, req.params.id])
    res.json({ actif: newActif })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── DOSSIER MÉDICAL PATIENT ──────────────────────────────────────────────────

// GET /medical/patient-file — dossier complet du patient
router.get('/patient-file', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  try {
    const pid = req.user.id

    const [appointments] = await pool.query(
      `SELECT a.*,
              sp.nom AS structure_nom, sp.adresse AS structure_adresse,
              d.nom AS doctor_nom, d.prenom AS doctor_prenom,
              dp.specialite
       FROM appointments a
       LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
       LEFT JOIN users d ON d.id = a.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = a.doctor_id
       WHERE a.patient_id = ? AND (a.animal_id IS NULL)
       ORDER BY a.date_rdv DESC`,
      [pid]
    )

    const [prescriptions] = await pool.query(
      `SELECT p.*, a.date_rdv, a.service,
              sp.nom AS structure_nom, u.nom AS medecin_nom, u.prenom AS medecin_prenom,
              h.service AS hosp_service, h.motif AS hosp_motif
       FROM prescriptions p
       LEFT JOIN appointments a ON a.id = p.appointment_id
       LEFT JOIN hospitalizations h ON h.id = p.hospitalization_id
       LEFT JOIN structure_profiles sp ON sp.id = COALESCE(a.structure_id, h.structure_id)
       LEFT JOIN users u ON u.id = p.emetteur_id
       WHERE p.patient_id = ? ORDER BY p.created_at DESC`,
      [pid]
    )

    const [referrals] = await pool.query(
      `SELECT r.*,
              u.nom AS emetteur_nom, u.prenom AS emetteur_prenom,
              sp.nom AS structure_nom, a.date_rdv AS appt_date, a.service AS appt_service
       FROM medical_referrals r
       JOIN users u ON u.id = r.emetteur_id
       JOIN appointments a ON a.id = r.appointment_id
       LEFT JOIN structure_profiles sp ON sp.user_id = r.emetteur_id
       WHERE r.patient_id = ? ORDER BY r.created_at DESC`,
      [pid]
    )

    const [hospitalizations] = await pool.query(
      `SELECT h.*,
              u.nom AS emetteur_nom, u.prenom AS emetteur_prenom,
              sp.nom AS structure_nom
       FROM hospitalizations h
       JOIN users u ON u.id = h.emetteur_id
       LEFT JOIN structure_profiles sp ON sp.id = h.structure_id
       WHERE h.patient_id = ? ORDER BY h.created_at DESC`,
      [pid]
    )

    const [exams] = await pool.query(
      `SELECT e.*, u.nom AS emetteur_nom, u.prenom AS emetteur_prenom
       FROM medical_exams e JOIN users u ON u.id = e.emetteur_id
       WHERE e.patient_id = ? ORDER BY e.created_at DESC`,
      [pid]
    )

    const [reminders] = await pool.query(
      `SELECT * FROM medical_reminders
       WHERE patient_id = ? AND (medicament_nom IS NULL OR medicament_nom NOT LIKE '[%]%')
       ORDER BY created_at DESC`,
      [pid]
    )

    const [payments] = await pool.query(
      `SELECT * FROM payments WHERE payer_id = ? AND description LIKE '%consultation%'
       OR payer_id = ? AND description LIKE '%orientation%'
       OR payer_id = ? AND description LIKE '%hospitalisation%'
       OR payer_id = ? AND description LIKE '%examen%'
       ORDER BY created_at DESC LIMIT 50`,
      [pid, pid, pid, pid]
    )

    // Attach prescriptions to appointments
    const apptIds = appointments.map(a => a.id)
    let apptPrescriptions = {}
    if (apptIds.length) {
      const [presc] = await pool.query('SELECT * FROM prescriptions WHERE appointment_id IN (?)', [apptIds])
      for (const p of presc) {
        if (!apptPrescriptions[p.appointment_id]) apptPrescriptions[p.appointment_id] = []
        apptPrescriptions[p.appointment_id].push(p)
      }
    }

    res.json({
      appointments: appointments.map(a => ({
        ...a,
        prescriptions: apptPrescriptions[a.id] || []
      })),
      prescriptions,
      referrals,
      hospitalizations,
      exams,
      reminders,
      payments,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
