-- MedMap+ - Schéma MySQL
-- Exécuter : mysql -u root -p < database/init.sql

CREATE DATABASE IF NOT EXISTS medmap_plus CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE medmap_plus;

-- ─── Utilisateurs ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nom           VARCHAR(100) NOT NULL,
  prenom        VARCHAR(100) NOT NULL,
  telephone     VARCHAR(20),
  role          ENUM('patient','medecin','pharmacie','clinique','veterinaire','admin','livreur') NOT NULL DEFAULT 'patient',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  is_verified   TINYINT(1) NOT NULL DEFAULT 0,
  avatar_url    VARCHAR(500),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Profils médecins ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctor_profiles (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  user_id        INT UNIQUE NOT NULL,
  specialite     VARCHAR(100),
  cabinet        VARCHAR(200),
  ville          VARCHAR(100),
  adresse        TEXT,
  tarif          DECIMAL(10,2),
  disponible     TINYINT(1) DEFAULT 1,
  langues        JSON,
  experience_ans INT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Profils structures (pharmacies, cliniques, vétérinaires) ──────────────────
CREATE TABLE IF NOT EXISTS structure_profiles (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT UNIQUE NOT NULL,
  type       VARCHAR(50) NOT NULL,
  nom        VARCHAR(200),
  adresse    TEXT,
  ville      VARCHAR(100),
  telephone  VARCHAR(20),
  email      VARCHAR(255),
  partenaire TINYINT(1) DEFAULT 0,
  note       DECIMAL(3,2),
  lat        DECIMAL(10,7),
  lng        DECIMAL(10,7),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Profils cliniques ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_profiles (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  structure_id INT UNIQUE NOT NULL,
  urgence24h  TINYINT(1) DEFAULT 0,
  nombre_lits INT,
  horaires    VARCHAR(200),
  services    JSON,
  FOREIGN KEY (structure_id) REFERENCES structure_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Profils pharmacies ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pharmacy_profiles (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  structure_id INT UNIQUE NOT NULL,
  garde        TINYINT(1) DEFAULT 0,
  horaires     VARCHAR(200),
  FOREIGN KEY (structure_id) REFERENCES structure_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Profils vétérinaires ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vet_profiles (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  structure_id INT UNIQUE NOT NULL,
  services     JSON,
  horaires     VARCHAR(200),
  FOREIGN KEY (structure_id) REFERENCES structure_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Rendez-vous ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appointments (
  id            INT PRIMARY KEY AUTO_INCREMENT,
  patient_id    INT NOT NULL,
  provider_type ENUM('medecin','structure') NOT NULL,
  doctor_id     INT,
  structure_id  INT,
  service       VARCHAR(200),
  date_rdv      DATE NOT NULL,
  heure_rdv     TIME NOT NULL,
  type_rdv      VARCHAR(100),
  motif         TEXT,
  statut        ENUM('en_attente','confirme','annule','termine') DEFAULT 'en_attente',
  prix          DECIMAL(10,2),
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES users(id),
  FOREIGN KEY (doctor_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ─── Médicaments ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medicines (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  nom             VARCHAR(200) NOT NULL,
  description     TEXT,
  categorie       VARCHAR(100),
  prix            DECIMAL(10,2),
  stock           INT DEFAULT 0,
  sur_ordonnance  TINYINT(1) DEFAULT 0,
  fabricant       VARCHAR(200),
  image_url       VARCHAR(500),
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─── Médicaments par pharmacie ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pharmacy_medicines (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  pharmacy_id  INT NOT NULL,
  medicine_id  INT NOT NULL,
  prix_local   DECIMAL(10,2),
  stock_local  INT DEFAULT 0,
  UNIQUE KEY uq_pharma_med (pharmacy_id, medicine_id),
  FOREIGN KEY (pharmacy_id) REFERENCES structure_profiles(id),
  FOREIGN KEY (medicine_id) REFERENCES medicines(id)
) ENGINE=InnoDB;

-- ─── Commandes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                INT PRIMARY KEY AUTO_INCREMENT,
  patient_id        INT NOT NULL,
  pharmacy_id       INT NOT NULL,
  items             JSON NOT NULL,
  notes             TEXT,
  statut            ENUM('en_attente','confirme','en_preparation','en_route','livre','annule') DEFAULT 'en_attente',
  total             DECIMAL(10,2),
  frais_livraison   DECIMAL(10,2) DEFAULT 700.00,
  adresse_livraison VARCHAR(500),
  livreur_id        INT,
  livreur_statut    ENUM('non_assigne','assigne','vers_pharmacie','arrive_pharmacie','vers_patient','arrive_patient','livre') DEFAULT 'non_assigne',
  paiement_statut   ENUM('non_requis','bloque','libere','rembourse') DEFAULT 'bloque',
  paiement_id       INT,
  commission        DECIMAL(10,2),
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES users(id),
  FOREIGN KEY (pharmacy_id) REFERENCES structure_profiles(id)
) ENGINE=InnoDB;

-- ─── Portefeuilles ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT UNIQUE NOT NULL,
  solde      DECIMAL(10,2) DEFAULT 0.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Transactions portefeuille ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id           INT PRIMARY KEY AUTO_INCREMENT,
  wallet_id    INT NOT NULL,
  montant      DECIMAL(10,2) NOT NULL,
  type         ENUM('credit','debit') NOT NULL,
  description  VARCHAR(500),
  reference_id INT,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (wallet_id) REFERENCES wallets(id)
) ENGINE=InnoDB;

-- ─── Paiements (séquestre) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  payer_id        INT NOT NULL,
  receiver_id     INT,
  appointment_id  INT,
  order_id        INT,
  structure_id    INT,
  montant         DECIMAL(10,2) NOT NULL,
  commission      DECIMAL(10,2) DEFAULT 0,
  description     VARCHAR(500),
  statut          ENUM('en_attente','confirme','dispute','rembourse') DEFAULT 'en_attente',
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payer_id) REFERENCES users(id),
  FOREIGN KEY (receiver_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ─── Litiges ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  payment_id  INT NOT NULL,
  user_id     INT NOT NULL,
  motif       TEXT,
  statut      ENUM('ouvert','en_cours','resolu') DEFAULT 'ouvert',
  resolution  TEXT,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (payment_id) REFERENCES payments(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ─── Urgences ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS emergency_reports (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  user_id     INT,
  type        VARCHAR(100) NOT NULL,
  gravite     ENUM('critical','urgent','moderate') NOT NULL,
  description TEXT,
  lat         DECIMAL(10,7),
  lng         DECIMAL(10,7),
  adresse     TEXT,
  statut      ENUM('signale','en_cours','resolu') DEFAULT 'signale',
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- ─── Abonnements MediA ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id               INT PRIMARY KEY AUTO_INCREMENT,
  user_id          INT UNIQUE NOT NULL,
  plan             ENUM('basic','premium') DEFAULT 'basic',
  messages_used    INT DEFAULT 0,
  last_reset_date  DATE,
  expires_at       TIMESTAMP NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Chat ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT NOT NULL,
  message    TEXT NOT NULL,
  response   TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

SELECT 'Schéma MedMap+ créé avec succès !' AS status;
