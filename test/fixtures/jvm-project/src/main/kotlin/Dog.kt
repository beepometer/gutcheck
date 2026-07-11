package demo

class Dog : Animal() {
    override fun sound(): String = "woof"   // the RUNTIME override the probe must gut (see Animal.kt)
}
