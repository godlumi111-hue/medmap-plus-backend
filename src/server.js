require('dotenv').config()
const http = require('http')
const { Server } = require('socket.io')
const app = require('./app')

const PORT = process.env.PORT || 5000
const allowedOrigins = [
  ...(process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(s => s.trim()),
  'https://medmap-plus-frontend.vercel.app',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
]

const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true)
      cb(new Error('Not allowed by CORS'))
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

io.on('connection', (socket) => {
  console.log(`🔌 Client connecté : ${socket.id}`)

  // Rejoindre la room personnelle de l'utilisateur
  socket.on('join', async (userId) => {
    socket.join(`user_${userId}`)
    // Auto-join role room for emergency services
    try {
      const pool = require('./db')
      const [rows] = await pool.query('SELECT role FROM users WHERE id = ?', [userId])
      const role = rows[0]?.role
      if (['samu', 'pompiers', 'ambulance'].includes(role)) {
        socket.join(`role_${role}`)
        console.log(`🚨 ${role.toUpperCase()} ${userId} rejoint role_${role}`)
      }
    } catch {}
    console.log(`👤 User ${userId} rejoint sa room`)
  })

  // Rejoindre la room d'un hôpital (staff + patients)
  socket.on('join:hospital', (structureId) => {
    socket.join(`hospital_struct_${structureId}`)
    console.log(`🏥 Socket ${socket.id} rejoint hospital_struct_${structureId}`)
  })

  // Rejoindre une room de conversation
  socket.on('join:conversation', (conversationId) => {
    socket.join(`conv_${conversationId}`)
  })

  // Quitter une room de conversation
  socket.on('leave:conversation', (conversationId) => {
    socket.leave(`conv_${conversationId}`)
  })

  // Indicateur "en train d'écrire"
  socket.on('typing:start', ({ conversationId, userId }) => {
    socket.to(`conv_${conversationId}`).emit('typing:start', { userId })
  })
  socket.on('typing:stop', ({ conversationId, userId }) => {
    socket.to(`conv_${conversationId}`).emit('typing:stop', { userId })
  })

  socket.on('disconnect', () => {
    console.log(`❌ Client déconnecté : ${socket.id}`)
  })
})

app.set('io', io)

async function ensureTestAccounts() {
  const pool = require('./db')
  const { hash } = require('./utils/password')
  const PASS = 'password123'

  const accounts = [
    { email: 'patient.demo@medmap.ci',              nom: 'Kouamé',      prenom: 'Adjoua',            role: 'patient',     tel: '+225 07 01 23 45' },
    { email: 'patient2.demo@medmap.ci',             nom: 'Bamba',       prenom: 'Seydou',            role: 'patient',     tel: '+225 07 99 00 11' },
    { email: 'dr.kwadjo@medmap.ci',                 nom: 'Kwadjo',      prenom: 'Ama',               role: 'medecin',     tel: '+225 07 11 22 33' },
    { email: 'dr.coulibaly@medmap.ci',              nom: 'Coulibaly',   prenom: 'Ibrahim',           role: 'medecin',     tel: '+225 05 44 55 66' },
    { email: 'pharmacie.cocody@medmap.ci',          nom: 'Pharmacie',   prenom: 'Cocody Village',    role: 'pharmacie',   tel: '+225 22 43 56 78' },
    { email: 'pharmacie.riviera@medmap.ci',         nom: 'Pharmacie',   prenom: 'Riviera Palmeraie', role: 'pharmacie',   tel: '+225 22 41 30 20' },
    { email: 'chu.cocody@medmap.ci',                nom: 'CHU Cocody',  prenom: 'Admin',             role: 'clinique',    tel: '+225 22 44 55 00' },
    { email: 'polyclinique.farah@medmap.ci',        nom: 'Polyclinique',prenom: 'Farah',             role: 'clinique',    tel: '+225 22 42 30 40' },
    { email: 'livreur.kouassi@medmap.ci',           nom: 'Kouassi',     prenom: 'Koffi',             role: 'livreur',     tel: '+225 07 55 66 77' },
    { email: 'livreur.diarra@medmap.ci',            nom: 'Diarra',      prenom: 'Mamadou',           role: 'livreur',     tel: '+225 01 33 44 55' },
    { email: 'admin@medmap.ci',                     nom: 'Admin',       prenom: 'MedMap',            role: 'admin',       tel: '+225 22 00 00 01' },
    { email: 'vetcity.abidjan@medmap.ci',           nom: 'VétCity',     prenom: 'Abidjan',           role: 'veterinaire', tel: '+225 22 50 60 70' },
    { email: 'cabinet.vet.riviera@medmap.ci',       nom: 'Cabinet Vét', prenom: 'Riviera',           role: 'veterinaire', tel: '+225 22 43 80 90' },
    { email: 'clinique.animale.riviera@medmap.ci',  nom: 'Clinique',    prenom: 'Animale',           role: 'veterinaire', tel: '+225 22 43 70 80' },
    { email: 'veto.deuxplateaux@medmap.ci',         nom: 'Centre',      prenom: 'Deux Plateaux',     role: 'veterinaire', tel: '+225 22 41 90 00' },
    { email: 'veto.marcory@medmap.ci',              nom: 'Clinique',    prenom: 'Marcory',           role: 'veterinaire', tel: '+225 22 35 10 20' },
    { email: 'cabinet.angre@medmap.ci',             nom: 'Cabinet',     prenom: 'Angré',             role: 'veterinaire', tel: '+225 07 88 99 10' },
    { email: 'clinique.bingerville@medmap.ci',      nom: 'Clinique',    prenom: 'Bingerville',       role: 'veterinaire', tel: '+225 22 51 40 50' },
    { email: 'centre.vet.plateau@medmap.ci',        nom: 'Centre',      prenom: 'Plateau',           role: 'veterinaire', tel: '+225 22 20 30 40' },
    { email: 'veto.yopougon@medmap.ci',             nom: 'Clinique',    prenom: 'Yopougon',          role: 'veterinaire', tel: '+225 22 46 20 30' },
    { email: 'cabinet.riviera.palmeraie@medmap.ci', nom: 'Cabinet',     prenom: 'Palmeraie',         role: 'veterinaire', tel: '+225 22 43 55 60' },
  ]

  const specialites = { 'dr.kwadjo@medmap.ci': 'Cardiologie', 'dr.coulibaly@medmap.ci': 'Médecine générale' }
  const cliniques   = {
    'chu.cocody@medmap.ci': 'CHU de Cocody', 'polyclinique.farah@medmap.ci': 'Polyclinique Farah',
    'vetcity.abidjan@medmap.ci':              'Clinique VétCity Abidjan',
    'cabinet.vet.riviera@medmap.ci':          'Cabinet Vétérinaire Riviera',
    'clinique.animale.riviera@medmap.ci':     'Clinique Animale Riviera',
    'veto.deuxplateaux@medmap.ci':            'Centre Vétérinaire Deux Plateaux',
    'veto.marcory@medmap.ci':                 'Clinique Vétérinaire Marcory',
    'cabinet.angre@medmap.ci':                'Cabinet Vétérinaire Angré',
    'clinique.bingerville@medmap.ci':         'Clinique Animale Bingerville',
    'centre.vet.plateau@medmap.ci':           'Centre Vétérinaire Plateau',
    'veto.yopougon@medmap.ci':                'Clinique Vétérinaire Yopougon',
    'cabinet.riviera.palmeraie@medmap.ci':    'Cabinet Vétérinaire Riviera Palmeraie',
  }

  const vetConfigs = {
    'vetcity.abidjan@medmap.ci':              { ville: 'Plateau',          adresse: 'Bd de la République, Plateau',          services: ['Consultation','Vaccination','Chirurgie','Urgences 24h','Radiologie','Analyses'], horaires: '7h-20h',  urgences: true,  note: 4.8 },
    'cabinet.vet.riviera@medmap.ci':          { ville: 'Riviera',          adresse: 'Riviera 2, Cocody',                      services: ['Consultation','Vaccination','Bilan de santé','Dentaire'],                        horaires: '8h-18h',  urgences: false, note: 4.5 },
    'clinique.animale.riviera@medmap.ci':     { ville: 'Riviera',          adresse: 'Riviera Palmeraie, Cocody',              services: ['Consultation','Vaccination','Chirurgie','Urgences','Échographie'],               horaires: '7h-21h',  urgences: true,  note: 4.7 },
    'veto.deuxplateaux@medmap.ci':            { ville: 'Deux Plateaux',    adresse: '7ème Tranche, Deux Plateaux',           services: ['Consultation','Vaccination','Dermatologie','Orthopédie','Toilettage'],           horaires: '8h-19h',  urgences: true,  note: 4.6 },
    'veto.marcory@medmap.ci':                 { ville: 'Marcory',          adresse: 'Marcory Zone 4',                         services: ['Consultation','Vaccination','Petite chirurgie','Analyses'],                      horaires: '8h-18h',  urgences: false, note: 4.3 },
    'cabinet.angre@medmap.ci':                { ville: 'Angré',            adresse: 'Angré 8ème Tranche',                     services: ['Consultation','Vaccination','Stérilisation','Comportement'],                    horaires: '9h-18h',  urgences: false, note: 4.4 },
    'clinique.bingerville@medmap.ci':         { ville: 'Bingerville',      adresse: 'Route de Bingerville',                   services: ['Consultation','Vaccination','Chirurgie','Radiologie'],                          horaires: '8h-17h',  urgences: false, note: 4.2 },
    'centre.vet.plateau@medmap.ci':           { ville: 'Plateau',          adresse: 'Avenue Noguès, Plateau',                 services: ['Consultation','Vaccination','Ophtalmologie','Cardiologie','Urgences'],           horaires: '24h/24',  urgences: true,  note: 4.9 },
    'veto.yopougon@medmap.ci':                { ville: 'Yopougon',         adresse: 'Yopougon Marché, Zone Industrielle',     services: ['Consultation','Vaccination','Toilettage','Petite chirurgie'],                   horaires: '8h-19h',  urgences: false, note: 4.1 },
    'cabinet.riviera.palmeraie@medmap.ci':    { ville: 'Riviera Palmeraie',adresse: 'Palmeraie Golf, Cocody',                 services: ['Consultation','Vaccination','Chirurgie','Urgences','Bien-être animal'],          horaires: '8h-20h',  urgences: true,  note: 4.6 },
  }

  let created = 0
  for (const u of accounts) {
    try {
      const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [u.email])
      if (existing.length) continue

      const passwordHash = await hash(PASS)
      const [res] = await pool.query(
        'INSERT INTO users (email, password_hash, nom, prenom, telephone, role, is_active, is_verified) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
        [u.email, passwordHash, u.nom, u.prenom, u.tel, u.role]
      )
      const uid = res.insertId
      await pool.query('INSERT INTO wallets (user_id, solde) VALUES (?, ?)', [uid, 50000])

      if (u.role === 'medecin') {
        await pool.query(
          'INSERT INTO doctor_profiles (user_id, specialite, cabinet, ville, tarif, disponible, experience_ans) VALUES (?, ?, ?, ?, ?, 1, ?)',
          [uid, specialites[u.email] || 'Généraliste', `Cabinet ${u.prenom} ${u.nom}`, 'Abidjan', 15000, 10]
        )
      } else if (u.role === 'pharmacie') {
        const [sp] = await pool.query(
          'INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          [uid, 'pharmacie', u.prenom, 'Abidjan', 'Abidjan', u.tel, 4.7]
        )
        await pool.query('INSERT INTO pharmacy_profiles (structure_id, garde, horaires) VALUES (?, 1, ?)', [sp.insertId, '24h/24'])
      } else if (u.role === 'clinique') {
        const [sp] = await pool.query(
          'INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          [uid, 'clinique', cliniques[u.email] || u.prenom, 'Abidjan', 'Abidjan', u.tel, 4.5]
        )
        await pool.query('INSERT INTO clinic_profiles (structure_id, urgence24h, nombre_lits, horaires) VALUES (?, 1, 200, ?)', [sp.insertId, '24h/24'])
      } else if (u.role === 'veterinaire') {
        const vc = vetConfigs[u.email] || { ville: 'Abidjan', adresse: 'Abidjan', services: ['Consultation générale', 'Vaccination', 'Chirurgie', 'Urgences animales'], horaires: '8h-18h', urgences: false, note: 4.5 }
        const [sp] = await pool.query(
          'INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          [uid, 'veterinaire', cliniques[u.email] || u.prenom, vc.adresse, vc.ville, u.tel, vc.note]
        )
        await pool.query(
          'INSERT INTO vet_profiles (structure_id, services, horaires) VALUES (?, ?, ?)',
          [sp.insertId, JSON.stringify(vc.services), vc.horaires]
        )
      } else if (u.role === 'livreur') {
        await pool.query('INSERT INTO livreur_profiles (user_id, vehicule, zone, statut) VALUES (?, ?, ?, ?)', [uid, 'Moto', 'Abidjan', 'disponible'])
      }
      created++
    } catch (_) {}
  }
  if (created > 0) console.log(`   ✅ ${created} compte(s) test recréé(s) automatiquement`)
}

async function ensureMigrations() {
  const pool = require('./db')
  const migrations = [
    // orders columns — base
    `ALTER TABLE orders
       ADD COLUMN IF NOT EXISTS frais_livraison DECIMAL(10,2) DEFAULT 700.00,
       ADD COLUMN IF NOT EXISTS adresse_livraison VARCHAR(500),
       ADD COLUMN IF NOT EXISTS livreur_id INT,
       ADD COLUMN IF NOT EXISTS paiement_id INT,
       ADD COLUMN IF NOT EXISTS commission DECIMAL(10,2)`,
    // Extend livreur_statut ENUM — covers all tracking phases
    `ALTER TABLE orders MODIFY COLUMN livreur_statut
       ENUM('non_assigne','assigne','vers_pharmacie','arrive_pharmacie','vers_patient','arrive_patient','livre')
       DEFAULT 'non_assigne'`,
    // paiement_statut column for escrow
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS paiement_statut
       ENUM('non_requis','bloque','libere','rembourse') DEFAULT 'bloque'`,
    // appointments columns
    `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS symptomes TEXT,
       ADD COLUMN IF NOT EXISTS age_patient INT,
       ADD COLUMN IF NOT EXISTS sexe_patient VARCHAR(10),
       ADD COLUMN IF NOT EXISTS premiere_consult TINYINT(1) DEFAULT 1,
       ADD COLUMN IF NOT EXISTS antecedents TEXT,
       ADD COLUMN IF NOT EXISTS consultation_statut ENUM('attente','effectuee','confirmee') DEFAULT 'attente',
       ADD COLUMN IF NOT EXISTS paiement_statut ENUM('non_requis','bloque','libere','rembourse') DEFAULT 'non_requis',
       ADD COLUMN IF NOT EXISTS commission_taux DECIMAL(5,2) DEFAULT 10.00,
       ADD COLUMN IF NOT EXISTS paiement_id INT`,
    // appointments statut ENUM with 'refuse'
    `ALTER TABLE appointments MODIFY COLUMN statut ENUM('en_attente','confirme','refuse','annule','termine') DEFAULT 'en_attente'`,
    // users role ENUM with all roles including emergency services and coach
    `ALTER TABLE users MODIFY COLUMN role ENUM('patient','medecin','pharmacie','clinique','veterinaire','admin','livreur','samu','pompiers','ambulance','coach') NOT NULL DEFAULT 'patient'`,
    // Repair any coach user whose role was reset to '' by a previous bad migration
    `UPDATE users SET role='coach' WHERE id IN (SELECT user_id FROM coach_profiles) AND role != 'coach'`,
    // prescriptions table
    `CREATE TABLE IF NOT EXISTS prescriptions (
       id INT PRIMARY KEY AUTO_INCREMENT,
       appointment_id INT NOT NULL,
       patient_id INT NOT NULL,
       emetteur_id INT NOT NULL,
       medicaments JSON NOT NULL,
       notes TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
       FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
       FOREIGN KEY (emetteur_id) REFERENCES users(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    // medical tables
    `CREATE TABLE IF NOT EXISTS medical_referrals (
       id INT PRIMARY KEY AUTO_INCREMENT,
       appointment_id INT NOT NULL, patient_id INT NOT NULL, emetteur_id INT NOT NULL,
       structure_id INT NULL,
       specialite VARCHAR(100) NOT NULL, motif TEXT, urgence ENUM('normal','urgent','tres_urgent') DEFAULT 'normal',
       resume_medical TEXT, symptomes_observes TEXT, medecin_recommande VARCHAR(200),
       service_recommande VARCHAR(200), date_proposee DATE, heure_proposee TIME,
       tarif DECIMAL(10,2), examens_necessaires TEXT, commentaire TEXT,
       statut ENUM('envoyee_reception','en_traitement','attribuee','acceptee','refusee','annulee') DEFAULT 'envoyee_reception',
       assigned_room_id INT NULL, assigned_by_id INT NULL,
       new_appointment_id INT, paiement_id INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
       FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
       FOREIGN KEY (emetteur_id) REFERENCES users(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS hospitalizations (
       id INT PRIMARY KEY AUTO_INCREMENT,
       appointment_id INT NOT NULL, patient_id INT NOT NULL, emetteur_id INT NOT NULL,
       structure_id INT, motif TEXT NOT NULL, duree_estimee VARCHAR(100),
       service VARCHAR(200), chambre VARCHAR(100), urgence ENUM('normal','urgent','tres_urgent') DEFAULT 'normal',
       frais DECIMAL(10,2), examens TEXT, commentaire TEXT,
       statut ENUM('en_attente','accepte','refuse','en_cours','termine') DEFAULT 'en_attente',
       paiement_statut ENUM('non_requis','bloque','libere','rembourse') DEFAULT 'non_requis',
       paiement_id INT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
       FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
       FOREIGN KEY (emetteur_id) REFERENCES users(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS medical_exams (
       id INT PRIMARY KEY AUTO_INCREMENT,
       appointment_id INT NOT NULL, patient_id INT NOT NULL, emetteur_id INT NOT NULL,
       examens JSON NOT NULL, motif TEXT, urgence ENUM('normal','urgent','tres_urgent') DEFAULT 'normal',
       laboratoire VARCHAR(200), date_proposee DATE, frais DECIMAL(10,2),
       statut ENUM('demande','realise','annule') DEFAULT 'demande', resultats TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
       FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS medical_reminders (
       id INT PRIMARY KEY AUTO_INCREMENT, patient_id INT NOT NULL,
       prescription_id INT, appointment_id INT,
       type ENUM('medicament','rdv','examen','controle') DEFAULT 'medicament',
       titre VARCHAR(200) NOT NULL, description TEXT, horaire VARCHAR(50),
       date_debut DATE, date_fin DATE, medicament_nom VARCHAR(200),
       actif TINYINT(1) DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    // livreur_profiles table
    `CREATE TABLE IF NOT EXISTS livreur_profiles (
       id INT PRIMARY KEY AUTO_INCREMENT,
       user_id INT UNIQUE NOT NULL,
       statut ENUM('disponible','en_livraison','hors_ligne') DEFAULT 'disponible',
       vehicule VARCHAR(100),
       zone VARCHAR(200),
       note_moy DECIMAL(3,2) DEFAULT 0.00,
       livraisons INT DEFAULT 0,
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    // ── Système hospitalier ──────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS hospital_services (
       id INT PRIMARY KEY AUTO_INCREMENT,
       structure_id INT NOT NULL,
       nom VARCHAR(200) NOT NULL,
       specialite VARCHAR(100),
       actif TINYINT(1) DEFAULT 1,
       ordre INT DEFAULT 0,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (structure_id) REFERENCES structure_profiles(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS hospital_rooms (
       id INT PRIMARY KEY AUTO_INCREMENT,
       service_id INT NOT NULL,
       nom VARCHAR(200) NOT NULL,
       statut ENUM('libre','occupee','pause','fermee') DEFAULT 'libre',
       medecin_nom VARCHAR(200),
       ordre INT DEFAULT 0,
       FOREIGN KEY (service_id) REFERENCES hospital_services(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS queue_entries (
       id INT PRIMARY KEY AUTO_INCREMENT,
       room_id INT NOT NULL,
       appointment_id INT,
       patient_id INT NOT NULL,
       patient_nom VARCHAR(200),
       numero_ordre INT NOT NULL,
       statut ENUM('en_attente','appele','en_consultation','termine') DEFAULT 'en_attente',
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (room_id) REFERENCES hospital_rooms(id) ON DELETE CASCADE,
       FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
     ) ENGINE=InnoDB`,
    `ALTER TABLE appointments
       ADD COLUMN IF NOT EXISTS type_consultation ENUM('immediate','programme') DEFAULT 'programme',
       ADD COLUMN IF NOT EXISTS room_id INT,
       ADD COLUMN IF NOT EXISTS ticket_numero VARCHAR(20),
       ADD COLUMN IF NOT EXISTS queue_position INT`,
    `ALTER TABLE hospital_services ADD COLUMN IF NOT EXISTS prix DECIMAL(10,2) DEFAULT 5000.00`,
    // Extend payments.statut ENUM to support hospital escrow states
    `ALTER TABLE payments MODIFY COLUMN statut ENUM('en_attente','bloque','confirme','libere','dispute','rembourse') DEFAULT 'en_attente'`,
    // Update existing service prices by name
    `UPDATE hospital_services SET prix = CASE nom
       WHEN 'Consultation générale' THEN 5000
       WHEN 'Cardiologie' THEN 15000
       WHEN 'Pédiatrie' THEN 7500
       WHEN 'Ophtalmologie' THEN 12000
       WHEN 'Gynécologie' THEN 10000
       WHEN 'Urgences' THEN 20000
       ELSE prix END
     WHERE prix = 5000 OR prix IS NULL`,
    // Queue entries: add timer + absence tracking
    `ALTER TABLE queue_entries
       ADD COLUMN IF NOT EXISTS called_at TIMESTAMP NULL,
       ADD COLUMN IF NOT EXISTS absent_count INT DEFAULT 0`,
    `ALTER TABLE queue_entries MODIFY COLUMN statut
       ENUM('en_attente','appele','en_consultation','absent','termine') DEFAULT 'en_attente'`,
    // Referrals: proper hospital circuit
    // Step 1 — convert statut to VARCHAR so it accepts any string (old ENUM values remain valid)
    `ALTER TABLE medical_referrals MODIFY COLUMN statut VARCHAR(50) DEFAULT 'envoyee_reception'`,
    // Step 2 — remap all legacy values to 'annulee' (VARCHAR allows this freely)
    `UPDATE medical_referrals SET statut = 'annulee'
       WHERE statut IN ('en_attente','accepte','refuse','reporte') OR statut = ''`,
    // Step 3 — now safe to switch to the correct ENUM (no invalid values remain)
    `ALTER TABLE medical_referrals MODIFY COLUMN statut
       ENUM('envoyee_reception','en_traitement','attribuee','acceptee','refusee','annulee')
       DEFAULT 'envoyee_reception'`,
    // Step 4 — add new columns one by one (fails silently if column already exists)
    `ALTER TABLE medical_referrals ADD COLUMN structure_id INT NULL`,
    `ALTER TABLE medical_referrals ADD COLUMN assigned_room_id INT NULL`,
    `ALTER TABLE medical_referrals ADD COLUMN assigned_by_id INT NULL`,
    // Hospitalizations: extend statut ENUM for full reception circuit
    `ALTER TABLE hospitalizations MODIFY COLUMN statut VARCHAR(50) DEFAULT 'envoyee_reception'`,
    `UPDATE hospitalizations SET statut = 'acceptee'         WHERE statut = 'accepte'`,
    `UPDATE hospitalizations SET statut = 'refusee'          WHERE statut = 'refuse'`,
    `UPDATE hospitalizations SET statut = 'envoyee_reception' WHERE statut = 'en_attente'`,
    `ALTER TABLE hospitalizations MODIFY COLUMN statut
       ENUM('envoyee_reception','en_traitement','attribuee','acceptee','refusee','en_cours','termine','annulee')
       DEFAULT 'envoyee_reception'`,
    `ALTER TABLE hospitalizations ADD COLUMN assigned_room_id INT NULL`,
    `ALTER TABLE hospitalizations ADD COLUMN assigned_by_id INT NULL`,
    // Medical exams: add structure + reception columns, extend statut ENUM
    `ALTER TABLE medical_exams MODIFY COLUMN statut VARCHAR(50) DEFAULT 'envoyee_reception'`,
    `UPDATE medical_exams SET statut = 'envoyee_reception' WHERE statut = 'demande'`,
    `ALTER TABLE medical_exams MODIFY COLUMN statut
       ENUM('envoyee_reception','en_traitement','attribuee','acceptee','refusee','realise','annule')
       DEFAULT 'envoyee_reception'`,
    `ALTER TABLE medical_exams ADD COLUMN structure_id INT NULL`,
    `ALTER TABLE medical_exams ADD COLUMN assigned_room_id INT NULL`,
    `ALTER TABLE medical_exams ADD COLUMN assigned_by_id INT NULL`,
    `ALTER TABLE medical_exams ADD COLUMN tarif DECIMAL(10,2) NULL`,
    `ALTER TABLE medical_exams ADD COLUMN heure_rdv TIME NULL`,
    `ALTER TABLE medical_exams ADD COLUMN paiement_id INT NULL`,
    `ALTER TABLE medical_exams ADD COLUMN paiement_statut VARCHAR(30) DEFAULT 'non_requis'`,
    // Queue entries: track exam/hospitalization entries
    `ALTER TABLE queue_entries ADD COLUMN exam_id INT NULL`,
    `ALTER TABLE queue_entries ADD COLUMN hospitalization_id INT NULL`,
    `ALTER TABLE queue_entries ADD COLUMN entry_type VARCHAR(20) DEFAULT 'consultation'`,
    // hospital_rooms: per-room pricing
    `ALTER TABLE hospital_rooms ADD COLUMN IF NOT EXISTS prix DECIMAL(10,2) DEFAULT 0`,
    `UPDATE hospital_rooms SET prix = 50000 WHERE nom IN ('Chambre 1', 'Chambre 2', 'Chambre 3') AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 120000 WHERE nom = 'Unité Chirurgie' AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 60000 WHERE nom = 'Unité Médecine interne' AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 35000 WHERE nom = 'Unité Observation' AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 5000 WHERE nom IN ('Laboratoire 1', 'Laboratoire 2') AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 15000 WHERE nom = 'Salle Radiologie' AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 35000 WHERE nom = 'Salle Scanner' AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 20000 WHERE nom = 'Salle Échographie' AND prix = 0`,
    `UPDATE hospital_rooms SET prix = 8000 WHERE nom = 'Salle ECG' AND prix = 0`,
    // ── Vétérinaire ──────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS animals (
       id INT PRIMARY KEY AUTO_INCREMENT,
       owner_id INT NOT NULL,
       nom VARCHAR(200) NOT NULL,
       espece VARCHAR(100) NOT NULL DEFAULT 'Autre',
       race VARCHAR(200),
       date_naissance DATE,
       poids DECIMAL(6,2),
       couleur VARCHAR(100),
       numero_puce VARCHAR(100),
       sterilise TINYINT(1) DEFAULT 0,
       notes TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_animals_owner (owner_id)
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS vet_vaccines (
       id INT PRIMARY KEY AUTO_INCREMENT,
       animal_id INT NOT NULL,
       appointment_id INT,
       nom VARCHAR(200) NOT NULL,
       date_admin DATE NOT NULL,
       prochaine_date DATE,
       lot VARCHAR(100),
       veterinaire_nom VARCHAR(200),
       notes TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_vet_vaccines_animal (animal_id)
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS vet_prescriptions (
       id INT PRIMARY KEY AUTO_INCREMENT,
       animal_id INT NOT NULL,
       appointment_id INT,
       veterinaire_id INT NOT NULL,
       medicaments JSON NOT NULL,
       consignes TEXT,
       recommandations TEXT,
       notes TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_vet_presc_animal (animal_id)
     ) ENGINE=InnoDB`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS animal_id INT NULL`,
    // ── Salles et file d'attente vétérinaire ────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS vet_rooms (
       id INT PRIMARY KEY AUTO_INCREMENT,
       structure_id INT NOT NULL,
       nom VARCHAR(200) NOT NULL,
       type ENUM('consultation','vaccination','urgence','chirurgie') DEFAULT 'consultation',
       statut ENUM('libre','occupee','fermee') DEFAULT 'libre',
       ordre INT DEFAULT 0,
       INDEX idx_vr_structure (structure_id)
     ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS vet_queue (
       id INT PRIMARY KEY AUTO_INCREMENT,
       structure_id INT NOT NULL,
       room_id INT,
       appointment_id INT,
       patient_id INT NOT NULL,
       animal_name VARCHAR(200),
       animal_species VARCHAR(100),
       owner_name VARCHAR(200),
       type ENUM('normal','urgence') DEFAULT 'normal',
       statut ENUM('en_attente','appele','en_cours','termine') DEFAULT 'en_attente',
       position INT NOT NULL DEFAULT 1,
       ticket_numero VARCHAR(20),
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_vq_structure (structure_id),
       INDEX idx_vq_appointment (appointment_id)
     ) ENGINE=InnoDB`,
    // vet_profiles: add urgences column
    `ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS urgences TINYINT(1) DEFAULT 0`,
    `ALTER TABLE vet_profiles ADD COLUMN IF NOT EXISTS soins_domicile TINYINT(1) DEFAULT 0`,
    // appointments: add animal info columns for vet context
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS animal_nom VARCHAR(200) NULL`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS animal_espece VARCHAR(100) NULL`,
    // prescriptions: extend for discharge ordonnance de sortie
    `ALTER TABLE prescriptions MODIFY COLUMN appointment_id INT NULL`,
    `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS hospitalization_id INT NULL`,
    `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS type VARCHAR(30) DEFAULT 'standard'`,
    `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS consignes TEXT NULL`,
    `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS rdv_controle DATE NULL`,
    `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS recommandations TEXT NULL`,
    `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS repos_jours INT NULL`,
    // ── Examens vétérinaires ────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS vet_exams (
       id INT PRIMARY KEY AUTO_INCREMENT,
       animal_id INT,
       appointment_id INT,
       veterinaire_id INT NOT NULL,
       patient_id INT NOT NULL,
       structure_id INT NOT NULL,
       type_examen VARCHAR(200) NOT NULL,
       description TEXT,
       statut ENUM('demande','confirme','effectue','annule') DEFAULT 'demande',
       prix DECIMAL(10,2) DEFAULT 0,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_ve_structure (structure_id),
       INDEX idx_ve_animal (animal_id)
     ) ENGINE=InnoDB`,
    // ── Hospitalisations vétérinaires ───────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS vet_hospitalizations (
       id INT PRIMARY KEY AUTO_INCREMENT,
       animal_id INT,
       appointment_id INT,
       veterinaire_id INT NOT NULL,
       patient_id INT NOT NULL,
       structure_id INT NOT NULL,
       motif TEXT,
       salle VARCHAR(200),
       duree_estimee VARCHAR(100),
       statut ENUM('demandee','acceptee','en_cours','terminee','annulee') DEFAULT 'demandee',
       prix DECIMAL(10,2) DEFAULT 0,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_vh_structure (structure_id),
       INDEX idx_vh_animal (animal_id)
     ) ENGINE=InnoDB`,
    // vet_rooms: extend type enum
    `ALTER TABLE vet_rooms MODIFY COLUMN type ENUM('consultation','vaccination','urgence','chirurgie','soins','hospitalisation','examens') DEFAULT 'consultation'`,
    // vet_queue: add countdown columns
    `ALTER TABLE vet_queue ADD COLUMN IF NOT EXISTS called_at TIMESTAMP NULL`,
    `ALTER TABLE vet_queue ADD COLUMN IF NOT EXISTS absent_count INT DEFAULT 0`,
    `ALTER TABLE vet_queue MODIFY COLUMN statut ENUM('en_attente','appele','en_cours','absent','termine') DEFAULT 'en_attente'`,
    // vet_queue: deadline for 5-min countdown
    `ALTER TABLE vet_queue ADD COLUMN IF NOT EXISTS deadline DATETIME NULL`,
    // vet_rooms: add pause to statut
    `ALTER TABLE vet_rooms MODIFY COLUMN statut ENUM('libre','occupee','pause','fermee') DEFAULT 'libre'`,
    // appointments: track room assignment for vet
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS vet_room_id INT NULL`,
    // chirurgies vétérinaires
    `CREATE TABLE IF NOT EXISTS vet_surgeries (
       id INT PRIMARY KEY AUTO_INCREMENT,
       animal_id INT,
       appointment_id INT,
       veterinaire_id INT NOT NULL,
       patient_id INT NOT NULL,
       structure_id INT NOT NULL,
       type_chirurgie VARCHAR(200) NOT NULL,
       motif TEXT,
       urgence ENUM('normal','urgent','tres_urgent') DEFAULT 'normal',
       observations TEXT,
       recommandations TEXT,
       prix DECIMAL(10,2) DEFAULT 80000,
       statut ENUM('proposee','acceptee','en_cours','terminee','annulee') DEFAULT 'proposee',
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_vs_structure (structure_id),
       INDEX idx_vs_animal (animal_id)
     ) ENGINE=InnoDB`,
  ]
  for (const sql of migrations) {
    try { await pool.query(sql) } catch (err) {
      // Ignore "column already exists" and "table already exists" noise
      const harmless = err.message.includes('Duplicate column') || err.message.includes('already exists') || err.sqlState === '42S21'
      if (!harmless) {
        const preview = sql.trim().split('\n')[0].slice(0, 80)
        console.warn(`⚠️  Migration warning [${preview}…]: ${err.message}`)
      }
    }
  }
}

async function ensureHospitalSetup() {
  const pool = require('./db')
  const SERVICES = [
    { nom: 'Consultation générale', specialite: 'Médecine générale', prix: 5000,  rooms: ['Salle Générale 1', 'Salle Générale 2', 'Salle Générale 3'] },
    { nom: 'Cardiologie',           specialite: 'Cardiologie',        prix: 15000, rooms: ['Salle Cardio 1', 'Salle Cardio 2'] },
    { nom: 'Pédiatrie',             specialite: 'Pédiatrie',          prix: 7500,  rooms: ['Salle Pédia 1', 'Salle Pédia 2'] },
    { nom: 'Ophtalmologie',         specialite: 'Ophtalmologie',      prix: 12000, rooms: ['Salle Ophta 1'] },
    { nom: 'Gynécologie',           specialite: 'Gynécologie',        prix: 10000, rooms: ['Salle Gynéco 1'] },
    { nom: 'Urgences',              specialite: 'Urgences',           prix: 20000, rooms: ['Salle Urgences 1', 'Salle Urgences 2', 'Salle Urgences 3'] },
  ]
  const EXTRA_SERVICES = [
    { nom: 'Hospitalisation', specialite: 'Hospitalisation', prix: 0, rooms: ['Chambre 1', 'Chambre 2', 'Chambre 3', 'Unité Chirurgie', 'Unité Médecine interne', 'Unité Observation'] },
    { nom: 'Examens complémentaires', specialite: 'Examens', prix: 0, rooms: ['Laboratoire 1', 'Laboratoire 2', 'Salle Radiologie', 'Salle Scanner', 'Salle Échographie', 'Salle ECG'] },
  ]
  try {
    const [clinics] = await pool.query(
      `SELECT sp.id FROM structure_profiles sp
       JOIN users u ON u.id = sp.user_id
       WHERE u.role = 'clinique'`
    )
    for (const clinic of clinics) {
      const [existing] = await pool.query('SELECT id FROM hospital_services WHERE structure_id = ?', [clinic.id])
      if (!existing.length) {
        // First time: create all standard services
        for (let i = 0; i < SERVICES.length; i++) {
          const svc = SERVICES[i]
          const [sr] = await pool.query(
            'INSERT INTO hospital_services (structure_id, nom, specialite, prix, ordre) VALUES (?, ?, ?, ?, ?)',
            [clinic.id, svc.nom, svc.specialite, svc.prix, i]
          )
          for (let j = 0; j < svc.rooms.length; j++) {
            await pool.query('INSERT INTO hospital_rooms (service_id, nom, ordre) VALUES (?, ?, ?)', [sr.insertId, svc.rooms[j], j])
          }
        }
        console.log(`   🏥 Services/salles créés pour clinique #${clinic.id}`)
      }
      // Always ensure dedicated exam/hosp services exist
      for (const svc of EXTRA_SERVICES) {
        const [ex] = await pool.query(
          'SELECT id FROM hospital_services WHERE structure_id = ? AND nom = ?', [clinic.id, svc.nom]
        )
        if (!ex.length) {
          const [sr] = await pool.query(
            'INSERT INTO hospital_services (structure_id, nom, specialite, prix, ordre) VALUES (?, ?, ?, ?, ?)',
            [clinic.id, svc.nom, svc.specialite, svc.prix, 99]
          )
          for (let j = 0; j < svc.rooms.length; j++) {
            await pool.query('INSERT INTO hospital_rooms (service_id, nom, ordre) VALUES (?, ?, ?)', [sr.insertId, svc.rooms[j], j])
          }
          console.log(`   ➕ Service "${svc.nom}" ajouté pour clinique #${clinic.id}`)
        }
      }
    }
  } catch (e) { console.error('ensureHospitalSetup:', e.message) }
}

async function ensureVetSetup() {
  const pool = require('./db')
  const VET_ROOMS = [
    { nom: 'Salle Consultation 1',      type: 'consultation',    ordre: 0 },
    { nom: 'Salle Consultation 2',      type: 'consultation',    ordre: 1 },
    { nom: 'Salle Vaccination',         type: 'vaccination',     ordre: 2 },
    { nom: 'Salle Soins',              type: 'soins',           ordre: 3 },
    { nom: 'Salle Chirurgie',          type: 'chirurgie',       ordre: 4 },
    { nom: 'Salle Hospitalisation',     type: 'hospitalisation', ordre: 5 },
    { nom: 'Salle Examens',            type: 'examens',         ordre: 6 },
    { nom: 'Salle Urgence Animale',     type: 'urgence',         ordre: 7 },
  ]
  try {
    const [vets] = await pool.query(
      `SELECT sp.id FROM structure_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.type = 'veterinaire'`
    )
    let added = 0
    for (const vet of vets) {
      for (const room of VET_ROOMS) {
        const [existing] = await pool.query(
          'SELECT id FROM vet_rooms WHERE structure_id = ? AND nom = ?', [vet.id, room.nom]
        )
        if (!existing.length) {
          await pool.query(
            'INSERT INTO vet_rooms (structure_id, nom, type, ordre) VALUES (?, ?, ?, ?)',
            [vet.id, room.nom, room.type, room.ordre]
          )
          added++
        }
      }
    }
    if (added > 0) console.log(`   🐾 ${added} salle(s) vétérinaires créées/ajoutées`)
    else console.log('   ✅ Salles vétérinaires : OK')
  } catch (e) { console.error('ensureVetSetup:', e.message) }
}

server.listen(PORT, async () => {
  console.log(`\n🚀 MedMap+ Backend démarré`)
  console.log(`   URL : http://localhost:${PORT}`)
  console.log(`   API : http://localhost:${PORT}/api/v1`)
  console.log(`   Santé : http://localhost:${PORT}/health\n`)
  await ensureMigrations()
  await ensureTestAccounts()
  await ensureHospitalSetup()
  await ensureVetSetup()

  // Quick table health check
  const pool = require('./db')
  const tables = ['animals', 'vet_vaccines', 'vet_prescriptions']
  for (const t of tables) {
    try {
      await pool.query(`SELECT 1 FROM \`${t}\` LIMIT 1`)
      console.log(`   ✅ Table ${t}: OK`)
    } catch (e) {
      console.error(`   ❌ Table ${t}: MANQUANTE — ${e.message}`)
      // Try to create it inline as fallback
      if (t === 'animals') {
        try {
          await pool.query(`CREATE TABLE IF NOT EXISTS animals (
            id INT PRIMARY KEY AUTO_INCREMENT,
            owner_id INT NOT NULL,
            nom VARCHAR(200) NOT NULL,
            espece VARCHAR(100) NOT NULL DEFAULT 'Autre',
            race VARCHAR(200), date_naissance DATE, poids DECIMAL(6,2),
            couleur VARCHAR(100), numero_puce VARCHAR(100),
            sterilise TINYINT(1) DEFAULT 0, notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB`)
          console.log(`   ✅ Table animals créée en fallback`)
        } catch (e2) { console.error(`   ❌ Fallback animals échoué: ${e2.message}`) }
      }
      if (t === 'vet_vaccines') {
        try {
          await pool.query(`CREATE TABLE IF NOT EXISTS vet_vaccines (
            id INT PRIMARY KEY AUTO_INCREMENT, animal_id INT NOT NULL,
            appointment_id INT, nom VARCHAR(200) NOT NULL, date_admin DATE NOT NULL,
            prochaine_date DATE, lot VARCHAR(100), veterinaire_nom VARCHAR(200),
            notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB`)
          console.log(`   ✅ Table vet_vaccines créée en fallback`)
        } catch (e2) { console.error(`   ❌ Fallback vet_vaccines échoué: ${e2.message}`) }
      }
      if (t === 'vet_prescriptions') {
        try {
          await pool.query(`CREATE TABLE IF NOT EXISTS vet_prescriptions (
            id INT PRIMARY KEY AUTO_INCREMENT, animal_id INT NOT NULL,
            appointment_id INT, veterinaire_id INT NOT NULL,
            medicaments JSON NOT NULL, consignes TEXT, recommandations TEXT,
            notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB`)
          console.log(`   ✅ Table vet_prescriptions créée en fallback`)
        } catch (e2) { console.error(`   ❌ Fallback vet_prescriptions échoué: ${e2.message}`) }
      }
    }
  }
})
