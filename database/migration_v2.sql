-- MedMap+ Migration v2 - Communication temps réel
-- Exécuter : mysql -u root -p medmap_plus < database/migration_v2.sql
USE medmap_plus;

-- ─── Conversations entre patients et structures/médecins ──────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  patient_id      INT NOT NULL,
  other_user_id   INT NOT NULL,
  context_type    ENUM('order','appointment','general') DEFAULT 'general',
  context_id      INT,
  last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (other_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Messages dans les conversations ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              INT PRIMARY KEY AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  sender_id       INT NOT NULL,
  content         TEXT NOT NULL,
  read_at         TIMESTAMP NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id)       REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Notifications système ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         INT PRIMARY KEY AUTO_INCREMENT,
  user_id    INT NOT NULL,
  type       VARCHAR(50) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       TEXT,
  data       JSON,
  read_at    TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ─── Mise à jour ENUM orders (ajouter en_route) ───────────────────────────────
ALTER TABLE orders
  MODIFY COLUMN statut ENUM('en_attente','confirme','en_preparation','en_route','livre','annule') DEFAULT 'en_attente';

-- ─── Mise à jour ENUM appointments (ajouter refuse) ──────────────────────────
ALTER TABLE appointments
  MODIFY COLUMN statut ENUM('en_attente','confirme','refuse','annule','termine') DEFAULT 'en_attente';

-- ─── Champs supplémentaires pour orders ──────────────────────────────────────
ALTER TABLE orders ADD COLUMN adresse_livraison TEXT AFTER notes;
ALTER TABLE orders ADD COLUMN note_patient TEXT AFTER adresse_livraison;

SELECT 'Migration v2 appliquée avec succès !' AS status;
