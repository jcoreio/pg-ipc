// eslint-disable-next-line no-undef
module.exports = function (env) {
  env.setDefaults({
    DB_PORT: env.get('CI') ? '5432' : '2745',
  })
}
