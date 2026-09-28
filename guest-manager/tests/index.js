// Entry point so `node --test guest-manager/tests/` works: on Node 22 a
// directory argument resolves to this index file, which loads every suite.
// (`node --test guest-manager/tests/*.test.js` works too.)
import './logic.test.js';
