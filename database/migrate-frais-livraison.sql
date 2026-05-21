USE medmap_plus;

-- Add frais_livraison column to orders (idempotent)
SET @col_exists = 0;
SELECT COUNT(*) INTO @col_exists FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'medmap_plus' AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'frais_livraison';
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE orders ADD COLUMN frais_livraison DECIMAL(10,2) DEFAULT 700.00 AFTER commission',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'Migration frais_livraison OK' AS status;
