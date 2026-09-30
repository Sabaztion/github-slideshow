// Entry point so `node --test guest-manager/tests/` works: on Node 22 a
// directory argument resolves to this index file, which loads every suite.
// (`node --test guest-manager/tests/*.test.js` works too.)
import './logic.test.js';
import './review.test.js';
import './store.test.js';
import './a11y.test.js';
import './backend.test.js';
import './slots.test.js';
import './plan.test.js';
import './remote.test.js';
import './security.test.js';
