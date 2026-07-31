// server.js
// Entry point — loads/validates env first (fails fast if misconfigured),
// then starts the app.

const { port } = require('./config/env');
const app = require('./app');

app.listen(port, () => {
  console.log(`GVMC FMS backend listening on port ${port}`);
});
