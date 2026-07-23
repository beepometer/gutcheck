package demo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
class FxTest {
    @Test fun label_formatsBand() {
        assertEquals("band-7", Fx.label(7))
        assertTrue(Fx.trustworthy(5))
    }
}
