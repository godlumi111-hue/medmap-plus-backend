const mysql = require('mysql2/promise')
require('dotenv').config()

// Support Railway MySQL plugin variables (MYSQLHOST etc.) and custom DB_* variables
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || process.env.MYSQLPORT || '3306'),
  user:     process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME     || process.env.MYSQLDATABASE || 'medmap_plus',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
})

pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL connecté')
    conn.release()
  })
  .catch(err => {
    console.error('❌ Erreur MySQL :', err.message)
    // Don't exit — let the app start and fail gracefully per-request
  })

module.exports = pool
