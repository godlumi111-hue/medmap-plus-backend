/**
 * MedMap+ - Script de création des comptes de test
 * Usage: node database/seeds.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const pool = require('../src/db')
const { hash } = require('../src/utils/password')

const PASS = 'password123'

async function seed() {
  console.log('🌱 Création des comptes de test MedMap+...\n')

  // Add 'coach' to users.role ENUM if missing
  await pool.query("ALTER TABLE users MODIFY COLUMN role ENUM('patient','medecin','pharmacie','clinique','veterinaire','admin','livreur','samu','pompiers','ambulance','coach') NOT NULL DEFAULT 'patient'").catch(() => {})

  // Add missing columns to doctor_profiles gracefully
  await pool.query('ALTER TABLE doctor_profiles ADD COLUMN note DECIMAL(3,2) DEFAULT 4.5').catch(() => {})
  await pool.query('ALTER TABLE doctor_profiles ADD COLUMN teleconsultation TINYINT DEFAULT 0').catch(() => {})
  await pool.query('ALTER TABLE doctor_profiles ADD COLUMN domicile TINYINT DEFAULT 0').catch(() => {})
  await pool.query('ALTER TABLE doctor_profiles ADD COLUMN nb_patients INT DEFAULT 0').catch(() => {})

  const passwordHash = await hash(PASS)

  const users = [
    // ── Patients ─────────────────────────────────────────────────────────────
    { email: 'patient.demo@medmap.ci',      nom: 'Kouamé',      prenom: 'Adjoua',      role: 'patient',   tel: '+225 07 01 23 45' },
    { email: 'patient2.demo@medmap.ci',     nom: 'Bamba',       prenom: 'Seydou',      role: 'patient',   tel: '+225 07 99 00 11' },

    // ── Médecins existants ────────────────────────────────────────────────────
    { email: 'dr.kwadjo@medmap.ci',         nom: 'Kwadjo',      prenom: 'Ama',         role: 'medecin',   tel: '+225 07 11 22 33' },
    { email: 'dr.coulibaly@medmap.ci',      nom: 'Coulibaly',   prenom: 'Ibrahim',     role: 'medecin',   tel: '+225 05 44 55 66' },
    { email: 'dr.assi@medmap.ci',           nom: 'Assi',        prenom: 'Christelle',  role: 'medecin',   tel: '+225 07 22 33 44' },

    // ── Nouveaux médecins ─────────────────────────────────────────────────────
    { email: 'dr.amara.coulibaly@medmap.ci',nom: 'Coulibaly',   prenom: 'Amara',       role: 'medecin',   tel: '+225 07 12 34 56' },
    { email: 'dr.fatou.diaby@medmap.ci',    nom: 'Diaby',       prenom: 'Fatou',       role: 'medecin',   tel: '+225 05 23 45 67' },
    { email: 'dr.issiaka.ouattara@medmap.ci',nom:'Ouattara',    prenom: 'Issiaka',     role: 'medecin',   tel: '+225 07 34 56 78' },
    { email: 'dr.mariam.toure@medmap.ci',   nom: 'Touré',       prenom: 'Mariam',      role: 'medecin',   tel: '+225 05 45 67 89' },
    { email: 'dr.joseph.yao@medmap.ci',     nom: 'Yao',         prenom: 'Joseph',      role: 'medecin',   tel: '+225 07 56 78 90' },
    { email: 'dr.ibrahim.bah@medmap.ci',    nom: 'Bah',         prenom: 'Ibrahim',     role: 'medecin',   tel: '+225 07 60 12 34' },
    { email: 'dr.aissata.bah@medmap.ci',    nom: 'Bah',         prenom: 'Aïssata',     role: 'medecin',   tel: '+225 05 67 89 01' },
    { email: 'dr.kouadio.mensah@medmap.ci', nom: 'Mensah',      prenom: 'Kouadio',     role: 'medecin',   tel: '+225 07 78 90 12' },
    { email: 'dr.reine.akissi@medmap.ci',   nom: 'Akissi',      prenom: 'Reine',       role: 'medecin',   tel: '+225 05 89 01 23' },
    { email: 'dr.patrick.tuo@medmap.ci',    nom: 'Tuo',         prenom: 'Patrick',     role: 'medecin',   tel: '+225 07 90 12 34' },
    { email: 'dr.adjoua.konan@medmap.ci',   nom: 'Konan',       prenom: 'Adjoua',      role: 'medecin',   tel: '+225 05 01 23 45' },
    { email: 'dr.sekou.camara@medmap.ci',   nom: 'Camara',      prenom: 'Sékou',       role: 'medecin',   tel: '+225 07 12 45 67' },
    { email: 'dr.nathalie.assoi@medmap.ci', nom: 'Assoi',       prenom: 'Nathalie',    role: 'medecin',   tel: '+225 05 23 56 78' },
    { email: 'dr.eric.gnagnon@medmap.ci',   nom: 'Gnagnon',     prenom: 'Éric',        role: 'medecin',   tel: '+225 07 34 67 89' },
    { email: 'dr.bintou.fofana@medmap.ci',  nom: 'Fofana',      prenom: 'Bintou',      role: 'medecin',   tel: '+225 07 45 78 90' },
    { email: 'dr.michel.akoua@medmap.ci',   nom: 'Akoua',       prenom: 'Michel',      role: 'medecin',   tel: '+225 05 56 89 01' },

    // ── Pharmacies ────────────────────────────────────────────────────────────
    { email: 'pharmacie.cocody@medmap.ci',  nom: 'Pharmacie',   prenom: 'Cocody Village',     role: 'pharmacie', tel: '+225 22 43 56 78' },
    { email: 'pharmacie.riviera@medmap.ci', nom: 'Pharmacie',   prenom: 'Riviera Palmeraie',  role: 'pharmacie', tel: '+225 22 41 30 20' },
    { email: 'pharmacie.plateau@medmap.ci', nom: 'Pharmacie',   prenom: 'du Plateau',         role: 'pharmacie', tel: '+225 22 20 15 40' },

    // ── Cliniques ─────────────────────────────────────────────────────────────
    { email: 'chu.cocody@medmap.ci',        nom: 'CHU Cocody',  prenom: 'Admin',       role: 'clinique',  tel: '+225 22 44 55 00' },
    { email: 'polyclinique.farah@medmap.ci',nom: 'Polyclinique',prenom: 'Farah',       role: 'clinique',  tel: '+225 22 42 30 40' },

    // ── Livreurs ──────────────────────────────────────────────────────────────
    { email: 'livreur.kouassi@medmap.ci',   nom: 'Kouassi',     prenom: 'Koffi',       role: 'livreur',   tel: '+225 07 55 66 77' },
    { email: 'livreur.diarra@medmap.ci',    nom: 'Diarra',      prenom: 'Mamadou',     role: 'livreur',   tel: '+225 01 33 44 55' },
    { email: 'livreur.kone@medmap.ci',      nom: 'Koné',        prenom: 'Lamine',      role: 'livreur',   tel: '+225 07 77 88 99' },

    // ── Admin ─────────────────────────────────────────────────────────────────
    { email: 'admin@medmap.ci',             nom: 'Admin',       prenom: 'MedMap',      role: 'admin',     tel: '+225 22 00 00 01' },

    // ── Coachs santé existants ────────────────────────────────────────────────
    { email: 'coach.diabete@medmap.ci',     nom: 'Traoré',      prenom: 'Fatoumata',   role: 'coach',     tel: '+225 07 33 44 55' },
    { email: 'coach.nutrition@medmap.ci',   nom: 'Diallo',      prenom: 'Mariame',     role: 'coach',     tel: '+225 07 44 55 66' },
    { email: 'coach.poids@medmap.ci',       nom: "N'Goran",     prenom: 'Yves',        role: 'coach',     tel: '+225 05 55 66 77' },
    { email: 'coach.hypertension@medmap.ci',nom: 'Koné',        prenom: 'Aïcha',       role: 'coach',     tel: '+225 05 66 77 88' },
    { email: 'coach.sport@medmap.ci',       nom: 'Ouattara',    prenom: 'Moussa',      role: 'coach',     tel: '+225 07 77 88 99' },
    { email: 'coach.grossesse@medmap.ci',   nom: 'Bah',         prenom: 'Aminata',     role: 'coach',     tel: '+225 07 88 99 00' },
    { email: 'coach.mental@medmap.ci',      nom: 'Touré',       prenom: 'Sarah',       role: 'coach',     tel: '+225 05 99 00 11' },
    { email: 'coach.alimentation@medmap.ci',nom: 'Kouyaté',     prenom: 'Ibrahima',    role: 'coach',     tel: '+225 07 00 11 22' },

    // ── Nouveaux coachs ───────────────────────────────────────────────────────
    { email: 'coach.recuperation@medmap.ci',nom: 'Koné',        prenom: 'Marcelline',  role: 'coach',     tel: '+225 07 11 22 30' },
    { email: 'coach.fitness@medmap.ci',     nom: 'Diabaté',     prenom: 'Omar',        role: 'coach',     tel: '+225 07 22 33 40' },
    { email: 'coach.stress@medmap.ci',      nom: 'Sanogo',      prenom: 'Ramata',      role: 'coach',     tel: '+225 05 33 44 50' },
    { email: 'coach.immunite@medmap.ci',    nom: 'Dembélé',     prenom: 'Seydou',      role: 'coach',     tel: '+225 07 44 55 60' },
    { email: 'coach.sommeil@medmap.ci',     nom: 'Traoré',      prenom: 'Adama',       role: 'coach',     tel: '+225 05 55 66 70' },
  ]

  // ── Doctor speciality data ──────────────────────────────────────────────────
  const specs = {
    'dr.kwadjo@medmap.ci':              { spec: 'Cardiologie',            cabinet: 'Clinique Cardiologique du Plateau',          tarif: 20000, exp: 15, note: 4.8, tel: 1, dom: 0 },
    'dr.coulibaly@medmap.ci':           { spec: 'Médecine générale',      cabinet: 'Cabinet Dr. Coulibaly – Cocody',             tarif: 12000, exp: 10, note: 4.7, tel: 1, dom: 1 },
    'dr.assi@medmap.ci':               { spec: 'Pédiatrie',               cabinet: 'Cabinet Pédiatrique Dr. Assi',               tarif: 15000, exp: 8,  note: 4.6, tel: 1, dom: 0 },
    'dr.amara.coulibaly@medmap.ci':    { spec: 'Dermatologie',            cabinet: 'Clinique Dermatologique Moderne – Cocody',   tarif: 18000, exp: 12, note: 4.6, tel: 0, dom: 0 },
    'dr.fatou.diaby@medmap.ci':        { spec: 'Gynécologie-Obstétrique', cabinet: 'Cabinet de Gynécologie du Plateau',          tarif: 22000, exp: 14, note: 4.8, tel: 0, dom: 0 },
    'dr.issiaka.ouattara@medmap.ci':   { spec: 'Neurologie',              cabinet: 'Centre Neurologique d\'Abidjan – Deux Plateaux', tarif: 25000, exp: 18, note: 4.7, tel: 1, dom: 0 },
    'dr.mariam.toure@medmap.ci':       { spec: 'Endocrinologie',          cabinet: 'Cabinet d\'Endocrinologie – Riviera 3',      tarif: 22000, exp: 11, note: 4.6, tel: 1, dom: 0 },
    'dr.joseph.yao@medmap.ci':         { spec: 'Psychiatrie',             cabinet: 'Centre de Santé Mentale d\'Abidjan',         tarif: 25000, exp: 15, note: 4.7, tel: 1, dom: 0 },
    'dr.ibrahim.bah@medmap.ci':        { spec: 'Neurologie',              cabinet: 'Neuro Marcory',                              tarif: 120000, exp: 18, note: 4.9, tel: 1, dom: 0 },
    'dr.aissata.bah@medmap.ci':        { spec: 'Psychologie Clinique',    cabinet: 'Cabinet Psychologique – Riviera',            tarif: 18000, exp: 8,  note: 4.5, tel: 1, dom: 0 },
    'dr.kouadio.mensah@medmap.ci':     { spec: 'Kinésithérapie',          cabinet: 'Centre Kiné Marcory',                        tarif: 15000, exp: 10, note: 4.6, tel: 0, dom: 1 },
    'dr.reine.akissi@medmap.ci':       { spec: 'Ophtalmologie',           cabinet: 'Cabinet d\'Ophtalmologie du Plateau',        tarif: 20000, exp: 13, note: 4.7, tel: 0, dom: 0 },
    'dr.patrick.tuo@medmap.ci':        { spec: 'ORL',                     cabinet: 'Cabinet ORL Liberté – Adjamé',               tarif: 18000, exp: 9,  note: 4.5, tel: 0, dom: 0 },
    'dr.adjoua.konan@medmap.ci':       { spec: 'Chirurgie Dentaire',      cabinet: 'Cabinet Dentaire Sorriso – Cocody',          tarif: 15000, exp: 7,  note: 4.4, tel: 0, dom: 0 },
    'dr.sekou.camara@medmap.ci':       { spec: 'Médecine interne',        cabinet: 'Clinique Internationale Cocody',             tarif: 25000, exp: 20, note: 4.9, tel: 1, dom: 0 },
    'dr.nathalie.assoi@medmap.ci':     { spec: 'Nutrition & Diététique',  cabinet: 'Cabinet de Nutrition – Deux Plateaux',       tarif: 16000, exp: 6,  note: 4.5, tel: 1, dom: 0 },
    'dr.eric.gnagnon@medmap.ci':       { spec: 'Pneumologie',             cabinet: 'Centre Respiratoire – Treichville',          tarif: 22000, exp: 16, note: 4.6, tel: 0, dom: 0 },
    'dr.bintou.fofana@medmap.ci':      { spec: 'Rhumatologie',            cabinet: 'Cabinet Rhumatologie – Deux Plateaux',       tarif: 20000, exp: 12, note: 4.7, tel: 0, dom: 0 },
    'dr.michel.akoua@medmap.ci':       { spec: 'Urologie',                cabinet: 'Centre d\'Urologie du Plateau',              tarif: 22000, exp: 11, note: 4.6, tel: 0, dom: 0 },
  }

  // ── Coach data ──────────────────────────────────────────────────────────────
  const coachData = {
    'coach.diabete@medmap.ci':      { spec: 'Coach Diabète',              desc: 'Spécialiste du suivi personnalisé des patients diabétiques. Programme alimentaire, activité physique et gestion du stress adapté à votre profil.', tarif: 45000, note: 4.8, exp: 7 },
    'coach.nutrition@medmap.ci':    { spec: 'Coach Nutrition',            desc: 'Nutritionniste certifiée, je vous aide à rééquilibrer votre alimentation pour une santé durable, adaptée au contexte ivoirien.', tarif: 40000, note: 4.7, exp: 5 },
    'coach.poids@medmap.ci':        { spec: 'Coach Perte de Poids',       desc: 'Programme sur-mesure pour perdre du poids durablement sans frustration. Combinaison nutrition + activité physique + suivi motivationnel.', tarif: 50000, note: 4.9, exp: 8 },
    'coach.hypertension@medmap.ci': { spec: 'Coach Hypertension',         desc: 'Accompagnement des patients hypertendus : alimentation faible en sel, gestion du stress, suivi tensionnel régulier.', tarif: 45000, note: 4.6, exp: 6 },
    'coach.sport@medmap.ci':        { spec: 'Coach Sport & Santé',        desc: "Programme d'exercices adaptés à votre condition physique et vos objectifs de santé. Coach certifié spécialisé en médecine du sport.", tarif: 35000, note: 4.7, exp: 10 },
    'coach.grossesse@medmap.ci':    { spec: 'Coach Suivi Grossesse',      desc: "Accompagnement personnalisé de la grossesse : nutrition, préparation à l'accouchement, yoga prénatal et conseils post-partum.", tarif: 55000, note: 4.9, exp: 9 },
    'coach.mental@medmap.ci':       { spec: 'Coach Santé Mentale',        desc: 'Psychologue de formation, je vous accompagne pour gérer le stress, l\'anxiété et améliorer votre bien-être mental au quotidien.', tarif: 60000, note: 4.8, exp: 12 },
    'coach.alimentation@medmap.ci': { spec: 'Coach Alimentation',         desc: 'Éducation alimentaire et changement des habitudes sur le long terme. Spécialiste de l\'alimentation saine en milieu tropical.', tarif: 38000, note: 4.5, exp: 4 },
    'coach.recuperation@medmap.ci': { spec: 'Coach Récupération & Bien-être', desc: 'Spécialiste en récupération physique et mentale après maladie, chirurgie ou burn-out. Programme doux et progressif adapté à votre corps et votre rythme de vie.', tarif: 42000, note: 4.7, exp: 5 },
    'coach.fitness@medmap.ci':      { spec: 'Coach Fitness & Cardio',     desc: 'Coach certifié en fitness et entraînement cardiovasculaire. Programmes sur-mesure pour améliorer votre endurance, brûler les graisses et sculpter votre silhouette.', tarif: 35000, note: 4.6, exp: 7 },
    'coach.stress@medmap.ci':       { spec: 'Coach Gestion du Stress',    desc: 'Accompagnement pour identifier vos sources de stress, développer des stratégies de gestion efficaces et retrouver sérénité et performance au quotidien.', tarif: 45000, note: 4.8, exp: 9 },
    'coach.immunite@medmap.ci':     { spec: 'Coach Immunité & Défenses',  desc: 'Programme naturel pour renforcer votre système immunitaire : nutrition anti-inflammatoire, compléments naturels et mode de vie adapté au climat ivoirien.', tarif: 38000, note: 4.5, exp: 4 },
    'coach.sommeil@medmap.ci':      { spec: 'Coach Sommeil & Rythme de Vie', desc: 'Troubles du sommeil, insomnie, fatigue chronique — je vous accompagne pour retrouver un rythme circadien sain et un sommeil réparateur grâce à des méthodes non-médicamenteuses.', tarif: 40000, note: 4.6, exp: 6 },
  }

  for (const u of users) {
    try {
      const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [u.email])
      if (existing.length) {
        console.log(`  ⏭  ${u.email} déjà existant`)
        continue
      }

      const [res] = await pool.query(
        'INSERT INTO users (email, password_hash, nom, prenom, telephone, role, is_active, is_verified) VALUES (?, ?, ?, ?, ?, ?, 1, 1)',
        [u.email, passwordHash, u.nom, u.prenom, u.tel, u.role]
      )
      const uid = res.insertId

      await pool.query('INSERT INTO wallets (user_id, solde) VALUES (?, ?)', [uid, 50000])

      if (u.role === 'medecin') {
        const s = specs[u.email] || { spec: 'Médecine générale', cabinet: null, tarif: 12000, exp: 5, note: 4.5, tel: 0, dom: 0 }
        await pool.query(
          'INSERT INTO doctor_profiles (user_id, specialite, cabinet, ville, tarif, disponible, experience_ans, note, teleconsultation, domicile) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
          [uid, s.spec, s.cabinet || `Cabinet Dr. ${u.nom}`, 'Abidjan', s.tarif, s.exp, s.note, s.tel, s.dom]
        )
      } else if (u.role === 'coach') {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS coach_profiles (
            id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL UNIQUE,
            specialite VARCHAR(150) NOT NULL, description TEXT,
            tarif_mensuel DECIMAL(10,2) DEFAULT 50000, disponible TINYINT DEFAULT 1,
            note DECIMAL(3,2) DEFAULT 4.5, nb_patients INT DEFAULT 0,
            experience_ans INT DEFAULT 0, ville VARCHAR(100) DEFAULT 'Abidjan',
            langues JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )`
        ).catch(() => {})
        const cd = coachData[u.email] || { spec: 'Coach Santé', desc: '', tarif: 40000, note: 4.5, exp: 5 }
        await pool.query(
          'INSERT INTO coach_profiles (user_id, specialite, description, tarif_mensuel, disponible, note, nb_patients, experience_ans, ville, langues) VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?, ?)',
          [uid, cd.spec, cd.desc, cd.tarif, cd.note, cd.exp, 'Abidjan', JSON.stringify(['Français'])]
        )
      } else if (u.role === 'pharmacie') {
        const [sp] = await pool.query(
          'INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          [uid, 'pharmacie', `${u.prenom}`, 'Abidjan', 'Abidjan', u.tel, 4.7]
        )
        await pool.query('INSERT INTO pharmacy_profiles (structure_id, garde, horaires) VALUES (?, 1, ?)',
          [sp.insertId, '24h/24'])
      } else if (u.role === 'clinique') {
        const noms = {
          'chu.cocody@medmap.ci': 'CHU de Cocody',
          'polyclinique.farah@medmap.ci': 'Polyclinique Farah',
        }
        const nom = noms[u.email] || `${u.prenom}`
        const [sp] = await pool.query(
          'INSERT INTO structure_profiles (user_id, type, nom, adresse, ville, telephone, partenaire, note) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          [uid, 'clinique', nom, 'Abidjan', 'Abidjan', u.tel, 4.5]
        )
        await pool.query('INSERT INTO clinic_profiles (structure_id, urgence24h, nombre_lits, horaires) VALUES (?, 1, 200, ?)',
          [sp.insertId, '24h/24'])
      } else if (u.role === 'livreur') {
        await pool.query('INSERT INTO livreur_profiles (user_id, vehicule, zone, statut) VALUES (?, ?, ?, ?)',
          [uid, 'Moto', 'Abidjan', 'disponible'])
      }

      console.log(`  ✅ ${u.email} (${u.role}) créé`)
    } catch (err) {
      console.error(`  ❌ Erreur pour ${u.email}:`, err.message)
    }
  }

  // Seed medicines if none exist
  const [medCount] = await pool.query('SELECT COUNT(*) AS n FROM medicines')
  if (!medCount[0].n) {
    console.log('\n💊 Ajout des médicaments de base...')
    const meds = [
      ['Paracétamol 500mg', 'Analgésique', 300, 'Antidouleur et antipyrétique', 0, 'Laborex'],
      ['Amoxicilline 500mg', 'Antibiotique', 800, 'Antibiotique à large spectre', 1, 'Cipla'],
      ['Artemether-Luméfantrine', 'Antipaludique', 2500, 'Traitement du paludisme', 1, 'Novartis'],
      ['Metformine 850mg', 'Antidiabétique', 1200, 'Traitement du diabète type 2', 1, 'Sanofi'],
      ['Ibuprofène 400mg', 'Anti-inflammatoire', 500, 'Anti-inflammatoire non stéroïdien', 0, 'Pfizer'],
      ['Vitamine C 500mg', 'Vitamine', 400, 'Renforcement du système immunitaire', 0, 'Bayer'],
      ['Oméprazole 20mg', 'Gastro-entérologie', 900, 'Traitement des ulcères gastriques', 1, 'AstraZeneca'],
      ['Amlodipine 5mg', 'Antihypertenseur', 1500, 'Antihypertenseur inhibiteur calcique', 1, 'Pfizer'],
      ['Loratadine 10mg', 'Antihistaminique', 600, 'Traitement des allergies', 0, 'Schering'],
      ['Metronidazole 250mg', 'Antibiotique', 700, 'Traitement des infections parasitaires', 1, 'Sanofi'],
      ['Fer + Acide Folique', 'Vitamine', 500, 'Supplément fer pour grossesse', 0, 'Laborex'],
      ['Salbutamol 100mcg', 'Respiratoire', 1800, 'Bronchodilatateur pour asthme', 1, 'GSK'],
      ['Diclofénac 50mg', 'Anti-inflammatoire', 600, 'Anti-inflammatoire articulaire', 0, 'Novartis'],
      ['Ciprofloxacine 500mg', 'Antibiotique', 1100, 'Antibiotique quinolone', 1, 'Bayer'],
      ['Hydroxychloroquine 200mg', 'Antipaludique', 3000, 'Prophylaxie paludisme', 1, 'Sanofi'],
    ]
    for (const [nom, cat, prix, desc, ordo, fab] of meds) {
      await pool.query(
        'INSERT INTO medicines (nom, categorie, prix, description, sur_ordonnance, fabricant, stock) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [nom, cat, prix, desc, ordo, fab, 100]
      ).catch(() => {})
    }
    console.log('  ✅ Médicaments ajoutés')
  }

  console.log('\n✅ Seeds terminés !')
  console.log('\n📋 COMPTES DE TEST :')
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('PATIENTS')
  console.log('  patient.demo@medmap.ci / password123')
  console.log('  patient2.demo@medmap.ci / password123')
  console.log('')
  console.log('MÉDECINS')
  console.log('  dr.kwadjo@medmap.ci / password123           (Cardiologue, 15 ans)')
  console.log('  dr.coulibaly@medmap.ci / password123        (Généraliste, domicile + téléconsult)')
  console.log('  dr.assi@medmap.ci / password123             (Pédiatre, téléconsult)')
  console.log('  dr.amara.coulibaly@medmap.ci / password123  (Dermatologue)')
  console.log('  dr.fatou.diaby@medmap.ci / password123      (Gynécologue, 14 ans)')
  console.log('  dr.issiaka.ouattara@medmap.ci / password123 (Neurologue, 18 ans)')
  console.log('  dr.mariam.toure@medmap.ci / password123     (Endocrinologue, téléconsult)')
  console.log('  dr.joseph.yao@medmap.ci / password123       (Psychiatre, téléconsult)')
  console.log('  dr.aissata.bah@medmap.ci / password123      (Psychologue, téléconsult)')
  console.log('  dr.kouadio.mensah@medmap.ci / password123   (Kinésithérapeute, domicile)')
  console.log('  dr.reine.akissi@medmap.ci / password123     (Ophtalmologue)')
  console.log('  dr.patrick.tuo@medmap.ci / password123      (ORL)')
  console.log('  dr.adjoua.konan@medmap.ci / password123     (Dentiste)')
  console.log('  dr.sekou.camara@medmap.ci / password123     (Médecine interne, 20 ans, note 4.9)')
  console.log('  dr.nathalie.assoi@medmap.ci / password123   (Nutritionniste, téléconsult)')
  console.log('  dr.eric.gnagnon@medmap.ci / password123     (Pneumologue, 16 ans)')
  console.log('  dr.bintou.fofana@medmap.ci / password123    (Rhumatologue)')
  console.log('  dr.michel.akoua@medmap.ci / password123     (Urologue)')
  console.log('')
  console.log('PHARMACIES')
  console.log('  pharmacie.cocody@medmap.ci / password123')
  console.log('  pharmacie.riviera@medmap.ci / password123')
  console.log('  pharmacie.plateau@medmap.ci / password123')
  console.log('')
  console.log('HÔPITAUX')
  console.log('  chu.cocody@medmap.ci / password123')
  console.log('  polyclinique.farah@medmap.ci / password123')
  console.log('')
  console.log('LIVREURS')
  console.log('  livreur.kouassi@medmap.ci / password123')
  console.log('  livreur.diarra@medmap.ci / password123')
  console.log('  livreur.kone@medmap.ci / password123')
  console.log('')
  console.log('ADMIN')
  console.log('  admin@medmap.ci / password123')
  console.log('')
  console.log('COACHS SANTÉ (13 au total)')
  console.log('  coach.diabete@medmap.ci / password123       (Coach Diabète)')
  console.log('  coach.nutrition@medmap.ci / password123     (Coach Nutrition)')
  console.log('  coach.poids@medmap.ci / password123         (Coach Perte de Poids)')
  console.log('  coach.hypertension@medmap.ci / password123  (Coach Hypertension)')
  console.log('  coach.sport@medmap.ci / password123         (Coach Sport & Santé)')
  console.log('  coach.grossesse@medmap.ci / password123     (Coach Grossesse)')
  console.log('  coach.mental@medmap.ci / password123        (Coach Santé Mentale)')
  console.log('  coach.alimentation@medmap.ci / password123  (Coach Alimentation)')
  console.log('  coach.recuperation@medmap.ci / password123  (Coach Récupération)')
  console.log('  coach.fitness@medmap.ci / password123       (Coach Fitness & Cardio)')
  console.log('  coach.stress@medmap.ci / password123        (Coach Gestion du Stress)')
  console.log('  coach.immunite@medmap.ci / password123      (Coach Immunité)')
  console.log('  coach.sommeil@medmap.ci / password123       (Coach Sommeil)')
  console.log('═══════════════════════════════════════════════════════════════════')
  process.exit(0)
}

seed().catch(err => { console.error(err); process.exit(1) })
