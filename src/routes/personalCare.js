const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

// ─── Auto-create tables ───────────────────────────────────────────────────────

;(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS coach_profiles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        specialite VARCHAR(150) NOT NULL,
        description TEXT,
        tarif_mensuel DECIMAL(10,2) DEFAULT 50000,
        disponible TINYINT DEFAULT 1,
        note DECIMAL(3,2) DEFAULT 4.5,
        nb_patients INT DEFAULT 0,
        experience_ans INT DEFAULT 0,
        ville VARCHAR(100) DEFAULT 'Abidjan',
        langues JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS personal_assignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        patient_id INT NOT NULL,
        provider_id INT NOT NULL,
        provider_type ENUM('medecin', 'coach') NOT NULL,
        duree_mois INT NOT NULL DEFAULT 1,
        date_debut DATE NOT NULL,
        date_fin DATE NOT NULL,
        statut ENUM('actif', 'termine', 'annule') DEFAULT 'actif',
        notes TEXT,
        montant_total DECIMAL(10,2) DEFAULT 0,
        confirmation_pending TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await pool.query('ALTER TABLE personal_assignments ADD COLUMN IF NOT EXISTS montant_total DECIMAL(10,2) DEFAULT 0').catch(() => {})

    await pool.query(`
      CREATE TABLE IF NOT EXISTS personal_escrow (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assignment_id INT NOT NULL UNIQUE,
        patient_id INT NOT NULL,
        provider_id INT NOT NULL,
        montant_total DECIMAL(10,2) NOT NULL,
        commission_pct DECIMAL(5,4) DEFAULT 0.15,
        montant_libere DECIMAL(10,2) DEFAULT 0,
        montant_rembourse DECIMAL(10,2) DEFAULT 0,
        statut ENUM('bloque','partiellement_libere','libere','rembourse') DEFAULT 'bloque',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_schedules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assignment_id INT NOT NULL,
        jour_semaine TINYINT NOT NULL,
        heure_debut TIME NOT NULL,
        duree_minutes INT DEFAULT 60
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS care_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        assignment_id INT NOT NULL,
        scheduled_date DATE NOT NULL,
        heure_debut TIME DEFAULT '09:00',
        statut ENUM('planifie','effectue','absent_provider','absent_patient','litige') DEFAULT 'planifie',
        provider_validated_at TIMESTAMP NULL,
        patient_confirmed_at TIMESTAMP NULL,
        provider_note TEXT,
        patient_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Extend statut ENUM: full flow including meeting steps
    await pool.query(
      "ALTER TABLE personal_assignments MODIFY COLUMN statut ENUM('pending','accepted','meeting_scheduled','meeting_done','actif','termine','annule','rejete') NOT NULL DEFAULT 'pending'"
    ).catch(() => {})

    // Add meeting columns
    await pool.query('ALTER TABLE personal_assignments ADD COLUMN IF NOT EXISTS meeting_date DATE NULL').catch(() => {})
    await pool.query('ALTER TABLE personal_assignments ADD COLUMN IF NOT EXISTS meeting_heure TIME NULL').catch(() => {})
    await pool.query('ALTER TABLE personal_assignments ADD COLUMN IF NOT EXISTS meeting_patient_arrived TINYINT DEFAULT 0').catch(() => {})
    await pool.query('ALTER TABLE personal_assignments ADD COLUMN IF NOT EXISTS meeting_provider_arrived TINYINT DEFAULT 0').catch(() => {})

    // Add complaint/bonus columns on care_sessions
    await pool.query('ALTER TABLE care_sessions ADD COLUMN IF NOT EXISTS patient_complaint TINYINT DEFAULT 0').catch(() => {})
    await pool.query('ALTER TABLE care_sessions ADD COLUMN IF NOT EXISTS patient_validated TINYINT DEFAULT 0').catch(() => {})

    // Extend users.role ENUM to include 'coach' if not already present
    await pool.query(
      "ALTER TABLE users MODIFY COLUMN role ENUM('patient','medecin','coach','pharmacie','clinique','veterinaire','admin','livreur') NOT NULL DEFAULT 'patient'"
    ).catch(() => {})

    console.log('[personalCare] Tables ready.')
  } catch (err) {
    console.error('[personalCare] Failed to create tables:', err.message)
  }
})()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessions(dateDebut, dateFin, joursEu, heure) {
  const sessions = []
  const current = new Date(dateDebut)
  const end = new Date(dateFin)
  while (current <= end) {
    const dowEu = (current.getDay() + 6) % 7  // Mon=0 … Sun=6
    if (joursEu.includes(dowEu)) {
      sessions.push(current.toISOString().slice(0, 10))
    }
    current.setDate(current.getDate() + 1)
  }
  return sessions
}

async function getOrCreateWallet(userId) {
  const [rows] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId])
  if (rows.length) return rows[0]
  await pool.query('INSERT INTO wallets (user_id, solde) VALUES (?, 0)', [userId])
  const [created] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId])
  return created[0]
}

// ─── GET /coaches ─────────────────────────────────────────────────────────────

router.get('/coaches', async (req, res) => {
  try {
    const { specialite, disponible, ville } = req.query
    let sql = `
      SELECT u.id, u.nom, u.prenom, u.email, u.telephone, u.avatar_url, u.is_verified,
             cp.specialite, cp.description, cp.tarif_mensuel, cp.disponible, cp.note,
             cp.nb_patients, cp.experience_ans, cp.ville, cp.langues
      FROM users u
      INNER JOIN coach_profiles cp ON cp.user_id = u.id
      WHERE u.role = 'coach' AND u.is_active = 1
    `
    const params = []
    if (specialite) { sql += ' AND cp.specialite = ?'; params.push(specialite) }
    if (disponible !== undefined) { sql += ' AND cp.disponible = ?'; params.push(disponible === 'true' || disponible === '1' ? 1 : 0) }
    if (ville) { sql += ' AND cp.ville = ?'; params.push(ville) }
    sql += ' ORDER BY cp.note DESC, cp.nb_patients DESC'

    const [rows] = await pool.query(sql, params)
    res.json(rows.map(row => ({
      id: row.id, nom: row.nom, prenom: row.prenom, email: row.email,
      telephone: row.telephone || null, avatar_url: row.avatar_url,
      is_verified: !!row.is_verified,
      coach_profile: {
        specialite: row.specialite, description: row.description,
        tarif_mensuel: parseFloat(row.tarif_mensuel),
        disponible: !!row.disponible, note: parseFloat(row.note),
        nb_patients: row.nb_patients, experience_ans: row.experience_ans,
        ville: row.ville,
        langues: typeof row.langues === 'string' ? JSON.parse(row.langues) : (row.langues || []),
      },
    })))
  } catch (err) {
    console.error('[GET /coaches]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /request ───────────────────────────────────────────────────────────
// Patient sends a request to a provider — no payment yet

router.post('/request', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé aux patients.' })

    const { provider_id, provider_type, message } = req.body
    if (!provider_id || !provider_type) return res.status(400).json({ detail: 'provider_id et provider_type requis.' })
    if (!['medecin', 'coach'].includes(provider_type)) return res.status(400).json({ detail: 'provider_type invalide.' })

    const [subRows] = await pool.query('SELECT plan FROM subscriptions WHERE user_id = ?', [req.user.id])
    if (!subRows.length || subRows[0].plan !== 'premium') {
      return res.status(403).json({ detail: 'Fonctionnalité réservée aux abonnés premium.', premium_required: true })
    }

    const [existing] = await pool.query(
      "SELECT id FROM personal_assignments WHERE patient_id = ? AND provider_id = ? AND statut NOT IN ('rejete','annule','termine')",
      [req.user.id, provider_id]
    )
    if (existing.length) return res.status(409).json({ detail: 'Une demande est déjà en cours avec ce professionnel.' })

    const [providerRows] = await pool.query('SELECT id, nom, prenom, role FROM users WHERE id = ? AND is_active = 1', [provider_id])
    if (!providerRows.length) return res.status(404).json({ detail: 'Prestataire introuvable.' })

    const today = new Date().toISOString().slice(0, 10)
    const [result] = await pool.query(
      "INSERT INTO personal_assignments (patient_id, provider_id, provider_type, duree_mois, date_debut, date_fin, notes, statut) VALUES (?, ?, ?, 1, ?, ?, ?, 'pending')",
      [req.user.id, provider_id, provider_type, today, today, message || null]
    )

    const io = req.app.get('io') || null
    const provider = providerRows[0]
    await notifyAndEmit(io, provider_id, 'new_request', 'Nouvelle demande de suivi',
      `${req.user.prenom} ${req.user.nom} souhaite vous engager comme ${provider_type === 'coach' ? 'coach' : 'médecin'} personnel.`,
      { assignment_id: result.insertId, patient_id: req.user.id }
    )

    res.status(201).json({ id: result.insertId, statut: 'pending' })
  } catch (err) {
    console.error('[POST /request]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/accept ─────────────────────────────────────────────────────────
// Provider accepts the patient's request

router.post('/:id/accept', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ detail: 'Demande introuvable.' })
    const a = rows[0]
    if (a.provider_id !== req.user.id) return res.status(403).json({ detail: 'Accès refusé.' })
    if (a.statut !== 'pending') return res.status(400).json({ detail: "Cette demande n'est pas en attente." })

    await pool.query("UPDATE personal_assignments SET statut = 'accepted' WHERE id = ?", [id])

    const io = req.app.get('io') || null
    await notifyAndEmit(io, a.patient_id, 'request_accepted', 'Demande acceptée !',
      `${req.user.prenom} ${req.user.nom} a accepté votre demande. Confirmez et payez pour démarrer le suivi.`,
      { assignment_id: id }
    )

    res.json({ success: true, statut: 'accepted' })
  } catch (err) {
    console.error('[POST /:id/accept]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/reject ─────────────────────────────────────────────────────────
// Provider rejects the patient's request

router.post('/:id/reject', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const { motif } = req.body
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ detail: 'Demande introuvable.' })
    const a = rows[0]
    if (a.provider_id !== req.user.id) return res.status(403).json({ detail: 'Accès refusé.' })
    if (a.statut !== 'pending') return res.status(400).json({ detail: "Cette demande n'est pas en attente." })

    await pool.query("UPDATE personal_assignments SET statut = 'rejete', notes = ? WHERE id = ?", [motif || null, id])

    const io = req.app.get('io') || null
    await notifyAndEmit(io, a.patient_id, 'request_rejected', 'Demande refusée',
      `${req.user.prenom} ${req.user.nom} n'est pas disponible pour le moment.`,
      { assignment_id: id }
    )

    res.json({ success: true, statut: 'rejete' })
  } catch (err) {
    console.error('[POST /:id/reject]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/schedule-meeting ──────────────────────────────────────────────
// Provider schedules the initial meeting date after accepting

router.post('/:id/schedule-meeting', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const { meeting_date, meeting_heure } = req.body
    if (!meeting_date || !meeting_heure) return res.status(400).json({ detail: 'meeting_date et meeting_heure requis.' })

    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ detail: 'Demande introuvable.' })
    const a = rows[0]
    if (a.provider_id !== req.user.id) return res.status(403).json({ detail: 'Accès refusé.' })
    if (!['accepted', 'meeting_scheduled'].includes(a.statut)) return res.status(400).json({ detail: 'Statut invalide.' })

    await pool.query(
      "UPDATE personal_assignments SET statut='meeting_scheduled', meeting_date=?, meeting_heure=?, meeting_patient_arrived=0, meeting_provider_arrived=0 WHERE id=?",
      [meeting_date, meeting_heure, id]
    )

    const io = req.app.get('io') || null
    await notifyAndEmit(io, a.patient_id, 'meeting_scheduled', 'Rendez-vous initial fixé !',
      `${req.user.prenom} ${req.user.nom} vous propose un premier rendez-vous le ${new Date(meeting_date).toLocaleDateString('fr-FR')} à ${meeting_heure.slice(0,5)}.`,
      { assignment_id: id, meeting_date, meeting_heure }
    )
    res.json({ success: true, statut: 'meeting_scheduled', meeting_date, meeting_heure })
  } catch (err) {
    console.error('[POST /:id/schedule-meeting]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/patient-arrives ────────────────────────────────────────────────
// Patient confirms they arrived at the initial meeting

router.post('/:id/patient-arrives', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ detail: 'Demande introuvable.' })
    const a = rows[0]
    if (a.patient_id !== req.user.id) return res.status(403).json({ detail: 'Réservé au patient.' })
    if (a.statut !== 'meeting_scheduled') return res.status(400).json({ detail: 'Aucun rendez-vous planifié.' })

    const bothPresent = a.meeting_provider_arrived === 1
    await pool.query(
      "UPDATE personal_assignments SET meeting_patient_arrived=1, statut=IF(?, 'meeting_done', statut) WHERE id=?",
      [bothPresent, id]
    )

    const io = req.app.get('io') || null
    await notifyAndEmit(io, a.provider_id, 'patient_arrived', 'Patient présent',
      `Le patient a confirmé sa présence au rendez-vous initial.`,
      { assignment_id: id }
    )
    res.json({ success: true, meeting_patient_arrived: true, meeting_done: bothPresent })
  } catch (err) {
    console.error('[POST /:id/patient-arrives]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/provider-arrives ───────────────────────────────────────────────
// Provider confirms they were present at the initial meeting

router.post('/:id/provider-arrives', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ detail: 'Demande introuvable.' })
    const a = rows[0]
    if (a.provider_id !== req.user.id) return res.status(403).json({ detail: 'Réservé au prestataire.' })
    if (a.statut !== 'meeting_scheduled') return res.status(400).json({ detail: 'Aucun rendez-vous planifié.' })

    const bothPresent = a.meeting_patient_arrived === 1
    await pool.query(
      "UPDATE personal_assignments SET meeting_provider_arrived=1, statut=IF(?, 'meeting_done', statut) WHERE id=?",
      [bothPresent, id]
    )

    const io = req.app.get('io') || null
    await notifyAndEmit(io, a.patient_id, 'provider_arrived', 'Prestataire présent',
      `Votre rendez-vous initial est confirmé. Vous pouvez maintenant démarrer le suivi.`,
      { assignment_id: id }
    )
    res.json({ success: true, meeting_provider_arrived: true, meeting_done: bothPresent })
  } catch (err) {
    console.error('[POST /:id/provider-arrives]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/pay ────────────────────────────────────────────────────────────
// Patient confirms & pays after meeting is done (or after accepted if no meeting required)

router.post('/:id/pay', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé aux patients.' })

    const id = parseInt(req.params.id, 10)
    const { duree_mois, jours, heure } = req.body

    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [id])
    if (!rows.length) return res.status(404).json({ detail: 'Demande introuvable.' })
    const a = rows[0]
    if (a.patient_id !== req.user.id) return res.status(403).json({ detail: 'Accès refusé.' })
    if (!['accepted', 'meeting_done'].includes(a.statut)) return res.status(400).json({ detail: "Le prestataire doit d'abord accepter votre demande." })

    const duree = Number(duree_mois) || 1

    // Compute amount from provider profile
    let montantTotal = 0
    if (a.provider_type === 'coach') {
      const [cp] = await pool.query('SELECT tarif_mensuel FROM coach_profiles WHERE user_id = ?', [a.provider_id])
      montantTotal = cp.length ? parseFloat(cp[0].tarif_mensuel) * duree : 50000 * duree
    } else {
      const [dp] = await pool.query('SELECT tarif FROM doctor_profiles WHERE user_id = ?', [a.provider_id])
      const monthly = dp.length ? parseFloat(dp[0].tarif) * 4 : 48000
      montantTotal = monthly * duree
    }

    // Check wallet
    const patientWallet = await getOrCreateWallet(req.user.id)
    if (parseFloat(patientWallet.solde) < montantTotal) {
      return res.status(400).json({
        detail: `Solde insuffisant. Requis : ${montantTotal.toLocaleString('fr-FR')} F CFA. Solde : ${parseFloat(patientWallet.solde).toLocaleString('fr-FR')} F CFA.`,
        solde_insuffisant: true, montant_requis: montantTotal, solde_actuel: parseFloat(patientWallet.solde),
      })
    }

    // Deduct wallet
    await pool.query('UPDATE wallets SET solde = solde - ? WHERE id = ?', [montantTotal, patientWallet.id])
    await pool.query(
      'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, ?, ?)',
      [patientWallet.id, montantTotal, 'debit', `Séquestre suivi ${a.provider_type === 'coach' ? 'coach' : 'médecin'} #${a.provider_id} – ${duree} mois`]
    )

    // Update dates and activate
    const dateDebut = new Date()
    const dateFin = new Date(dateDebut)
    dateFin.setMonth(dateFin.getMonth() + duree)
    const fmt = d => d.toISOString().slice(0, 10)

    await pool.query(
      "UPDATE personal_assignments SET statut = 'actif', duree_mois = ?, date_debut = ?, date_fin = ?, montant_total = ? WHERE id = ?",
      [duree, fmt(dateDebut), fmt(dateFin), montantTotal, id]
    )

    // Create escrow
    await pool.query(
      'INSERT INTO personal_escrow (assignment_id, patient_id, provider_id, montant_total) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE montant_total = VALUES(montant_total)',
      [id, a.patient_id, a.provider_id, montantTotal]
    )

    if (a.provider_type === 'coach') {
      await pool.query('UPDATE coach_profiles SET nb_patients = nb_patients + 1 WHERE user_id = ?', [a.provider_id])
    }

    // Generate schedule if provided
    if (jours && Array.isArray(jours) && jours.length > 0 && heure) {
      await pool.query('DELETE FROM session_schedules WHERE assignment_id = ?', [id])
      for (const jour of jours) {
        await pool.query('INSERT INTO session_schedules (assignment_id, jour_semaine, heure_debut) VALUES (?, ?, ?)', [id, jour, heure])
      }
      await pool.query("DELETE FROM care_sessions WHERE assignment_id = ? AND statut = 'planifie'", [id])
      const dates = generateSessions(fmt(dateDebut), fmt(dateFin), jours, heure)
      for (const d of dates) {
        await pool.query('INSERT INTO care_sessions (assignment_id, scheduled_date, heure_debut) VALUES (?, ?, ?)', [id, d, heure])
      }
    }

    const io = req.app.get('io') || null
    await notifyAndEmit(io, a.provider_id, 'assignment_paid', 'Suivi démarré !',
      `${req.user.prenom} ${req.user.nom} a confirmé et payé. Le suivi de ${duree} mois commence. Séquestre : ${montantTotal.toLocaleString('fr-FR')} F CFA.`,
      { assignment_id: id }
    )

    res.json({ success: true, statut: 'actif', montant_total: montantTotal })
  } catch (err) {
    console.error('[POST /:id/pay]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /assign ─────────────────────────────────────────────────────────────

router.post('/assign', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé aux patients' })

    const [subRows] = await pool.query('SELECT plan FROM subscriptions WHERE user_id = ?', [req.user.id])
    if (!subRows.length || subRows[0].plan !== 'premium') {
      return res.status(403).json({ detail: 'Fonctionnalité réservée aux abonnés premium.', premium_required: true })
    }

    const { provider_id, provider_type, duree_mois, notes, montant_total } = req.body
    if (!provider_id || !provider_type || !duree_mois) {
      return res.status(400).json({ detail: 'provider_id, provider_type et duree_mois sont requis.' })
    }
    if (!['medecin', 'coach'].includes(provider_type)) {
      return res.status(400).json({ detail: 'provider_type invalide.' })
    }
    if (![1, 3, 6, 12].includes(Number(duree_mois))) {
      return res.status(400).json({ detail: 'duree_mois doit être 1, 3, 6 ou 12.' })
    }

    const [providerRows] = await pool.query('SELECT id, nom, prenom, role FROM users WHERE id = ? AND is_active = 1', [provider_id])
    if (!providerRows.length) return res.status(404).json({ detail: 'Prestataire introuvable.' })

    const [existingRows] = await pool.query(
      "SELECT id FROM personal_assignments WHERE patient_id = ? AND provider_id = ? AND provider_type = ? AND statut = 'actif'",
      [req.user.id, provider_id, provider_type]
    )
    if (existingRows.length) return res.status(409).json({ detail: 'Vous avez déjà un suivi actif avec ce prestataire.' })

    // Calculate amount from provider profile
    let computedAmount = parseFloat(montant_total) || 0
    if (!computedAmount || computedAmount <= 0) {
      if (provider_type === 'coach') {
        const [cp] = await pool.query('SELECT tarif_mensuel FROM coach_profiles WHERE user_id = ?', [provider_id])
        computedAmount = cp.length ? parseFloat(cp[0].tarif_mensuel) * Number(duree_mois) : 50000 * Number(duree_mois)
      } else {
        const [dp] = await pool.query('SELECT tarif FROM doctor_profiles WHERE user_id = ?', [provider_id])
        const monthlyRate = dp.length ? parseFloat(dp[0].tarif) * 4 : 48000
        computedAmount = monthlyRate * Number(duree_mois)
      }
    }

    // Deduct from patient wallet
    const wallet = await getOrCreateWallet(req.user.id)
    if (parseFloat(wallet.solde) < computedAmount) {
      return res.status(400).json({
        detail: `Solde insuffisant. Requis : ${computedAmount.toLocaleString('fr-FR')} F CFA. Solde : ${parseFloat(wallet.solde).toLocaleString('fr-FR')} F CFA.`,
        solde_insuffisant: true,
        montant_requis: computedAmount,
        solde_actuel: parseFloat(wallet.solde),
      })
    }

    const newSolde = parseFloat(wallet.solde) - computedAmount
    await pool.query('UPDATE wallets SET solde = ? WHERE id = ?', [newSolde, wallet.id])

    // Record debit transaction
    await pool.query(
      'INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, ?, ?)',
      [wallet.id, computedAmount, 'debit', `Séquestre suivi ${provider_type === 'coach' ? 'coach' : 'médecin'} #${provider_id} – ${duree_mois} mois`]
    )

    const dateDebut = new Date()
    const dateFin = new Date(dateDebut)
    dateFin.setMonth(dateFin.getMonth() + Number(duree_mois))
    const fmt = d => d.toISOString().slice(0, 10)

    const [result] = await pool.query(
      'INSERT INTO personal_assignments (patient_id, provider_id, provider_type, duree_mois, date_debut, date_fin, notes, montant_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, provider_id, provider_type, Number(duree_mois), fmt(dateDebut), fmt(dateFin), notes || null, computedAmount]
    )
    const assignmentId = result.insertId

    // Create escrow record
    await pool.query(
      'INSERT INTO personal_escrow (assignment_id, patient_id, provider_id, montant_total) VALUES (?, ?, ?, ?)',
      [assignmentId, req.user.id, provider_id, computedAmount]
    )

    if (provider_type === 'coach') {
      await pool.query('UPDATE coach_profiles SET nb_patients = nb_patients + 1 WHERE user_id = ?', [provider_id])
    }

    const io = req.app.get('io') || null
    const provider = providerRows[0]
    await notifyAndEmit(io, provider_id, 'new_assignment', 'Nouveau patient assigné',
      `${req.user.prenom} ${req.user.nom} vous a choisi comme ${provider_type === 'coach' ? 'coach' : 'médecin'} personnel. Montant en séquestre : ${computedAmount.toLocaleString('fr-FR')} F CFA.`,
      { assignment_id: assignmentId, patient_id: req.user.id }
    )

    const [assignRows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [assignmentId])
    res.status(201).json({ ...assignRows[0], montant_total: computedAmount, nouveau_solde: newSolde })
  } catch (err) {
    console.error('[POST /assign]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/schedule ───────────────────────────────────────────────────────

router.post('/:id/schedule', requireAuth, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [assignmentId])
    if (!rows.length) return res.status(404).json({ detail: 'Suivi introuvable.' })
    const assignment = rows[0]

    if (req.user.id !== assignment.patient_id && req.user.id !== assignment.provider_id) {
      return res.status(403).json({ detail: 'Accès refusé.' })
    }

    const { jours, heure } = req.body  // jours: [0,2,4] (0=lundi), heure: '09:00'
    if (!jours || !Array.isArray(jours) || !heure) {
      return res.status(400).json({ detail: 'jours (array) et heure sont requis.' })
    }

    // Replace schedule
    await pool.query('DELETE FROM session_schedules WHERE assignment_id = ?', [assignmentId])
    for (const jour of jours) {
      await pool.query('INSERT INTO session_schedules (assignment_id, jour_semaine, heure_debut) VALUES (?, ?, ?)',
        [assignmentId, jour, heure])
    }

    // Generate care_sessions (delete existing planifie ones, keep validated)
    await pool.query("DELETE FROM care_sessions WHERE assignment_id = ? AND statut = 'planifie'", [assignmentId])

    const dates = generateSessions(assignment.date_debut, assignment.date_fin, jours, heure)
    for (const d of dates) {
      await pool.query('INSERT INTO care_sessions (assignment_id, scheduled_date, heure_debut) VALUES (?, ?, ?)',
        [assignmentId, d, heure])
    }

    // Notify provider if patient set the schedule
    const io = req.app.get('io') || null
    const notifyId = req.user.id === assignment.patient_id ? assignment.provider_id : assignment.patient_id
    const JOURS_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche']
    const joursStr = jours.map(j => JOURS_FR[j]).join(', ')
    await notifyAndEmit(io, notifyId, 'schedule_set', 'Planning défini',
      `Planning : ${joursStr} à ${heure}. ${dates.length} séances planifiées.`,
      { assignment_id: assignmentId }
    )

    res.json({ message: `${dates.length} séances planifiées.`, sessions_count: dates.length })
  } catch (err) {
    console.error('[POST /:id/schedule]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── GET /:id/sessions ────────────────────────────────────────────────────────

router.get('/:id/sessions', requireAuth, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [assignmentId])
    if (!rows.length) return res.status(404).json({ detail: 'Suivi introuvable.' })
    const assignment = rows[0]

    if (req.user.id !== assignment.patient_id && req.user.id !== assignment.provider_id) {
      return res.status(403).json({ detail: 'Accès refusé.' })
    }

    const [sessions] = await pool.query(
      'SELECT * FROM care_sessions WHERE assignment_id = ? ORDER BY scheduled_date ASC',
      [assignmentId]
    )
    res.json(sessions)
  } catch (err) {
    console.error('[GET /:id/sessions]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/validate-today-session ────────────────────────────────────────
// Patient valide la séance d'aujourd'hui (trouve et valide automatiquement)

router.post('/:id/validate-today-session', requireAuth, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [assignmentId])
    if (!rows.length) return res.status(404).json({ detail: 'Suivi introuvable.' })
    const assignment = rows[0]
    if (req.user.id !== assignment.patient_id) return res.status(403).json({ detail: 'Réservé au patient.' })

    const today = new Date().toISOString().slice(0, 10)
    const [sessions] = await pool.query(
      "SELECT * FROM care_sessions WHERE assignment_id = ? AND DATE(scheduled_date) = ? AND statut = 'planifie' AND patient_validated = 0",
      [assignmentId, today]
    )
    if (!sessions.length) return res.status(422).json({ detail: 'Aucune séance planifiée pour aujourd\'hui.' })

    const session = sessions[0]
    await pool.query(
      "UPDATE care_sessions SET patient_validated=1, patient_confirmed_at=NOW(), statut='effectue' WHERE id=?",
      [session.id]
    )

    const io = req.app.get('io') || null
    const { notifyAndEmit } = require('../utils/notify')
    await notifyAndEmit(io, assignment.provider_id, 'session_confirmed', 'Séance confirmée',
      `Le patient a confirmé votre présence pour la séance du ${today}.`,
      { session_id: session.id }
    )

    const [updated] = await pool.query('SELECT * FROM care_sessions WHERE id = ?', [session.id])
    res.json(updated[0])
  } catch (err) {
    console.error('[POST /:id/validate-today-session]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /sessions/:sessionId/patient-validate ──────────────────────────────
// Patient seul valide la séance ("Le prestataire est venu")

router.post('/sessions/:sessionId/patient-validate', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10)
    const [rows] = await pool.query('SELECT cs.*, pa.provider_id, pa.patient_id FROM care_sessions cs JOIN personal_assignments pa ON pa.id = cs.assignment_id WHERE cs.id = ?', [sessionId])
    if (!rows.length) return res.status(404).json({ detail: 'Séance introuvable.' })
    const session = rows[0]
    if (req.user.id !== session.patient_id) return res.status(403).json({ detail: 'Réservé au patient.' })

    await pool.query(
      "UPDATE care_sessions SET patient_validated=1, patient_confirmed_at=NOW(), statut='effectue' WHERE id=?",
      [sessionId]
    )

    const io = req.app.get('io') || null
    await notifyAndEmit(io, session.provider_id, 'session_validated_by_patient', 'Séance validée',
      `Le patient a confirmé votre présence pour la séance du ${session.scheduled_date}.`,
      { session_id: sessionId }
    )

    const [updated] = await pool.query('SELECT * FROM care_sessions WHERE id = ?', [sessionId])
    res.json(updated[0])
  } catch (err) {
    console.error('[POST /sessions/:id/patient-validate]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /sessions/:sessionId/patient-complaint ──────────────────────────────
// Patient signale un problème (absence, retard) → malus sur règlement

router.post('/sessions/:sessionId/patient-complaint', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10)
    const { motif } = req.body
    const [rows] = await pool.query('SELECT cs.*, pa.provider_id, pa.patient_id FROM care_sessions cs JOIN personal_assignments pa ON pa.id = cs.assignment_id WHERE cs.id = ?', [sessionId])
    if (!rows.length) return res.status(404).json({ detail: 'Séance introuvable.' })
    const session = rows[0]
    if (req.user.id !== session.patient_id) return res.status(403).json({ detail: 'Réservé au patient.' })

    await pool.query(
      "UPDATE care_sessions SET patient_complaint=1, patient_note=?, statut='litige' WHERE id=?",
      [motif || 'Absence/retard signalé', sessionId]
    )

    const io = req.app.get('io') || null
    await notifyAndEmit(io, session.provider_id, 'session_complaint', '⚠️ Plainte reçue',
      `Le patient a signalé un problème pour la séance du ${session.scheduled_date}. Cela impactera votre règlement.`,
      { session_id: sessionId }
    )
    const [updated] = await pool.query('SELECT * FROM care_sessions WHERE id = ?', [sessionId])
    res.json(updated[0])
  } catch (err) {
    console.error('[POST /sessions/:id/patient-complaint]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /sessions/:sessionId/patient-confirm (legacy compat) ────────────────
router.post('/sessions/:sessionId/patient-confirm', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10)
    const [rows] = await pool.query('SELECT cs.*, pa.provider_id, pa.patient_id FROM care_sessions cs JOIN personal_assignments pa ON pa.id = cs.assignment_id WHERE cs.id = ?', [sessionId])
    if (!rows.length) return res.status(404).json({ detail: 'Séance introuvable.' })
    const session = rows[0]
    if (req.user.id !== session.patient_id) return res.status(403).json({ detail: 'Réservé au patient.' })
    await pool.query("UPDATE care_sessions SET patient_validated=1, patient_confirmed_at=NOW(), statut='effectue' WHERE id=?", [sessionId])
    const io = req.app.get('io') || null
    await notifyAndEmit(io, session.provider_id, 'session_confirmed', 'Séance confirmée', `Séance du ${session.scheduled_date} validée.`, { session_id: sessionId })
    const [updated] = await pool.query('SELECT * FROM care_sessions WHERE id = ?', [sessionId])
    res.json(updated[0])
  } catch (err) {
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /sessions/:sessionId/report ────────────────────────────────────────

router.post('/sessions/:sessionId/report', requireAuth, async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10)
    const { motif } = req.body
    const [rows] = await pool.query('SELECT cs.*, pa.provider_id, pa.patient_id FROM care_sessions cs JOIN personal_assignments pa ON pa.id = cs.assignment_id WHERE cs.id = ?', [sessionId])
    if (!rows.length) return res.status(404).json({ detail: 'Séance introuvable.' })
    const session = rows[0]

    if (req.user.id !== session.patient_id) return res.status(403).json({ detail: 'Réservé au patient.' })

    await pool.query(
      "UPDATE care_sessions SET statut = 'litige', patient_note = ? WHERE id = ?",
      [motif || 'Litige signalé par le patient', sessionId]
    )

    const [updated] = await pool.query('SELECT * FROM care_sessions WHERE id = ?', [sessionId])
    res.json(updated[0])
  } catch (err) {
    console.error('[POST /sessions/:id/report]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/settle ─────────────────────────────────────────────────────────
// Release funds based on validated sessions

router.post('/:id/settle', requireAuth, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT pa.*, pe.montant_total AS escrow_total, pe.commission_pct, pe.id AS escrow_id FROM personal_assignments pa LEFT JOIN personal_escrow pe ON pe.assignment_id = pa.id WHERE pa.id = ?', [assignmentId])
    if (!rows.length) return res.status(404).json({ detail: 'Suivi introuvable.' })
    const a = rows[0]

    if (req.user.id !== a.patient_id && req.user.id !== a.provider_id) {
      return res.status(403).json({ detail: 'Accès refusé.' })
    }

    const [sessions] = await pool.query('SELECT statut FROM care_sessions WHERE assignment_id = ?', [assignmentId])
    const total = sessions.length
    if (!total) return res.status(400).json({ detail: 'Aucune séance planifiée.' })

    const effectue = sessions.filter(s => s.statut === 'effectue').length
    const absent = sessions.filter(s => s.statut === 'absent_provider').length
    const ratio = effectue / total
    const montantEscrow = parseFloat(a.escrow_total || a.montant_total || 0)
    const commission = parseFloat(a.commission_pct || 0.15)

    const montantProvider = Math.round(montantEscrow * ratio * (1 - commission))
    const montantPlatform = Math.round(montantEscrow * ratio * commission)
    const montantRembourse = Math.round(montantEscrow * (absent / total))
    const montantRetenu = montantEscrow - montantProvider - montantPlatform - montantRembourse

    // Provider reçoit 85% (commission déduite du prestataire pour personalCare)
    if (montantProvider > 0) {
      const providerWallet = await getOrCreateWallet(a.provider_id)
      await pool.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montantProvider, providerWallet.id])
      await pool.query('INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, ?, ?)',
        [providerWallet.id, montantProvider, 'credit', `Règlement suivi personnel #${assignmentId} — net après commission 15% (${effectue}/${total} séances)`])
    }

    // MedMap+ reçoit 15% de commission (déduite du prestataire)
    if (montantPlatform > 0) {
      const [adminWalletRows] = await pool.query('SELECT id FROM wallets WHERE user_id = ?', [1])
      if (adminWalletRows.length) {
        await pool.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montantPlatform, adminWalletRows[0].id])
        await pool.query('INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, ?, ?)',
          [adminWalletRows[0].id, montantPlatform, 'credit', `Commission MedMap+ 15% — suivi personnel #${assignmentId} (${effectue}/${total} séances)`])
      }
    }

    // Refund patient for absent sessions
    if (montantRembourse > 0) {
      const patientWallet = await getOrCreateWallet(a.patient_id)
      await pool.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [montantRembourse, patientWallet.id])
      await pool.query('INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, ?, ?)',
        [patientWallet.id, montantRembourse, 'credit', `Remboursement absences prestataire #${assignmentId}`])
    }

    // Update escrow
    if (a.escrow_id) {
      await pool.query(
        "UPDATE personal_escrow SET montant_libere = ?, montant_rembourse = ?, statut = 'libere' WHERE id = ?",
        [montantProvider, montantRembourse, a.escrow_id]
      )
    }

    const io = req.app.get('io') || null
    await notifyAndEmit(io, a.provider_id, 'escrow_released', 'Règlement effectué',
      `${montantProvider.toLocaleString('fr-FR')} F CFA ont été versés sur votre portefeuille.`,
      { assignment_id: assignmentId }
    )
    await notifyAndEmit(io, a.patient_id, 'escrow_settled', 'Suivi clôturé',
      `Suivi clôturé. ${montantRembourse > 0 ? `${montantRembourse.toLocaleString('fr-FR')} F CFA remboursés.` : ''}`,
      { assignment_id: assignmentId }
    )

    res.json({
      sessions_total: total, sessions_effectuees: effectue, sessions_absentes: absent,
      montant_escrow: montantEscrow, montant_provider: montantProvider,
      montant_platform: montantPlatform, montant_rembourse: montantRembourse,
      montant_retenu: montantRetenu,
    })
  } catch (err) {
    console.error('[POST /:id/settle]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── GET /debug/mine ─────────────────────────────────────────────────────────
// Diagnostic: show raw DB rows for this user (to identify account mismatch)

router.get('/debug/mine', requireAuth, async (req, res) => {
  try {
    const [asPatient] = await pool.query(
      'SELECT id, patient_id, provider_id, provider_type, statut, meeting_date, meeting_heure, created_at FROM personal_assignments WHERE patient_id = ?',
      [req.user.id]
    )
    const [asProvider] = await pool.query(
      'SELECT id, patient_id, provider_id, provider_type, statut, meeting_date, meeting_heure, created_at FROM personal_assignments WHERE provider_id = ?',
      [req.user.id]
    )
    res.json({ user_id: req.user.id, user_role: req.user.role, as_patient: asPatient, as_provider: asProvider })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /mine ────────────────────────────────────────────────────────────────

router.get('/mine', requireAuth, async (req, res) => {
  try {
    // Step 1: fetch raw assignment rows
    const [rows] = await pool.query(
      "SELECT * FROM personal_assignments WHERE patient_id = ? AND statut != 'annule' ORDER BY created_at DESC",
      [req.user.id]
    )

    const result = []
    for (const pa of rows) {
      // Step 2: fetch provider user
      const [provUsers] = await pool.query(
        'SELECT id, nom, prenom, email, telephone, avatar_url, is_verified FROM users WHERE id = ?',
        [pa.provider_id]
      )
      const provUser = provUsers[0] || {}

      // Step 3: fetch provider profile
      let profile = {}
      if (pa.provider_type === 'medecin') {
        const [dp] = await pool.query('SELECT specialite, tarif, ville FROM doctor_profiles WHERE user_id = ?', [pa.provider_id])
        if (dp[0]) profile = { specialite: dp[0].specialite, tarif: dp[0].tarif ? parseFloat(dp[0].tarif) : null, ville: dp[0].ville }
      } else {
        const [cp] = await pool.query('SELECT specialite, description, tarif_mensuel, note, nb_patients, experience_ans, ville, langues FROM coach_profiles WHERE user_id = ?', [pa.provider_id])
        if (cp[0]) {
          let langues = []
          try { langues = typeof cp[0].langues === 'string' ? JSON.parse(cp[0].langues) : (cp[0].langues || []) } catch {}
          profile = { specialite: cp[0].specialite, description: cp[0].description, tarif_mensuel: cp[0].tarif_mensuel ? parseFloat(cp[0].tarif_mensuel) : null, note: cp[0].note ? parseFloat(cp[0].note) : null, nb_patients: cp[0].nb_patients, experience_ans: cp[0].experience_ans, ville: cp[0].ville, langues }
        }
      }

      // Step 4: fetch escrow
      const [escRows] = await pool.query('SELECT montant_total, montant_libere, statut FROM personal_escrow WHERE assignment_id = ?', [pa.id])
      const esc = escRows[0] || {}

      // Step 5: session stats (only for actif)
      let sessions = { total: 0, effectuees: 0, a_confirmer: 0 }
      if (pa.statut === 'actif') {
        const today = new Date().toISOString().slice(0, 10)
        const [sess] = await pool.query('SELECT statut, scheduled_date, patient_validated FROM care_sessions WHERE assignment_id = ?', [pa.id])
        const todayStr = today
        sessions = {
          total: sess.length,
          effectuees: sess.filter(s => s.statut === 'effectue').length,
          a_confirmer: sess.filter(s => {
            const d = s.scheduled_date instanceof Date ? s.scheduled_date.toISOString().slice(0, 10) : String(s.scheduled_date || '').slice(0, 10)
            return s.statut === 'planifie' && d === todayStr && !s.patient_validated
          }).length,
        }
      }

      result.push({
        id: pa.id,
        provider_id: pa.provider_id,
        provider_type: pa.provider_type,
        duree_mois: pa.duree_mois,
        date_debut: pa.date_debut,
        date_fin: pa.date_fin,
        statut: pa.statut,
        notes: pa.notes,
        confirmation_pending: !!pa.confirmation_pending,
        montant_total: parseFloat(pa.montant_total || esc.montant_total || 0),
        meeting_date: pa.meeting_date || null,
        meeting_heure: pa.meeting_heure ? String(pa.meeting_heure).slice(0, 5) : null,
        meeting_patient_arrived: !!pa.meeting_patient_arrived,
        meeting_provider_arrived: !!pa.meeting_provider_arrived,
        created_at: pa.created_at,
        escrow: {
          montant_total: parseFloat(esc.montant_total || 0),
          montant_libere: parseFloat(esc.montant_libere || 0),
          statut: esc.statut || 'bloque',
        },
        sessions,
        provider: {
          id: provUser.id,
          nom: provUser.nom,
          prenom: provUser.prenom,
          email: provUser.email,
          telephone: provUser.telephone || null,
          avatar_url: provUser.avatar_url || null,
          is_verified: !!provUser.is_verified,
          profile,
        },
      })
    }

    res.json(result)
  } catch (err) {
    console.error('[GET /mine]', err)
    res.status(500).json({ detail: err.message })
  }
})

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.id, 10)
    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [assignmentId])
    if (!rows.length) return res.status(404).json({ detail: 'Suivi introuvable.' })
    const assignment = rows[0]

    if (req.user.id !== assignment.patient_id && req.user.id !== assignment.provider_id) {
      return res.status(403).json({ detail: 'Accès refusé.' })
    }
    if (assignment.statut !== 'actif') return res.status(409).json({ detail: "Ce suivi n'est plus actif." })

    await pool.query("UPDATE personal_assignments SET statut = 'annule' WHERE id = ?", [assignmentId])

    // Partial refund: sessions not done yet
    const [sessions] = await pool.query('SELECT statut FROM care_sessions WHERE assignment_id = ?', [assignmentId])
    const [escrowRows] = await pool.query('SELECT * FROM personal_escrow WHERE assignment_id = ?', [assignmentId])
    if (escrowRows.length) {
      const escrow = escrowRows[0]
      const total = sessions.length || 1
      const effectue = sessions.filter(s => s.statut === 'effectue').length
      const nonEffectue = total - effectue
      const montant = parseFloat(escrow.montant_total)
      const remboursement = Math.round(montant * (nonEffectue / total) * 0.85) // 15% penalty for cancellation
      if (remboursement > 0) {
        const patientWallet = await getOrCreateWallet(assignment.patient_id)
        await pool.query('UPDATE wallets SET solde = solde + ? WHERE id = ?', [remboursement, patientWallet.id])
        await pool.query('INSERT INTO wallet_transactions (wallet_id, montant, type, description) VALUES (?, ?, ?, ?)',
          [patientWallet.id, remboursement, 'credit', `Remboursement annulation suivi #${assignmentId} (85%)`])
      }
      await pool.query("UPDATE personal_escrow SET statut = 'rembourse', montant_rembourse = ? WHERE id = ?",
        [remboursement, escrow.id])
    }

    if (assignment.provider_type === 'coach') {
      await pool.query('UPDATE coach_profiles SET nb_patients = GREATEST(nb_patients - 1, 0) WHERE user_id = ?', [assignment.provider_id])
    }

    const io = req.app.get('io') || null
    const notifyId = req.user.id === assignment.patient_id ? assignment.provider_id : assignment.patient_id
    await notifyAndEmit(io, notifyId, 'assignment_cancelled', 'Suivi annulé', 'Un suivi personnalisé a été annulé.', { assignment_id: assignmentId })

    res.json({ detail: 'Suivi annulé. Remboursement partiel effectué.' })
  } catch (err) {
    console.error('[DELETE /:id]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── POST /:id/confirm-renewal ────────────────────────────────────────────────

router.post('/:id/confirm-renewal', requireAuth, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.id, 10)
    if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé aux patients.' })
    const { confirm } = req.body
    if (typeof confirm !== 'boolean') return res.status(400).json({ detail: 'Le champ confirm (boolean) est requis.' })

    const [rows] = await pool.query('SELECT * FROM personal_assignments WHERE id = ?', [assignmentId])
    if (!rows.length) return res.status(404).json({ detail: 'Suivi introuvable.' })
    const assignment = rows[0]

    if (req.user.id !== assignment.patient_id) return res.status(403).json({ detail: 'Accès refusé.' })
    if (assignment.statut !== 'actif') return res.status(409).json({ detail: "Ce suivi n'est plus actif." })

    if (confirm) {
      const currentFin = new Date(assignment.date_fin)
      currentFin.setMonth(currentFin.getMonth() + assignment.duree_mois)
      const newDateFin = currentFin.toISOString().slice(0, 10)
      await pool.query('UPDATE personal_assignments SET date_fin = ?, confirmation_pending = 0 WHERE id = ?', [newDateFin, assignmentId])
      const io = req.app.get('io') || null
      await notifyAndEmit(io, assignment.provider_id, 'assignment_renewed', 'Renouvellement confirmé',
        'Un patient a renouvelé son suivi.', { assignment_id: assignmentId, new_date_fin: newDateFin })
      res.json({ detail: 'Suivi renouvelé.', new_date_fin: newDateFin })
    } else {
      await pool.query("UPDATE personal_assignments SET statut = 'annule', confirmation_pending = 0 WHERE id = ?", [assignmentId])
      if (assignment.provider_type === 'coach') {
        await pool.query('UPDATE coach_profiles SET nb_patients = GREATEST(nb_patients - 1, 0) WHERE user_id = ?', [assignment.provider_id])
      }
      const io = req.app.get('io') || null
      await notifyAndEmit(io, assignment.provider_id, 'assignment_not_renewed', 'Renouvellement refusé', 'Un patient ne renouvelle pas son suivi.', { assignment_id: assignmentId })
      res.json({ detail: 'Suivi non renouvelé.' })
    }
  } catch (err) {
    console.error('[POST /:id/confirm-renewal]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── GET /provider/requests ───────────────────────────────────────────────────
// Provider sees all pending requests from patients

router.get('/provider/requests', requireAuth, async (req, res) => {
  try {
    if (!['medecin', 'coach'].includes(req.user.role)) {
      return res.status(403).json({ detail: 'Réservé aux médecins et aux coachs.' })
    }
    const [rows] = await pool.query(
      `SELECT pa.*, u.nom, u.prenom, u.email, u.telephone, u.avatar_url
       FROM personal_assignments pa
       JOIN users u ON u.id = pa.patient_id
       WHERE pa.provider_id = ? AND pa.statut = 'pending'
       ORDER BY pa.created_at DESC`,
      [req.user.id]
    )
    res.json(rows)
  } catch (err) {
    console.error('[GET /provider/requests]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── GET /provider/patients ───────────────────────────────────────────────────

router.get('/provider/patients', requireAuth, async (req, res) => {
  try {
    if (!['medecin', 'coach'].includes(req.user.role)) {
      return res.status(403).json({ detail: 'Réservé aux médecins et aux coachs.' })
    }

    const [rows] = await pool.query(
      `SELECT pa.*, pe.montant_total AS escrow_total, pe.montant_libere, pe.statut AS escrow_statut,
              u.id AS patient_user_id, u.nom AS patient_nom, u.prenom AS patient_prenom,
              u.email AS patient_email, u.telephone AS patient_telephone,
              u.avatar_url AS patient_avatar_url, u.is_verified AS patient_is_verified
       FROM personal_assignments pa
       INNER JOIN users u ON u.id = pa.patient_id
       LEFT JOIN personal_escrow pe ON pe.assignment_id = pa.id
       WHERE pa.provider_id = ? AND pa.statut IN ('accepted', 'meeting_scheduled', 'meeting_done', 'actif')
       ORDER BY pa.created_at DESC`,
      [req.user.id]
    )

    const patients = await Promise.all(rows.map(async (row) => {
      let sessions = []
      let todaySessions = []
      if (row.statut === 'actif') {
        const [sess] = await pool.query('SELECT * FROM care_sessions WHERE assignment_id = ? ORDER BY scheduled_date ASC', [row.id])
        sessions = sess
        const today = new Date().toISOString().slice(0, 10)
        todaySessions = sessions.filter(s => s.scheduled_date === today)
      }

      return {
        id: row.id, patient_id: row.patient_id, provider_type: row.provider_type,
        duree_mois: row.duree_mois, date_debut: row.date_debut, date_fin: row.date_fin,
        statut: row.statut, notes: row.notes, confirmation_pending: !!row.confirmation_pending,
        montant_total: parseFloat(row.montant_total || row.escrow_total || 0),
        meeting_date: row.meeting_date || null,
        meeting_heure: row.meeting_heure ? String(row.meeting_heure).slice(0, 5) : null,
        meeting_patient_arrived: !!row.meeting_patient_arrived,
        meeting_provider_arrived: !!row.meeting_provider_arrived,
        escrow: {
          montant_total: parseFloat(row.escrow_total || 0),
          montant_libere: parseFloat(row.montant_libere || 0),
          statut: row.escrow_statut || 'bloque',
        },
        sessions_today: todaySessions,
        sessions_stats: {
          total: sessions.length,
          effectuees: sessions.filter(s => s.statut === 'effectue').length,
          planifiees: sessions.filter(s => s.statut === 'planifie').length,
        },
        created_at: row.created_at,
        patient: {
          id: row.patient_user_id, nom: row.patient_nom, prenom: row.patient_prenom,
          email: row.patient_email, telephone: row.patient_telephone,
          avatar_url: row.patient_avatar_url, is_verified: !!row.patient_is_verified,
        },
      }
    }))

    res.json(patients)
  } catch (err) {
    console.error('[GET /provider/patients]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ─── GET /provider/dashboard ──────────────────────────────────────────────────

router.get('/provider/dashboard', requireAuth, async (req, res) => {
  try {
    if (!['medecin', 'coach'].includes(req.user.role)) {
      return res.status(403).json({ detail: 'Réservé aux médecins et aux coachs.' })
    }

    const [assignments] = await pool.query(
      "SELECT pa.id, pa.patient_id, pa.montant_total, pa.date_debut, pa.date_fin, pe.montant_libere, pe.statut AS escrow_statut, pe.commission_pct FROM personal_assignments pa LEFT JOIN personal_escrow pe ON pe.assignment_id = pa.id WHERE pa.provider_id = ? AND pa.statut = 'actif'",
      [req.user.id]
    )

    const [allSessions] = await pool.query(
      `SELECT cs.* FROM care_sessions cs JOIN personal_assignments pa ON pa.id = cs.assignment_id WHERE pa.provider_id = ?`,
      [req.user.id]
    )

    const today = new Date().toISOString().slice(0, 10)
    const seancesAujourdhui = allSessions.filter(s => s.scheduled_date === today)
    const seancesEffectuees = allSessions.filter(s => s.statut === 'effectue')
    const seancesAValider = allSessions.filter(s => s.statut === 'planifie' && !s.patient_validated && s.scheduled_date <= today)

    const escrowTotal = assignments.reduce((s, a) => s + parseFloat(a.montant_total || 0), 0)
    const revenuLibere = assignments.reduce((s, a) => s + parseFloat(a.montant_libere || 0), 0)
    const commission = 0.15
    const revenuNet = Math.round(revenuLibere * (1 - commission))

    res.json({
      nb_patients_actifs: assignments.length,
      escrow_total: escrowTotal,
      revenu_libere: revenuLibere,
      revenu_net: revenuNet,
      commission_pct: commission * 100,
      seances_aujourd_hui: seancesAujourdhui.length,
      seances_effectuees_total: seancesEffectuees.length,
      seances_a_valider: seancesAValider.length,
    })
  } catch (err) {
    console.error('[GET /provider/dashboard]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
