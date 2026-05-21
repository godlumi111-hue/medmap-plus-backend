const bcrypt = require('bcryptjs')

async function hash(password) {
  return bcrypt.hash(password, 12)
}

async function compare(password, hashed) {
  return bcrypt.compare(password, hashed)
}

module.exports = { hash, compare }
