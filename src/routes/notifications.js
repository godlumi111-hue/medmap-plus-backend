const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

// GET /notifications
router.get('/', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    )
    res.json(rows.map(r => ({
      ...r,
      data: r.data ? JSON.parse(r.data) : null,
      read: !!r.read_at,
    })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /notifications/unread-count
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const [[{ count }]] = await pool.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL',
      [req.user.id]
    )
    res.json({ count: parseInt(count) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /notifications/read-all (must be before /:id/read)
router.put('/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      [req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// PUT /notifications/:id/read
router.put('/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET read_at = NOW() WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
