// Script de données de test MedMap+
// Lancer : npm run seed

require('dotenv').config()
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')
const fs = require('fs')
const path = require('path')

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
}

async function seed() {
  const conn = await mysql.createConnection(DB_CONFIG)
  console.log('✅ Connecté à MySQL')

  await conn.query(`CREATE DATABASE IF NOT EXISTS medmap_plus CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  await conn.query(`USE medmap_plus`)
  console.log('✅ Base de données medmap_plus sélectionnée')

  // Supprimer toutes les tables (ordre inverse des dépendances)
  await conn.query(`SET FOREIGN_KEY_CHECKS = 0`)
  const tables = [
    'chat_messages','subscriptions','emergency_reports','disputes','payments',
    'wallet_transactions','wallets','orders','pharmacy_medicines',
    'medicines','appointments','vet_profiles','clinic_profiles',
    'pharmacy_profiles','structure_profiles','doctor_profiles','users'
  ]
  for (const t of tables) {
    await conn.query(`DROP TABLE IF EXISTS \`${t}\``)
  }
  await conn.query(`SET FOREIGN_KEY_CHECKS = 1`)
  console.log('🗑️  Anciennes tables supprimées')

  // Recréer les tables depuis init.sql
  const initSql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8')
  const filteredSql = initSql
    .split('\n')
    .filter(line => !line.trim().startsWith('CREATE DATABASE') && !line.trim().startsWith('USE ') && !line.trim().startsWith('SELECT '))
    .join('\n')
  await conn.query(filteredSql)
  console.log('✅ Tables créées')

  // ─── Mots de passe ─────────────────────────────────────────────────────────
  const hashPwd = pwd => bcrypt.hash(pwd, 10)
  const hAdmin    = await hashPwd('Admin123!')
  const hPatient  = await hashPwd('Patient123!')
  const hMedecin  = await hashPwd('Medecin123!')
  const hPharma   = await hashPwd('Pharma123!')
  const hClinique = await hashPwd('Clinique123!')
  const hVet      = await hashPwd('Vet123!')
  console.log('🔐 Mots de passe hashés')

  // ─── Utilisateurs ──────────────────────────────────────────────────────────
  await conn.query(
    `INSERT INTO users (email, password_hash, nom, prenom, role, is_active, is_verified) VALUES
      (?, ?, 'Admin', 'MedMap', 'admin', 1, 1),
      (?, ?, 'Kone', 'Aminata', 'patient', 1, 1),
      (?, ?, 'Toure', 'Ibrahim', 'patient', 1, 1),
      (?, ?, 'Konan', 'Jean-Paul', 'medecin', 1, 1),
      (?, ?, 'Coulibaly', 'Fatou', 'medecin', 1, 1),
      (?, ?, 'Bamba', 'Moussa', 'medecin', 1, 1),
      (?, ?, 'Pharmacie', 'Plateau', 'pharmacie', 1, 1),
      (?, ?, 'Pharmacie', 'Cocody', 'pharmacie', 1, 1),
      (?, ?, 'Clinique', 'Avicenne', 'clinique', 1, 1),
      (?, ?, 'CHU', 'Cocody', 'clinique', 1, 1),
      (?, ?, 'Vet', 'Abidjan', 'veterinaire', 1, 1)`,
    [
      'admin@medmap.ci', hAdmin,
      'patient@test.ci', hPatient,
      'patient2@test.ci', hPatient,
      'dr.konan@test.ci', hMedecin,
      'dr.coulibaly@test.ci', hMedecin,
      'dr.bamba@test.ci', hMedecin,
      'pharmacie.plateau@test.ci', hPharma,
      'pharmacie.cocody@test.ci', hPharma,
      'clinique.avicenne@test.ci', hClinique,
      'chu.cocody@test.ci', hClinique,
      'vet.abidjan@test.ci', hVet,
    ]
  )

  const [createdUsers] = await conn.query('SELECT id, email, role FROM users ORDER BY id')
  console.log(`👥 ${createdUsers.length} utilisateurs créés :`)
  createdUsers.forEach(u => console.log(`   #${u.id} ${u.email} (${u.role})`))

  // ─── Profils médecins ──────────────────────────────────────────────────────
  await conn.query(
    `INSERT INTO doctor_profiles (user_id, specialite, cabinet, ville, adresse, tarif, disponible, langues, experience_ans) VALUES
      (4, 'Cardiologie', 'Cabinet Dr Konan', 'Abidjan', 'Plateau, Rue des Banques', 20000, 1, '["Français","Dioula"]', 15),
      (5, 'Pédiatrie', 'Clinique Sainte-Anne', 'Abidjan', 'Cocody, Résidence Les Pins', 15000, 1, '["Français","Malinké"]', 8),
      (6, 'Médecine générale', 'Cabinet Bamba', 'Abidjan', 'Yopougon, Avenue 25', 10000, 1, '["Français"]', 5)`
  )
  console.log('👨‍⚕️ Profils médecins créés')

  // ─── Structures ────────────────────────────────────────────────────────────
  await conn.query(
    `INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note, lat, lng) VALUES
      (7,  'Pharmacie',   'Pharmacie du Plateau',         'Rue du Commerce, Plateau',          'Abidjan', '+225 27 20 22 34 56', 1, 4.5, 5.3178, -4.0228),
      (8,  'Pharmacie',   'Pharmacie Cocody Village',     'Carrefour Palmeraie, Cocody',        'Abidjan', '+225 27 22 41 01 23', 1, 4.2, 5.3657, -3.9965),
      (9,  'Clinique',    'Clinique Avicenne',             'Boulevard de France, Deux Plateaux', 'Abidjan', '+225 27 22 41 87 00', 1, 4.7, 5.3621, -4.0077),
      (10, 'Clinique',    'CHU de Cocody',                 'Avenue Christiani, Cocody',          'Abidjan', '+225 27 22 44 34 34', 1, 4.3, 5.3479, -3.9930),
      (11, 'Vétérinaire', 'Clinique Vétérinaire Abidjan',  'Zone 4, Boulevard VGE',              'Abidjan', '+225 27 21 24 50 60', 0, 4.0, 5.2990, -4.0145)`
  )

  const [structs] = await conn.query(`SELECT id, user_id FROM structure_profiles ORDER BY id`)
  const sId = {}
  structs.forEach(s => { sId[s.user_id] = s.id })

  await conn.query(
    `INSERT INTO pharmacy_profiles (structure_id, garde, horaires) VALUES (?, 0, '07:30 - 21:00'), (?, 1, '08:00 - 22:00 | Garde : 22:00 - 08:00')`,
    [sId[7], sId[8]]
  )

  await conn.query(
    `INSERT INTO clinic_profiles (structure_id, urgence24h, nombre_lits, horaires, services) VALUES
      (?, 1, 80,  '24h/24 - 7j/7', '["Médecine générale","Chirurgie","Gynécologie","Pédiatrie","Radiologie","Urgences"]'),
      (?, 1, 350, '24h/24 - 7j/7', '["Cardiologie","Neurologie","Urgences","Réanimation","Maternité","Oncologie","Scanner","IRM"]')`,
    [sId[9], sId[10]]
  )

  await conn.query(
    `INSERT INTO vet_profiles (structure_id, services, horaires) VALUES (?, '["Consultation","Vaccination","Chirurgie","Dentisterie","Urgences animales"]', '08:00 - 19:00')`,
    [sId[11]]
  )
  console.log('🏥 Structures créées')

  // ─── Médicaments ──────────────────────────────────────────────────────────
  await conn.query(
    `INSERT INTO medicines (nom, description, categorie, prix, stock, sur_ordonnance, fabricant) VALUES
      ('Paracétamol 500mg',    'Antalgique et antipyrétique. Usage : douleurs légères à modérées, fièvre.',       'Analgésique',        350,  500, 0, 'Sanofi'),
      ('Ibuprofène 400mg',     'Anti-inflammatoire non stéroïdien. Usage : douleurs, inflammations, fièvre.',     'Anti-inflammatoire',  600, 300, 0, 'Pfizer'),
      ('Amoxicilline 500mg',   'Antibiotique à large spectre. Usage : infections bactériennes.',                  'Antibiotique',       1200, 200, 1, 'GlaxoSmithKline'),
      ('Coartem 20/120mg',     'Antipaludéen combiné Artémether/Luméfantrine. Traitement du paludisme simple.',  'Antipaludéen',       2500, 150, 1, 'Novartis'),
      ('Artesunate 200mg',     'Antipaludéen injectable de référence pour paludisme grave.',                      'Antipaludéen',       3500,  80, 1, 'Guilin'),
      ('Cotrimoxazole 480mg',  'Antibiotique combiné sulfamide/triméthoprime.',                                   'Antibiotique',        800, 250, 1, 'Roche'),
      ('Metformine 500mg',     'Antidiabétique oral biguanide. Contrôle la glycémie.',                            'Antidiabétique',     1100, 180, 1, 'Merck'),
      ('Amlodipine 5mg',       'Antihypertenseur inhibiteur calcique. Traitement hypertension artérielle.',       'Antihypertenseur',   1500, 120, 1, 'Pfizer'),
      ('Oméprazole 20mg',      'Inhibiteur de la pompe à protons. Gastrite, ulcère, reflux.',                     'Gastro-entérologie',  900, 200, 0, 'AstraZeneca'),
      ('SRO Sachet',           'Sels de réhydratation orale. Déshydratation par diarrhée ou vomissements.',       'Réhydratation',       200, 1000, 0, 'OMS'),
      ('Vitamine C 500mg',     'Supplément vitaminique antioxydant. Renforce le système immunitaire.',            'Supplément',          250,  800, 0, 'Bayer'),
      ('Acide folique 5mg',    'Essentiel pendant la grossesse. Prévention malformations tube neural.',           'Supplément',          300,  600, 1, 'Sanofi'),
      ('Zinc 20mg',            'Oligo-élément essentiel. Renforce l''immunité, aide la cicatrisation.',           'Supplément',          150, 1200, 0, 'Pfizer'),
      ('Doxycycline 100mg',    'Antibiotique tétracycline. Infections, prophylaxie antipaludéenne.',              'Antibiotique',         900, 180, 1, 'Pfizer'),
      ('Ciprofloxacine 500mg', 'Antibiotique fluoroquinolone. Infections urinaires et digestives.',               'Antibiotique',        1400, 150, 1, 'Bayer')`
  )

  const [meds] = await conn.query(`SELECT id FROM medicines ORDER BY id`)
  const medIds = meds.map(m => m.id)

  await conn.query(
    `INSERT INTO pharmacy_medicines (pharmacy_id, medicine_id, prix_local, stock_local) VALUES
      (?, ?, 400, 50),  (?, ?, 700, 30),  (?, ?, 1300, 20), (?, ?, 2700, 15),
      (?, ?, 1000, 25), (?, ?, 250, 100), (?, ?, 300, 80),  (?, ?, 1600, 20),
      (?, ?, 950, 40),  (?, ?, 210, 200),
      (?, ?, 380, 80),  (?, ?, 2600, 20), (?, ?, 1250, 15), (?, ?, 850, 30)`,
    [
      sId[7], medIds[0],  sId[7], medIds[1],  sId[7], medIds[2],  sId[7], medIds[3],
      sId[7], medIds[8],  sId[7], medIds[9],  sId[7], medIds[10], sId[7], medIds[7],
      sId[7], medIds[5],  sId[7], medIds[12],
      sId[8], medIds[0],  sId[8], medIds[3],  sId[8], medIds[2],  sId[8], medIds[5],
    ]
  )
  console.log('💊 Médicaments créés')

  // ─── Portefeuilles ────────────────────────────────────────────────────────
  await conn.query(
    `INSERT INTO wallets (user_id, solde) VALUES
      (1,0),(2,50000),(3,25000),(4,150000),(5,80000),
      (6,45000),(7,200000),(8,175000),(9,500000),(10,1000000),(11,60000)`
  )
  console.log('💰 Portefeuilles créés')

  // ─── Abonnements MediA ────────────────────────────────────────────────────
  await conn.query(
    `INSERT INTO subscriptions (user_id, plan, messages_used, last_reset_date) VALUES
      (1, 'premium', 0, CURDATE()),
      (2, 'premium', 0, CURDATE()),
      (3, 'basic',   0, CURDATE()),
      (4, 'basic',   0, CURDATE()),
      (5, 'basic',   0, CURDATE()),
      (6, 'basic',   0, CURDATE())`
  )
  console.log('⭐ Abonnements MediA créés')

  // ─── Rendez-vous ──────────────────────────────────────────────────────────
  await conn.query(
    `INSERT INTO appointments (patient_id, provider_type, doctor_id, service, date_rdv, heure_rdv, type_rdv, motif, statut, prix) VALUES
      (2, 'medecin', 4, 'Cardiologie',       '2026-05-20', '09:00:00', 'Consultation', 'Douleur thoracique',  'confirme',   20000),
      (2, 'medecin', 5, 'Pédiatrie',         '2026-05-25', '14:30:00', 'Consultation', 'Fièvre enfant',       'en_attente', 15000),
      (3, 'medecin', 6, 'Médecine générale', '2026-05-18', '10:00:00', 'Consultation', 'Bilan de santé',      'termine',    10000)`
  )
  console.log('📅 Rendez-vous créés')

  await conn.end()

  console.log('\n✅ Seed terminé avec succès !')
  console.log('\n════════════════════════════════════════')
  console.log('COMPTES DE TEST :')
  console.log('════════════════════════════════════════')
  console.log('  patient@test.ci            / Patient123!   (Patient - Premium MediA)')
  console.log('  patient2@test.ci           / Patient123!   (Patient - Basic MediA)')
  console.log('  dr.konan@test.ci           / Medecin123!   (Médecin - Cardiologie)')
  console.log('  dr.coulibaly@test.ci       / Medecin123!   (Médecin - Pédiatrie)')
  console.log('  pharmacie.plateau@test.ci  / Pharma123!    (Pharmacie du Plateau)')
  console.log('  pharmacie.cocody@test.ci   / Pharma123!    (Pharmacie Cocody - De garde)')
  console.log('  clinique.avicenne@test.ci  / Clinique123!  (Clinique Avicenne)')
  console.log('  chu.cocody@test.ci         / Clinique123!  (CHU Cocody)')
  console.log('  vet.abidjan@test.ci        / Vet123!       (Clinique Vétérinaire)')
  console.log('  admin@medmap.ci            / Admin123!     (Admin MedMap+)')
  console.log('════════════════════════════════════════\n')
}

seed().catch(err => {
  console.error('\n❌ Erreur seed :', err.message)
  console.error(err)
  process.exit(1)
})
