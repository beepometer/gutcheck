package demo

// jvm-instance-reach virtual-dispatch fixture: a receiver DECLARED as Animal but CONSTRUCTED as Dog
// (see CalcTest.kt's testPolymorphicSound). An instance call dispatches to the RUNTIME type (Dog), so
// the probe must gut Dog.sound (the constructor's type), NOT Animal.sound — gutting Animal.sound would
// never execute and a sound test would survive → a false HOLLOW.
open class Animal {
    open fun sound(): String = "generic"
}
