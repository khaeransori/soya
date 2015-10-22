import register from './RegisterClient.js';

/**
 * Loads webpack hot client along with the function. Ensures that webpack hot
 * client does not get loaded more than once.
 *
 * @CLIENT
 */
if (!window.__hotReload) {
  window.__hotReload = require('webpack-hot-middleware/client');
}
export default register;