package demo

class Meter {
    fun reading(x: Int): Int = x * 2   // jvm-instance-reach target: an INSTANCE method on a lowercase-
                                        // variable receiver (m.reading(x)) — see CalcTest.kt's
                                        // testMeterReading (proven) / testMeterEcho (HOLLOW echo-oracle)
}
