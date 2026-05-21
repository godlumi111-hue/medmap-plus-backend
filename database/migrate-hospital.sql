-- MedMap+ — Migration système hospitalier
-- Usage: & "C:\xampp\mysql\bin\mysql.exe" -u root medmap_plus < database/migrate-hospital.sql

USE medmap_plus;

-- 1. Fix statut ENUM (ajouter 'refuse')
ALTER TABLE appointments
  MODIFY COLUMN statut
    ENUM('en_attente','confirme','refuse','annule','termine')
    DEFAULT 'en_attente';

-- 2. Colonnes patient info + suivi consultation
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS symptomes         TEXT        AFTER motif,
  ADD COLUMN IF NOT EXISTS age_patient       INT         AFTER symptomes,
  ADD COLUMN IF NOT EXISTS sexe_patient      VARCHAR(10) AFTER age_patient,
  ADD COLUMN IF NOT EXISTS premiere_consult  TINYINT(1)  DEFAULT 1 AFTER sexe_patient,
  ADD COLUMN IF NOT EXISTS antecedents       TEXT        AFTER premiere_consult,
  ADD COLUMN IF NOT EXISTS consultation_statut
    ENUM('attente','effectuee','confirmee') DEFAULT 'attente' AFTER antecedents,
  ADD COLUMN IF NOT EXISTS paiement_statut
    ENUM('non_requis','bloque','libere','rembourse') DEFAULT 'non_requis' AFTER consultation_statut,
  ADD COLUMN IF NOT EXISTS commission_taux   DECIMAL(5,2) DEFAULT 10.00 AFTER paiement_statut,
  ADD COLUMN IF NOT EXISTS paiement_id       INT          AFTER commission_taux;

-- 3. Table ordonnances / prescriptions
CREATE TABLE IF NOT EXISTS prescriptions (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  appointment_id INT NOT NULL,
  patient_id     INT NOT NULL,
  emetteur_id    INT,
  medicaments    JSON,
  notes          TEXT,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

SELECT 'Migration hôpital OK' AS status;
