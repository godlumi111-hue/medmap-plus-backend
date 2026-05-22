require('dotenv').config()
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')
const fs = require('fs')
const path = require('path')

const DB_CONFIG = {
  host:     process.env.DB_HOST     || process.env.MYSQLHOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || process.env.MYSQLPORT || '3306'),
  user:     process.env.DB_USER     || process.env.MYSQLUSER     || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD || '',
  database: process.env.DB_NAME     || process.env.MYSQLDATABASE || 'medmap_plus',
  multipleStatements: true,
  charset: 'utf8mb4',
}

async function autoInit() {
  let conn
  try {
    conn = await mysql.createConnection(DB_CONFIG)

    const [tables] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = ? AND table_name = 'users'`,
      [DB_CONFIG.database]
    )
    if (tables[0].cnt > 0) {
      const [rows] = await conn.query('SELECT COUNT(*) AS cnt FROM users')
      if (rows[0].cnt > 0) {
        console.log(`✅ DB already seeded (${rows[0].cnt} users) — skipping auto-init`)
        return
      }
    }

    console.log('🔧 Empty database detected — running auto-init...')

    const initSql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8')
    const schemaSql = initSql
      .split('\n')
      .filter(l => !l.trim().startsWith('CREATE DATABASE') && !l.trim().startsWith('USE ') && !l.trim().startsWith('SELECT '))
      .join('\n')
    await conn.query(schemaSql)
    console.log('✅ Tables created')

    await conn.query(
      `ALTER TABLE users MODIFY COLUMN role ENUM('patient','medecin','pharmacie','clinique','veterinaire','admin','livreur','samu','pompiers','ambulance') NOT NULL DEFAULT 'patient'`
    ).catch(() => {})

    const h = pwd => bcrypt.hash(pwd, 10)
    const [hAdmin, hPatient, hMedecin, hPharma, hClinique, hVet, hEmerg] = await Promise.all([
      h('Admin123!'), h('Patient123!'), h('Medecin123!'), h('Pharma123!'), h('Clinique123!'), h('Vet123!'), h('Urgence123!')
    ])

    await conn.query(
      `INSERT INTO users (email, password_hash, nom, prenom, role, is_active, is_verified) VALUES
        (?,?,'Admin','MedMap','admin',1,1),
        (?,?,'Kone','Aminata','patient',1,1),
        (?,?,'Toure','Ibrahim','patient',1,1),
        (?,?,'Konan','Jean-Paul','medecin',1,1),
        (?,?,'Coulibaly','Fatou','medecin',1,1),
        (?,?,'Bamba','Moussa','medecin',1,1),
        (?,?,'Pharmacie','Plateau','pharmacie',1,1),
        (?,?,'Pharmacie','Cocody','pharmacie',1,1),
        (?,?,'Clinique','Avicenne','clinique',1,1),
        (?,?,'CHU','Cocody','clinique',1,1),
        (?,?,'Vet','Abidjan','veterinaire',1,1),
        (?,?,'SAMU','Urgences','samu',1,1),
        (?,?,'Pompiers','Abidjan','pompiers',1,1),
        (?,?,'Ambulance','MedMap','ambulance',1,1)`,
      [
        'admin@medmap.ci',hAdmin,
        'patient@test.ci',hPatient,
        'patient2@test.ci',hPatient,
        'dr.konan@test.ci',hMedecin,
        'dr.coulibaly@test.ci',hMedecin,
        'dr.bamba@test.ci',hMedecin,
        'pharmacie.plateau@test.ci',hPharma,
        'pharmacie.cocody@test.ci',hPharma,
        'clinique.avicenne@test.ci',hClinique,
        'chu.cocody@test.ci',hClinique,
        'vet.abidjan@test.ci',hVet,
        'samu@medmap.ci',hEmerg,
        'pompiers@medmap.ci',hEmerg,
        'ambulance@medmap.ci',hEmerg,
      ]
    )
    console.log('✅ Auto-init complete!')
  } catch (err) {
    console.error('❌ Auto-init error:', err.message)
  } finally {
    if (conn) await conn.end()
  }
}

module.exports = autoInit
