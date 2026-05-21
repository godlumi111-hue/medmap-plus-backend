const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

const COMMISSION_TAUX = 15 // 15% — ajoutée au client, le provider reçoit 100%
const ADMIN_USER_ID = 1

const STATUT_LABELS = {
  en_attente: 'En attente',
  confirme:   'Confirmé',
  refuse:     'Refusé',
  annule:     'Annulé',
  termine:    'Terminé',
}

// ── POST /appointments ──────────────────────────────────────────────────────
// Patient crée un rendez-vous + paiement séquestre si prix > 0
router.post('/', requireAuth, async (req, res) => {
  const {
    provider_type, doctor_id, structure_id, service, date_rdv, heure_rdv,
    type_rdv, motif, prix,
    symptomes, age_patient, sexe_patient, premiere_consult, antecedents,
    animal_id, animal_nom, animal_espece,
  } = req.body

  if (!provider_type || !date_rdv || !heure_rdv) {
    return res.status(422).json({ detail: 'Champs obligatoires manquants' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    let paiementStatut = 'non_requis'
    let paiementId = null

    // Séquestre si prix > 0
    if (prix && parseFloat(prix) > 0) {
      const [wallets] = await conn.query('SELECT id, solde FROM wallets WHERE user_id = ?', [req.user.id])
      if (!wallets.length) {
        await conn.rollback(); conn.release()
        return res.status(422).json({ detail: 'Portefeuille introuvable.' })
      }
      const walletId = wallets[0].id
      const prixBase = parseFloat(prix)
      const commission = parseFloat((prixBase * COMMISSION_TAUX / 100).toFixed(2))
      const totalDebite = parseFloat((prixBase + commission).toFixed(2))

      if (parseFloat(wallets[0].solde) < totalDebite) {
        await conn.rollback(); conn.release()
        return res.status(422).json({ detail: `Solde insuffisant. Vous avez besoin de ${totalDebite.toLocaleString('fr-FR')} FCFA (dont ${commission.toLocaleString('fr-FR')} FCFA de commission MedMap+).` })
      }

      // Débiter le patient (base + commission)
      await conn.query('UPDATE wallets SET solde = solde - ? WHERE id = ?', [totalDebite, walletId])
      await conn.query(
        'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "debit", ?)',
        [walletId, totalDebite, `Consultation ${service || 'médicale'} — séquestre (${prixBase.toLocaleString('fr-FR')} + ${commission.toLocaleString('fr-FR')} commission)`]
      )

      // Créer entrée de paiement (séquestre) — montant = base, commission = surcoût client
      const [payRes] = await conn.query(
        `INSERT INTO payments (payer_id, receiver_id, structure_id, montant, commission, description, statut)
         VALUES (?, ?, ?, ?, ?, ?, 'en_attente')`,
        [req.user.id, doctor_id || null, structure_id || null, prixBase, commission,
         `Consultation ${service || 'médicale'}`]
      )
      paiementId = payRes.insertId
      paiementStatut = 'bloque'
    }

    const [result] = await conn.query(
      `INSERT INTO appointments
         (patient_id, provider_type, doctor_id, structure_id, service, date_rdv, heure_rdv,
          type_rdv, motif, prix, symptomes, age_patient, sexe_patient, premiere_consult,
          antecedents, paiement_statut, commission_taux, paiement_id, animal_id, animal_nom, animal_espece)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, provider_type, doctor_id || null, structure_id || null,
       service || null, date_rdv, heure_rdv, type_rdv || null, motif || null,
       prix || null, symptomes || null, age_patient || null, sexe_patient || null,
       premiere_consult != null ? premiere_consult : 1, antecedents || null,
       paiementStatut, COMMISSION_TAUX, paiementId,
       animal_id || null, animal_nom || null, animal_espece || null]
    )

    if (paiementId) {
      await conn.query('UPDATE payments SET appointment_id = ? WHERE id = ?', [result.insertId, paiementId])
    }

    await conn.commit()

    const [rows] = await pool.query('SELECT * FROM appointments WHERE id = ?', [result.insertId])
    const io = req.app.get('io')

    // Notifier le prestataire
    if (doctor_id) {
      await notifyAndEmit(io, doctor_id, 'appointment_new', 'Nouveau rendez-vous',
        `${req.user.prenom} ${req.user.nom} — ${service || 'Consultation'} le ${date_rdv}`,
        { appointment_id: result.insertId }
      )
      if (io) io.to(`user_${doctor_id}`).emit('appointment:new', { appointment_id: result.insertId })
    }
    if (structure_id) {
      const [sp] = await pool.query('SELECT user_id FROM structure_profiles WHERE id = ?', [structure_id])
      if (sp.length) {
        await notifyAndEmit(io, sp[0].user_id, 'appointment_new', 'Nouveau rendez-vous',
          `${req.user.prenom} ${req.user.nom} — ${service || 'Consultation'} le ${date_rdv}`,
          { appointment_id: result.insertId }
        )
        if (io) io.to(`user_${sp[0].user_id}`).emit('appointment:new', { appointment_id: result.insertId })
      }
    }

    res.status(201).json(rows[0])
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally {
    conn.release()
  }
})

// ── GET /appointments ───────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    let sql, params
    if (req.user.role === 'medecin') {
      sql = `
        SELECT a.*, u.nom AS patient_nom, u.prenom AS patient_prenom,
               u.telephone AS patient_tel, u.email AS patient_email, u.id AS patient_user_id
        FROM appointments a JOIN users u ON u.id = a.patient_id
        WHERE a.doctor_id = ? ORDER BY a.date_rdv DESC, a.heure_rdv DESC`
      params = [req.user.id]
    } else if (['pharmacie', 'clinique', 'veterinaire'].includes(req.user.role)) {
      const [sp] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [req.user.id])
      const structId = sp.length ? sp[0].id : -1
      sql = `
        SELECT a.*, u.nom AS patient_nom, u.prenom AS patient_prenom,
               u.telephone AS patient_tel, u.email AS patient_email, u.id AS patient_user_id
        FROM appointments a JOIN users u ON u.id = a.patient_id
        WHERE a.structure_id = ? ORDER BY a.date_rdv DESC, a.heure_rdv DESC`
      params = [structId]
    } else {
      // patient
      sql = `
        SELECT a.*,
               d.nom AS doctor_nom, d.prenom AS doctor_prenom,
               dp.specialite, dp.cabinet,
               sp.nom AS structure_nom, sp.adresse AS structure_adresse,
               sp.ville AS structure_ville
        FROM appointments a
        LEFT JOIN users d ON d.id = a.doctor_id
        LEFT JOIN doctor_profiles dp ON dp.user_id = a.doctor_id
        LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
        WHERE a.patient_id = ? ORDER BY a.date_rdv DESC, a.heure_rdv DESC`
      params = [req.user.id]
    }
    const [rows] = await pool.query(sql, params)

    // Attach prescriptions for each appointment
    const ids = rows.map(r => r.id)
    let prescsByAppt = {}
    if (ids.length) {
      const [prescs] = await pool.query(
        'SELECT * FROM prescriptions WHERE appointment_id IN (?)', [ids]
      )
      for (const p of prescs) {
        if (!prescsByAppt[p.appointment_id]) prescsByAppt[p.appointment_id] = []
        prescsByAppt[p.appointment_id].push(p)
      }
    }
    const enriched = rows.map(r => ({ ...r, prescriptions: prescsByAppt[r.id] || [] }))
    res.json(enriched)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /appointments/:id ───────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, sp.nom AS structure_nom, d.nom AS doctor_nom, d.prenom AS doctor_prenom
       FROM appointments a
       LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
       LEFT JOIN users d ON d.id = a.doctor_id
       WHERE a.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const [prescs] = await pool.query('SELECT * FROM prescriptions WHERE appointment_id = ?', [req.params.id])
    res.json({ ...rows[0], prescriptions: prescs })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── PUT /appointments/:id/status ───────────────────────────────────────────
// Hôpital: confirme, refuse. Patient: annule.
router.put('/:id/status', requireAuth, async (req, res) => {
  const { statut } = req.body
  const validStatuts = ['en_attente', 'confirme', 'refuse', 'annule', 'termine']
  if (!validStatuts.includes(statut)) {
    return res.status(422).json({ detail: 'Statut invalide' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query(
      `SELECT a.*, u.id AS patient_user_id FROM appointments a
       JOIN users u ON u.id = a.patient_id WHERE a.id = ?`,
      [req.params.id]
    )
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const appt = rows[0]

    await conn.query('UPDATE appointments SET statut = ? WHERE id = ?', [statut, req.params.id])

    // Si refus ou annulation avec paiement bloqué → rembourser
    if (['refuse', 'annule'].includes(statut) && appt.paiement_statut === 'bloque' && appt.prix) {
      const montant = parseFloat(appt.prix)
      const [pw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [appt.patient_user_id])
      if (pw.length) {
        await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montant, pw[0].id])
        await conn.query(
          'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
          [pw[0].id, montant, `Remboursement RDV #${req.params.id} — ${STATUT_LABELS[statut]}`]
        )
      }
      if (appt.paiement_id) {
        await conn.query("UPDATE payments SET statut = 'rembourse' WHERE id = ?", [appt.paiement_id])
      }
      await conn.query("UPDATE appointments SET paiement_statut = 'rembourse' WHERE id = ?", [req.params.id])
    }

    await conn.commit()

    const io = req.app.get('io')
    if (appt.patient_user_id) {
      const label = STATUT_LABELS[statut] || statut
      await notifyAndEmit(io, appt.patient_user_id, `appointment_${statut}`,
        `Rendez-vous ${statut === 'refuse' ? 'refusé' : statut === 'confirme' ? 'confirmé ✓' : label} — RDV #${req.params.id}`,
        statut === 'confirme'
          ? `Votre rendez-vous est confirmé. Votre ticket électronique est disponible.`
          : statut === 'refuse'
            ? 'Votre demande de rendez-vous a été refusée. Vous avez été remboursé.'
            : `Service : ${appt.service || '—'}`,
        { appointment_id: parseInt(req.params.id), statut }
      )
      if (io) io.to(`user_${appt.patient_user_id}`).emit('appointment:update', {
        appointment_id: parseInt(req.params.id), statut
      })
    }

    const [updated] = await pool.query('SELECT * FROM appointments WHERE id = ?', [req.params.id])
    res.json(updated[0])
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally {
    conn.release()
  }
})

// ── POST /appointments/:id/mark-done ───────────────────────────────────────
// Hôpital marque la consultation comme effectuée → patient doit confirmer
router.post('/:id/mark-done', requireAuth, async (req, res) => {
  if (!['clinique', 'medecin', 'veterinaire'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Accès refusé' })
  }
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.id AS patient_user_id FROM appointments a
       JOIN users u ON u.id = a.patient_id WHERE a.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Introuvable' })
    const appt = rows[0]
    if (appt.statut !== 'confirme') {
      return res.status(422).json({ detail: 'Le rendez-vous doit être confirmé avant de marquer la consultation.' })
    }
    if (appt.consultation_statut === 'effectuee' || appt.consultation_statut === 'confirmee') {
      return res.json({ success: true, already: true })
    }

    await pool.query(
      "UPDATE appointments SET consultation_statut = 'effectuee' WHERE id = ?",
      [req.params.id]
    )

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_user_id, 'consultation_effectuee',
      '✅ Consultation effectuée — Action requise',
      `Votre consultation "${appt.service || 'médicale'}" a été enregistrée. Veuillez confirmer que la consultation a bien eu lieu.`,
      { appointment_id: parseInt(req.params.id) }
    )
    if (io) io.to(`user_${appt.patient_user_id}`).emit('appointment:update', {
      appointment_id: parseInt(req.params.id), consultation_statut: 'effectuee'
    })

    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /appointments/:id/patient-confirm ─────────────────────────────────
// Patient confirme que la consultation a eu lieu → libération des fonds
router.post('/:id/patient-confirm', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') {
    return res.status(403).json({ detail: 'Accès réservé au patient' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [rows] = await conn.query(
      `SELECT a.*, sp.user_id AS structure_user_id
       FROM appointments a
       LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
       WHERE a.id = ? AND a.patient_id = ?`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) { await conn.rollback(); conn.release(); return res.status(404).json({ detail: 'Introuvable' }) }
    const appt = rows[0]

    if (appt.consultation_statut !== 'effectuee') {
      await conn.rollback(); conn.release()
      return res.status(422).json({ detail: "L'établissement n'a pas encore marqué la consultation comme effectuée." })
    }
    if (appt.consultation_statut === 'confirmee') {
      await conn.rollback(); conn.release()
      return res.json({ success: true, already: true })
    }

    // Libérer les fonds — provider reçoit 100% du prix de base, MedMap+ reçoit la commission
    if (appt.paiement_statut === 'bloque' && appt.prix && parseFloat(appt.prix) > 0) {
      // Récupérer commission stockée dans payments
      let montantBase = parseFloat(appt.prix)
      let commission = parseFloat((montantBase * COMMISSION_TAUX / 100).toFixed(2))
      if (appt.paiement_id) {
        const [payRows] = await conn.query('SELECT montant, commission FROM payments WHERE id = ?', [appt.paiement_id])
        if (payRows.length) {
          montantBase = parseFloat(payRows[0].montant)
          commission = parseFloat(payRows[0].commission || (montantBase * COMMISSION_TAUX / 100))
        }
      }

      // Provider reçoit 100% du montant de base
      const providerId = appt.structure_user_id || appt.doctor_id
      if (providerId) {
        const [pw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [providerId])
        if (!pw.length) {
          await conn.query('INSERT INTO wallets (user_id, solde) VALUES (?, ?)', [providerId, montantBase])
        } else {
          await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montantBase, pw[0].id])
          await conn.query(
            'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
            [pw[0].id, montantBase, `Consultation RDV #${req.params.id} — paiement intégral`]
          )
        }
      }

      // MedMap+ reçoit la commission (payée par le client en sus)
      const [aw] = await conn.query('SELECT id FROM wallets WHERE user_id = ?', [ADMIN_USER_ID])
      if (aw.length) {
        await conn.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [commission, aw[0].id])
        await conn.query(
          'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, "credit", ?)',
          [aw[0].id, commission, `Commission MedMap+ RDV #${req.params.id} (15%)`]
        )
      }

      if (appt.paiement_id) {
        await conn.query("UPDATE payments SET statut = 'confirme' WHERE id = ?", [appt.paiement_id])
      }
    }

    await conn.query(
      "UPDATE appointments SET statut = 'termine', consultation_statut = 'confirmee', paiement_statut = 'libere' WHERE id = ?",
      [req.params.id]
    )

    // Transition pending referrals (envoyee_reception → en_traitement)
    const [pendingRefs] = await conn.query(
      "SELECT * FROM medical_referrals WHERE appointment_id = ? AND statut = 'envoyee_reception'",
      [req.params.id]
    )
    for (const ref of pendingRefs) {
      await conn.query("UPDATE medical_referrals SET statut = 'en_traitement' WHERE id = ?", [ref.id])
    }

    // Transition pending hospitalizations (envoyee_reception → en_traitement)
    const [pendingHosp] = await conn.query(
      "SELECT * FROM hospitalizations WHERE appointment_id = ? AND statut = 'envoyee_reception'",
      [req.params.id]
    )
    for (const h of pendingHosp) {
      await conn.query("UPDATE hospitalizations SET statut = 'en_traitement' WHERE id = ?", [h.id])
    }

    // Transition pending exams (envoyee_reception → en_traitement)
    const [pendingExams] = await conn.query(
      "SELECT * FROM medical_exams WHERE appointment_id = ? AND statut = 'envoyee_reception'",
      [req.params.id]
    )
    for (const e of pendingExams) {
      await conn.query("UPDATE medical_exams SET statut = 'en_traitement' WHERE id = ?", [e.id])
    }

    await conn.commit()

    const io = req.app.get('io')
    const providerId = appt.structure_user_id || appt.doctor_id
    if (providerId) {
      await notifyAndEmit(io, providerId, 'consultation_confirmee',
        '💰 Consultation confirmée — Fonds libérés',
        `La consultation de ${req.user.prenom} ${req.user.nom} a été confirmée. Les fonds ont été virés sur votre portefeuille.`,
        { appointment_id: parseInt(req.params.id) }
      )
      if (io) io.to(`user_${providerId}`).emit('appointment:update', {
        appointment_id: parseInt(req.params.id), statut: 'termine'
      })
    }

    // Notify reception that all pending requests are now actionable
    const structId = appt.structure_id
      || pendingRefs[0]?.structure_id
      || pendingHosp[0]?.structure_id
      || pendingExams[0]?.structure_id
    if (structId) {
      if (pendingRefs.length > 0) {
        io?.to(`hospital_struct_${structId}`).emit('referral:confirmed', {
          referral_ids: pendingRefs.map(r => r.id),
          specialites: pendingRefs.map(r => r.specialite),
          message: 'Patient a confirmé — vous pouvez attribuer la salle',
        })
      }
      if (pendingHosp.length > 0 || pendingExams.length > 0) {
        io?.to(`hospital_struct_${structId}`).emit('medical:requests_confirmed', {
          hosp_ids: pendingHosp.map(h => h.id),
          exam_ids: pendingExams.map(e => e.id),
          message: 'Patient a confirmé — demandes débloquées',
        })
      }
    }

    res.json({
      success: true,
      montant_libere: appt.prix || 0,
      referrals_unlocked: pendingRefs.length,
      hosp_unlocked: pendingHosp.length,
      exams_unlocked: pendingExams.length,
    })
  } catch (err) {
    await conn.rollback()
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  } finally {
    conn.release()
  }
})

// ── POST /appointments/:id/prescription ────────────────────────────────────
// Hôpital / médecin ajoute une ordonnance
router.post('/:id/prescription', requireAuth, async (req, res) => {
  if (!['clinique', 'medecin', 'veterinaire'].includes(req.user.role)) {
    return res.status(403).json({ detail: 'Accès refusé' })
  }
  const { medicaments, notes } = req.body
  if (!medicaments || !Array.isArray(medicaments) || !medicaments.length) {
    return res.status(422).json({ detail: 'Au moins un médicament requis' })
  }
  try {
    const [rows] = await pool.query(
      'SELECT * FROM appointments WHERE id = ?', [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const appt = rows[0]

    const [result] = await pool.query(
      'INSERT INTO prescriptions (appointment_id, patient_id, emetteur_id, medicaments, notes) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, appt.patient_id, req.user.id, JSON.stringify(medicaments), notes || null]
    )

    const io = req.app.get('io')
    await notifyAndEmit(io, appt.patient_id, 'ordonnance_ajoutee',
      '📋 Ordonnance ajoutée',
      `Une ordonnance a été ajoutée à votre dossier suite à votre consultation du ${appt.date_rdv}.`,
      { appointment_id: parseInt(req.params.id), prescription_id: result.insertId }
    )
    if (io) io.to(`user_${appt.patient_id}`).emit('prescription:new', {
      appointment_id: parseInt(req.params.id), prescription_id: result.insertId
    })

    // Auto-create MediA reminders for each medication
    const today = new Date().toISOString().split('T')[0]
    for (const med of medicaments) {
      if (!med.nom) continue
      try {
        await pool.query(
          `INSERT INTO medical_reminders (patient_id, prescription_id, appointment_id, type, titre, description, horaire, date_debut, medicament_nom)
           VALUES (?, ?, ?, 'medicament', ?, ?, ?, ?, ?)`,
          [
            appt.patient_id, result.insertId, parseInt(req.params.id),
            `💊 ${med.nom}${med.dosage ? ` — ${med.dosage}` : ''}`,
            [med.frequence, med.instructions].filter(Boolean).join(' | ') || null,
            med.frequence || null,
            today,
            med.nom,
          ]
        )
      } catch (_) {}
    }

    const [presc] = await pool.query('SELECT * FROM prescriptions WHERE id = ?', [result.insertId])
    res.status(201).json(presc[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /appointments/prescriptions/mine ──────────────────────────────────
// Patient récupère toutes ses ordonnances
router.get('/prescriptions/mine', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, a.date_rdv, a.service, a.heure_rdv,
              sp.nom AS structure_nom,
              u.nom AS medecin_nom, u.prenom AS medecin_prenom
       FROM prescriptions p
       JOIN appointments a ON a.id = p.appointment_id
       LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
       LEFT JOIN users u ON u.id = p.emetteur_id
       WHERE p.patient_id = ?
       ORDER BY p.created_at DESC`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /appointments/:id/ticket ───────────────────────────────────────────
router.get('/:id/ticket', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, u.nom AS patient_nom, u.prenom AS patient_prenom, u.email AS patient_email,
              u.telephone AS patient_tel,
              d.nom AS doctor_nom, d.prenom AS doctor_prenom,
              dp.specialite, dp.cabinet,
              sp.nom AS structure_nom, sp.adresse AS structure_adresse,
              sp.telephone AS structure_tel
       FROM appointments a
       JOIN users u ON u.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
       LEFT JOIN doctor_profiles dp ON dp.user_id = a.doctor_id
       LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
       WHERE a.id = ? AND (a.patient_id = ? OR a.doctor_id = ? OR a.structure_id IN (
         SELECT id FROM structure_profiles WHERE user_id = ?
       ))`,
      [req.params.id, req.user.id, req.user.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Rendez-vous introuvable' })
    const r = rows[0]
    if (r.statut !== 'confirme' && r.statut !== 'termine') {
      return res.status(403).json({ detail: 'Ticket disponible uniquement après confirmation' })
    }
    res.json({
      ticket_id:       `TKT-${String(r.id).padStart(6, '0')}`,
      patient:         `${r.patient_prenom} ${r.patient_nom}`,
      email:           r.patient_email,
      telephone:       r.patient_tel,
      medecin:         r.doctor_nom ? `Dr ${r.doctor_prenom} ${r.doctor_nom}` : null,
      structure:       r.structure_nom || null,
      structure_adresse: r.structure_adresse || null,
      structure_tel:   r.structure_tel || null,
      specialite:      r.specialite || null,
      cabinet:         r.cabinet || null,
      date:            r.date_rdv,
      heure:           r.heure_rdv,
      service:         r.service,
      motif:           r.motif,
      symptomes:       r.symptomes,
      age_patient:     r.age_patient,
      sexe_patient:    r.sexe_patient,
      statut:          r.statut,
      prix:            r.prix,
      consultation_statut: r.consultation_statut,
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
