package demo

fun add(a: Int, b: Int): Int = a + b            // expression body, Int

fun greet(name: String): String {               // block body, String
    return "Hello, " + name
}

fun isPositive(n: Int): Boolean = n > 0          // Boolean

fun firstTwo(xs: List<Int>): List<Int> {         // compile-fail-only for numeric/string sentinel
    return xs.take(2)
}

fun double(n: Int): Int = n * 2                  // echo-oracle HOLLOW target (see testDouble)

fun triple(n: Int): Int = n * 3                  // caught ONLY through a backtick-named @Test (see CalcTest)

fun quadruple(n: Int): Int = n * 4               // caught ONLY through a @Nested inner-class @Test (see CalcTest)
