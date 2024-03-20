export default {
  prefix: '/ping',
  get: {
    '': async () => "pong"
  }
}