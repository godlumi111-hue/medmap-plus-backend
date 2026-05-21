const express = require('express')
const router = express.Router()
const pool = require('../db')
const { requireAuth } = require('../middleware/auth')

// GET /messages/conversations
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id
    const [rows] = await pool.query(`
      SELECT c.*,
        u1.nom AS patient_nom, u1.prenom AS patient_prenom,
        u2.nom AS other_nom, u2.prenom AS other_prenom, u2.role AS other_role,
        (SELECT m2.content FROM messages m2 WHERE m2.conversation_id = c.id ORDER BY m2.created_at DESC LIMIT 1) AS last_message,
        (SELECT COUNT(*) FROM messages m3 WHERE m3.conversation_id = c.id AND m3.sender_id != ? AND m3.read_at IS NULL) AS unread_count
      FROM conversations c
      JOIN users u1 ON u1.id = c.patient_id
      JOIN users u2 ON u2.id = c.other_user_id
      WHERE c.patient_id = ? OR c.other_user_id = ?
      ORDER BY c.last_message_at DESC
    `, [uid, uid, uid])
    res.json(rows.map(r => ({ ...r, unread_count: parseInt(r.unread_count || 0) })))
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /messages/conversations — find or create
router.post('/conversations', requireAuth, async (req, res) => {
  const { other_user_id, context_type = 'general', context_id = null } = req.body
  if (!other_user_id) return res.status(422).json({ detail: 'other_user_id requis' })

  try {
    const [otherUser] = await pool.query('SELECT id, role FROM users WHERE id = ?', [other_user_id])
    if (!otherUser.length) return res.status(404).json({ detail: 'Utilisateur introuvable' })

    const patientId = req.user.role === 'patient' ? req.user.id : parseInt(other_user_id)
    const otherId   = req.user.role === 'patient' ? parseInt(other_user_id) : req.user.id

    // Find existing conversation for same context
    let query, params
    if (context_id != null) {
      query = 'SELECT * FROM conversations WHERE patient_id = ? AND other_user_id = ? AND context_type = ? AND context_id = ?'
      params = [patientId, otherId, context_type, context_id]
    } else {
      query = 'SELECT * FROM conversations WHERE patient_id = ? AND other_user_id = ? AND context_type = ? AND context_id IS NULL'
      params = [patientId, otherId, context_type]
    }
    const [existing] = await pool.query(query, params)
    if (existing.length) return res.json(existing[0])

    const [result] = await pool.query(
      'INSERT INTO conversations (patient_id, other_user_id, context_type, context_id) VALUES (?, ?, ?, ?)',
      [patientId, otherId, context_type, context_id]
    )
    const [conv] = await pool.query('SELECT * FROM conversations WHERE id = ?', [result.insertId])
    res.status(201).json(conv[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// GET /messages/conversations/:id — load messages + mark read
router.get('/conversations/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT m.id, m.conversation_id, m.sender_id, m.content, m.read_at, m.created_at,
             u.nom, u.prenom, u.role
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at ASC
    `, [req.params.id])

    // Mark incoming messages as read
    await pool.query(
      'UPDATE messages SET read_at = NOW() WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL',
      [req.params.id, req.user.id]
    )
    res.json(rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

// POST /messages/conversations/:id — send a message
router.post('/conversations/:id', requireAuth, async (req, res) => {
  const { content } = req.body
  if (!content?.trim()) return res.status(422).json({ detail: 'Message vide' })

  try {
    const convId = parseInt(req.params.id)
    const [conv] = await pool.query('SELECT * FROM conversations WHERE id = ?', [convId])
    if (!conv.length) return res.status(404).json({ detail: 'Conversation introuvable' })

    const c = conv[0]
    if (c.patient_id !== req.user.id && c.other_user_id !== req.user.id) {
      return res.status(403).json({ detail: 'Accès interdit' })
    }

    const [result] = await pool.query(
      'INSERT INTO messages (conversation_id, sender_id, content) VALUES (?, ?, ?)',
      [convId, req.user.id, content.trim()]
    )
    await pool.query('UPDATE conversations SET last_message_at = NOW() WHERE id = ?', [convId])

    const [msg] = await pool.query(`
      SELECT m.*, u.nom, u.prenom, u.role
      FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.id = ?
    `, [result.insertId])

    const io = req.app.get('io')
    if (io) {
      const recipientId = c.patient_id === req.user.id ? c.other_user_id : c.patient_id
      io.to(`user_${recipientId}`).emit('message:new', { conversation_id: convId, message: msg[0] })
    }

    res.status(201).json(msg[0])
  } catch (err) {
    console.error(err)
    res.status(500).json({ detail: 'Erreur serveur' })
  }
})

module.exports = router
