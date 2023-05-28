const config = require('./config');
const mysql = require('mysql');

const pool  = mysql.createPool({
  connectionLimit : 10,
  host            : config.db.host,
  user            : config.db.user,
  password        : config.db.pass,
  database        : config.db.name,
  port: config.db.port
});

module.exports = pool;
