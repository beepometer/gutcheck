package demo

// A trailing-lambda DSL builder: idiomatically CALLED as `yaml { … }` with NO parens (the lambda is the
// sole argument). Caught only once the probe recognizes a parenless trailing-lambda call as a SUT
// reference (see CalcTest `builds via a trailing-lambda DSL`). String return → gutValueFor's sentinel is
// type-compatible → the gutted body compiles and violates the pinned literal → CAUGHT.
fun yaml(build: StringBuilder.() -> Unit): String = StringBuilder().apply(build).toString()
