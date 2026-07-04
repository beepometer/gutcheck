## gutcheck — diff verification report

**2 functions changed** · proven 1 · hollow 0 · unverifiable 0 · untested 1

| Function | File | Status | Evidence |
| --- | --- | --- | --- |
| `dbl` | src/lib.mjs | ✅ proven | test/t.test.mjs:3 "sound" went red when gutted |
| `ghost` | src/lib.mjs | ∅ untested | no test mentions it |

✓ verified 1 test genuinely catches breaks (broke the function, the test went red).

---
*Evidence classes: **proven/hollow** are execution-backed (we mutated the function and reran its test). **unverifiable/untested** are name-search (a same-named function elsewhere can confuse them). Only value-pinning tests with locatable functions are probeable — skipped tests are counted in the run banner. Top-level functions only (JS/TS + Python).*
