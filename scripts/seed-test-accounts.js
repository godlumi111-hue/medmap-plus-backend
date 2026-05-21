/**
 * Creates test accounts for all roles.
 * Run: node scripts/seed-test-accounts.js
 * Password for all accounts: Test1234!
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'medmap_plus',
  waitForConnections: true,
  connectionLimit: 5,
})

const PASSWORD = 'Test1234!'

const ACCOUNTS = [
  { email: 'patient@test.com',    nom: 'Kouamé',    prenom: 'Aya',       role: 'patient',     telephone: '+225 0700000001' },
  { email: 'medecin@test.com',    nom: 'Bamba',     prenom: 'Moussa',    role: 'medecin',     telephone: '+225 0700000002' },
  { email: 'pharmacie@test.com',  nom: 'Diallo',    prenom: 'Fatou',     role: 'pharmacie',   telephone: '+225 0700000003' },
  { email: 'clinique@test.com',   nom: 'Traoré',    prenom: 'Karim',     role: 'clinique',    telephone: '+225 0700000004' },
  { email: 'hopital@test.com',    nom: 'Kone',      prenom: 'Ibrahim',   role: 'clinique',    telephone: '+225 0700000005' },
  { email: 'veterinaire@test.com',nom: 'Sylla',     prenom: 'Mariam',    role: 'veterinaire', telephone: '+225 0700000006' },
  { email: 'livreur@test.com',    nom: 'Coulibaly', prenom: 'Sékou',     role: 'livreur',     telephone: '+225 0700000007' },
  { email: 'samu@test.com',       nom: 'Ouédraogo', prenom: 'Issa',      role: 'samu',        telephone: '+225 0700000008' },
  { email: 'pompiers@test.com',   nom: 'Sawadogo',  prenom: 'Drissa',    role: 'pompiers',    telephone: '+225 0700000009' },
  { email: 'ambulance@test.com',  nom: 'Méite',     prenom: 'Abdoul',    role: 'ambulance',   telephone: '+225 0700000010' },
  { email: 'admin@test.com',      nom: 'Admin',     prenom: 'MedMap',    role: 'admin',       telephone: '+225 0700000000' },
]

async function seed() {
  const hash = await bcrypt.hash(PASSWORD, 12)

  console.log('\n🌱 Création des comptes de test (mot de passe : Test1234!)\n')

  for (const acc of ACCOUNTS) {
    try {
      const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [acc.email])
      if (existing.length) {
        console.log(`  ⏭️  ${acc.role.padEnd(12)} ${acc.email} — déjà existant (id=${existing[0].id})`)
        continue
      }

      const [result] = await pool.query(
        `INSERT INTO users (email, password_hash, nom, prenom, telephone, role, is_active, is_verified)
         VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
        [acc.email, hash, acc.nom, acc.prenom, acc.telephone, acc.role]
      )
      const userId = result.insertId

      // Create wallet
      await pool.query('INSERT INTO wallets (user_id, solde) VALUES (?, ?)', [userId, acc.role === 'patient' ? 50000 : 0])

      // Role-specific profiles
      if (acc.role === 'medecin') {
        await pool.query(
          `INSERT INTO doctor_profiles (user_id, specialite, tarif_consultation, bio)
           VALUES (?, 'Médecine générale', 15000, 'Médecin généraliste disponible 24h/7')`,
          [userId]
        ).catch(() => {})
      } else if (['pharmacie', 'clinique', 'veterinaire'].includes(acc.role)) {
        const [spRes] = await pool.query(
          `INSERT INTO structure_profiles (user_id, type, nom, ville, adresse, est_partenaire)
           VALUES (?, ?, ?, 'Abidjan', 'Cocody, Abidjan', 1)`,
          [userId, acc.role, `${acc.role.charAt(0).toUpperCase() + acc.role.slice(1)} Test ${acc.nom}`]
        ).catch(async () => {
          const [sp] = await pool.query('SELECT id FROM structure_profiles WHERE user_id = ?', [userId])
          return [sp[0] ? { insertId: sp[0].id } : { insertId: null }]
        })
        const structId = spRes.insertId
        if (structId) {
          if (acc.role === 'pharmacie') {
            await pool.query('INSERT INTO pharmacy_profiles (structure_id) VALUES (?)', [structId]).catch(() => {})
          } else if (acc.role === 'clinique') {
            await pool.query('INSERT INTO clinic_profiles (structure_id) VALUES (?)', [structId]).catch(() => {})
          } else if (acc.role === 'veterinaire') {
            await pool.query('INSERT INTO vet_profiles (structure_id) VALUES (?)', [structId]).catch(() => {})
          }
        }
      } else if (acc.role === 'livreur') {
        await pool.query('INSERT INTO livreur_profiles (user_id) VALUES (?)', [userId]).catch(() => {})
      }

      console.log(`  ✅ ${acc.role.padEnd(12)} ${acc.email} — créé (id=${userId})`)
    } catch (err) {
      console.error(`  ❌ ${acc.role.padEnd(12)} ${acc.email} — erreur: ${err.message}`)
    }
  }

  console.log('\n📋 Récapitulatif des comptes de test :')
  console.log('─'.repeat(60))
  console.log('  Mot de passe pour tous : Test1234!')
  console.log('─'.repeat(60))
  for (const acc of ACCOUNTS) {
    console.log(`  ${acc.role.padEnd(12)} → ${acc.email}`)
  }
  console.log('─'.repeat(60))

  await pool.end()
}

seed().catch(err => {
  console.error('Erreur fatale :', err.message)
  process.exit(1)
})
