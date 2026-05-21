-- MedMap+ — Migration système médical avancé
USE medmap_plus;

-- ── Orientations / Transferts médicaux ────────────────────────────────────
CREATE TABLE IF NOT EXISTS medical_referrals (
  id                  INT PRIMARY KEY AUTO_INCREMENT,
  appointment_id      INT NOT NULL,
  patient_id          INT NOT NULL,
  emetteur_id         INT NOT NULL,
  specialite          VARCHAR(100) NOT NULL,
  motif               TEXT,
  urgence             ENUM('normal','urgent','tres_urgent') DEFAULT 'normal',
  resume_medical      TEXT,
  symptomes_observes  TEXT,
  medecin_recommande  VARCHAR(200),
  service_recommande  VARCHAR(200),
  date_proposee       DATE,
  heure_proposee      TIME,
  tarif               DECIMAL(10,2),
  examens_necessaires TEXT,
  commentaire         TEXT,
  statut              ENUM('en_attente','accepte','refuse','reporte') DEFAULT 'en_attente',
  new_appointment_id  INT,
  paiement_id         INT,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id)     REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (emetteur_id)    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Hospitalisations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hospitalizations (
  id               INT PRIMARY KEY AUTO_INCREMENT,
  appointment_id   INT NOT NULL,
  patient_id       INT NOT NULL,
  emetteur_id      INT NOT NULL,
  structure_id     INT,
  motif            TEXT NOT NULL,
  duree_estimee    VARCHAR(100),
  service          VARCHAR(200),
  chambre          VARCHAR(100),
  urgence          ENUM('normal','urgent','tres_urgent') DEFAULT 'normal',
  frais            DECIMAL(10,2),
  examens          TEXT,
  commentaire      TEXT,
  statut           ENUM('en_attente','accepte','refuse','en_cours','termine') DEFAULT 'en_attente',
  paiement_statut  ENUM('non_requis','bloque','libere','rembourse') DEFAULT 'non_requis',
  paiement_id      INT,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id)     REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (emetteur_id)    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Demandes d'examens complémentaires ────────────────────────────────────
CREATE TABLE IF NOT EXISTS medical_exams (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  appointment_id INT NOT NULL,
  patient_id     INT NOT NULL,
  emetteur_id    INT NOT NULL,
  examens        JSON NOT NULL,
  motif          TEXT,
  urgence        ENUM('normal','urgent','tres_urgent') DEFAULT 'normal',
  laboratoire    VARCHAR(200),
  date_proposee  DATE,
  frais          DECIMAL(10,2),
  statut         ENUM('demande','realise','annule') DEFAULT 'demande',
  resultats      TEXT,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id)     REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Rappels médicaux MediA ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS medical_reminders (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  patient_id      INT NOT NULL,
  prescription_id INT,
  appointment_id  INT,
  type            ENUM('medicament','rdv','examen','controle') DEFAULT 'medicament',
  titre           VARCHAR(200) NOT NULL,
  description     TEXT,
  horaire         VARCHAR(50),
  date_debut      DATE,
  date_fin        DATE,
  medicament_nom  VARCHAR(200),
  actif           TINYINT(1) DEFAULT 1,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

SELECT 'Migration médicale OK' AS status;
