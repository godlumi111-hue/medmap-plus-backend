const pool = require('../db')

async function createNotification(userId, type, title, body = null, data = null) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?)',
      [userId, type, title, body, data ? JSON.stringify(data) : null]
    )
  } catch (e) {
    console.warn('[notify] createNotification failed (non-fatal):', e.message)
  }
}

async function notifyAndEmit(io, userId, type, title, body = null, data = null) {
  await createNotification(userId, type, title, body, data)
  if (io) {
    io.to(`user_${userId}`).emit('notification:new', { type, title, body, data })
  }
}

module.exports = { createNotification, notifyAndEmit }
