USE medmap_plus;

-- 1. Add livreur to users ENUM
ALTER TABLE users MODIFY COLUMN role ENUM('patient','medecin','pharmacie','clinique','veterinaire','admin','livreur') NOT NULL DEFAULT 'patient';

-- 2. Create livreur_profiles table
CREATE TABLE IF NOT EXISTS livreur_profiles (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  user_id     INT UNIQUE NOT NULL,
  statut      ENUM('disponible','occupe','inactif') DEFAULT 'disponible',
  vehicule    VARCHAR(100) DEFAULT 'Moto',
  zone        VARCHAR(100) DEFAULT 'Abidjan',
  note_moy    DECIMAL(3,2) DEFAULT 0.00,
  livraisons  INT DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. Add livreur columns to orders (safe ALTER with column checks)
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'medmap_plus' AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'livreur_id';
SET @sql = IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN livreur_id INT NULL AFTER pharmacy_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'medmap_plus' AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'livreur_statut';
SET @sql = IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN livreur_statut VARCHAR(50) DEFAULT NULL AFTER livreur_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'medmap_plus' AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'commission';
SET @sql = IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN commission DECIMAL(10,2) DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'medmap_plus' AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'paiement_statut';
SET @sql = IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN paiement_statut ENUM(''en_attente'',''bloque'',''libere'') DEFAULT ''en_attente''', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'medmap_plus' AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'adresse_livraison';
SET @sql = IF(@col_exists = 0, 'ALTER TABLE orders ADD COLUMN adresse_livraison TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'Migration livreur terminee !' AS status;
