/**
 * Crée le compte Dr. Ibrahim Bah (Neurologue) sur Railway.
 *
 * Étapes :
 *  1. Mets les credentials Railway dans .env  (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME)
 *  2. node scripts/add-ibrahim-bah.js
 *
 * Compte créé :
 *   Email    : dr.ibrahim.bah@medmap.ci
 *   Password : password123
 *   Rôle     : medecin
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')

const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'medmap_plus',
  waitForConnections: true,
  connectionLimit: 3,
})

async function run() {
  const EMAIL    = 'dr.ibrahim.bah@medmap.ci'
  const PASSWORD = 'password123'
  const hash     = await bcrypt.hash(PASSWORD, 12)

  // Vérifie si déjà existant
  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [EMAIL])
  if (existing.length) {
    const userId = existing[0].id
    console.log(`⚠️  Utilisateur déjà existant (id=${userId}). Mise à jour du profil médecin...`)

    await pool.query(
      `UPDATE doctor_profiles
         SET specialite = 'Neurologie', cabinet = 'Neuro Marcory', ville = 'Abidjan',
             tarif = 120000, disponible = 1, experience_ans = 18, note = 4.9,
             teleconsultation = 1, domicile = 0
       WHERE user_id = ?`,
      [userId]
    )
    console.log('✅ Profil mis à jour.')
    await pool.end()
    return
  }

  // Création de l'utilisateur
  const [result] = await pool.query(
    `INSERT INTO users (email, password_hash, nom, prenom, telephone, role, is_active, is_verified)
     VALUES (?, ?, 'Bah', 'Ibrahim', '+225 07 60 12 34', 'medecin', 1, 1)`,
    [EMAIL, hash]
  )
  const userId = result.insertId
  console.log(`✅ Utilisateur créé (id=${userId})`)

  // Portefeuille
  await pool.query('INSERT INTO wallets (user_id, solde) VALUES (?, 50000)', [userId])

  // Profil médecin complet
  await pool.query(
    `INSERT INTO doctor_profiles
       (user_id, specialite, cabinet, ville, tarif, disponible, experience_ans, note, teleconsultation, domicile)
     VALUES (?, 'Neurologie', 'Neuro Marcory', 'Abidjan', 120000, 1, 18, 4.9, 1, 0)`,
    [userId]
  )
  console.log('✅ Profil médecin créé')

  console.log('\n══════════════════════════════════════════')
  console.log('  Dr. Ibrahim Bah — Compte créé')
  console.log('  Email    : dr.ibrahim.bah@medmap.ci')
  console.log('  Password : password123')
  console.log('  Tarif    : 120 000 FCFA / consultation')
  console.log('  Spécialité : Neurologie — Neuro Marcory')
  console.log('══════════════════════════════════════════\n')

  await pool.end()
}

run().catch(err => { console.error('Erreur :', err.message); process.exit(1) })
