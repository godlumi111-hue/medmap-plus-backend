const express = require('express')
const router = express.Router()
const pool = require('../db')

// GET /medicines
router.get('/', async (req, res) => {
  const { search, categorie, sur_ordonnance, limit = 50, offset = 0 } = req.query
  try {
    let sql = 'SELECT * FROM medicines WHERE 1=1'
    const params = []

    if (search) {
      sql += ' AND (nom LIKE ? OR description LIKE ? OR fabricant LIKE ?)'
      params.push(`%${search}%`, `%${search}%`, `%${search}%`)
    }
    if (categorie) { sql += ' AND categorie LIKE ?'; params.push(`%${categorie}%`) }
    if (sur_ordonnance !== undefined) {
      sql += ' AND sur_ordonnance = ?'; params.push(sur_ordonnance === 'true' ? 1 : 0)
    }
    sql += ' ORDER BY nom LIMIT ? OFFSET ?'
    params.push(parseInt(limit), parseInt(offset))

    const [rows] = await pool.query(sql, params)
    res.json(rows.map(r => ({ ...r, sur_ordonnance: Boolean(r.sur_ordonnance), prix: r.prix ? parseFloat(r.prix) : null })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /medicines/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM medicines WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ detail: 'Médicament introuvable' })
    const r = rows[0]
    res.json({ ...r, sur_ordonnance: Boolean(r.sur_ordonnance), prix: r.prix ? parseFloat(r.prix) : null })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
