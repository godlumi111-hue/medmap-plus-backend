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

    // Check if already seeded
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

    // Create schema (filter out CREATE DATABASE / USE statements)
    const initSql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8')
    const schemaSql = initSql
      .split('\n')
      .filter(l => !l.trim().startsWith('CREATE DATABASE') && !l.trim().startsWith('USE ') && !l.trim().startsWith('SELECT '))
      .join('\n')
    await conn.query(schemaSql)
    console.log('✅ Tables created')

    // Add emergency roles to ENUM
    await conn.query(
      `ALTER TABLE users MODIFY COLUMN role ENUM('patient','medecin','pharmacie','clinique','veterinaire','admin','livreur','samu','pompiers','ambulance') NOT NULL DEFAULT 'patient'`
    ).catch(() => {})

    // Hash passwords
    const h = pwd => bcrypt.hash(pwd, 10)
    const [hAdmin, hPatient, hMedecin, hPharma, hClinique, hVet, hEmerg] = await Promise.all([
      h('Admin123!'), h('Patient123!'), h('Medecin123!'), h('Pharma123!'), h('Clinique123!'), h('Vet123!'), h('Urgence123!')
    ])

    // Users
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
    console.log('👥 Users seeded')

    // Doctor profiles (user ids 4,5,6)
    await conn.query(
      `INSERT INTO doctor_profiles (user_id, specialite, cabinet, ville, adresse, tarif, disponible, langues, experience_ans) VALUES
        (4,'Cardiologie','Cabinet Dr Konan','Abidjan','Plateau, Rue des Banques',20000,1,'["Français","Dioula"]',15),
        (5,'Pédiatrie','Clinique Sainte-Anne','Abidjan','Cocody, Résidence Les Pins',15000,1,'["Français","Malinké"]',8),
        (6,'Médecine générale','Cabinet Bamba','Abidjan','Yopougon, Avenue 25',10000,1,'["Français"]',5)`
    )

    // Structure profiles
    await conn.query(
      `INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note, lat, lng) VALUES
        (7,'Pharmacie','Pharmacie du Plateau','Rue du Commerce, Plateau','Abidjan','+225 27 20 22 34 56',1,4.5,5.3178,-4.0228),
        (8,'Pharmacie','Pharmacie Cocody Village','Carrefour Palmeraie, Cocody','Abidjan','+225 27 22 41 01 23',1,4.2,5.3657,-3.9965),
        (9,'Clinique','Clinique Avicenne','Boulevard de France, Deux Plateaux','Abidjan','+225 27 22 41 87 00',1,4.7,5.3621,-4.0077),
        (10,'Clinique','CHU de Cocody','Avenue Christiani, Cocody','Abidjan','+225 27 22 44 34 34',1,4.3,5.3479,-3.9930),
        (11,'Vétérinaire','Clinique Vétérinaire Abidjan','Zone 4, Boulevard VGE','Abidjan','+225 27 21 24 50 60',0,4.0,5.2990,-4.0145)`
    )

    const [structs] = await conn.query(`SELECT id, user_id FROM structure_profiles ORDER BY id`)
    const sId = {}
    structs.forEach(s => { sId[s.user_id] = s.id })

    await conn.query(
      `INSERT INTO pharmacy_profiles (structure_id, garde, horaires) VALUES (?,0,'07:30 - 21:00'),(?,1,'08:00 - 22:00 | Garde : 22:00 - 08:00')`,
      [sId[7], sId[8]]
    )
    await conn.query(
      `INSERT INTO clinic_profiles (structure_id, urgence24h, nombre_lits, horaires, services) VALUES
        (?,1,80,'24h/24 - 7j/7','["Médecine générale","Chirurgie","Gynécologie","Pédiatrie","Radiologie","Urgences"]'),
        (?,1,350,'24h/24 - 7j/7','["Cardiologie","Neurologie","Urgences","Réanimation","Maternité","Oncologie","Scanner","IRM"]')`,
      [sId[9], sId[10]]
    )
    await conn.query(
      `INSERT INTO vet_profiles (structure_id, services, horaires) VALUES (?,'["Consultation","Vaccination","Chirurgie","Dentisterie","Urgences animales"]','08:00 - 19:00')`,
      [sId[11]]
    )
    console.log('🏥 Structures seeded')

    // Medicines
    await conn.query(
      `INSERT INTO medicines (nom, description, categorie, prix, stock, sur_ordonnance, fabricant) VALUES
        ('Paracétamol 500mg','Antalgique et antipyrétique.','Analgésique',350,500,0,'Sanofi'),
        ('Ibuprofène 400mg','Anti-inflammatoire non stéroïdien.','Anti-inflammatoire',600,300,0,'Pfizer'),
        ('Amoxicilline 500mg','Antibiotique à large spectre.','Antibiotique',1200,200,1,'GlaxoSmithKline'),
        ('Coartem 20/120mg','Antipaludéen combiné Artémether/Luméfantrine.','Antipaludéen',2500,150,1,'Novartis'),
        ('Artesunate 200mg','Antipaludéen injectable de référence.','Antipaludéen',3500,80,1,'Guilin'),
        ('Cotrimoxazole 480mg','Antibiotique combiné sulfamide/triméthoprime.','Antibiotique',800,250,1,'Roche'),
        ('Metformine 500mg','Antidiabétique oral biguanide.','Antidiabétique',1100,180,1,'Merck'),
        ('Amlodipine 5mg','Antihypertenseur inhibiteur calcique.','Antihypertenseur',1500,120,1,'Pfizer'),
        ('Oméprazole 20mg','Inhibiteur de la pompe à protons.','Gastro-entérologie',900,200,0,'AstraZeneca'),
        ('SRO Sachet','Sels de réhydratation orale.','Réhydratation',200,1000,0,'OMS'),
        ('Vitamine C 500mg','Supplément vitaminique antioxydant.','Supplément',250,800,0,'Bayer'),
        ('Acide folique 5mg','Essentiel pendant la grossesse.','Supplément',300,600,1,'Sanofi'),
        ('Zinc 20mg','Oligo-élément essentiel.','Supplément',150,1200,0,'Pfizer'),
        ('Doxycycline 100mg','Antibiotique tétracycline.','Antibiotique',900,180,1,'Pfizer'),
        ('Ciprofloxacine 500mg','Antibiotique fluoroquinolone.','Antibiotique',1400,150,1,'Bayer')`
    )

    const [meds] = await conn.query(`SELECT id FROM medicines ORDER BY id`)
    const medIds = meds.map(m => m.id)

    await conn.query(
      `INSERT INTO pharmacy_medicines (pharmacy_id, medicine_id, prix_local, stock_local) VALUES
        (?,?,400,50),(?,?,700,30),(?,?,1300,20),(?,?,2700,15),
        (?,?,1000,25),(?,?,250,100),(?,?,300,80),(?,?,1600,20),
        (?,?,950,40),(?,?,210,200),
        (?,?,380,80),(?,?,2600,20),(?,?,1250,15),(?,?,850,30)`,
      [
        sId[7],medIds[0], sId[7],medIds[1], sId[7],medIds[2], sId[7],medIds[3],
        sId[7],medIds[8], sId[7],medIds[9], sId[7],medIds[10],sId[7],medIds[7],
        sId[7],medIds[5], sId[7],medIds[12],
        sId[8],medIds[0], sId[8],medIds[3], sId[8],medIds[2], sId[8],medIds[5],
      ]
    )
    console.log('💊 Medicines seeded')

    // Wallets
    await conn.query(
      `INSERT INTO wallets (user_id, solde) VALUES
        (1,0),(2,50000),(3,25000),(4,150000),(5,80000),
        (6,45000),(7,200000),(8,175000),(9,500000),(10,1000000),(11,60000)`
    )

    // Subscriptions
    await conn.query(
      `INSERT INTO subscriptions (user_id, plan, messages_used, last_reset_date) VALUES
        (1,'premium',0,CURDATE()),(2,'premium',0,CURDATE()),(3,'basic',0,CURDATE()),
        (4,'basic',0,CURDATE()),(5,'basic',0,CURDATE()),(6,'basic',0,CURDATE())`
    )

    // Appointments
    await conn.query(
      `INSERT INTO appointments (patient_id, provider_type, doctor_id, service, date_rdv, heure_rdv, type_rdv, motif, statut, prix) VALUES
        (2,'medecin',4,'Cardiologie','2026-05-20','09:00:00','Consultation','Douleur thoracique','confirme',20000),
        (2,'medecin',5,'Pédiatrie','2026-05-25','14:30:00','Consultation','Fièvre enfant','en_attente',15000),
        (3,'medecin',6,'Médecine générale','2026-05-18','10:00:00','Consultation','Bilan de santé','termine',10000)`
    )

    console.log('✅ Auto-init complete!')
    console.log('Accounts: patient@test.ci / Patient123! | admin@medmap.ci / Admin123! | samu@medmap.ci / Urgence123!')
  } catch (err) {
    console.error('❌ Auto-init error:', err.message)
  } finally {
    if (conn) await conn.end()
  }
}

module.exports = autoInit
