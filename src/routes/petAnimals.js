const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

// ── Table setup ───────────────────────────────────────────────────────────────
;(async () => {
  const tables = [
    `CREATE TABLE IF NOT EXISTS pet_animals (
       id INT PRIMARY KEY AUTO_INCREMENT,
       owner_id INT NOT NULL,
       name VARCHAR(200) NOT NULL,
       species VARCHAR(100) NOT NULL DEFAULT 'Chien',
       breed VARCHAR(200),
       age INT,
       weight DECIMAL(6,2),
       gender VARCHAR(20) DEFAULT 'Inconnu',
       photo_url VARCHAR(500),
       notes TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_pet_owner (owner_id)
     ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS pet_vaccines (
       id INT PRIMARY KEY AUTO_INCREMENT,
       pet_animal_id INT NOT NULL,
       name VARCHAR(200) NOT NULL,
       date_admin DATE NOT NULL,
       next_date DATE,
       vet_name VARCHAR(200),
       lot VARCHAR(100),
       notes TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_pv_animal (pet_animal_id)
     ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS pet_appointments (
       id INT PRIMARY KEY AUTO_INCREMENT,
       pet_animal_id INT NOT NULL,
       appointment_id INT NOT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_pa_animal (pet_animal_id),
       INDEX idx_pa_appt (appointment_id)
     ) ENGINE=InnoDB`,
  ]
  for (const sql of tables) {
    try { await pool.query(sql) } catch (e) {
      if (!e.message.includes('already exists')) console.error('pet init:', e.message)
    }
  }
  console.log('   ✅ Tables vétérinaires (pet_animals, pet_vaccines, pet_appointments) : OK')
})()

// ── GET /api/animals/my ───────────────────────────────────────────────────────
router.get('/my', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM pet_animals WHERE owner_id = ? ORDER BY created_at DESC',
      [req.user.id]
    )
    res.json(rows)
  } catch (e) {
    console.error('GET /api/animals/my:', e.message)
    res.status(500).json({ detail: 'Impossible de récupérer vos animaux.' })
  }
})

// ── GET /api/animals/:id — dossier complet ────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [animals] = await pool.query(
      'SELECT * FROM pet_animals WHERE id = ? AND owner_id = ?',
      [req.params.id, req.user.id]
    )
    if (!animals.length) return res.status(404).json({ detail: 'Animal introuvable.' })
    const animal = animals[0]
    const safe = (p) => p.catch(() => [[]])

    const [
      [consultations],
      [prescriptions],
      [vaccins],
      [examens],
      [hospitalisations],
      [chirurgies],
      [rappels],
    ] = await Promise.all([
      safe(pool.query(
        `SELECT a.*, sp.nom AS structure_nom, u.nom AS vet_nom, u.prenom AS vet_prenom
         FROM appointments a
         LEFT JOIN structure_profiles sp ON sp.id = a.structure_id
         LEFT JOIN users u ON u.id = a.doctor_id
         WHERE a.animal_id = ? ORDER BY a.date_rdv DESC`,
        [animal.id]
      )),
      safe(pool.query(
        `SELECT vp.*, u.nom AS vet_nom, u.prenom AS vet_prenom
         FROM vet_prescriptions vp JOIN users u ON u.id = vp.veterinaire_id
         WHERE vp.animal_id = ? ORDER BY vp.created_at DESC`,
        [animal.id]
      )),
      safe(pool.query(
        'SELECT * FROM vet_vaccines WHERE animal_id = ? ORDER BY date_admin DESC',
        [animal.id]
      )),
      safe(pool.query(
        `SELECT ve.*, u.nom AS vet_nom, u.prenom AS vet_prenom
         FROM vet_exams ve LEFT JOIN users u ON u.id = ve.veterinaire_id
         WHERE ve.animal_id = ? ORDER BY ve.created_at DESC`,
        [animal.id]
      )),
      safe(pool.query(
        `SELECT vh.*, u.nom AS vet_nom, u.prenom AS vet_prenom
         FROM vet_hospitalizations vh LEFT JOIN users u ON u.id = vh.veterinaire_id
         WHERE vh.animal_id = ? ORDER BY vh.created_at DESC`,
        [animal.id]
      )),
      safe(pool.query(
        `SELECT vs.*, u.nom AS vet_nom, u.prenom AS vet_prenom
         FROM vet_surgeries vs LEFT JOIN users u ON u.id = vs.veterinaire_id
         WHERE vs.animal_id = ? ORDER BY vs.created_at DESC`,
        [animal.id]
      )),
      safe(pool.query(
        'SELECT * FROM medical_reminders WHERE patient_id = ? AND medicament_nom LIKE ? ORDER BY date_debut',
        [animal.owner_id, `%[${animal.name}]%`]
      )),
    ])

    res.json({ ...animal, consultations, prescriptions, vaccins, examens, hospitalisations, chirurgies, rappels })
  } catch (e) {
    console.error('GET /api/animals/:id:', e.message)
    res.status(500).json({ detail: 'Impossible de charger le dossier.' })
  }
})

// ── POST /api/animals — créer un animal ──────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { name, species, breed, age, weight, gender, notes } = req.body
  if (!name || !String(name).trim()) {
    return res.status(422).json({ detail: 'Le nom de l\'animal est requis.' })
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO pet_animals (owner_id, name, species, breed, age, weight, gender, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, String(name).trim(), species || 'Chien', breed || null,
       age ? parseInt(age, 10) : null, weight ? parseFloat(weight) : null,
       gender || 'Inconnu', notes || null]
    )
    const [rows] = await pool.query('SELECT * FROM pet_animals WHERE id = ?', [result.insertId])
    res.status(201).json(rows[0])
  } catch (e) {
    console.error('POST /api/animals:', e.message)
    res.status(500).json({ detail: 'Impossible d\'enregistrer l\'animal pour le moment.' })
  }
})

// ── PUT /api/animals/:id — modifier un animal ────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  const { name, species, breed, age, weight, gender, notes } = req.body
  try {
    const [check] = await pool.query(
      'SELECT id FROM pet_animals WHERE id = ? AND owner_id = ?',
      [req.params.id, req.user.id]
    )
    if (!check.length) return res.status(404).json({ detail: 'Animal introuvable.' })
    await pool.query(
      `UPDATE pet_animals SET
         name = COALESCE(?, name), species = COALESCE(?, species),
         breed = ?, age = ?, weight = ?, gender = COALESCE(?, gender), notes = ?
       WHERE id = ?`,
      [name || null, species || null, breed || null,
       age ? parseInt(age, 10) : null, weight ? parseFloat(weight) : null,
       gender || null, notes !== undefined ? notes : null, req.params.id]
    )
    const [rows] = await pool.query('SELECT * FROM pet_animals WHERE id = ?', [req.params.id])
    res.json(rows[0])
  } catch (e) {
    console.error('PUT /api/animals/:id:', e.message)
    res.status(500).json({ detail: 'Impossible de modifier l\'animal.' })
  }
})

// ── DELETE /api/animals/:id ───────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const [check] = await pool.query(
      'SELECT id FROM pet_animals WHERE id = ? AND owner_id = ?',
      [req.params.id, req.user.id]
    )
    if (!check.length) return res.status(404).json({ detail: 'Animal introuvable.' })
    await pool.query('DELETE FROM pet_vaccines WHERE pet_animal_id = ?', [req.params.id])
    await pool.query('DELETE FROM pet_appointments WHERE pet_animal_id = ?', [req.params.id])
    await pool.query('DELETE FROM pet_animals WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /api/animals/:id:', e.message)
    res.status(500).json({ detail: 'Impossible de supprimer l\'animal.' })
  }
})

// ── POST /api/animals/:id/vaccines — ajouter un vaccin ───────────────────────
router.post('/:id/vaccines', requireAuth, async (req, res) => {
  const { name, date_admin, next_date, vet_name, lot, notes } = req.body
  if (!name?.trim()) return res.status(422).json({ detail: 'Nom du vaccin requis.' })
  try {
    const [check] = await pool.query(
      'SELECT id FROM pet_animals WHERE id = ? AND owner_id = ?',
      [req.params.id, req.user.id]
    )
    if (!check.length) return res.status(404).json({ detail: 'Animal introuvable.' })
    const [result] = await pool.query(
      `INSERT INTO pet_vaccines (pet_animal_id, name, date_admin, next_date, vet_name, lot, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, name.trim(), date_admin || new Date().toISOString().slice(0, 10),
       next_date || null, vet_name || null, lot || null, notes || null]
    )
    const [rows] = await pool.query('SELECT * FROM pet_vaccines WHERE id = ?', [result.insertId])
    res.status(201).json(rows[0])
  } catch (e) {
    console.error('POST /api/animals/:id/vaccines:', e.message)
    res.status(500).json({ detail: 'Impossible d\'enregistrer le vaccin.' })
  }
})

// ── DELETE /api/animals/vaccines/:vid ────────────────────────────────────────
router.delete('/vaccines/:vid', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT pv.id FROM pet_vaccines pv
       JOIN pet_animals pa ON pa.id = pv.pet_animal_id
       WHERE pv.id = ? AND pa.owner_id = ?`,
      [req.params.vid, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Vaccin introuvable.' })
    await pool.query('DELETE FROM pet_vaccines WHERE id = ?', [req.params.vid])
    res.json({ success: true })
  } catch (e) {
    console.error('DELETE /api/animals/vaccines/:vid:', e.message)
    res.status(500).json({ detail: 'Impossible de supprimer le vaccin.' })
  }
})

// ── POST /api/animals/:id/link-appointment — lier un RDV à l'animal ──────────
router.post('/:id/link-appointment', requireAuth, async (req, res) => {
  const { appointment_id } = req.body
  if (!appointment_id) return res.status(422).json({ detail: 'appointment_id requis.' })
  try {
    const [check] = await pool.query(
      'SELECT id FROM pet_animals WHERE id = ? AND owner_id = ?',
      [req.params.id, req.user.id]
    )
    if (!check.length) return res.status(404).json({ detail: 'Animal introuvable.' })
    // Avoid duplicate links
    const [existing] = await pool.query(
      'SELECT id FROM pet_appointments WHERE pet_animal_id = ? AND appointment_id = ?',
      [req.params.id, appointment_id]
    )
    if (!existing.length) {
      await pool.query(
        'INSERT INTO pet_appointments (pet_animal_id, appointment_id) VALUES (?, ?)',
        [req.params.id, appointment_id]
      )
    }
    res.json({ success: true })
  } catch (e) {
    console.error('POST /api/animals/:id/link-appointment:', e.message)
    res.status(500).json({ detail: 'Impossible de lier le rendez-vous.' })
  }
})

module.exports = router
