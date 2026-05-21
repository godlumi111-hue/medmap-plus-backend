const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')
const { notifyAndEmit } = require('../utils/notify')

// ── GET /animals — liste des animaux du patient ───────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  console.log('[animals GET] user.id=', req.user.id, 'role=', req.user.role)
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  try {
    console.log('[animals GET] querying animals...')
    const [animals] = await pool.query(
      'SELECT * FROM animals WHERE owner_id = ? ORDER BY created_at DESC',
      [req.user.id]
    )
    console.log('[animals GET] found', animals.length, 'animals')
    if (!animals.length) return res.json([])

    const ids = animals.map(a => a.id)
    console.log('[animals GET] querying vet_vaccines for ids', ids)
    const [vaccines] = await pool.query(
      'SELECT * FROM vet_vaccines WHERE animal_id IN (?) ORDER BY date_admin DESC',
      [ids]
    )
    const vaccinesByAnimal = {}
    for (const v of vaccines) {
      if (!vaccinesByAnimal[v.animal_id]) vaccinesByAnimal[v.animal_id] = []
      vaccinesByAnimal[v.animal_id].push(v)
    }
    res.json(animals.map(a => ({ ...a, vaccins: vaccinesByAnimal[a.id] || [] })))
  } catch (e) {
    console.error('[animals GET] ERROR:', e.message, e.sqlMessage || '')
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── POST /animals — créer un animal ──────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  const { nom, espece, race, date_naissance, poids, couleur, numero_puce, sterilise, notes } = req.body
  if (!nom || !nom.trim()) return res.status(422).json({ detail: 'Le nom est requis' })
  try {
    const [result] = await pool.query(
      `INSERT INTO animals (owner_id, nom, espece, race, date_naissance, poids, couleur, numero_puce, sterilise, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, nom.trim(), espece || 'Autre', race || null,
       date_naissance || null, poids ? parseFloat(poids) : null,
       couleur || null, numero_puce || null, sterilise ? 1 : 0, notes || null]
    )
    const [rows] = await pool.query('SELECT * FROM animals WHERE id = ?', [result.insertId])
    res.status(201).json({ ...rows[0], vaccins: [] })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── GET /animals/:id — dossier complet ───────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM animals WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ detail: 'Animal introuvable' })
    const animal = rows[0]
    if (animal.owner_id !== req.user.id && !['veterinaire', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ detail: 'Accès refusé' })
    }

    const [vaccines] = await pool.query(
      'SELECT * FROM vet_vaccines WHERE animal_id = ? ORDER BY date_admin DESC',
      [animal.id]
    )
    const [prescriptions] = await pool.query(
      `SELECT vp.*, u.nom AS vet_nom, u.prenom AS vet_prenom
       FROM vet_prescriptions vp JOIN users u ON u.id = vp.veterinaire_id
       WHERE vp.animal_id = ? ORDER BY vp.created_at DESC`,
      [animal.id]
    )
    const [rdvs] = await pool.query(
      `SELECT a.*, sp.nom AS structure_nom, u.nom AS vet_nom, u.prenom AS vet_prenom
       FROM appointments a
       LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
       LEFT JOIN users u ON u.id = a.doctor_id
       WHERE a.animal_id = ? ORDER BY a.date_rdv DESC`,
      [animal.id]
    )
    const [reminders] = await pool.query(
      'SELECT * FROM medical_reminders WHERE patient_id = ? AND medicament_nom LIKE ? ORDER BY date_debut',
      [animal.owner_id, `%[${animal.nom}]%`]
    )

    let examens = [], hospitalisations = [], chirurgies = []
    try {
      const [ex] = await pool.query(
        'SELECT ve.*, u.nom AS vet_nom, u.prenom AS vet_prenom FROM vet_exams ve LEFT JOIN users u ON u.id = ve.veterinaire_id WHERE ve.animal_id = ? ORDER BY ve.created_at DESC',
        [animal.id]
      )
      examens = ex
    } catch (_) {}
    try {
      const [ho] = await pool.query(
        'SELECT vh.*, u.nom AS vet_nom, u.prenom AS vet_prenom FROM vet_hospitalizations vh LEFT JOIN users u ON u.id = vh.veterinaire_id WHERE vh.animal_id = ? ORDER BY vh.created_at DESC',
        [animal.id]
      )
      hospitalisations = ho
    } catch (_) {}
    try {
      const [su] = await pool.query(
        'SELECT vs.*, u.nom AS vet_nom, u.prenom AS vet_prenom FROM vet_surgeries vs LEFT JOIN users u ON u.id = vs.veterinaire_id WHERE vs.animal_id = ? ORDER BY vs.created_at DESC',
        [animal.id]
      )
      chirurgies = su
    } catch (_) {}

    res.json({ ...animal, vaccins: vaccines, prescriptions, rdvs, reminders, examens, hospitalisations, chirurgies })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── PUT /animals/:id — mettre à jour ─────────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  const { nom, espece, race, date_naissance, poids, couleur, numero_puce, sterilise, notes } = req.body
  try {
    const [rows] = await pool.query('SELECT id FROM animals WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Animal introuvable' })

    await pool.query(
      `UPDATE animals SET
         nom = COALESCE(?, nom), espece = COALESCE(?, espece), race = COALESCE(?, race),
         date_naissance = COALESCE(?, date_naissance), poids = COALESCE(?, poids),
         couleur = COALESCE(?, couleur), numero_puce = COALESCE(?, numero_puce),
         sterilise = COALESCE(?, sterilise), notes = COALESCE(?, notes)
       WHERE id = ?`,
      [nom || null, espece || null, race || null, date_naissance || null,
       poids != null ? parseFloat(poids) : null, couleur || null, numero_puce || null,
       sterilise != null ? (sterilise ? 1 : 0) : null, notes !== undefined ? notes : null,
       req.params.id]
    )
    const [updated] = await pool.query('SELECT * FROM animals WHERE id = ?', [req.params.id])
    res.json(updated[0])
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// ── DELETE /animals/:id ───────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'patient') return res.status(403).json({ detail: 'Réservé au patient' })
  try {
    const [rows] = await pool.query('SELECT id FROM animals WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id])
    if (!rows.length) return res.status(404).json({ detail: 'Animal introuvable' })
    await pool.query('DELETE FROM animals WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (e) {
    console.error(e); res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
