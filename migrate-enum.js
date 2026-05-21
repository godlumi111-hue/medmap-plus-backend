require('dotenv').config()
const pool = require('./src/db')

;(async () => {
  try {
    await pool.query(
      `ALTER TABLE orders MODIFY COLUMN livreur_statut
       ENUM('non_assigne','assigne','vers_pharmacie','arrive_pharmacie','vers_patient','arrive_patient','livre')
       DEFAULT 'non_assigne'`
    )
    console.log('✅ livreur_statut ENUM étendu')

    await pool.query(
      `ALTER TABLE orders ADD COLUMN IF NOT EXISTS paiement_statut
       ENUM('non_requis','bloque','libere','rembourse') DEFAULT 'bloque'`
    )
    console.log('✅ paiement_statut ajouté/présent')

    const [cols] = await pool.query('DESCRIBE orders')
    const ls = cols.find(c => c.Field === 'livreur_statut')
    const ps = cols.find(c => c.Field === 'paiement_statut')
    console.log('livreur_statut :', ls?.Type)
    console.log('paiement_statut:', ps?.Type)
  } catch (e) {
    console.error('❌', e.message)
  }
  process.exit(0)
})()
