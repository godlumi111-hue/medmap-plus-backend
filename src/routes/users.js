const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

function formatUser(u) {
  return {
    id: u.id, email: u.email, nom: u.nom, prenom: u.prenom,
    telephone: u.telephone || null, role: u.role,
    is_active: Boolean(u.is_active), is_verified: Boolean(u.is_verified),
    avatar_url: u.avatar_url || null,
  }
}

async function buildStructureResponse(structureRow) {
  const pool2 = require('../db')
  const structId = structureRow.struct_id
  const type = (structureRow.type || '').toLowerCase()

  const base = {
    id: structureRow.user_id,
    structure_id: structureRow.struct_id,
    nom: structureRow.struct_nom || structureRow.nom,
    partenaire: Boolean(structureRow.partenaire),
    note: structureRow.note ? parseFloat(structureRow.note) : null,
    structure: {
      nom: structureRow.struct_nom || structureRow.nom,
      type: structureRow.type,
      adresse: structureRow.adresse,
      ville: structureRow.ville,
      telephone: structureRow.telephone,
      email: structureRow.email,
      lat: structureRow.lat ? parseFloat(structureRow.lat) : null,
      lng: structureRow.lng ? parseFloat(structureRow.lng) : null,
    },
    pharmacy_profile: {},
    clinic_profile: {},
    vet_profile: {},
  }

  if (type.includes('pharma')) {
    const [pp] = await pool2.query('SELECT * FROM pharmacy_profiles WHERE structure_id = ?', [structId])
    if (pp.length) {
      base.pharmacy_profile = { garde: Boolean(pp[0].garde), horaires: pp[0].horaires }
    }
  } else if (type.includes('vet')) {
    const [vp] = await pool2.query('SELECT * FROM vet_profiles WHERE structure_id = ?', [structId])
    if (vp.length) {
      base.vet_profile = {
        services: vp[0].services ? JSON.parse(vp[0].services) : [],
        horaires: vp[0].horaires,
      }
    }
  } else {
    const [cp] = await pool2.query('SELECT * FROM clinic_profiles WHERE structure_id = ?', [structId])
    if (cp.length) {
      base.clinic_profile = {
        urgence24h: Boolean(cp[0].urgence24h),
        nombre_lits: cp[0].nombre_lits,
        horaires: cp[0].horaires,
        services: cp[0].services ? JSON.parse(cp[0].services) : [],
      }
    }
  }

  return base
}

// GET /users/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const u = req.user
    const base = formatUser(u)
    let profile = null

    if (u.role === 'medecin') {
      const [dp] = await pool.query('SELECT * FROM doctor_profiles WHERE user_id = ?', [u.id])
      if (dp.length) profile = dp[0]
    } else if (['pharmacie', 'clinique', 'veterinaire'].includes(u.role)) {
      const [sp] = await pool.query('SELECT * FROM structure_profiles WHERE user_id = ?', [u.id])
      if (sp.length) profile = sp[0]
    }

    res.json({ ...base, profile })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /users/me
router.put('/me', requireAuth, async (req, res) => {
  const { nom, prenom, telephone, avatar_url } = req.body
  try {
    await pool.query(
      'UPDATE users SET nom = COALESCE(?, nom), prenom = COALESCE(?, prenom), telephone = COALESCE(?, telephone), avatar_url = COALESCE(?, avatar_url) WHERE id = ?',
      [nom || null, prenom || null, telephone || null, avatar_url || null, req.user.id]
    )
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id])
    res.json(formatUser(rows[0]))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /users/doctors
router.get('/doctors', async (req, res) => {
  const { ville, specialite, disponible } = req.query
  try {
    let sql = `
      SELECT u.id, u.nom, u.prenom, u.email, u.avatar_url, u.is_verified,
             u.telephone,
             dp.user_id AS doctor_user_id,
             dp.specialite, dp.cabinet, dp.ville, dp.adresse, dp.tarif,
             dp.disponible, dp.langues, dp.experience_ans,
             COALESCE(dp.note, 4.5) AS note,
             COALESCE(dp.teleconsultation, 0) AS teleconsultation,
             COALESCE(dp.domicile, 0) AS domicile,
             COALESCE(dp.nb_patients, 0) AS nb_patients
      FROM users u
      JOIN doctor_profiles dp ON dp.user_id = u.id
      WHERE u.role = 'medecin' AND u.is_active = 1
    `
    const params = []
    if (ville) { sql += ' AND dp.ville LIKE ?'; params.push(`%${ville}%`) }
    if (specialite) { sql += ' AND dp.specialite LIKE ?'; params.push(`%${specialite}%`) }
    if (disponible === 'true') { sql += ' AND dp.disponible = 1' }
    sql += ' ORDER BY note DESC, experience_ans DESC'

    const [rows] = await pool.query(sql, params)
    const doctors = rows.map(r => ({
      id: r.id,
      user_id: r.id,
      nom: r.nom,
      prenom: r.prenom,
      email: r.email,
      avatar_url: r.avatar_url,
      is_verified: Boolean(r.is_verified),
      telephone: r.telephone || null,
      // Flat fields for easy access in frontend
      specialite: r.specialite,
      cabinet: r.cabinet,
      ville: r.ville,
      tarif: r.tarif ? parseFloat(r.tarif) : null,
      disponible: Boolean(r.disponible),
      experience_ans: r.experience_ans,
      note: r.note ? parseFloat(r.note) : null,
      teleconsultation: Boolean(r.teleconsultation),
      domicile: Boolean(r.domicile),
      nb_patients: parseInt(r.nb_patients || 0),
      langues: (() => { try { return r.langues ? JSON.parse(r.langues) : [] } catch { return [] } })(),
      // Also nested for compatibility
      doctor_profile: {
        specialite: r.specialite, cabinet: r.cabinet, ville: r.ville,
        adresse: r.adresse, tarif: r.tarif ? parseFloat(r.tarif) : null,
        disponible: Boolean(r.disponible),
        langues: (() => { try { return r.langues ? JSON.parse(r.langues) : [] } catch { return [] } })(),
        experience_ans: r.experience_ans,
        note: r.note ? parseFloat(r.note) : null,
        teleconsultation: Boolean(r.teleconsultation),
        domicile: Boolean(r.domicile),
      },
    }))
    res.json(doctors)
  } catch (err) {
    console.error('[GET /doctors]', err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /users/doctors/:id
router.get('/doctors/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.nom, u.prenom, u.email, u.avatar_url, u.is_verified,
              u.telephone,
              dp.specialite, dp.cabinet, dp.ville, dp.adresse, dp.tarif,
              dp.disponible, dp.langues, dp.experience_ans,
              COALESCE(dp.note, 4.5) AS note,
              COALESCE(dp.teleconsultation, 0) AS teleconsultation,
              COALESCE(dp.domicile, 0) AS domicile
       FROM users u
       JOIN doctor_profiles dp ON dp.user_id = u.id
       WHERE u.id = ? AND u.role = 'medecin'`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Médecin introuvable' })
    const r = rows[0]
    res.json({
      id: r.id, user_id: r.id, nom: r.nom, prenom: r.prenom, email: r.email,
      avatar_url: r.avatar_url, is_verified: Boolean(r.is_verified),
      telephone: r.telephone || null,
      specialite: r.specialite, cabinet: r.cabinet, ville: r.ville,
      tarif: r.tarif ? parseFloat(r.tarif) : null,
      disponible: Boolean(r.disponible),
      experience_ans: r.experience_ans,
      note: r.note ? parseFloat(r.note) : null,
      teleconsultation: Boolean(r.teleconsultation),
      domicile: Boolean(r.domicile),
      doctor_profile: {
        specialite: r.specialite, cabinet: r.cabinet, ville: r.ville,
        adresse: r.adresse, tarif: r.tarif ? parseFloat(r.tarif) : null,
        disponible: Boolean(r.disponible),
        langues: (() => { try { return r.langues ? JSON.parse(r.langues) : [] } catch { return [] } })(),
        experience_ans: r.experience_ans,
        note: r.note ? parseFloat(r.note) : null,
        teleconsultation: Boolean(r.teleconsultation),
        domicile: Boolean(r.domicile),
      },
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /users/vets — liste des vétérinaires / cliniques vétérinaires
router.get('/vets', async (req, res) => {
  const { ville } = req.query
  try {
    let sql = `
      SELECT u.id as user_id, u.nom, u.email, u.avatar_url,
             sp.id as struct_id, sp.type, sp.nom as struct_nom, sp.adresse,
             sp.ville, sp.telephone, sp.partenaire, sp.note, sp.lat, sp.lng,
             vp.services AS vet_services, vp.horaires AS vet_horaires,
             vp.urgences AS vet_urgences, vp.soins_domicile AS vet_domicile
      FROM users u
      JOIN structure_profiles sp ON sp.user_id = u.id
      LEFT JOIN vet_profiles vp ON vp.structure_id = sp.id
      WHERE u.is_active = 1 AND sp.type = 'veterinaire'
    `
    const params = []
    if (ville) { sql += ' AND sp.ville LIKE ?'; params.push(`%${ville}%`) }
    sql += ' ORDER BY sp.partenaire DESC, sp.note DESC, sp.nom'

    const [rows] = await pool.query(sql, params)

    // Get queue counts for all structures (safe fallback if vet_queue doesn't exist yet)
    let queueCounts = {}
    try {
      const structIds = rows.map(r => r.struct_id)
      if (structIds.length) {
        const [qRows] = await pool.query(
          `SELECT structure_id, COUNT(*) as count
           FROM vet_queue
           WHERE structure_id IN (?) AND statut IN ('en_attente','appele','en_cours')
           GROUP BY structure_id`,
          [structIds]
        )
        for (const q of qRows) queueCounts[q.structure_id] = q.count
      }
    } catch (_) {}

    const results = rows.map(r => ({
      id: r.user_id,
      structure_id: r.struct_id,
      nom: r.struct_nom || r.nom,
      adresse: r.adresse,
      ville: r.ville,
      telephone: r.telephone,
      partenaire: Boolean(r.partenaire),
      note: r.note ? parseFloat(r.note) : null,
      services: r.vet_services ? JSON.parse(r.vet_services) : [],
      horaires: r.vet_horaires || '',
      urgences: Boolean(r.vet_urgences),
      soins_domicile: Boolean(r.vet_domicile),
      queue_count: queueCounts[r.struct_id] || 0,
    }))
    res.json(results)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /users/structures
router.get('/structures', async (req, res) => {
  const { type, ville, partenaire } = req.query
  try {
    let sql = `
      SELECT u.id as user_id, u.nom, u.email,
             sp.id as struct_id, sp.type, sp.nom as struct_nom, sp.adresse,
             sp.ville, sp.telephone, sp.email as struct_email,
             sp.partenaire, sp.note, sp.lat, sp.lng
      FROM users u
      JOIN structure_profiles sp ON sp.user_id = u.id
      WHERE u.is_active = 1
    `
    const params = []
    if (type) { sql += ' AND sp.type LIKE ?'; params.push(`%${type}%`) }
    if (ville) { sql += ' AND sp.ville LIKE ?'; params.push(`%${ville}%`) }
    if (partenaire === 'true') { sql += ' AND sp.partenaire = 1' }
    sql += ' ORDER BY sp.partenaire DESC, sp.nom, sp.id DESC'

    const [rows] = await pool.query(sql, params)
    const results = await Promise.all(rows.map(r => buildStructureResponse(r)))
    res.json(results)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /users/structures/:id
router.get('/structures/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id as user_id, u.nom, u.email,
              sp.id as struct_id, sp.type, sp.nom as struct_nom, sp.adresse,
              sp.ville, sp.telephone, sp.email as struct_email,
              sp.partenaire, sp.note, sp.lat, sp.lng
       FROM users u
       JOIN structure_profiles sp ON sp.user_id = u.id
       WHERE u.id = ?`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ detail: 'Structure introuvable' })
    const result = await buildStructureResponse(rows[0])
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
