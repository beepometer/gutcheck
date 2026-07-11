package demo;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class CalcTest {
    @Test void addsTwoNumbers() { assertEquals(5, new Calc().add(2, 3)); }
    @Test void clampsAboveCeiling() { assertEquals(100, new Calc().clampScore(999)); }
}
