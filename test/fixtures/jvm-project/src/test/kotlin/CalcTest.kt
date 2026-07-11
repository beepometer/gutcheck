package demo

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue

class CalcTest {
    @Test fun testAdd() { assertEquals(5, add(2, 3)) }          // proven
    @Test fun `triples a number`() { assertEquals(9, triple(3)) } // proven via a BACKTICK-named @Test (reach)
    @Test fun testGreet() { assertEquals("Hello, World", greet("World")) } // proven
    @Test fun testSquare() { assertEquals(9, JCalc.square(3)) } // proven (Java)
    @Test fun testFirstTwo() { assertEquals(listOf(1, 2), firstTwo(listOf(1, 2, 3))) } // proven; sentinel type-fails → ungutable
    @Test fun weakPositive() { assertTrue(isPositive(5)) }      // weak matcher → must be SKIPPED (no-pin), never probed
    @Test fun testDouble() {                                    // HOLLOW: echo-oracle — expected re-derived from the SUT
        val expected = double(3)                                // gut double → both sides become the sentinel → passes
        assertEquals(expected, double(3))
    }
    @Test fun testMeterReading() {                              // jvm-instance-reach: proven via a lowercase-
        val m = Meter()                                         // receiver instance call (m.reading(21)) —
        assertEquals(42, m.reading(21))                         // sutFnsIn never captures this; jvmInstanceSuts does
    }
    @Test fun testMeterEcho() {                                 // jvm-instance-reach: HOLLOW echo-oracle through
        val m = Meter()                                         // an instance method — expected re-derived from
        val expected = m.reading(21)                             // the same gutted m.reading(21) call
        assertEquals(expected, m.reading(21))
    }
    @Test fun testPolymorphicSound() {                          // jvm-instance-reach virtual dispatch: receiver
        val a: Animal = Dog()                                   // DECLARED Animal, CONSTRUCTED Dog — dispatch runs
        assertEquals("woof", a.sound())                         // Dog.sound; proven only if we gut the RUNTIME type
    }
    @Test fun `builds via a trailing-lambda DSL`() {            // trailing-lambda reach: yaml { … } (no parens)
        val out = yaml { append("hi") }                         // credited via the kotlin val-hop; gut yaml →
        assertEquals("hi", out)                                 // String sentinel → assertEquals fails → CAUGHT
    }

    @Nested inner class NestedCalc {                            // @Nested reach: FQN must be demo.CalcTest$NestedCalc.*
        @Test fun quadruples() { assertEquals(12, quadruple(3)) } // proven via a @Nested @Test (gut quadruple → fail)
    }
}
